# Enhancement-product worker: the Discord bridge + the Smithers control plane it
# drives (process-per-step: `smithers up` / `up --resume`, no --serve).
#
#   docker compose up -d           # or pull the prebuilt image (see compose.yaml)
#
# Auth: the compose/judge/generate agents ARE Claude Code — they shell out to the
# `claude` CLI installed below and authenticate headlessly via CLAUDE_CODE_OAUTH_TOKEN
# (mint it with `claude setup-token`, put it in .env). Image generation uses the
# .venv-img virtualenv (gen_image.py invokes .venv-img/bin/python).
#
# Runs as the image's non-root `bun` user (uid 1000): Claude Code refuses
# `--dangerously-skip-permissions` (which the smithers agents require) under root.
#
# LAYER ORDER is deliberate: everything that does NOT depend on the app source
# (system deps, the venv, JS deps, the claude CLI) is installed FIRST so it stays
# cached, and the source is COPYed LAST. A code edit then rebuilds only the final
# layer (seconds) instead of re-running the venv/bun/claude installs (minutes).
FROM oven/bun:1-debian

# 1. System deps (root): a real venv (image-gen SDKs) + curl/ca-certs/git.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Image-gen virtualenv — source-independent, so it caches across code changes.
#    openai is the default backend SDK; add gemini/replicate via the build arg,
#    e.g. --build-arg PIP_EXTRAS="google-genai".
ARG PIP_EXTRAS=""
RUN python3 -m venv /app/.venv-img \
    && /app/.venv-img/bin/pip install --no-cache-dir --upgrade pip \
    && /app/.venv-img/bin/pip install --no-cache-dir openai $PIP_EXTRAS

# 3. JS deps — depend ONLY on the manifests, so copy just those and install.
#    A source edit that doesn't touch package.json/bun.lock reuses this cache.
COPY .smithers/package.json .smithers/bun.lock /app/.smithers/
COPY discord/package.json  discord/bun.lock  /app/discord/
RUN cd /app/.smithers && bun install --frozen-lockfile || bun install
RUN cd /app/discord  && bun install --frozen-lockfile || bun install

# 4. App data dir + db symlink, then hand /app to the non-root user (root step).
#    smithers always writes smithers.db to its cwd (/app) with no override, so we
#    symlink it into the persisted /app/data volume — otherwise a run paused at a
#    QC gate is lost on restart. Both writer (CLI) and reader (bot) open the link.
ENV PROJECT_ROOT=/app
ENV BOT_DB=/app/data/state.db
RUN mkdir -p /app/data && ln -sf data/smithers.db /app/smithers.db \
    && chown -R bun:bun /app

# 5. Claude Code CLI + workspace trust, as the non-root bun user — also
#    source-independent, so it caches too. (Trust: recent Claude Code gates tool
#    use behind a flag that --dangerously-skip-permissions does NOT clear.)
USER bun
ENV HOME=/home/bun
ENV PATH="/home/bun/.local/bin:${PATH}"
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN bun -e 'const fs=require("fs"),f=process.env.HOME+"/.claude.json";let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}c.projects=c.projects||{};c.projects["/app"]={...(c.projects["/app"]||{}),hasTrustDialogAccepted:true};fs.writeFileSync(f,JSON.stringify(c,null,2))'

# 6. THE SOURCE — copied LAST, owned by bun. The ONLY layer a code edit
#    invalidates, so rebuilds after a change take seconds. (node_modules and
#    .venv-img are .dockerignored, so this doesn't clobber the cached installs.)
COPY --chown=bun:bun . /app

# Register slash commands (idempotent), then run the bridge.
CMD ["sh", "-c", "cd /app/discord && bun run register-commands.ts && exec bun run src/bot.ts"]

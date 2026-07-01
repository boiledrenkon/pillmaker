# Enhancement-product worker: the Discord bridge + the Smithers control plane it
# drives (process-per-step: `smithers up` / `up --resume`, no --serve).
#
#   docker build -t ep-worker .
#   docker run --env-file .env -v "$PWD/outputs:/app/outputs" ep-worker
# or just: docker compose up -d
#
# Auth: the compose/judge/generate agents ARE Claude Code — they shell out to the
# `claude` CLI installed below and authenticate headlessly via CLAUDE_CODE_OAUTH_TOKEN
# (mint it on your Mac with `claude setup-token`, put it in .env). Image generation
# uses the .venv-img virtualenv (gen_image.py invokes .venv-img/bin/python).
#
# Runs as the image's non-root `bun` user (uid 1000): Claude Code refuses
# `--dangerously-skip-permissions` (which the smithers agents require) under
# root, and non-root is the right security posture anyway.
FROM oven/bun:1-debian

# System deps (root): a real venv (image-gen SDKs) + curl/ca-certs/git (installer).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app

# Image-gen virtualenv, built FRESH in-image (the host's .venv-img is a different
# CPU arch and is .dockerignored). openai is the default backend SDK; add gemini/
# replicate via the build arg, e.g. --build-arg PIP_EXTRAS="google-genai".
ARG PIP_EXTRAS=""
RUN python3 -m venv /app/.venv-img \
    && /app/.venv-img/bin/pip install --no-cache-dir --upgrade pip \
    && /app/.venv-img/bin/pip install --no-cache-dir openai $PIP_EXTRAS

# JS deps for the Smithers project and the bridge.
RUN cd /app/.smithers && bun install --frozen-lockfile || bun install
RUN cd /app/discord  && bun install --frozen-lockfile || bun install

ENV PROJECT_ROOT=/app
ENV BOT_DB=/app/data/state.db
# smithers always writes smithers.db to its cwd (/app) with no env/flag override,
# so symlink it into the persisted /app/data volume — otherwise a run paused at a
# QC gate is lost when the container restarts. Both the CLI (writer) and the bot
# (reader) open /app/smithers.db → the real file lives in the volume. Its -wal/-shm
# land next to the resolved target, so they persist too.
RUN mkdir -p /app/data && ln -sf data/smithers.db /app/smithers.db \
    && chown -R bun:bun /app

# ── Everything below runs as the non-root `bun` user ─────────────────────────
USER bun
ENV HOME=/home/bun
ENV PATH="/home/bun/.local/bin:${PATH}"

# Claude Code CLI — every compose/judge/generate agent shells out to `claude`.
# Installed into the bun user's home so it runs non-root (root can't use the
# skip-permissions flag the agents pass).
RUN curl -fsSL https://claude.ai/install.sh | bash

# Trust the /app workspace so headless agents can run their bash tools (compose
# reads files, generate shells out to gen_image.py). Recent Claude Code gates
# tool use behind a workspace-trust flag that skip-permissions does NOT clear.
RUN bun -e 'const fs=require("fs"),f=process.env.HOME+"/.claude.json";let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}c.projects=c.projects||{};c.projects["/app"]={...(c.projects["/app"]||{}),hasTrustDialogAccepted:true};fs.writeFileSync(f,JSON.stringify(c,null,2))'

# Register slash commands (idempotent), then run the bridge.
CMD ["sh", "-c", "cd /app/discord && bun run register-commands.ts && exec bun run src/bot.ts"]

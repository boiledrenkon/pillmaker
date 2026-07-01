# Discord worker

A **worker** = the Discord bridge + the Smithers control plane it drives, co-located
in this repo and configured entirely by `.env`. Run it on your laptop to tinker,
or `docker compose up -d` on a VPS for an always-on version. Clone the repo with a
different `.env` to run a second worker (different Discord server / backend).

```
/concept slug:power_rod_11      → modal brief → thread → drop refs → ▶ Start
   #qc ▸ power_rod_11 thread
      ├─ 📝 Prompt QC     → Approve / Deny+note
      ├─ 🎨 generate       → (manual) drop the PNG here   ·  (api) auto
      └─ 🖼️ Image QC      → Approve / Deny+note
   #status   run lifecycle one-liners
   #outputs  accepted final images
```

## 1. Create the Discord app

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy → `DISCORD_BOT_TOKEN`.
3. Same tab → enable **MESSAGE CONTENT INTENT** (privileged). Required so the bot
   can see the PNG you drop during manual generation.
4. **General Information** → copy **Application ID** → `DISCORD_APP_ID`.
5. **OAuth2 → URL Generator**: scopes **`bot`** + **`applications.commands`**;
   bot permissions: **Send Messages, Create Public Threads, Send Messages in
   Threads, Embed Links, Attach Files, Read Message History, Use Application
   Commands**. Open the generated URL and invite the bot to your server.

## 2. Get the IDs

In Discord: **User Settings → Advanced → Developer Mode** on. Then right-click →
**Copy ID** for: your server (`DISCORD_GUILD_ID`) and three channels you create —
`#status`, `#qc`, `#outputs` (→ the three `*_CHANNEL_ID`s).

**Private channels:** the bot's role must be added to each channel's permissions
with **View Channel, Send Messages, Read Message History** (all three), plus
**Create Public Threads + Send Messages in Threads** on `#qc` and **Attach
Files** on `#outputs` and `#qc`. Channel-level overrides win over the server-wide
permissions from the invite, so adding the role per-channel is what actually
grants access.

## 3. Configure + install

```bash
./setup.sh --with-discord          # installs deps, prompts for keys + Discord IDs, writes .env
# (add --backend openai / gemini as needed)
```

**Agent auth (Claude Max subscription vs API key).** Smithers' compose/judge
agents *are* Claude Code, so they use whatever `claude` is logged in as:

- **Locally:** if you already use Claude Code, you're logged in — leave
  `ANTHROPIC_API_KEY` blank and the agents run on your Max subscription.
- **On a VPS:** the subscription login doesn't travel with the repo. After
  deploying, either run `claude` once on the box and complete the login flow, or
  generate a long-lived token on your laptop with `claude setup-token` and put it
  in the worker's environment. Both keep usage on your Max plan.
- **Or** set `ANTHROPIC_API_KEY` to bill the API directly instead.
- Heavy *parallel* runs draw down Max rate limits faster than the API; a few
  concepts at a time is fine.

Image-backend keys only matter if `BACKEND` isn't `manual`.

## Deploying to a VPS (Docker) — runbook

The worker runs as a non-root container; agents auth headlessly via
`CLAUDE_CODE_OAUTH_TOKEN` (mint with `claude setup-token`). Modest specs are fine
(1 vCPU / 2 GB / 20 GB+) — the LLM + image work is all remote API. **RAM is the
only constraint**: keep runs sequential and add swap.

**1. Prereqs on the VPS** — Docker Engine + the compose plugin:
```bash
curl -fsSL https://get.docker.com | sh
```

**2. Get the repo onto the box** (this project isn't in git — rsync it from your
Mac; over SSH so `.env` secrets stay encrypted):
```bash
# from the project root on your Mac:
rsync -av --delete \
  --exclude '.git' --exclude '**/node_modules' --exclude '.venv-img' \
  --exclude '**/smithers.db*' --exclude 'discord/state.db' --exclude 'discord/worker.log' \
  --exclude 'outputs/**/candidates' --exclude 'outputs/**/fail' --exclude '**/__pycache__' \
  ./ user@YOUR_VPS:/opt/dickpillnft/
```
Your local `.env` is already VPS-ready (has `CLAUDE_CODE_OAUTH_TOKEN`,
`BACKEND=openai`, `OPENAI_IMAGE_MODEL=gpt-image-2`), so it rsyncs across as-is.

**3. On the VPS**, prep and launch:
```bash
cd /opt/dickpillnft
# swap (insurance against agent RAM spikes on a 2 GB box):
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
# the ./outputs bind mount must be writable by the container's uid 1000:
mkdir -p outputs && sudo chown -R 1000:1000 outputs
# build + run (the image installs claude, the venv, deps; the CMD registers slash commands + starts the bot):
docker compose up -d --build
docker compose logs -f worker      # watch for: "Bridge online as …"
```

**4. Cutover** — one Discord bot token = one live bot. Once the VPS says
"Bridge online", stop the Mac worker so they don't collide:
```bash
# on your Mac:
launchctl unload ~/Library/LaunchAgents/com.dickpillnft.worker.plist
```

Ops on the VPS: `docker compose restart` (runs paused at a QC gate survive —
`smithers.db` + `state.db` are on the `worker-data` volume); `docker compose down`
to stop; `docker compose up -d --build` after an rsync of new code.

Per-concept reference images come from your Discord drops (saved under
`outputs/<slug>/ref_images/`). Image QC runs on the LLM judge alone.

## 4. Run

**Local (tinker):**
```bash
cd discord
bun run register      # register slash commands to your guild (re-run after editing them)
bun run start         # start the bridge
```

**VPS (always-on):**
```bash
docker compose up -d --build      # entrypoint registers commands, then runs the bridge
docker compose logs -f
```

## 5. Use it

- `/concept slug:power_rod_11 gender:male` → fill the brief → a `#qc` thread opens
  → drag reference images in → **▶ Start**.
- `/concept-json` → paste/attach a full concept (the `inputs/example-single.json`
  shape, or `{ "concepts": [ … ] }` for several).
- The brief is validated against the workflow's own schema **before** anything
  runs; bad input replies with exactly what's wrong and starts nothing.
- Approve/Deny each QC step in the thread (Deny opens a note box that feeds the
  revise/regenerate loop). For `manual` backend, drop the generated PNG in the
  thread when asked. Accepted images post to `#outputs` and land in
  `outputs/<slug>/`.
- `/status` lists active runs; `/cancel` (inside a thread) stops that run.

## Letting others request concepts (your IP stays private)

Outsiders can submit ideas without ever seeing how the workflow works — the
template, the QC, the reference library, the composed prompts all stay in
admin-only channels. They get back at most a finished image.

Set up:
1. Create a **role** for yourself/admins → `DISCORD_ADMIN_ROLE_ID`.
2. Create two more channels:
   - **`#requests`** (public — outsiders can post here) → `DISCORD_REQUESTS_CHANNEL_ID`
   - **`#intake`** (admin-only) → `DISCORD_INTAKE_CHANNEL_ID`
3. Keep `#qc` / `#status` / `#outputs` admin-only (outsiders must NOT see them).

Flow:
- An outsider runs **`/request idea:"neon arcade vibe…" [image1…]`** in `#requests`
  → they get "✅ submitted," nothing else.
- A card lands in **`#intake`** with **Approve / Reject** (only your admin role can
  click). **Approve** opens a modal where *you* turn the idea into a real brief
  (slug, name, theme, copy lines) → it runs privately in `#qc` exactly like
  `/concept`. Their reference images carry in automatically.
- The requester is **DM'd status only** (never the image): "approved, being
  created" on approval, "not picked up" on rejection. On completion the final
  image posts to the public **`#outputs` gallery** (credited `requested by @user`),
  and the requester gets a **follow-up DM with a link to that gallery post**. They
  never see how it was made.

`DISCORD_ADMIN_ROLE_ID` is **required** — the bot refuses to start without it and
admin actions deny by default (no un-gated mode). Even a solo worker needs an
admin role assigned to you. The `#requests`/`#intake` channels are optional: set
them only if you want outsiders to submit via `/request`; without them you just
use `/concept` yourself.

Accepted images always post to the `#outputs` gallery (credited "requested by
@user" when it came via `/request`). Make `#outputs` viewable by everyone but
postable only by admins + the bot. Requesters are DM'd status updates + a link to
their gallery post — never the image itself.

> ⚠️ Note: approved briefs drive **tool-enabled agents on your machine**. Only
> approve requests you're comfortable running, and keep the worker in its
> container. Approval is the trust boundary.

## How control flows (no workflow changes)

The bridge spawns one `smithers up <wf> --serve --supervise` process per run, polls
that run for pending approval gates (`/approvals`) and manual-gen requests
(`smithers human inbox`), mirrors them into the thread, and sends your decisions
back via the control-plane HTTP/CLI. The workflow's human layer is untouched —
Discord is purely a front-end onto the `Approval` / `HumanTask` nodes.

## ⚠️ One calibration pass on first live run

`discord/src/smithers.ts` maps a few JSON fields from your installed Smithers
version (pending-approval shape, `human inbox` JSON, run-status field). They're
marked `CALIBRATE`. On the very first live concept, run the bridge with
`DEBUG_SMITHERS=1` to log the raw payloads and adjust those small mappers if a
field name differs. Everything else (Discord UX, validation, file handling) is
version-independent.

## Cloning a second worker

Copy the repo (or just a second `.env`) with a different `DISCORD_*` (point at
another server) and/or `BACKEND`, then `docker compose up -d`. An `api` worker
generates images itself and uses Discord purely for QC — the `#qc` thread is
identical minus the "drop a PNG" step.

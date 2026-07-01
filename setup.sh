#!/usr/bin/env bash
# Portable setup for the enhancement-product workflow worker.
# Runs on macOS and Ubuntu/Linux. Installs Bun, the Smithers deps, optional
# Python backend deps, and writes a .env with your API keys.
#
#   ./setup.sh                       # interactive: installs base, prompts for keys
#   ./setup.sh --backend gemini      # also installs the Gemini SDK
#   ./setup.sh --non-interactive \   # CI / scripted: take keys from flags/env
#       --anthropic-key "$ANTHROPIC_API_KEY" --backend openai --openai-key "$OPENAI_API_KEY"
#
# Idempotent: safe to re-run. Never overwrites an existing key in .env unless you
# pass a new value for it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── pretty output ────────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; Y=; R=; N=; fi
say()  { printf '%s\n' "${B}==>${N} $*"; }
ok()   { printf '%s\n' "  ${G}ok${N} $*"; }
warn() { printf '%s\n' "  ${Y}!!${N} $*"; }
die()  { printf '%s\n' "  ${R}xx${N} $*" >&2; exit 1; }

# ── args ─────────────────────────────────────────────────────────────────────
BACKEND="manual"; INTERACTIVE=1; WITH_DISCORD=0
ANTHROPIC_KEY=""; OPENAI_KEY=""; GEMINI_KEY=""; REPLICATE_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --backend) BACKEND="$2"; shift 2;;
    --with-discord) WITH_DISCORD=1; shift;;
    --non-interactive) INTERACTIVE=0; shift;;
    --anthropic-key) ANTHROPIC_KEY="$2"; shift 2;;
    --openai-key) OPENAI_KEY="$2"; shift 2;;
    --gemini-key) GEMINI_KEY="$2"; shift 2;;
    --replicate-key) REPLICATE_KEY="$2"; shift 2;;
    -h|--help) sed -n '2,16p' "$0"; exit 0;;
    *) die "unknown arg: $1";;
  esac
done
case "$BACKEND" in manual|openai|gemini|replicate) ;; *) die "bad --backend: $BACKEND";; esac

OS="$(uname -s)"
say "Setup for worker ($OS, backend=$BACKEND)"

# ── 1. Bun ───────────────────────────────────────────────────────────────────
if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version)"
else
  say "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || die "bun install failed"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"; export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || die "bun not on PATH; open a new shell and re-run"
  ok "bun $(bun --version) (add \$HOME/.bun/bin to your PATH)"
fi

# ── 2. Python ────────────────────────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
  ok "python $(python3 --version 2>&1 | awk '{print $2}')"
else
  case "$OS" in
    Darwin) die "python3 not found — install with: brew install python";;
    Linux)  die "python3 not found — install with: sudo apt-get install -y python3 python3-venv python3-pip";;
    *) die "python3 not found";;
  esac
fi

# ── 3. Smithers deps ─────────────────────────────────────────────────────────
if [ -d .smithers ]; then
  say "Installing Smithers deps (.smithers)…"
  ( cd .smithers && bun install >/dev/null 2>&1 ) && ok "smithers deps installed" || warn "bun install in .smithers had warnings"
else
  warn ".smithers/ not found — run 'bunx smithers-orchestrator init' first"
fi

# ── 3b. Discord bridge deps ──────────────────────────────────────────────────
if [ "$WITH_DISCORD" -eq 1 ] && [ -d discord ]; then
  say "Installing Discord bridge deps (discord/)…"
  ( cd discord && bun install >/dev/null 2>&1 ) && ok "discord deps installed" || warn "bun install in discord had warnings"
fi

# ── 4. Python tool deps (optional) ───────────────────────────────────────────
# preflight.py is stdlib-only; the manual backend needs nothing here.
NEED_VENV=0
[ "$BACKEND" != "manual" ] && NEED_VENV=1
if [ "$NEED_VENV" -eq 1 ]; then
  say "Setting up Python venv (.venv) for backend deps…"
  python3 -m venv .venv || die "venv creation failed (Ubuntu: sudo apt-get install python3-venv)"
  # shellcheck disable=SC1091
  . .venv/bin/activate
  python3 -m pip install --upgrade pip >/dev/null 2>&1 || true
  case "$BACKEND" in
    openai)    pip install openai >/dev/null 2>&1 && ok "openai SDK";;
    gemini)    pip install google-genai >/dev/null 2>&1 && ok "google-genai SDK";;
    replicate) pip install replicate requests >/dev/null 2>&1 && ok "replicate SDK";;
  esac
  deactivate || true
else
  ok "no extra Python deps needed for backend=manual"
fi

# ── 5. .env with API keys ────────────────────────────────────────────────────
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example"; }

# set_key KEY VALUE : write/replace KEY=VALUE in .env (only if VALUE non-empty)
set_key() {
  key="$1"; val="$2"
  [ -z "$val" ] && return 0
  if grep -q "^${key}=" .env; then
    tmp="$(mktemp)"; grep -v "^${key}=" .env > "$tmp"; mv "$tmp" .env
  fi
  printf '%s=%s\n' "$key" "$val" >> .env
  ok "set $key"
}

prompt_secret() { # var prompt
  printf '  %s' "$2"; stty -echo 2>/dev/null || true; read -r _v; stty echo 2>/dev/null || true; printf '\n'
  eval "$1=\$_v"
}

prompt_plain() { # var prompt
  printf '  %s' "$2"; read -r _v; eval "$1=\$_v"
}

if [ "$INTERACTIVE" -eq 1 ]; then
  say "API keys (press Enter to skip / keep existing)"
  [ -z "$ANTHROPIC_KEY" ] && prompt_secret ANTHROPIC_KEY "ANTHROPIC_API_KEY (blank if Claude Code is already logged in): "
  case "$BACKEND" in
    openai)    [ -z "$OPENAI_KEY" ]    && prompt_secret OPENAI_KEY    "OPENAI_API_KEY: ";;
    gemini)    [ -z "$GEMINI_KEY" ]    && prompt_secret GEMINI_KEY    "GEMINI_API_KEY: ";;
    replicate) [ -z "$REPLICATE_KEY" ] && prompt_secret REPLICATE_KEY "REPLICATE_API_TOKEN: ";;
  esac
fi

set_key ANTHROPIC_API_KEY   "$ANTHROPIC_KEY"
set_key OPENAI_API_KEY      "$OPENAI_KEY"
set_key GEMINI_API_KEY      "$GEMINI_KEY"
set_key REPLICATE_API_TOKEN "$REPLICATE_KEY"
set_key BACKEND             "$BACKEND"

# ── 5b. Discord bridge config ────────────────────────────────────────────────
if [ "$WITH_DISCORD" -eq 1 ] && [ "$INTERACTIVE" -eq 1 ]; then
  say "Discord bridge (see WORKER.md for where to find these; Enter to skip)"
  prompt_secret DTOKEN "DISCORD_BOT_TOKEN: ";        set_key DISCORD_BOT_TOKEN "$DTOKEN"
  prompt_plain  DAPP   "DISCORD_APP_ID: ";           set_key DISCORD_APP_ID "$DAPP"
  prompt_plain  DGUILD "DISCORD_GUILD_ID: ";         set_key DISCORD_GUILD_ID "$DGUILD"
  prompt_plain  DROLE  "DISCORD_ADMIN_ROLE_ID (required — bot won't start without it): "; set_key DISCORD_ADMIN_ROLE_ID "$DROLE"
  prompt_plain  DST    "DISCORD_STATUS_CHANNEL_ID: ";set_key DISCORD_STATUS_CHANNEL_ID "$DST"
  prompt_plain  DQC    "DISCORD_QC_CHANNEL_ID: ";    set_key DISCORD_QC_CHANNEL_ID "$DQC"
  prompt_plain  DOUT   "DISCORD_OUTPUTS_CHANNEL_ID: ";set_key DISCORD_OUTPUTS_CHANNEL_ID "$DOUT"
  say "Request-intake flow (optional — set only to let outsiders submit via /request)"
  prompt_plain  DREQ   "DISCORD_REQUESTS_CHANNEL_ID: ";set_key DISCORD_REQUESTS_CHANNEL_ID "$DREQ"
  prompt_plain  DINT   "DISCORD_INTAKE_CHANNEL_ID: ";  set_key DISCORD_INTAKE_CHANNEL_ID "$DINT"
fi

# ── done ─────────────────────────────────────────────────────────────────────
say "Done. Next:"
printf '  • validate the graph:  %s\n' "bunx smithers-orchestrator graph .smithers/workflows/enhancement-product.tsx --input \"\$(cat inputs/example-single.json)\""
printf '  • preflight the backend: %s\n' "python3 tools/preflight.py --backend $BACKEND"
printf '  • run one concept:     %s\n' "bunx smithers-orchestrator up .smithers/workflows/enhancement-product.tsx --input \"\$(cat inputs/example-single.json)\""

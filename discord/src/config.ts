// Worker/bridge configuration, entirely from environment (see .env.example).
// The bridge is co-located with the Smithers project: PROJECT_ROOT is the repo
// root that holds .smithers/, tools/, config/, outputs/.
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// PROJECT_ROOT defaults to the parent of discord/ (i.e. the repo root).
export const PROJECT_ROOT = resolve(process.env.PROJECT_ROOT ?? resolve(import.meta.dir, "..", ".."));

// Load the project-root .env so the bridge works regardless of the launch dir
// (e.g. `cd discord && bun run start`). Real env vars (Docker/compose) win.
const envFile = resolve(PROJECT_ROOT, ".env");
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, dflt = ""): string {
  return process.env[name] ?? dflt;
}

export const config = {
  projectRoot: PROJECT_ROOT,
  workflowPath: resolve(PROJECT_ROOT, ".smithers/workflows/enhancement-product.tsx"),
  // Smithers' own durable workspace DB (written by run processes at the project
  // root). The bridge reads it directly to detect gates and terminal state —
  // the HTTP serve API does not resume on approval, so we drive runs via the
  // durable DB + `approve`/`resume` CLI instead.
  smithersDbPath: resolve(PROJECT_ROOT, opt("SMITHERS_DB", "smithers.db")),

  // Discord
  botToken: req("DISCORD_BOT_TOKEN"),
  appId: req("DISCORD_APP_ID"),
  guildId: req("DISCORD_GUILD_ID"),
  channels: {
    status: req("DISCORD_STATUS_CHANNEL_ID"),
    qc: req("DISCORD_QC_CHANNEL_ID"),
    outputs: req("DISCORD_OUTPUTS_CHANNEL_ID"),
    // Optional request-intake flow (outsiders submit ideas; admins approve).
    requests: opt("DISCORD_REQUESTS_CHANNEL_ID"), // public: where /request is used
    intake: opt("DISCORD_INTAKE_CHANNEL_ID"),     // admin-only: approve/reject queue
  },
  // REQUIRED. Only members with this role may approve/reject and use admin
  // commands; outsiders get /request only. The bot refuses to start without it,
  // and admin actions deny by default — there is no un-gated mode.
  adminRoleId: req("DISCORD_ADMIN_ROLE_ID"),

  // Worker identity / run defaults
  workerName: opt("WORKER_NAME", "worker"),
  backend: opt("BACKEND", "manual") as "manual" | "openai" | "gemini" | "replicate",
  promptQc: opt("PROMPT_QC", "both"),
  imageQc: opt("IMAGE_QC", "both"),
  maxAttempts: Number(opt("MAX_ATTEMPTS", "3")),
  // Speed: judge + compose default to Sonnet (≈2× faster than Opus, plenty for
  // the rubric judge).
  composeModel: opt("COMPOSE_MODEL", "claudeSonnet"),       // compose revisions
  composeFirstModel: opt("COMPOSE_FIRST_MODEL", "claudeOpus"), // first compose = Opus quality
  judgeModel: opt("JUDGE_MODEL", "claudeSonnet"),
  // Mechanical tool tasks (run the generator command, finalize files): cheap+fast.
  toolModel: opt("TOOL_MODEL", "claudeSonnet"),

  // Request-intake auto-expansion: when an admin approves a loose /request, a
  // one-shot `claude -p` call authors a full concept (name/theme/tagline/copy)
  // to pre-fill the review modal. Uses the logged-in CLI (Max), no API key.
  expandCmd: opt("EXPAND_CMD", "claude"),
  expandModel: opt("EXPAND_MODEL", "claude-sonnet-4-6"),

  // Smithers control plane
  bearerToken: opt("SMITHERS_BEARER_TOKEN", ""),
  basePort: Number(opt("SMITHERS_PORT", "7331")),
  smithersCmd: opt("SMITHERS_CMD", "bunx smithers-orchestrator").split(" "),
  pollMs: Number(opt("POLL_MS", "3000")),
  // Stall watchdog: flag a running (non-gated) run with no events/heartbeat for
  // this many minutes as possibly hung. Generate+judge steps are well under this.
  stallMin: Number(opt("STALL_MIN", "8")),
  // Hard kill: auto-cancel a run idle this long (no gate, no live process) — a
  // zombie (e.g. its process died on a restart) that will never self-resolve.
  // Must exceed the longest legit heartbeat window (~10min) with margin. 0 = off.
  killMin: Number(opt("KILL_MIN", "30")),

  // Local store (override with BOT_DB to point at a mounted volume)
  dbPath: resolve(opt("BOT_DB", resolve(import.meta.dir, "..", "state.db"))),
} as const;

export type Config = typeof config;

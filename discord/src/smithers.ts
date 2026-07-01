// Transport to the Smithers control plane.
//
// ⚠️ We do NOT use the HTTP serve API. It has a fatal gap for our use case:
// `POST /approve` records the decision durably (approveNode) but nothing
// re-renders the run — `--serve --supervise` only auto-resumes on crash/
// heartbeat-timeout, not on an approval grant. The run flips to a `waiting-event`
// zombie and never advances. The CLI itself says "resume the run to continue".
//
// So we drive runs the durable way, process-per-step:
//   • start a run            → `up <wf> --run-id X --input …`  (runs to the
//                              first gate, then exits; exit 3 = paused)
//   • detect open gates       → read the event stream in smithers.db
//                              (NodeWaitingApproval open → ApprovalGranted/Denied
//                               resolved). Covers BOTH <Approval> and <HumanTask>
//                               — the manual-gen step is an approval gate too.
//   • show the prompt/image   → read the per-schema output tables (compose, …)
//   • approve / deny a gate   → `approve|deny --node … [--note …]` then `up --resume`
//   • detect terminal         → _smithers_runs.status
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { config } from "./config";

const DEBUG = process.env.DEBUG_SMITHERS === "1";
const dbg = (...a: any[]) => DEBUG && console.log("[smithers]", ...a);

// On a fresh deploy no run has created smithers.db yet, so a read-only open would
// throw SQLITE_CANTOPEN and crash-loop the bot. Initialize an empty (valid) DB
// first if it's missing; smithers populates its tables on the first run.
if (!existsSync(config.smithersDbPath)) new Database(config.smithersDbPath, { create: true }).close();

// Read-only handle on Smithers' durable workspace DB. SQLite WAL allows readers
// concurrent with the run processes that write it.
const sdb = new Database(config.smithersDbPath, { readonly: true });

// ── shell out to the smithers CLI ────────────────────────────────────────────
function sh(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const [cmd, ...base] = config.smithersCmd;
  return new Promise((res) => {
    const p = spawn(cmd, [...base, ...args], { cwd: config.projectRoot, env: process.env });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code: code ?? -1, out, err }));
  });
}

// Fire-and-forget a long-running `up`/`up --resume`. The process renders to the
// next gate (or completion) and exits; the bridge observes progress via the DB.
function spawnDetached(args: string[]): void {
  const [cmd, ...base] = config.smithersCmd;
  dbg("spawn", [...base, ...args].join(" "));
  const p = spawn(cmd, [...base, ...args], {
    cwd: config.projectRoot,
    env: process.env,
    stdio: DEBUG ? "inherit" : "ignore",
    detached: false,
  });
  p.on("close", (code) => dbg("exited", args[0], args.includes("--resume") ? "(resume)" : "", "code", code));
}

// ── run lifecycle ────────────────────────────────────────────────────────────
/** Start a run. Renders to the first gate, then exits (no serve). */
export function startRun(runId: string, inputJson: string): void {
  spawnDetached(["up", config.workflowPath, "--run-id", runId, "--input", inputJson]);
}

/** Resume a paused run after a decision was recorded. Advances to the next gate. */
export function resume(runId: string, inputJson: string): void {
  spawnDetached(["up", config.workflowPath, "--resume", "--run-id", runId, "--input", inputJson]);
}

/** Reopen a stopped/cancelled run: force a resume back to its current open gate. */
export function reopen(runId: string, inputJson: string): void {
  spawnDetached(["up", config.workflowPath, "--resume", "--run-id", runId, "--force", "--input", inputJson]);
}

/** Best-effort cancel (marks the run cancelled in the DB). */
export async function cancel(runId: string): Promise<void> {
  await sh(["cancel", runId]);
}

// ── detection (read straight from smithers.db) ───────────────────────────────
export type GateKind = "prompt" | "image" | "generate";
export type Gate = { nodeId: string; iteration: number; kind: GateKind; slug: string };

function gateKind(nodeId: string): GateKind | null {
  if (nodeId.endsWith(":approve-prompt")) return "prompt";
  if (nodeId.endsWith(":approve-image")) return "image";
  if (nodeId.endsWith(":generate")) return "generate";
  return null;
}
function slugOf(nodeId: string): string {
  return nodeId.includes(":") ? nodeId.slice(0, nodeId.indexOf(":")) : nodeId;
}

/**
 * Open gates for a run: nodes whose latest gate event is NodeWaitingApproval
 * (i.e. not yet Granted/Denied). Event-sourced so it's correct across loop
 * iterations and survives process restarts.
 */
export function openGates(runId: string): Gate[] {
  const rows = sdb
    .query(
      `WITH ev AS (
         SELECT json_extract(payload_json,'$.nodeId') AS node_id,
                COALESCE(json_extract(payload_json,'$.iteration'),0) AS iteration,
                type, seq,
                ROW_NUMBER() OVER (
                  PARTITION BY json_extract(payload_json,'$.nodeId'),
                               COALESCE(json_extract(payload_json,'$.iteration'),0)
                  ORDER BY seq DESC
                ) AS rn
         FROM _smithers_events
         WHERE run_id = ?
           AND type IN ('NodeWaitingApproval','ApprovalGranted','ApprovalDenied')
       )
       SELECT node_id, iteration FROM ev WHERE rn = 1 AND type = 'NodeWaitingApproval'`,
    )
    .all(runId) as { node_id: string; iteration: number }[];
  const gates: Gate[] = [];
  for (const r of rows) {
    const kind = gateKind(r.node_id);
    if (kind) gates.push({ nodeId: r.node_id, iteration: r.iteration, kind, slug: slugOf(r.node_id) });
  }
  return gates;
}

/** Latest composed prompt for a concept (shown on the prompt-QC + manual-gen cards). */
export function composedPrompt(runId: string): string | null {
  const row = sdb
    .query(`SELECT prompt FROM compose WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`)
    .get(runId) as { prompt: string } | null;
  return row?.prompt ?? null;
}

/** Latest image-QC rejection (issues + suggestions), or null if the last verdict
 *  wasn't a reject — used to tell the user WHY a dropped image bounced. */
export function lastImageReject(runId: string): { issues: string[]; suggestions: string } | null {
  const row = sdb
    .query(`SELECT verdict, issues, suggestions FROM image_judge WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`)
    .get(runId) as { verdict: string; issues: string | null; suggestions: string | null } | null;
  if (!row || row.verdict !== "reject") return null;
  let issues: string[] = [];
  try { issues = JSON.parse(row.issues ?? "[]"); } catch { issues = row.issues ? [row.issues] : []; }
  return { issues, suggestions: row.suggestions ?? "" };
}

// ── observability: progress rows + liveness + snapshot ───────────────────────
/** Most recent activity timestamp (ms) for a run: max of its last event and the
 *  run heartbeat. 0 if unknown. Used by the stall watchdog. */
export function lastActivityMs(runId: string): number {
  const ev = sdb.query(`SELECT MAX(timestamp_ms) m FROM _smithers_events WHERE run_id=?`).get(runId) as { m: number | null } | null;
  const hb = sdb.query(`SELECT heartbeat_at_ms h FROM _smithers_runs WHERE run_id=?`).get(runId) as { h: number | null } | null;
  return Math.max(ev?.m ?? 0, hb?.h ?? 0);
}

export type GenRow = { iteration: number; ok: number; image_path: string | null };
export function generateRows(runId: string): GenRow[] {
  return sdb.query(`SELECT iteration, ok, image_path FROM generate WHERE run_id=? ORDER BY iteration`).all(runId) as GenRow[];
}
export type JudgeRow = { iteration: number; verdict: string; issues: string | null };
export function imageJudgeRows(runId: string): JudgeRow[] {
  return sdb.query(`SELECT iteration, verdict, issues FROM image_judge WHERE run_id=? ORDER BY iteration`).all(runId) as JudgeRow[];
}
export function promptJudgeRows(runId: string): JudgeRow[] {
  return sdb.query(`SELECT iteration, verdict, issues FROM prompt_judge WHERE run_id=? ORDER BY iteration`).all(runId) as JudgeRow[];
}

/** A compact health snapshot for /status. */
export type Snapshot = {
  status: string;
  composes: number;
  attempts: number;
  lastImageJudge: { iteration: number; verdict: string } | null;
  lastPromptJudge: { iteration: number; verdict: string } | null;
};
export function runSnapshot(runId: string): Snapshot {
  const status = (sdb.query(`SELECT status FROM _smithers_runs WHERE run_id=?`).get(runId) as { status: string } | null)?.status ?? "unknown";
  const composes = (sdb.query(`SELECT COUNT(*) c FROM compose WHERE run_id=?`).get(runId) as { c: number }).c;
  const attempts = (sdb.query(`SELECT COUNT(*) c FROM generate WHERE run_id=? AND ok=1`).get(runId) as { c: number }).c;
  const li = sdb.query(`SELECT iteration, verdict FROM image_judge WHERE run_id=? ORDER BY iteration DESC LIMIT 1`).get(runId) as { iteration: number; verdict: string } | null;
  const lp = sdb.query(`SELECT iteration, verdict FROM prompt_judge WHERE run_id=? ORDER BY iteration DESC LIMIT 1`).get(runId) as { iteration: number; verdict: string } | null;
  return { status, composes, attempts, lastImageJudge: li ?? null, lastPromptJudge: lp ?? null };
}

/** Latest accepted/candidate image path the workflow recorded for a concept. */
export function lastImagePath(runId: string): string | null {
  const row = sdb
    .query(`SELECT image_path FROM generate WHERE run_id = ? ORDER BY iteration DESC LIMIT 1`)
    .get(runId) as { image_path: string | null } | null;
  return row?.image_path ?? null;
}

const TERMINAL = new Set(["finished", "completed", "succeeded", "failed", "error", "cancelled", "canceled"]);
export type RunState = "active" | "completed" | "failed" | "cancelled" | "unknown";

/** Terminal state of a run from _smithers_runs.status, or "active"/"unknown". */
export function runState(runId: string): RunState {
  const row = sdb.query(`SELECT status FROM _smithers_runs WHERE run_id = ?`).get(runId) as { status: string } | null;
  if (!row) return "unknown";
  const s = row.status.toLowerCase();
  if (!TERMINAL.has(s)) return "active";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "completed";
}

// ── actions: record decision durably, then advance the run ───────────────────
/** Approve a gate, then resume so the run renders the next step. */
export async function approve(runId: string, nodeId: string, iteration: number, inputJson: string, by: string, note = ""): Promise<void> {
  const args = ["approve", runId, "--node", nodeId, "--iteration", String(iteration), "--by", by];
  if (note) args.push("--note", note);
  const r = await sh(args);
  dbg("approve", nodeId, "code", r.code, r.err || "");
  resume(runId, inputJson);
}

/** Deny a gate, then resume. For <HumanTask> (generate) prefer submitGenerated. */
export async function deny(runId: string, nodeId: string, iteration: number, inputJson: string, by: string, note = ""): Promise<void> {
  const args = ["deny", runId, "--node", nodeId, "--iteration", String(iteration), "--by", by];
  if (note) args.push("--note", note);
  const r = await sh(args);
  dbg("deny", nodeId, "code", r.code, r.err || "");
  resume(runId, inputJson);
}

/**
 * Resolve the manual-gen <HumanTask>. It's backed by a durable *human request*
 * (id = `human:<runId>:<nodeId>:<iteration>`); the node only dispatches once that
 * request is answered — granting the approval alone does NOT un-stick it. So we
 * `human answer` with the structured value, then resume to run image QC.
 * (`human answer` also satisfies the decision gate, so no separate approve.)
 */
export async function submitGenerated(
  runId: string,
  nodeId: string,
  iteration: number,
  inputJson: string,
  by: string,
  answer: { slug: string; imagePath: string | null; ok: boolean; note?: string },
): Promise<void> {
  const requestId = `human:${runId}:${nodeId}:${iteration}`;
  const r = await sh(["human", "answer", requestId, "--value", JSON.stringify(answer), "--by", by]);
  dbg("human answer", requestId, "code", r.code, r.err || "");
  resume(runId, inputJson);
}

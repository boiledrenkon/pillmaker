// Tiny durable state for the bridge: which run maps to which thread, what we've
// already posted (so polling doesn't double-post), and pending /concept intakes
// awaiting their "Start" click. Uses bun:sqlite — no extra dependency.
import { Database } from "bun:sqlite";
import { config } from "./config";

const db = new Database(config.dbPath, { create: true });
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    runId TEXT PRIMARY KEY, slug TEXT, threadId TEXT, port INTEGER,
    status TEXT DEFAULT 'active', requesterId TEXT, inputJson TEXT, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS posts ( key TEXT PRIMARY KEY );
  CREATE TABLE IF NOT EXISTS intake ( token TEXT PRIMARY KEY, json TEXT, createdAt INTEGER );
  CREATE TABLE IF NOT EXISTS msgrefs ( key TEXT PRIMARY KEY, channelId TEXT, messageId TEXT );
`);
// migrate older DBs that predate these columns
try { db.exec(`ALTER TABLE runs ADD COLUMN requesterId TEXT`); } catch {}
try { db.exec(`ALTER TABLE runs ADD COLUMN inputJson TEXT`); } catch {}

export type RunRow = { runId: string; slug: string; threadId: string; port: number; status: string; requesterId: string | null; inputJson: string | null };

export const store = {
  addRun(r: Omit<RunRow, "status" | "requesterId" | "inputJson"> & { requesterId?: string | null; inputJson?: string | null }) {
    db.query(
      `INSERT OR REPLACE INTO runs (runId, slug, threadId, port, status, requesterId, inputJson, createdAt)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(r.runId, r.slug, r.threadId, r.port, r.requesterId ?? null, r.inputJson ?? null, Date.now());
  },
  setRunStatus(runId: string, status: string) {
    db.query(`UPDATE runs SET status = ? WHERE runId = ?`).run(status, runId);
  },
  activeRuns(): RunRow[] {
    return db.query(`SELECT * FROM runs WHERE status = 'active'`).all() as RunRow[];
  },
  runByThread(threadId: string): RunRow | null {
    return (db.query(`SELECT * FROM runs WHERE threadId = ?`).get(threadId) as RunRow) ?? null;
  },
  runById(runId: string): RunRow | null {
    return (db.query(`SELECT * FROM runs WHERE runId = ?`).get(runId) as RunRow) ?? null;
  },
  runBySlug(slug: string): RunRow | null {
    return (db.query(`SELECT * FROM runs WHERE slug = ? ORDER BY createdAt DESC`).get(slug) as RunRow) ?? null;
  },
  shelvedRuns(): RunRow[] {
    return db.query(`SELECT * FROM runs WHERE status = 'shelved' ORDER BY createdAt DESC`).all() as RunRow[];
  },
  // Hard discard: drop a run's Discord-side recovery handle (its row + every
  // card marker) so it can no longer be found or reopened from Discord.
  purgeRun(runId: string): void {
    db.query(`DELETE FROM runs WHERE runId = ?`).run(runId);
    db.query(`DELETE FROM posts WHERE key LIKE '%' || ? || '%'`).run(runId);
    db.query(`DELETE FROM msgrefs WHERE key LIKE '%' || ? || '%'`).run(runId);
  },
  // Reopen helper: drop a run's card markers (NOT the row) so its open-gate card
  // re-posts on the next tick.
  clearMarks(runId: string): void {
    db.query(`DELETE FROM posts WHERE key LIKE '%' || ? || '%'`).run(runId);
    db.query(`DELETE FROM msgrefs WHERE key LIKE '%' || ? || '%'`).run(runId);
  },

  // dedupe markers: returns true the FIRST time a key is seen, false after.
  firstSeen(key: string): boolean {
    const exists = db.query(`SELECT 1 FROM posts WHERE key = ?`).get(key);
    if (exists) return false;
    db.query(`INSERT INTO posts (key) VALUES (?)`).run(key);
    return true;
  },
  hasSeen(key: string): boolean {
    return !!db.query(`SELECT 1 FROM posts WHERE key = ?`).get(key);
  },
  mark(key: string): void {
    db.query(`INSERT OR IGNORE INTO posts (key) VALUES (?)`).run(key);
  },

  // remember a posted message so we can strip its (now-stale) buttons later
  saveMsgRef(key: string, channelId: string, messageId: string) {
    db.query(`INSERT OR REPLACE INTO msgrefs (key, channelId, messageId) VALUES (?, ?, ?)`).run(key, channelId, messageId);
  },
  takeMsgRef(key: string): { channelId: string; messageId: string } | null {
    const row = db.query(`SELECT channelId, messageId FROM msgrefs WHERE key = ?`).get(key) as { channelId: string; messageId: string } | null;
    if (row) db.query(`DELETE FROM msgrefs WHERE key = ?`).run(key);
    return row ?? null;
  },

  // pending /concept intake (between modal submit and Start click)
  saveIntake(token: string, data: unknown) {
    db.query(`INSERT OR REPLACE INTO intake (token, json, createdAt) VALUES (?, ?, ?)`)
      .run(token, JSON.stringify(data), Date.now());
  },
  takeIntake<T>(token: string): T | null {
    const row = db.query(`SELECT json FROM intake WHERE token = ?`).get(token) as { json: string } | null;
    if (!row) return null;
    db.query(`DELETE FROM intake WHERE token = ?`).run(token);
    return JSON.parse(row.json) as T;
  },
};

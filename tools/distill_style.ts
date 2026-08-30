#!/usr/bin/env bun
// Distill one influence LENS (config/influences/<lens>/) into its sensibility
// document (config/lenses/<lens>.md) — a workflow-level style lens that compose
// and the judges read as ADVISORY guidance (see product-compose.mdx).
//
// A lens = one coherent taste, distilled from a canon of influential works.
// Keep several (shadows, pulp-neon, …) and pick one per run: the bot selects
// via the STYLE_LENS env; CLI runs pass stylePhilosophyPath in the input JSON.
// A "mix" of lenses is just a new lens whose canon lists the union — the
// distillation pass is what makes the combination coherent.
//
// Runs a one-shot `claude -p` against the logged-in CLI — same engine the
// workflow's agents use, so no API key is needed (pattern from
// discord/src/expand.ts). Distillation is rare and taste-sensitive, so it
// defaults to the Opus model the workflow uses for first-compose.
//
//   bun tools/distill_style.ts <lens>           # writes config/lenses/<lens>.proposed.md if the target exists
//   bun tools/distill_style.ts <lens> --force   # overwrite config/lenses/<lens>.md
//
// Env: DISTILL_CMD (default "claude"), DISTILL_MODEL (default "claude-opus-4-8").
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INFLUENCES_DIR = join(ROOT, "config/influences");
const LENSES_DIR = join(ROOT, "config/lenses");
const TEXT_CAP = 20_000; // chars per excerpt file fed to the distiller

const lens = (process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "").replace(/[^A-Za-z0-9_-]/g, "");
if (!lens) {
  let available: string[] = [];
  try { available = readdirSync(INFLUENCES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  console.error("Usage: bun tools/distill_style.ts <lens> [--force]");
  console.error(available.length ? `Available lenses: ${available.join(", ")}` : `No lens folders under ${INFLUENCES_DIR} yet — create config/influences/<lens>/canon.md first.`);
  process.exit(1);
}
const CANON = join(INFLUENCES_DIR, lens, "canon.md");
const TEXTS_DIR = join(INFLUENCES_DIR, lens, "texts");
const OUT = join(LENSES_DIR, `${lens}.md`);
const PROPOSED = join(LENSES_DIR, `${lens}.proposed.md`);

const SYSTEM = `You are distilling an art director's INFLUENCE CANON — works that shaped
their taste, with their notes on what resonates — into a short SENSIBILITY
DOCUMENT for a packaging art-direction pipeline. The document tilts how every
package in a product line is art-directed. It is a lens, never a checklist.

Write 150-250 words of transferable aesthetic principles, as short markdown
paragraphs or bullets, covering (where the canon speaks to them): palette &
light, material & finish, typography & lettering, composition, and overall
temperament.

Hard rules:
- CARRY THE SENSIBILITY, NEVER THE SETTING. No principle may name any source's
  subject matter, era, place, culture, or medium. A reader must not be able to
  guess what the source works were about.
- Phrase every principle POSITIVELY — name what to prize and reach for, never
  "avoid X" or "no Y" (downstream image models ignore negations).
- Plain descriptive prose only. No slogans, no ALL-CAPS phrases, nothing
  quotable enough to be mistaken for on-pack copy.
- Honor the owner's "what resonates" notes over your own reading of a work —
  they pick the thread that matters.
- If the canon holds several influences, melt them into ONE coherent taste —
  a single voice, not a per-work list.

Output ONLY the document body in markdown. No title, no preamble, no code
fences, and no meta-commentary about the canon or its files — begin directly
with the first principle.`;

function runClaude(prompt: string, timeoutMs = 240_000): Promise<string> {
  const cmd = process.env.DISTILL_CMD ?? "claude";
  const model = process.env.DISTILL_MODEL ?? "claude-opus-4-8";
  const args = ["-p", prompt, "--model", model, "--output-format", "text"];
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); rej(new Error("distill timed out")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); rej(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res(out.trim());
      else rej(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

// --- gather the lens's canon ---
if (!existsSync(CANON)) {
  console.error(`No canon found at ${CANON} — write the lens's influences there first.`);
  process.exit(1);
}
const canon = readFileSync(CANON, "utf8");

let excerpts = "";
const textFiles: string[] = [];
try {
  for (const f of readdirSync(TEXTS_DIR).sort()) {
    if (/^readme/i.test(f) || f.startsWith(".")) continue;
    const full = readFileSync(join(TEXTS_DIR, f), "utf8");
    const clipped = full.length > TEXT_CAP;
    textFiles.push(f);
    excerpts += `\n\n### Excerpt file: ${f}${clipped ? ` (first ${TEXT_CAP} chars of ${full.length})` : ""}\n\n${full.slice(0, TEXT_CAP)}`;
  }
} catch {}

const user = [
  "## The canon (works + the owner's notes on what resonates)",
  "",
  canon,
  excerpts ? `\n## Full texts / excerpts supplied by the owner${excerpts}` : "",
].join("\n");

// --- distill ---
console.log(`Distilling lens "${lens}" (${textFiles.length ? `canon.md + ${textFiles.length} excerpt file(s)` : "canon.md"}) with ${process.env.DISTILL_MODEL ?? "claude-opus-4-8"}…`);
const body = await runClaude(`${SYSTEM}\n\n---\n\n${user}`);
if (!body) {
  console.error("Distillation returned nothing — not writing.");
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const sources = ["canon.md", ...textFiles].join(", ");
const doc = `<!-- Distilled sensibility — the "${lens}" style lens, injected into compose +
     judges as ADVISORY guidance when a run selects it (STYLE_LENS env on the
     bot, or stylePhilosophyPath in the input JSON).
     Generated ${date} by tools/distill_style.ts from config/influences/${lens}/ (${sources}).
     Hand-edit freely — your edits are the source of truth until you regenerate.
     Regenerating writes ${lens}.proposed.md when this file exists (never
     clobbers edits); pass --force to overwrite. -->

${body}
`;

// --- write, never clobbering hand edits ---
const force = process.argv.includes("--force");
if (existsSync(OUT) && !force) {
  writeFileSync(PROPOSED, doc);
  console.log(`Wrote ${PROPOSED}`);
  console.log(`(${OUT} already exists — diff and merge, e.g.:`);
  console.log(`  git diff --no-index config/lenses/${lens}.md config/lenses/${lens}.proposed.md`);
  console.log(` or rerun with --force to overwrite.)`);
} else {
  writeFileSync(OUT, doc);
  console.log(`Wrote ${OUT}`);
}

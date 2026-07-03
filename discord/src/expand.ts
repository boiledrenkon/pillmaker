// Auto-expand a loose request idea into a full concept brief, so the admin's
// review modal opens PRE-FILLED instead of asking them to author from scratch.
//
// Runs a one-shot `claude -p` (Sonnet, for speed) against the logged-in CLI —
// same engine the workflow's agents use, so no API key is needed. The output is
// only a STARTING POINT: the admin edits it in the modal (or compose fills any
// slot left blank), so a flaky parse never blocks the flow — we fall back to a
// minimal brief (the raw idea as theme) and let the human take over.
import { spawn } from "node:child_process";
import { config } from "./config";

const DEBUG = process.env.DEBUG_SMITHERS === "1";
const dbg = (...a: any[]) => DEBUG && console.log("[expand]", ...a);

export type ExpandedConcept = {
  name: string;
  theme: string;
  mainTagline: string;
  copyLines: string[];
  extraInstructions: string;
};

const SYSTEM = `You are a packaging copywriter for a line of fictional NOVELTY PARODY
"male/female enhancement" counter products — capsule blister packs, chewables,
honey-pack sachets and the like (clearly fake, gas-station retail humor). Given a
loose product idea, author a complete concept brief.

Voice: punny, lurid, confident parody — double-entendres tied to the theme,
over-the-top superlatives, fake "clinical-grade" dosages/certifications, ALL-CAPS
hero phrases. Keep it obviously fictional and SFW (no explicit anatomy).

Return ONLY a JSON object (no prose, no markdown fences) with exactly these keys:
{
  "name": "PRODUCT NAME as printed, ALL CAPS, on-theme and punny",
  "theme": "one rich sentence expanding the idea into a vivid parody world compose can build a hero scene from",
  "mainTagline": "the big hero tagline, ALL CAPS",
  "copyLines": ["3-4 supporting copy lines, each ALL CAPS, punny, themed"],
  "extraInstructions": "any art/brand-safety notes (e.g. avoid real trademarks); empty string if none"
}
If the idea already suggests a name, honor it. Do not wrap the JSON in code fences.`;

/** Pull the first balanced JSON object out of arbitrary model text. */
function parseLooseJson(text: string): any | null {
  const fenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runClaude(prompt: string, timeoutMs = 120_000): Promise<string> {
  const [cmd, ...base] = config.expandCmd.split(" ");
  const args = [...base, "-p", prompt, "--model", config.expandModel, "--output-format", "text"];
  return new Promise((res, rej) => {
    dbg("spawn", cmd, "-p <prompt>", "--model", config.expandModel);
    const p = spawn(cmd, args, { cwd: config.projectRoot, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); rej(new Error("expand timed out")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); rej(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res(out);
      else rej(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

/**
 * Expand a loose idea into a concept brief. Never throws: on any failure it
 * returns a minimal brief built from the raw idea so the admin still gets an
 * editable modal.
 */
export async function expandConcept(
  idea: string,
  opts: { suggestedName?: string | null; gender?: string } = {},
): Promise<{ concept: ExpandedConcept; ok: boolean }> {
  const fallback: ExpandedConcept = {
    name: (opts.suggestedName ?? "").toUpperCase().trim() || "(name me)",
    theme: idea.trim(),
    mainTagline: "",
    copyLines: [],
    extraInstructions: "",
  };
  const user = [
    `Audience: ${opts.gender ?? "male"}.`,
    opts.suggestedName ? `Requester's suggested name: ${opts.suggestedName}.` : "",
    `Product idea: ${idea}`,
  ].filter(Boolean).join("\n");

  try {
    const raw = await runClaude(`${SYSTEM}\n\n---\n${user}`);
    const j = parseLooseJson(raw);
    if (!j || typeof j !== "object") return { concept: fallback, ok: false };
    const arr = Array.isArray(j.copyLines) ? j.copyLines : [];
    const concept: ExpandedConcept = {
      name: String(j.name ?? fallback.name).trim() || fallback.name,
      theme: String(j.theme ?? idea).trim() || idea.trim(),
      mainTagline: String(j.mainTagline ?? "").trim(),
      copyLines: arr.map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 6),
      extraInstructions: String(j.extraInstructions ?? "").trim(),
    };
    return { concept, ok: true };
  } catch (e) {
    dbg("failed", String(e));
    return { concept: fallback, ok: false };
  }
}

// ── pre-run direction pitches ────────────────────────────────────────────────
// Short, reviewable artwork directions offered in the thread BEFORE the run
// starts. The chosen pitch lands in the concept's `artwork` field (a weighted
// seed) and compose expands only that one into the full prompt.
const PITCH_SYSTEM = (n: number) => `You are the art director for a line of fictional
NOVELTY PARODY "enhancement" counter products (capsule blister packs, chewables,
honey-pack sachets — gas-station retail humor, clearly fake, SFW). Given a concept
brief, propose ${n} DISTINCT directions for the pack's hero artwork.

Each direction is ONE punchy paragraph, UNDER 300 characters, containing: the
hero-scene idea, one short copy hook in ALL CAPS, and the art-direction look
(palette / typography / finish / dose format). Make the ${n} directions genuinely
different takes — different scene, different angle, different look — never
variations of one idea. No real brands or copyrighted characters.

Return ONLY a JSON array of ${n} strings. No markdown fences, no commentary.`;

export async function pitchDirections(
  c: { name: string; theme: string; gender: string; extraInstructions?: string | null },
  n = 3,
): Promise<string[]> {
  const user = [
    `Product: ${c.name}`,
    `Audience: ${c.gender} (who it's sold to — not necessarily who appears in the artwork)`,
    `Theme: ${c.theme}`,
    c.extraInstructions ? `Notes: ${c.extraInstructions}` : "",
  ].filter(Boolean).join("\n");
  try {
    const raw = await runClaude(`${PITCH_SYSTEM(n)}\n\n---\n${user}`);
    const fenced = raw.replace(/```(?:json)?/gi, "").trim();
    const s = fenced.indexOf("["), e = fenced.lastIndexOf("]");
    if (s === -1 || e <= s) return [];
    const arr = JSON.parse(fenced.slice(s, e + 1));
    return Array.isArray(arr)
      ? arr.map((x: unknown) => String(x).trim().slice(0, 350)).filter(Boolean).slice(0, n)
      : [];
  } catch (err) {
    dbg("pitch failed", String(err));
    return [];
  }
}

/** Deterministic folder slug from a product name (auto-derived; admin no longer
 *  types it). Lowercase, alnum→underscore, trimmed; caller adds uniqueness. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return s || "concept";
}

/** Harden a slug that reaches the filesystem + the generate agent's shell command
 *  (`--out outputs/<slug>/…`). Strips everything but [A-Za-z0-9_-] so no spaces,
 *  quotes, `$`, `;`, `/`, `..` etc. can break the path or inject into the shell.
 *  Preserves case/intent (unlike slugify); caps length. Applied at launch. */
export function safeSlug(s: string): string {
  const clean = (s ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 40);
  return clean || "concept";
}

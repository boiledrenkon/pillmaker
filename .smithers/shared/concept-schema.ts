// Single source of truth for run inputs. Both the workflow
// (.smithers/workflows/enhancement-product.tsx) and the Discord bridge
// (discord/) import from here so a brief is validated against the SAME schema
// at kick-off that the workflow runs on. Lives under .smithers/ so it resolves
// zod from .smithers/node_modules regardless of which side imports it.
import { z } from "zod/v4";

// VERBATIM MARKER: any optional copy field below (or any single line of
// `copyLines`) whose value STARTS WITH "=" is reproduced on the package
// EXACTLY as written (the "=" itself is stripped). Without the marker, a
// provided value is a WEIGHTED SEED: the compose agent honors its intent but
// may polish it to fit the theme and house style. A blank/null field is
// INVENTED from `theme` + `name` + `gender`. See product-compose.mdx.
export const VERBATIM_MARKER = "=";

export const conceptSchema = z.object({
  // --- minimal brief (the only things a request really needs) ---
  slug: z.string().describe("output folder name, e.g. power_rod_11"),
  name: z.string().describe("product name as printed, e.g. POWER ROD 11"),
  gender: z.enum(["male", "female", "couples"]).default("male"),
  theme: z.string().min(1).describe("the parody inspiration / world — compose expands everything from this"),

  // --- optional creative overrides (blank = invent; plain = weighted seed; '='-prefix = verbatim) ---
  artwork: z.string().nullable().default(null).describe("main artwork / hero-scene direction"),
  tags: z.array(z.string()).default([]).describe("style / reference tags to fold in"),
  title: z.string().nullable().default(null),
  subtitle: z.string().nullable().default(null),
  mainTagline: z.string().nullable().default(null),
  secondaryTagline: z.string().nullable().default(null),
  copyLines: z.array(z.string()).default([]).describe("supporting copy lines; prefix a line with '=' to force it verbatim"),
  bottomSlogan: z.string().nullable().default(null),
  capsule: z.string().nullable().default(null),
  format: z.string().nullable().default(null).describe("dose format, e.g. 'single capsule blister', 'gummy pouch', 'honey pack sachet' — blank = compose picks from the theme (capsule blister is the classic)"),
  packagingStyle: z.string().nullable().default(null),

  // --- inputs & constraints ---
  refImages: z.array(z.string()).default([]).describe("reference image file paths or dirs"),
  extraInstructions: z.string().nullable().default(null),
  bannedExtra: z.array(z.string()).default([]).describe("per-concept banned items, merged on top of the global list"),
});

export const inputSchema = z.object({
  concepts: z.array(conceptSchema).default([]),
  backend: z.enum(["manual", "openai", "gemini", "replicate"]).default("manual"),
  composeModel: z.enum(["claude", "claudeSonnet", "claudeOpus"]).default("claude").describe("model for compose REVISIONS (iterations after the first)"),
  composeFirstModel: z.enum(["claude", "claudeSonnet", "claudeOpus"]).default("claudeOpus").describe("model for the FIRST compose (quality where it counts most)"),
  judgeModel: z.enum(["claude", "claudeSonnet", "claudeOpus"]).default("claude"),
  toolModel: z.enum(["claude", "claudeSonnet", "claudeOpus"]).default("claudeSonnet").describe("model for mechanical tool tasks (run the generator command, finalize files) — cheap is fine"),
  promptQc: z.enum(["off", "auto", "human", "both"]).default("both"),
  imageQc: z.enum(["off", "auto", "human", "both"]).default("both"),
  maxAttempts: z.number().int().min(1).default(3),
  // Separate retry budgets so an auto-QC (machine) reject never spends the
  // human's deny retries, and vice-versa. Each applies to BOTH the prompt and
  // image stages: a "retry" = one recompose (prompt) or regenerate (image).
  maxMachineRetries: z.number().int().min(0).default(3).describe("auto-judge recompose/regenerate attempts before giving up"),
  maxHumanRetries: z.number().int().min(0).default(3).describe("human-deny recompose/regenerate attempts before giving up"),
  bannedTermsPath: z.string().default("config/banned_terms.json"),
  stylePhilosophyPath: z.string().default("config/style_philosophy.md").describe("distilled aesthetic sensibility to apply, e.g. config/lenses/shadows.md (built from config/influences/<lens>/ via tools/distill_style.ts); tilts art direction, never a checklist; missing file = none"),
  outDir: z.string().default("outputs"),
});

export type Concept = z.infer<typeof conceptSchema>;
export type RunInput = z.infer<typeof inputSchema>;

/** Flatten a ZodError into readable "path: message" lines for a Discord reply. */
function flatten(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.join(".") || "(root)";
    return `${path}: ${i.message}`;
  });
}

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; errors: string[] };

/** Validate one concept brief (e.g. assembled from the /concept modal). */
/** Strip stray markdown artifacts (leading list bullets, backticks, ** emphasis)
 *  that leak in when a brief is drafted in markdown and pasted into plain fields.
 *  Preserves the leading "=" verbatim marker. */
export function stripMd(s: string): string {
  return s
    .replace(/^\s*[-*•]\s+/, "") // leading list bullet
    .replace(/`/g, "")           // inline-code backticks
    .replace(/\*\*/g, "")        // bold markers
    .trim();
}

/** Normalize a parsed concept: de-markdown the free-text copy fields. */
function cleanConcept(c: Concept): Concept {
  const md = (v: string | null) => (v == null ? v : stripMd(v));
  return {
    ...c,
    theme: stripMd(c.theme),
    title: md(c.title),
    subtitle: md(c.subtitle),
    mainTagline: md(c.mainTagline),
    secondaryTagline: md(c.secondaryTagline),
    bottomSlogan: md(c.bottomSlogan),
    copyLines: (c.copyLines ?? []).map(stripMd).filter(Boolean),
  };
}

export function validateConcept(raw: unknown): Ok<Concept> | Err {
  const r = conceptSchema.safeParse(raw);
  return r.success ? { ok: true, value: cleanConcept(r.data) } : { ok: false, errors: flatten(r.error) };
}

/** Validate a full run input (single or bulk). */
export function validateInput(raw: unknown): Ok<RunInput> | Err {
  const r = inputSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: flatten(r.error) };
}

/** Split a textarea (one item per line) into a trimmed, non-empty array. */
export function lines(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Copy fields that honor the VERBATIM_MARKER ("=") prefix.
const MARKABLE_FIELDS = [
  "title", "subtitle", "mainTagline", "secondaryTagline",
  "bottomSlogan", "capsule", "format", "packagingStyle", "artwork",
] as const;

/**
 * Resolve the "=" verbatim markers DETERMINISTICALLY (in code, not by the LLM):
 * strip the leading "=" from any marked field / copy line so the marker never
 * reaches the image prompt, and return the cleaned strings as an explicit
 * "reproduce these exactly" list. The returned `concept` is "=" -free; unmarked
 * provided fields stay as weighted seeds and blanks remain for invention.
 */
export function resolveMarkers(c: Concept): { concept: Concept; verbatim: string[] } {
  const verbatim: string[] = [];
  const out: Concept = { ...c };
  const strip = (v: string) => v.slice(VERBATIM_MARKER.length).trim();
  for (const f of MARKABLE_FIELDS) {
    const v = out[f];
    if (typeof v === "string" && v.startsWith(VERBATIM_MARKER)) {
      out[f] = strip(v);
      verbatim.push(`${f}: ${out[f]}`);
    }
  }
  out.copyLines = (c.copyLines ?? []).map((line) => {
    if (line.startsWith(VERBATIM_MARKER)) {
      const clean = strip(line);
      verbatim.push(`copy line: ${clean}`);
      return clean;
    }
    return line;
  });
  return { concept: out, verbatim };
}

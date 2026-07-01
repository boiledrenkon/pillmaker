// smithers-source: authored
// smithers-metadata-version: 1
// smithers-display-name: Enhancement Product Generator
// smithers-description: Reusable pipeline for the novelty parody "enhancement" product line — compose a prompt from a generalized template + reference tags/text/images, QC the prompt (auto judge up to N, then human gate), generate the image (manual handoff or an API backend), QC the image (LLM judge up to N, then human gate), and finalize to outputs/<slug>/. Single or bulk, every checkpoint toggleable.
// smithers-tags: image-generation, qc, human-in-the-loop, content-pipeline
/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { createSmithers, HumanTask } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import ComposePrompt from "../prompts/product-compose.mdx";
import PromptJudge from "../prompts/product-prompt-judge.mdx";
import ImageJudge from "../prompts/product-image-judge.mdx";
import GenerateManual from "../prompts/product-generate-manual.mdx";
import GenerateApi from "../prompts/product-generate-api.mdx";
import Finalize from "../prompts/product-finalize.mdx";
import { conceptSchema, inputSchema, resolveMarkers } from "../shared/concept-schema";

// ----------------------------------------------------------------- inputs ---
// conceptSchema + inputSchema are the single source of truth, shared with the
// Discord bridge (see .smithers/shared/concept-schema.ts).

// ---------------------------------------------------------------- outputs ---
const qc = z.enum(["pass", "fail"]).default("fail");
const preflightSchema = z.object({ backend: z.string(), ok: z.boolean().default(false), message: z.string().default("") });
const composeSchema = z.object({ prompt: z.string().default("") });
const promptJudgeSchema = z.object({
  verdict: z.enum(["pass", "revise"]).default("revise"),
  completeness: qc, faithfulness: qc, constraints: qc, template: qc, grounding: qc,
  issues: z.array(z.string()).default([]),
  suggestions: z.string().default(""),
});
const generateSchema = z.object({
  slug: z.string().default(""),
  imagePath: z.string().nullable().default(null),
  ok: z.boolean().default(false),
  note: z.string().default(""),
});
const imageJudgeSchema = z.object({
  verdict: z.enum(["accept", "reject"]).default("reject"),
  promptAdherence: qc, textLegibility: qc, constraintCompliance: qc, styleMatch: qc,
  issues: z.array(z.string()).default([]),
  suggestions: z.string().default(""),
});
const approvalSchema = z.object({
  approved: z.boolean().default(false),
  note: z.string().nullable().default(null),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.string().nullable().default(null),
});
const finalizeSchema = z.object({
  status: z.enum(["accepted", "rejected", "needs_rework"]).default("needs_rework"),
  finalImage: z.string().nullable().default(null),
  promptPath: z.string().nullable().default(null),
  fails: z.array(z.string()).default([]),
});

const { Workflow, Task, Sequence, Branch, Loop, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  preflight: preflightSchema,
  compose: composeSchema,
  promptJudge: promptJudgeSchema,
  generate: generateSchema,
  imageJudge: imageJudgeSchema,
  approval: approvalSchema,
  finalize: finalizeSchema,
});

// ------------------------------------------------------------- the graph ----
export default smithers((ctx) => {
  const input = ctx.input;
  const concepts = input.concepts ?? [];
  const backend = input.backend ?? "manual";
  // compose agent is chosen per-iteration inside renderConcept (Opus first, then composeModel).
  const judgeAgents = [providers[input.judgeModel ?? "claude"]];
  const toolAgents = [providers.claude]; // generation + finalize need bash/write tools
  const maxAttempts = input.maxAttempts ?? 3;
  const maxMachineRetries = input.maxMachineRetries ?? 3;
  const maxHumanRetries = input.maxHumanRetries ?? 3;
  const outDir = input.outDir ?? "outputs";

  // Count prior rejections per node straight from the durable store so machine
  // (auto-judge) and human (deny) retries draw from SEPARATE budgets — an
  // auto-revise never starves a human deny. Read-only; degrades to 0 (full
  // budget) if the DB can't be opened (e.g. `smithers graph` with no run).
  const countRows = (sql: string, ...params: (string | number)[]): number => {
    try {
      const d = new Database(process.env.SMITHERS_DB ?? "smithers.db", { readonly: true });
      try {
        return ((d.query(sql).get(...params) as { n?: number } | null)?.n ?? 0);
      } finally {
        d.close();
      }
    } catch {
      return 0;
    }
  };

  // `ctx.outputMaybe` is iteration-SCOPED — it returns the row for the current
  // frame's iteration. That's correct INSIDE a loop, but at finalize (outside
  // the loop) it can hand back a STALE early iteration: e.g. a prompt gate that
  // was denied on iter0 then approved on iter1 reads back as the iter0 DENY,
  // wrongly finalizing the whole run as needs_rework. For terminal accept/reject
  // decisions, read the LATEST iteration's verdict straight from the store.
  const latestApproved = (nodeId: string): boolean =>
    countRows(
      `SELECT approved n FROM approval WHERE run_id=? AND node_id=? ORDER BY iteration DESC LIMIT 1`,
      ctx.runId,
      nodeId,
    ) === 1;

  const promptAutoOn = input.promptQc === "auto" || input.promptQc === "both";
  const promptHumanOn = input.promptQc === "human" || input.promptQc === "both";
  const imageAutoOn = input.imageQc === "auto" || input.imageQc === "both";
  const imageHumanOn = input.imageQc === "human" || input.imageQc === "both";

  // Global banned list (file) — read once, merged per-concept with bannedExtra.
  let bannedBase: string[] = [];
  try {
    const j = JSON.parse(readFileSync(input.bannedTermsPath ?? "config/banned_terms.json", "utf8"));
    bannedBase = [...(j.banned_visual ?? []), ...(j.banned_text ?? [])];
  } catch {
    bannedBase = ["real brand logos", "copyrighted characters", "explicit anatomy", "medical claims"];
  }

  const read = (table: string, nodeId: string) => ctx.outputMaybe(table, { nodeId });

  if (concepts.length === 0) {
    return (
      <Workflow name="enhancement-product">
        <Task id="noop" output={outputs.preflight} agent={toolAgents}>
          {`No concepts were supplied. Return { backend: "${backend}", ok: false, message: "Pass at least one concept in input.concepts." }`}
        </Task>
      </Workflow>
    );
  }

  // Preflight: confirm the chosen backend's key exists (manual needs none).
  const preflight = read("preflight", "preflight");
  const proceed = backend === "manual" || preflight?.ok === true;

  function renderConcept(concept: z.infer<typeof conceptSchema>) {
    const slug = concept.slug;
    const banned = [...bannedBase, ...(concept.bannedExtra ?? [])].map((b) => `- ${b}`).join("\n");
    const refList = (concept.refImages ?? []).length ? concept.refImages.join("\n") : "(none provided)";
    const refArgs = (concept.refImages ?? []).map((r) => `--ref ${r}`).join(" ");
    // Resolve "=" verbatim markers in code so the marker never reaches the
    // prompt; the spec the agents see is marker-free, with locked copy listed
    // explicitly for both compose and the judge.
    const { concept: cleanConcept, verbatim } = resolveMarkers(concept);
    const spec = JSON.stringify(cleanConcept, null, 2);
    const verbatimList = verbatim.length
      ? verbatim.map((v) => `- ${v}`).join("\n")
      : "(none — invent or polish all copy to fit the theme)";

    // --- prompt loop state ---
    const lastPromptJudge = read("promptJudge", `${slug}:prompt-judge`);
    const lastCompose = read("compose", `${slug}:compose`);
    const promptApproval = read("approval", `${slug}:approve-prompt`);
    // First compose uses the higher-quality model; revisions use composeModel.
    const composeAgentsForConcept = [providers[(lastCompose ? input.composeModel : input.composeFirstModel) ?? "claude"]];

    // Feedback fed into the NEXT compose. Either an auto-judge "revise" verdict
    // OR a human deny note triggers a recompose inside the prompt loop below.
    const judgeFeedback =
      promptAutoOn && lastPromptJudge?.verdict === "revise"
        ? `Auto-QC issues:\n${(lastPromptJudge.issues ?? [])
            .map((i: string) => `- ${i}`)
            .join("\n")}\nSuggestions: ${lastPromptJudge.suggestions ?? ""}`
        : "";
    const denyFeedback =
      promptHumanOn && promptApproval?.approved === false && promptApproval?.note
        ? `Human reviewer rejected the prompt with this note — address it:\n- ${promptApproval.note}`
        : "";
    const composeFeedback =
      judgeFeedback || denyFeedback
        ? `## PREVIOUS PROMPT WAS REJECTED — fix these and recompose\n${[judgeFeedback, denyFeedback]
            .filter(Boolean)
            .join("\n")}`
        : "";
    // The human's live deny note ALSO goes to the judge (not just compose), so the
    // auto-QC won't reject a prompt for following a human redirect that contradicts
    // the concept's original spec (e.g. "make it modern" vs a saved "1980s" instruction).
    const promptHumanNote =
      promptHumanOn && promptApproval?.approved === false && promptApproval?.note
        ? `A human reviewer redirected this concept — treat this as authoritative over the spec:\n- ${promptApproval.note}`
        : "";

    // Only surface the human gate once the auto-judge has signed off this
    // iteration (or auto-QC is off) — a human never sees a machine-rejected draft.
    const promptJudgePassed = !promptAutoOn || lastPromptJudge?.verdict === "pass";

    // Separate budgets: count machine revises vs human denies for THIS prompt.
    const promptRevises = promptAutoOn
      ? countRows(`SELECT COUNT(*) n FROM prompt_judge WHERE run_id=? AND node_id=? AND verdict='revise'`, ctx.runId, `${slug}:prompt-judge`)
      : 0;
    const promptDenies = promptHumanOn
      ? countRows(`SELECT COUNT(*) n FROM approval WHERE run_id=? AND node_id=? AND approved=0`, ctx.runId, `${slug}:approve-prompt`)
      : 0;
    const promptSuccess = promptHumanOn
      ? promptApproval?.approved === true
      : promptAutoOn
        ? lastPromptJudge?.verdict === "pass"
        : (lastCompose?.prompt?.length ?? 0) > 0;
    // Give up only on the axis that exhausted its OWN budget.
    const promptAutoStuck = promptAutoOn && lastPromptJudge?.verdict === "revise" && promptRevises > maxMachineRetries;
    const promptHumanStuck = promptHumanOn && promptApproval?.approved === false && promptDenies > maxHumanRetries;
    const promptLoopDone = promptSuccess || promptAutoStuck || promptHumanStuck;
    // Hard safety cap on total iterations (sum of both budgets + buffer).
    const promptMaxIters = (promptAutoOn ? maxMachineRetries : 0) + (promptHumanOn ? maxHumanRetries : 0) + 2;

    // Human-edited prompt override: if the reviewer used ✏️ Edit at the prompt
    // gate, the bot wrote their exact text here and approved — it becomes the
    // final prompt as-is (no recompose, no re-judge; the human is authoritative).
    let editedPrompt = "";
    try { editedPrompt = readFileSync(`${outDir}/${slug}/.edited-${ctx.runId}.txt`, "utf8").trim(); } catch {}
    const finalPrompt = editedPrompt || (lastCompose?.prompt ?? "");
    // Terminal check: use the LATEST approval iteration, not frame-scoped
    // outputMaybe (which returns the stale iter-0 deny at finalize — the
    // needs_rework bug on deny-then-approve prompt gates).
    const promptOk = !promptHumanOn || latestApproved(`${slug}:approve-prompt`);

    // --- image loop state ---
    const genRows = (ctx.outputs.generate ?? []).filter((r: any) => r.slug === slug);
    const attempt = genRows.length + 1;
    const savePath = `${outDir}/${slug}/candidates/attempt${attempt}.png`;
    // Build the FULL generator command here, where backend/refArgs/savePath are
    // real values, and pass it to the API-generate prompt as a single bare prop.
    // (MDX does NOT interpolate {props.*} inside code fences/backticks, so the
    // command must be assembled in code, not templated inside the .mdx fence.)
    const genCmd = `.venv-img/bin/python tools/gen_image.py --backend ${backend} --prompt-file ${savePath}.txt ${refArgs} --out ${savePath}`.replace(/\s+/g, " ").trim();
    const lastGen = read("generate", `${slug}:generate`);
    const lastImageJudge = read("imageJudge", `${slug}:image-judge`);
    const imageApproval = read("approval", `${slug}:approve-image`);
    const judgeRegenNote =
      imageAutoOn && lastImageJudge?.verdict === "reject"
        ? `PREVIOUS IMAGE WAS REJECTED (auto-QC). Address: ${(lastImageJudge.issues ?? []).join("; ")}. ${lastImageJudge.suggestions ?? ""}`
        : "";
    const denyRegenNote =
      imageHumanOn && imageApproval?.approved === false && imageApproval?.note
        ? `PREVIOUS IMAGE WAS REJECTED (human). Address: ${imageApproval.note}`
        : "";
    const regenNote = [judgeRegenNote, denyRegenNote].filter(Boolean).join(" ");

    // Separate budgets for regeneration: machine rejects vs human denies.
    const imageRejects = imageAutoOn
      ? countRows(`SELECT COUNT(*) n FROM image_judge WHERE run_id=? AND node_id=? AND verdict='reject'`, ctx.runId, `${slug}:image-judge`)
      : 0;
    const imageDenies = imageHumanOn
      ? countRows(`SELECT COUNT(*) n FROM approval WHERE run_id=? AND node_id=? AND approved=0`, ctx.runId, `${slug}:approve-image`)
      : 0;
    const imageSuccess = imageHumanOn
      ? imageApproval?.approved === true
      : imageAutoOn
        ? lastImageJudge?.verdict === "accept"
        : lastGen?.ok === true;
    // Auto-QC has used up its machine retries on a still-rejected image.
    const imageAutoStuckRaw = imageAutoOn && lastImageJudge?.verdict === "reject" && imageRejects > maxMachineRetries;
    // Give up on auto-stuck ONLY when there's no human gate to fall back to.
    // With a human gate on, auto-stuck instead hands the best attempt to the
    // human for a FINAL override (see imageJudgePassed + the gate summary below),
    // so a run never dies "rejected" without the human getting the last word.
    const imageAutoStuck = imageAutoStuckRaw && !imageHumanOn;
    const imageHumanStuck = imageHumanOn && imageApproval?.approved === false && imageDenies > maxHumanRetries;
    const imageLoopDone = imageSuccess || imageAutoStuck || imageHumanStuck;
    // Surface the human image gate once auto-QC accepts — OR once auto-QC has
    // exhausted its retries (human override before we ever finalize as rejected).
    const imageJudgePassed = !imageAutoOn || lastImageJudge?.verdict === "accept" || imageAutoStuckRaw;
    const imageMaxIters = (imageAutoOn ? maxMachineRetries : 0) + (imageHumanOn ? maxHumanRetries : 0) + 3;

    // The HUMAN decision is final whenever the human gate is on (it can override
    // an auto-QC reject). Auto-only → the judge decides. Neither → any image OK.
    // Terminal reads use the LATEST iteration (latest gen row / latest approval),
    // NOT frame-scoped outputMaybe, which returns a stale early iteration here.
    const finalGen = genRows[genRows.length - 1];
    const status = !promptOk
      ? "needs_rework"
      : imageHumanOn
        ? (latestApproved(`${slug}:approve-image`) ? "accepted" : "rejected")
        : imageAutoOn
          ? (lastImageJudge?.verdict === "accept" ? "accepted" : "rejected")
          : (finalGen?.ok === true ? "accepted" : "rejected");
    const acceptedPath = status === "accepted" ? finalGen?.imagePath ?? "" : "";
    const candidatesList = genRows.map((r: any) => r.imagePath).filter(Boolean).join("\n") || "(none)";

    return (
      <Sequence key={slug}>
        {/* 1. Compose + (optional) auto prompt-QC + (optional) human gate, looping
              up to N. A human Deny+note recomposes with the note as feedback. */}
        <Loop id={`${slug}:prompt-loop`} until={promptLoopDone} maxIterations={promptMaxIters} onMaxReached="return-last">
          <Sequence>
            <Task id={`${slug}:compose`} output={outputs.compose} agent={composeAgentsForConcept} timeoutMs={900_000} heartbeatTimeoutMs={300_000}>
              <ComposePrompt spec={spec} banned={banned} verbatim={verbatimList} refImages={refList} feedback={composeFeedback} previous={composeFeedback ? (lastCompose?.prompt ?? "") : ""} />
            </Task>
            <Branch
              if={promptAutoOn}
              then={
                <Task id={`${slug}:prompt-judge`} output={outputs.promptJudge} agent={judgeAgents} timeoutMs={900_000} heartbeatTimeoutMs={300_000}>
                  <PromptJudge spec={spec} banned={banned} verbatim={verbatimList} refImages={refList} humanNote={promptHumanNote} prompt={lastCompose?.prompt ?? "(compose this iteration)"} />
                </Task>
              }
            />
            {/* Human gate INSIDE the loop: Deny+note feeds composeFeedback and
                loops back to recompose. Only shown once the auto-judge passes. */}
            <Branch
              if={promptHumanOn && promptJudgePassed}
              then={
                <Approval
                  id={`${slug}:approve-prompt`}
                  output={outputs.approval}
                  onDeny="continue"
                  request={{
                    title: `Approve PROMPT for "${concept.name}" (${slug})?`,
                    summary:
                      `${finalPrompt.slice(0, 1500)}\n\n--- auto-QC: ${lastPromptJudge ? lastPromptJudge.verdict : "off"} ` +
                      `${lastPromptJudge ? `(issues: ${(lastPromptJudge.issues ?? []).length})` : ""}`,
                    metadata: { slug, autoVerdict: lastPromptJudge?.verdict ?? "off" },
                  }}
                />
              }
            />
          </Sequence>
        </Loop>

        {/* 3. Generate + (optional) auto image-QC, looping up to N — only if the prompt is OK. */}
        <Branch
          if={promptOk}
          then={
            <Sequence>
              <Loop id={`${slug}:image-loop`} until={imageLoopDone} maxIterations={imageMaxIters} onMaxReached="return-last">
                <Sequence>
                  <Branch
                    if={backend === "manual"}
                    then={
                      <HumanTask
                        id={`${slug}:generate`}
                        output={outputs.generate}
                        maxAttempts={5}
                        prompt={<GenerateManual slug={slug} prompt={finalPrompt} refImages={refList} savePath={savePath} />}
                      />
                    }
                    else={
                      <Task id={`${slug}:generate`} output={outputs.generate} agent={toolAgents} timeoutMs={1_200_000} heartbeatTimeoutMs={600_000}>
                        <GenerateApi slug={slug} prompt={`${finalPrompt}${regenNote ? `\n\n${regenNote}` : ""}`} savePath={savePath} command={genCmd} />
                      </Task>
                    }
                  />
                  <Branch
                    if={imageAutoOn && lastGen?.ok === true}
                    then={
                      <Task id={`${slug}:image-judge`} output={outputs.imageJudge} agent={judgeAgents} timeoutMs={900_000} heartbeatTimeoutMs={300_000}>
                        <ImageJudge
                          imagePath={lastGen?.imagePath ?? savePath}
                          prompt={finalPrompt}
                          spec={spec}
                          banned={banned}
                          refImages={refList}
                        />
                      </Task>
                    }
                  />
                  {/* Human image gate INSIDE the loop: Deny+note regenerates
                      (re-asks for a PNG / re-runs the API) up to the human budget,
                      separate from auto-QC's. Only shown once auto-QC accepts. */}
                  <Branch
                    if={imageHumanOn && imageJudgePassed}
                    then={
                      <Approval
                        id={`${slug}:approve-image`}
                        output={outputs.approval}
                        onDeny="continue"
                        request={{
                          title: `Approve IMAGE for "${concept.name}" (${slug})?`,
                          summary:
                            `${imageAutoStuckRaw ? "⚠️ Auto-QC used up its retries — FINAL human call. Approve to accept this attempt, or Deny+note to try again.\n" : ""}` +
                            `Candidate: ${lastGen?.imagePath ?? "(none)"}\nauto-QC: ${lastImageJudge ? lastImageJudge.verdict : "off"} ` +
                            `${lastImageJudge ? `(issues: ${(lastImageJudge.issues ?? []).length})` : ""}`,
                          metadata: { slug, imagePath: lastGen?.imagePath ?? null, autoVerdict: lastImageJudge?.verdict ?? "off", override: imageAutoStuckRaw },
                        }}
                      />
                    }
                  />
                </Sequence>
              </Loop>
            </Sequence>
          }
        />

        {/* 5. Finalize: save accepted to outputs/<slug>/, route the rest to fail/. */}
        <Task id={`${slug}:finalize`} output={outputs.finalize} agent={toolAgents} timeoutMs={600_000} heartbeatTimeoutMs={300_000}>
          <Finalize
            slug={slug}
            outDir={outDir}
            status={status}
            acceptedPath={acceptedPath}
            candidates={candidatesList}
            prompt={finalPrompt}
          />
        </Task>
      </Sequence>
    );
  }

  return (
    <Workflow name="enhancement-product">
      <Sequence>
        <Task id="preflight" output={outputs.preflight} agent={toolAgents} timeoutMs={300_000} heartbeatTimeoutMs={120_000}>
          {`Run from the project root: python3 tools/preflight.py --backend ${backend}\n` +
            `It prints one JSON line and exits non-zero if a required API key is missing. ` +
            `Return { backend, ok, message } from its output (ok=false if it exited non-zero).`}
        </Task>
        <Branch
          if={proceed}
          then={<Sequence>{concepts.map((c) => renderConcept(c))}</Sequence>}
          else={
            <Approval
              id="preflight-block"
              output={outputs.approval}
              onDeny="continue"
              request={{
                title: `Missing API key for backend "${backend}"`,
                summary: preflight?.message ?? `Set the key for ${backend}, or re-run with backend=manual (no key needed). Approve to override and try anyway.`,
                metadata: { backend },
              }}
            />
          }
        />
      </Sequence>
    </Workflow>
  );
});

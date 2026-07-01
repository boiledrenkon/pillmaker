# Enhancement-Product Generator — Smithers workflow

A reusable, durable pipeline that turns a concept brief into a finished parody
"enhancement" product package image, with QC at both the prompt and image stages.
It mirrors the structure already in `outputs/<slug>/` (an accepted `.png`, the
final `.txt` prompt, a `fail/` folder of rejects, and `ref_images/`).

```
preflight (key check)
  └─ for each concept:
       1. compose prompt   ← generalized template + your tags/text/refs   (Loop ≤N)
       2. prompt QC         ← auto Claude judge, then optional human gate
       3. generate image    ← manual handoff OR openai/gemini/replicate    (Loop ≤N)
       4. image QC          ← CLIP soft-signal + auto Claude judge, then optional human gate
       5. finalize          ← accepted → outputs/<slug>/<slug>.png + .txt; rejects → fail/
```

Files:
- `.smithers/workflows/enhancement-product.tsx` — the graph
- `.smithers/prompts/product-*.mdx` — compose / judge / generate / finalize prompts
- `config/banned_terms.json` — **editable** banned-items list (add/remove freely)
- `tools/preflight.py` — backend API-key check
- `tools/gen_image.py` — API backend dispatcher (openai | gemini | replicate)
- `tools/clip_score.py` — soft CLIP style score, reuses `scraper/filter.py`
- `inputs/example-single.json`, `inputs/example-bulk.json` — sample inputs

## Run it

All commands run from the project root. `smithers` = `bunx smithers-orchestrator`.

```bash
# Validate the graph renders (no run):
bunx smithers-orchestrator graph .smithers/workflows/enhancement-product.tsx --input "$(cat inputs/example-single.json)"

# Single concept:
bunx smithers-orchestrator up .smithers/workflows/enhancement-product.tsx --input "$(cat inputs/example-single.json)"

# Bulk (array of concepts, processed in order):
bunx smithers-orchestrator up .smithers/workflows/enhancement-product.tsx --input "$(cat inputs/example-bulk.json)"

# Watch / operate:
bunx smithers-orchestrator ps
bunx smithers-orchestrator logs <run-id> -f
```

When the run pauses on a gate, resolve it (the orchestrating agent does this for
you, but for reference):

```bash
# prompt / image approval gates:
bunx smithers-orchestrator approve <run-id> --node power_rod_11:approve-image --by you
bunx smithers-orchestrator deny    <run-id> --node power_rod_11:approve-prompt --by you --note "missing the FISH!! graphic"

# manual image generation (HumanTask): submit the path to the PNG you made:
bunx smithers-orchestrator human inbox
bunx smithers-orchestrator human answer <request-id> --value '{"slug":"power_rod_11","imagePath":"outputs/power_rod_11/candidates/attempt1.png","ok":true,"note":""}'
```

## Inputs (runtime config — nothing is hard-coded)

Top level:

| field | default | meaning |
|---|---|---|
| `concepts` | `[]` | one or many concept briefs (see below) |
| `backend` | `manual` | `manual` \| `openai` \| `gemini` \| `replicate` |
| `composeModel` / `judgeModel` | `claude` | `claude` \| `claudeSonnet` \| `claudeOpus` |
| `promptQc` | `both` | `off` \| `auto` \| `human` \| `both` |
| `imageQc` | `both` | `off` \| `auto` \| `human` \| `both` |
| `maxAttempts` | `3` | regen/revise cap per QC loop before the human gate |
| `clipWeight` | `0.2` | how much the CLIP style score counts (soft) |
| `bannedTermsPath` | `config/banned_terms.json` | editable banned list |
| `outDir` | `outputs` | where finished concepts land |

Each concept: `slug`, `name`, `gender` (`male`/`female`/`couples`), `theme`,
`artwork?`, `tags[]`, `title?`, `subtitle?`, `mainTagline?`, `secondaryTagline?`,
`copyLines[]` (verbatim required lines), `bottomSlogan?`, `capsule?`,
`packagingStyle?`, `refImages[]` (file paths or dirs), `extraInstructions?`,
`bannedExtra[]` (per-concept banned items, merged on top of the global list).

## The two QC checkpoints

- **Prompt QC** — a Claude vision judge reads your spec + reference images + the
  composed prompt and checks completeness (every required line present, verbatim),
  faithfulness, banned-item hygiene, template conformance, and reference grounding.
  On `revise` it feeds fixes back and recomposes, up to `maxAttempts`; then (if
  enabled) a human gate.
- **Image QC** — `tools/clip_score.py` produces a soft, weighted style number
  (reusing the scraper's CLIP filter), then a Claude vision judge checks prompt
  adherence, **text legibility/spelling** (the #1 failure), banned-item compliance,
  and style match. A low CLIP score alone never rejects. On `reject` it regenerates
  up to `maxAttempts`; then (if enabled) a human gate.

Toggle either checkpoint per run via `promptQc` / `imageQc`. `manual` backend
needs no API key; the API backends require `OPENAI_API_KEY`, `GEMINI_API_KEY`
(or `GOOGLE_API_KEY`), or `REPLICATE_API_TOKEN` respectively — checked up front
by the preflight step.

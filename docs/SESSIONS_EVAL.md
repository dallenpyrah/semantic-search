# Live Pi Session Evaluation

7 varied tasks, each run as a separate headless Pi session (`pi -p --mode json`) against this repo
(known ground truth), with only this extension + skill loaded. Re-run: `bun eval/sessions.ts`. Full
traces + answers in `eval/.cache/sessions/`.

## Results

| # | Task type | First retrieval | Config options the model chose | Tool calls | Correct? |
|---|---|---|---|---|---|
| t1 | discovery (watcher git-sync) | `semantic_search` | `queries[3]`, `mode:hybrid` (×2 searches) | 8 | ✅ |
| t2 | how-it-works (rerank + degrade) | `semantic_search` | `queries[3]`, `mode:hybrid` | 10 | ✅ |
| t3 | multi-faceted (pipeline) | `semantic_search` | `queries[4]`, `mode:hybrid` | 12 | ✅ |
| t4 | history "why v2" | `semantic_search` | `source:[code,docs,history]` + `file:defaults.ts lines:60-80` + `queries[]` | 8 | ✅ |
| t5 | file history (Search.ts) | `semantic_search` | `file:src/search/Search.ts` | 3 | ✅ |
| t6 | exact symbol (resolveSources) | `semantic_search` | single `query`, `mode:hybrid` | 3 | ✅ |
| t7 | true-grep (list TODOs) | `bash` (grep) | — (correctly did NOT use semantic_search) | 6 | ✅ |

**Adoption: 6/6 non-grep tasks used `semantic_search` first. The grep task used a raw text search and
0 `semantic_search` calls — correct routing, no over-routing. Correctness: 7/7**, every answer grounded
with exact `file:line` / commit citations.

## What this validates

- **The single tool with config options works.** The model chose the right params per task type with no
  prompting: `queries[]` parallel facets on multi-faceted/discovery tasks (t1–t4), a single `query` for a
  single focus (t6), `source:[...,history]` for a "why did this change" question (t4), and `file`/`lines`
  for file-history (t4, t5). One tool, no choice paralysis, full capability.
- **Multi-source routing is correct.** History surfaced only on the historical/causal question (t4); the
  file-diff mode returned real commits + diffs (t4, t5); plain code questions stayed on code.
- **Answers are right.** t4 nailed the exact reason for the v2 bump (source field + incremental-skip left
  rows source-less → fresh namespace). t6 described `resolveSources`'s routing rule precisely.

## Where it's heavy (honest)

- **"Explain how X works" tasks read a lot** (t1=8, t2=10, t3=12 tool calls): `semantic_search` lands the
  agent in the right files, but it then reads several to build a full explanation. Partly inherent
  (explaining requires reading), partly thoroughness. Lever to try: a higher default `limit` / larger
  snippets so more context arrives in the first call. Discovery/lookup tasks are tight (t5, t6 = 3 calls).
- **t7 grep task used 6 bash calls** to sweep — correct tool, just thorough.
- Latency 32–85s per full agent turn (the user's default model). `semantic_search` itself is ~0.6–1s.

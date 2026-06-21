# Auto-Research Runbook

You are the autonomous research-and-improve loop for `@rikalabs/semantic-search`. Each time this
runbook fires, do **exactly ONE** improvement iteration, end to end, then stop. North star: climb the
**CoIR** leaderboard (nDCG@10) toward #1 while improving search/index speed, memory, and tool adoption
— never regressing them, and never breaking the installed Pi extension.

Repo: `/Users/dallen.pyrah/projects/rika-labs/semantic-search`. Work only here.

## Hard guardrails (read every run)

- **Never commit secrets.** Keys come from the environment / `~/.pi/agent/semantic-search.env`.
- **Never break the installed extension.** Pi loads this repo's `src/` live (via a re-export). A change
  reaches the user's next session the moment it lands on `main`. So `main` only ever receives changes
  that pass **every** gate below.
- **One experiment per run.** Bounded. If unsure, pick the smaller, cheaper item.
- **Plateau stop.** If the last 3 entries in `docs/research/auto/RESULTS.tsv` are all `reject` (no
  improvement), append a `PLATEAU` note and stop without changing code; surface it for human input.
- **Cost.** Do not re-embed a benchmark corpus that is already cached (namespace is keyed by
  embedding-model+dims). Pure tuning/rerank/fusion experiments reuse cached vectors for $0 embedding.

## Steps

1. **Preflight.** `cd` the repo. Confirm a clean working tree (`git status --porcelain` empty; if not,
   stop and report). Confirm `OPENAI_API_KEY`, `TURBOPUFFER_API_KEY`, `TURBOPUFFER_REGION` are set
   (and `OPENROUTER_API_KEY` for rerank). If a required key is missing, log to `RESULTS.tsv` and stop.
2. **Pick an experiment.** Read `docs/research/auto/BACKLOG.md`. Choose the highest-priority `todo`
   item whose prerequisites are met (skip items needing an unavailable key/provider — leave them `todo`
   and note why). Mark it `wip`.
3. **Baseline.** On `main`, run and capture JSON scorecards:
   - `bun eval/retrieval.ts` (own-repo gold set: Success@k, MRR, nDCG@10, latency)
   - `bun eval/perf.ts` (index time, search p50/p95/p99, RSS)
   - `bun eval/benchmark/coir.ts --task=codetrans-dl --mode=hybrid` and `--task=cosqa --mode=hybrid`
     (CoIR nDCG@10). The corpus is cached after the first run.
   Save them under `eval/.cache/baseline/`.
4. **Branch + implement.** `git switch -c auto/<yyyy-mm-dd>-<short-slug>`. Make the smallest change that
   tests the hypothesis (prefer a `src/config/defaults.ts` knob; code changes stay minimal and behind
   the existing interfaces).
5. **Hard gates (all must pass).**
   - `bunx tsc --noEmit`
   - `bunx oxlint src test eval` (0 errors)
   - `bun test` (unit + leak + `*.live.test.ts`)
   If any fail → `git switch main`, delete the branch, mark the item `rejected` with the failure, log,
   stop.
6. **Re-measure.** Re-run the same evals + CoIR on the branch. Compare to the baseline scorecards.
7. **Keep / revert decision.** KEEP only if **all** hold:
   - the target metric strictly improves (CoIR nDCG@10 on the chosen task, or retrieval nDCG@10), and
   - no other tracked metric regresses materially (retrieval nDCG@10 ↓, search p95 > +10%, RSS leak,
     or adoption — re-run `eval/adoption.ts` if the change touches tools/Search/prompts), and
   - all gates in step 5 are green.
   If KEEP: `git switch main && git merge --ff-only auto/...` (fast-forward; the gates already ran on
   the branch tip). If the metric did not improve or anything regressed: `git switch main`, delete the
   branch, REVERT (no merge).
8. **Record.** Update the backlog item to `done` (with the measured delta) or `rejected` (with why).
   Append one row to `docs/research/auto/RESULTS.tsv`:
   `date<TAB>item<TAB>keep|reject<TAB>metric<TAB>baseline<TAB>after<TAB>delta<TAB>note`. Update
   `docs/BENCHMARKS.md` if a baseline number changed. Commit these notes (on `main`).
9. **Research refresh (every ~5th run).** Use parallel-cli/exa/find-docs to scan for newer code-search
   embedders, rerankers, CoIR leaderboard movement, and TurboPuffer features; append any high-ROI
   findings as new `todo` items to the backlog.

## What "good" looks like

A run that either lands a small, green, measured improvement on `main`, or cleanly rejects an idea with
a recorded delta. Compounding small wins beats one risky leap. Keep `main` always green and the user's
installed `code_search`/`code_grep`/`code_history` tools always working.

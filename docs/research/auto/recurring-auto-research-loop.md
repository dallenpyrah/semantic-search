# Recurring Auto-Research-and-Improve Agent — Design Brief

Status: grounding research, actionable. Date: 2026-06-20.
Target system: Effect v4 semantic + hybrid code-search (Pi extension + CLI) at
`.`.

North star: **be #1 on a real, published code-search benchmark** while improving speed, memory,
and indexing. The benchmark to chase is **CoIR** (NDCG@10). This brief specifies the recurring
loop, the backlog schema, the keep/revert rule, the scheduling mechanism, and the guardrails.

---

## TL;DR decisions (orchestrator reads this)

1. **North-star benchmark = CoIR** (ACL 2025 Main), metric **NDCG@10**, pip `coir-eval`. Public
   leaderboard exists. Add a **CodeRAG-Bench / SWE-bench-retrieval** track later as a second public
   signal. Our existing 30-query gold set becomes the **fast inner-loop tune set**; CoIR is the
   **outer-loop held-out signal**. (Sources below.)
2. **Loop contract = Karpathy's autoresearch shape**: pick highest-ROI untried backlog item →
   branch → typecheck+lint+test (hard gate) → run eval+perf harness → compare scorecard to committed
   baseline → **keep (commit) only if target metric strictly improves with no test/latency
   regression**, else revert and log measured delta. (Karpathy autoresearch: `program.md` loop +
   `results.tsv` + pinned eval shard + simplicity criterion.)
3. **Anti-overfitting is mandatory and is the #1 risk.** Our own-repo gold set is tiny (30 q) and
   trivially gameable. Split it into **tune (inner) vs held-out (gate)**, and require gains on the
   **held-out split AND a public benchmark subset (CoIR `cosqa` + `codesearchnet`)**, not just the
   tune set. A change that helps tune but not held-out/public is rejected as overfit.
4. **Scheduling = local cron / local agent run, NOT a cloud routine.** Justification: keys, the repo,
   the Pi install, and TurboPuffer namespaces are all local; a cloud routine cannot run `tsc`/`bun
   test`/the live eval against TurboPuffer without exfiltrating keys and the repo. Use a **durable
   cron entry** (`CronCreate durable:true` or system `launchd`/`cron`) that wakes a `pi` headless run
   pointed at a self-contained runbook file in the repo.
5. **Cost control: never re-embed the corpus every run.** Cache the benchmark namespace in
   TurboPuffer keyed by `(embedding-model, dims, corpus-SHA)`; only re-embed when an experiment
   changes the embedder/chunker. A pure rerank/fusion experiment reuses the cached vectors for $0
   embedding cost.
6. **Guardrails: token/cost ceiling per run; stop after N=3 no-improvement runs (plateau); never
   break the installed Pi extension; never commit secrets.** The installed extension is load-bearing
   for the user — experiments run on a branch and the loop never touches `main` unless a keep is
   proven green.

Blocking unknowns (must resolve before first scheduled run):
- **`OPENAI_API_KEY` is absent** from `~/.pi/agent/semantic-search.env` (only `TURBOPUFFER_API_KEY`,
  `OPENROUTER_API_KEY`, `TURBOPUFFER_REGION` present), yet `AppConfig` marks `OPENAI_API_KEY`
  required (`src/config/AppConfig.ts:72`). Live eval/embedding will fail until this is added. The
  runbook must pre-flight keys and abort cleanly if missing.
- CoIR full run cost/time on our stack is unmeasured; first run must measure a **single-dataset
  subset** (`cosqa`, ~500 queries) before committing to full CoIR each run.

---

## 1. What already exists (ground truth — do not rebuild)

Verified by reading the repo.

| Asset | Path | Role in the loop |
|---|---|---|
| Retrieval eval (emits JSON scorecard) | `eval/retrieval.ts` | Inner-loop quality gate. Prints `{mrr, ndcg10, successAt, latency, misses}`. |
| Perf eval (index/search/memory) | `eval/perf.ts` | Latency + memory budget gate. Emits `indexColdMs`, `searchLatency.p50/p95/p99`, `memory.deltaMb`. |
| Adoption eval (real Pi, NDJSON parse) | `eval/adoption.ts` | Tool-routing regression (don't break agent adoption). |
| Gold set (30 q: 20 semantic, 10 hybrid) | `eval/gold.ts` | **Split this into tune/held-out.** Currently one flat array. |
| Benchmarks scorecard (committed baseline) | `docs/BENCHMARKS.md` | Baseline prose; the loop needs a **machine-readable** baseline alongside it. |
| Tunable config (all knobs) | `src/config/defaults.ts` | The experiment surface: `chunkTargetChars`, `embedBatch`, `rankConstant`, `candidateMultiplier`, `perFile`, rerank `provider/model/poolMultiplier`, embedding `model/dimensions`. |
| Empty benchmark dir | `eval/benchmark/` | **Drop the CoIR adapter + cached scorecards here.** |
| Tests | `test/*.test.ts` (chunker, fuse, ignore, watcher-leak, `*.live.test.ts`) | Hard gate. `*.live.test.ts` need keys. |
| Keys | `~/.pi/agent/semantic-search.env` | TurboPuffer + OpenRouter present; **OpenAI missing**. |
| Scripts | `typecheck`=`tsc --noEmit`, `lint`=`oxlint src test eval`, `test`=`bun test` (package.json) | The three hard gates. |

Current committed baseline (from `docs/BENCHMARKS.md`, own-repo gold set, 30 q):
Success@1 80%, @3 93%, @5 97%, @10 97%, MRR 0.875, nDCG@10 0.899, search p50 ~600–720ms /
p95 ~1046–1300ms, cold index ~3.2s (97 chunks), incremental re-index ~5ms, RSS leak test green.

---

## 2. The north-star benchmark: CoIR

**CoIR — A Comprehensive Benchmark for Code Information Retrieval** (ACL 2025 Main).
- Leaderboard: https://archersama.github.io/coir
- Paper: https://arxiv.org/abs/2407.02883 — PDF https://aclanthology.org/2025.acl-long.1072.pdf
- Code: https://github.com/CoIR-team/coir — pip `coir-eval`
- Schema aligned to **MTEB / BEIR**, so cross-benchmark tooling transfers.

**10 datasets, 4 task families:** Text-to-Code, Code-to-Text, Code-to-Code, Hybrid.
Datasets: `apps`, `cosqa`, `synthetic-text2sql`, `codesearchnet`, `codesearchnet-ccr`,
`codetrans-contest`, `codetrans-dl`, `stackoverflow-qa`, `codefeedback-st`, `codefeedback-mt`.

**Metric: NDCG@10**, averaged across datasets (mean pooling).

**Public leaderboard (top 8, avg NDCG@10):**

| Rank | Model | Avg | Params (M) |
|---|---|---|---|
| 1 | Salesforce/SFR-Embedding-Code-2B_R | **67.41** | 2000 |
| 2 | CodeSage-large-v2 | 64.18 | 1300 |
| 3 | Salesforce/SFR-Embedding-Code-400M_R | 61.89 | 400 |
| 4 | CodeSage-large | 61.04 | 1300 |
| 5 | Voyage-Code-002 | 56.26 | — |
| 6 | E5-Mistral | 55.18 | 7000 |
| 7 | E5-Base-v2 | 50.9 | 110 |
| 8 | OpenAI-Ada-002 | 45.59 | — |

Source: https://archersama.github.io/coir (fetched 2026-06-20).

**Load-bearing insight for the orchestrator:** our embedder (OpenAI `text-embedding-3-large`) is a
*general* embedder. The only OpenAI model on the board is **Ada-002 at 45.59**, dead last of the
top 8; **code-specialized** models (SFR-Embedding-Code, CodeSage, Voyage-Code) dominate at 56–67.
text-embedding-3-large will land meaningfully higher than Ada-002 but **will not be #1 without a
code-specialized embedder and/or a strong reranker on top.** This makes the two highest-ROI backlog
items: (a) **add a strong reranker pass over CoIR candidates** (we already have Cohere rerank-v3.5
via OpenRouter — rerankers stack on any first-stage retriever and are how you beat raw-embedding
boards), and (b) **evaluate a code-specialized embedder** (SFR-Embedding-Code-400M_R is the ROI
sweet spot: rank 3 at 61.89 with only 400M params, self-hostable). Note: CoIR's stock harness scores
**bi-encoder retrieval only**; to score our *reranked* pipeline we run a custom retriever adapter
(below), which is exactly what "Beyond Retrieval" (arXiv:2605.04615) flags as missing in CoIR (D1:
no reranking support). That gap is our opening.

**Second public track (add later):** CodeRAG-Bench (NAACL 2025 Findings,
https://aclanthology.org/2025.findings-naacl.176.pdf) ties retrieval to downstream SWE-bench gains
(27.4% SWE-Bench gain with canonical docs) — closer to the agent use case than pure NDCG.

### CoIR adapter (custom retriever scores OUR full pipeline, including rerank)

`coir-eval` is Python; our system is Bun/TS. Bridge by implementing CoIR's two-method model
interface in Python that **shells out to our CLI** (or hits a thin local HTTP endpoint our CLI
exposes), so CoIR scores the *real* retrieve→fuse→rerank pipeline, not just raw embeddings.

```python
# eval/benchmark/coir_adapter.py  — run: python eval/benchmark/coir_adapter.py --tasks cosqa
import coir, subprocess, json, numpy as np
from coir.evaluation import COIR

class SemSearchRetriever:
    # CoIR calls encode_queries/encode_corpus for bi-encoders. For a full
    # retrieve+rerank pipeline, implement the BEIR `search()` contract instead and
    # call our CLI per query, returning {qid: {docid: score}}.
    def search(self, corpus, queries, top_k, score_function=None, **kw):
        results = {}
        for qid, q in queries.items():
            out = subprocess.run(
                ["bun", "src/cli/main.ts", "search", "--json", "--limit", str(top_k), q],
                capture_output=True, text=True, check=True).stdout
            hits = json.loads(out)["hits"]
            results[qid] = {h["docid"]: float(h["score"]) for h in hits}
        return results

tasks = coir.get_tasks(tasks=["cosqa"])          # start with ONE dataset
COIR(tasks=tasks, batch_size=128).run(SemSearchRetriever(), output_folder="eval/benchmark/coir-out")
# NDCG@10 lands in eval/benchmark/coir-out/<task>.json
```

This requires the CLI to (1) accept a CoIR corpus to index into a dedicated TurboPuffer namespace,
and (2) emit `docid`+`score`. Building that thin CLI bridge is **the first backlog item** (it is the
benchmark harness the goal asks for). Until it exists, the inner loop runs on `eval/retrieval.ts`.

---

## 3. The loop contract (the runbook the scheduled agent follows each run)

One run = one experiment. Steps are ordered; a failed gate aborts the run and reverts.

```
STEP 0  PRE-FLIGHT (abort cleanly on failure, do not branch)
  0.1  cd repo; assert `git status` clean and on `main` (or a known integration branch).
  0.2  Load keys from ~/.pi/agent/semantic-search.env. Assert OPENAI_API_KEY, TURBOPUFFER_API_KEY,
       OPENROUTER_API_KEY all present. If OPENAI_API_KEY missing -> log "blocked: missing key", exit 0.
  0.3  Assert baseline scorecard exists: eval/benchmark/baseline.json. If absent, run the harness
       once on main and write it (this is the committed baseline). Do NOT count this as an experiment.
  0.4  Check budget ledger eval/benchmark/ledger.json: if plateau (last N=3 runs all REVERTED) ->
       log "plateaued, stopping" and exit 0 (no experiment).

STEP 1  PICK (highest-ROI untried item)
  1.1  Read eval/backlog.jsonl. Filter status == "todo".
  1.2  Sort by (roi_score desc, est_cost asc). roi_score = expected metric delta / risk.
  1.3  Pick top 1. If none -> agent proposes 1 new item from research (append as "todo"), then picks it.
       Mark picked item status "in_progress", stamp run_id + started_at.

STEP 2  BRANCH
  2.1  git switch -c auto/exp-<run_id>-<slug>
  2.2  Implement the SMALLEST change that tests the hypothesis (one config/knob/module, not a rewrite).
       Encode "simpler is better": prefer a config delta over new code. (Karpathy simplicity criterion.)

STEP 3  HARD GATES (any failure -> STEP 7 revert with reason)
  3.1  bun run typecheck   (tsc --noEmit)            MUST pass
  3.2  bun run lint        (oxlint src test eval)    MUST pass
  3.3  bun test            (excludes *.live unless keys present; run live too if keys present) MUST pass
       -> these protect the installed extension: a broken build never reaches main.

STEP 4  MEASURE (produce a fresh scorecard)
  4.1  bun eval/retrieval.ts --json   -> inner-loop quality (tune + held-out splits, see §5)
  4.2  bun eval/perf.ts               -> latency p50/p95/p99 + cold/incremental index + RSS delta
  4.3  bun eval/adoption.ts <sample>  -> tool-routing not regressed (only if the change could affect it)
  4.4  IF experiment touches retrieval quality AND CoIR adapter exists:
         python eval/benchmark/coir_adapter.py --tasks cosqa,codesearchnet  (public held-out subset)
       ELSE skip 4.4 (cost control: don't run CoIR for a pure-latency experiment).
  4.5  Write candidate scorecard to eval/benchmark/run-<run_id>.json (tune, held-out, public, perf).

STEP 5  COMPARE vs eval/benchmark/baseline.json  (keep/revert rule in §6)

STEP 6  KEEP (only if STEP 5 says improve)
  6.1  Update eval/benchmark/baseline.json = candidate scorecard.
  6.2  Update docs/BENCHMARKS.md numbers (prose) only if the headline metric moved.
  6.3  git add -A; commit: "auto(exp): <slug> — <metric> <old>->%new> (+delta)\n\nClaude-Session: ..."
  6.4  Fast-forward main: git switch main; git merge --ff-only auto/exp-...; delete branch.
  6.5  backlog item status -> "done"; record measured_delta. Append KEPT to ledger.json.

STEP 7  REVERT (else)
  7.1  git switch main; git branch -D auto/exp-<run_id>-<slug>  (discard the branch entirely).
  7.2  backlog item status -> "rejected"; record measured_delta + reason (regressed_tests |
       no_inner_gain | overfit_failed_heldout | latency_budget | cost_ceiling).
  7.3  Append REVERTED to ledger.json. Plateau counter += 1 (reset to 0 on any KEEP).

STEP 8  LOG + STOP
  8.1  Append one line to eval/benchmark/ledger.json (run_id, item, decision, deltas, tokens, $, secs).
  8.2  Commit backlog.jsonl + ledger.json changes to main (even on revert — progress must persist).
  8.3  Exit. One experiment per run. No auto-chaining to a second experiment.
```

Why one experiment per run: it bounds cost, keeps the keep/revert attribution clean (one change →
one delta), and makes the git history a readable experiment trace.

---

## 4. Backlog file schema

`eval/backlog.jsonl` — one JSON object per line (append-only friendly, diff-friendly, no merge churn).

```jsonl
{"id":"exp-001","title":"CoIR adapter: score full pipeline on cosqa","hypothesis":"A custom BEIR-style retriever that shells to our CLI lets CoIR score our reranked pipeline, not raw embeddings.","surface":"eval/benchmark/coir_adapter.py + CLI --json docid/score","target_metric":"coir.cosqa.ndcg10","est_cost":"med","roi_score":9,"status":"todo","measured_delta":null,"run_id":null,"reason":null}
{"id":"exp-002","title":"Rerank CoIR candidates with Cohere rerank-v3.5","hypothesis":"Reranking the top-100 first-stage hits raises NDCG@10 above raw text-embedding-3-large (CoIR has no rerank track; rerankers stack).","surface":"src/rerank/Reranker.ts pool size","target_metric":"coir.avg.ndcg10","est_cost":"med","roi_score":9,"status":"todo","measured_delta":null,"run_id":null,"reason":null}
{"id":"exp-003","title":"Eval SFR-Embedding-Code-400M_R as embedder","hypothesis":"Code-specialized embedder (CoIR rank 3, 61.89, 400M, self-hostable) beats text-embedding-3-large on code tasks.","surface":"src/embedding/Embeddings.ts + defaults.model/dimensions","target_metric":"coir.avg.ndcg10","est_cost":"high","roi_score":8,"status":"todo","measured_delta":null,"run_id":null,"reason":null}
{"id":"exp-004","title":"Tune rankConstant (RRF k) 60 -> {40,80}","hypothesis":"RRF k affects fusion; sweep for held-out MRR gain.","surface":"src/config/defaults.ts search.rankConstant","target_metric":"heldout.mrr","est_cost":"low","roi_score":5,"status":"todo","measured_delta":null,"run_id":null,"reason":null}
```

Field contract:
- `status`: `todo` | `in_progress` | `done` (kept, improved) | `rejected` (reverted).
- `target_metric`: the ONE metric this experiment is judged on (must name the split: `tune.*`,
  `heldout.*`, `coir.<dataset>.ndcg10`, `perf.*`). Prevents moving the goalposts after the fact.
- `roi_score` (1–10) and `est_cost` (low/med/high) drive STEP 1 sorting.
- `measured_delta`: filled at decision time, e.g. `{"coir.cosqa.ndcg10":{"from":0.41,"to":0.47}}`.
- `reason`: only on `rejected`; one of the enumerated revert reasons.
- Rule: **never delete or rewrite a line.** A re-test of a rejected idea is a *new* id. This is how
  runs avoid repeating work and progress compounds — the file is the institutional memory.

Companion files in `eval/benchmark/`:
- `baseline.json` — current committed scorecard (the thing every candidate is compared to).
- `run-<id>.json` — each candidate scorecard (kept for trend lines).
- `ledger.json` — append-only run log: `{run_id, ts, item, decision, deltas, tokens, usd, secs, plateau_counter}`.

---

## 5. Anti-overfitting: tune vs held-out vs public

The own-repo gold set (30 q) is small enough that an agent can trivially tune knobs until every
query passes — that is overfitting, not improvement. Three-tier defense:

1. **Split `eval/gold.ts`.** Deterministic split (hash of query → bucket), e.g. 18 tune / 12
   held-out. The agent's inner loop (STEP 4.1) optimizes the **tune** split. The **held-out** split
   is a gate the agent must not inspect case-by-case during implementation.
2. **Public gate (STEP 4.4).** Require a non-negative move on a CoIR subset (`cosqa` +
   `codesearchnet`). A change that helps our own repo but not an independent public corpus is
   repo-overfit and is rejected.
3. **Keep rule requires BOTH** (see §6): strict gain on the experiment's `target_metric` on its
   named split, **and** no regression on held-out **and** no regression on the public subset.

Karpathy precedent: a pinned, agent-unmodifiable eval shard (`prepare.py`/`evaluate_bpb`). Mirror it:
the held-out split and the CoIR adapter scoring code are **owned by the harness, and the experiment
branch must not modify them** (enforce in code review / a guard test that checks those files are
unchanged on the branch).

---

## 6. Keep / revert decision rule (exact)

Let `M` = the experiment's declared `target_metric`. Candidate `c`, baseline `b`.

```
KEEP if ALL of:
  (1) candidate passed STEP 3 hard gates (typecheck, lint, test).            # safety, non-negotiable
  (2) c[M] > b[M] + epsilon                  # strict improvement on the declared metric
        epsilon = 0.5 * run_to_run_noise(M)  # measured: stddev of M over 3 baseline re-runs
  (3) c.heldout.mrr      >= b.heldout.mrr      - tol_q     # held-out not regressed (tol_q = noise band)
  (4) c.heldout.ndcg10   >= b.heldout.ndcg10   - tol_q
  (5) c.coir_subset.ndcg10 >= b.coir_subset.ndcg10 - tol_q  # public not regressed (if 4.4 ran)
  (6) c.perf.searchP95   <= b.perf.searchP95 * 1.10         # latency budget: <=10% p95 regression
  (7) c.perf.memDeltaMb  <= b.perf.memDeltaMb + 5           # memory budget
  (8) c.adoption unchanged or improved (if 4.3 ran)         # don't break tool routing
ELSE REVERT (record which clause failed as `reason`).
```

Notes:
- **Strict, not >=, on the target** (clause 2) so noise doesn't ratchet the baseline upward by luck.
- The **epsilon and tolerance bands come from measured run-to-run noise**, not guesses: STEP 0.3
  re-runs the baseline 3× to estimate stddev per metric and stores it in `baseline.json`. Without
  this, the loop will "keep" noise and slowly corrupt the baseline.
- A latency- or memory-only experiment (no quality change) flips the rule: clause 6/7 become the
  strict target and clauses 2–5 become "must not regress quality."
- Simplicity tiebreak (Karpathy): if two experiments tie on the metric, prefer the one with the
  smaller diff / fewer dependencies.

---

## 7. Scheduling: local cron vs cloud routine

**Decision: local.** Run the loop on this machine via a durable scheduled trigger that wakes a
headless `pi` (or a `bun` script driving the agent) pointed at the runbook in §3.

| Factor | Local cron / agent | Cloud routine |
|---|---|---|
| TurboPuffer keys + OpenRouter key | present at `~/.pi/agent/semantic-search.env` | absent; would require exfiltrating secrets to the cloud |
| The repo + git history | local working tree | needs clone + push creds; commits land remotely, drift risk |
| `tsc` / `bun test` / `*.live.test.ts` | run natively against real TurboPuffer | sandbox may lack Bun + live network to TurboPuffer/OpenRouter |
| Installed Pi extension (user depends on it) | same machine — loop can verify it still loads | can't validate the local install |
| Cost ceiling enforcement | local ledger + `pi` token caps | harder to bound a remote agent |
| TurboPuffer namespace cache reuse | warm, same region/account | cold, re-embeds (cost) |

The only thing a cloud routine buys is "runs while the laptop is asleep" — not worth re-platforming
keys, repo, and a live vector DB. **Recommendation: local.**

Mechanism, in preference order:
1. **System `launchd` (macOS) / `cron`** invoking a wrapper script. Most robust (survives Claude/pi
   session death, runs unattended). Wrapper: `cd repo && source keys && pi -p --runbook
   docs/research/auto/recurring-auto-research-loop.md ...` then logs to `eval/benchmark/ledger.json`.
   This is the production answer.
2. **`CronCreate durable:true`** (this session's scheduler) for a quick start — but note it is
   session-scoped and **recurring jobs auto-expire after 7 days**; not suitable for an unattended
   long-running loop. Good for a supervised first week.

**Schedule:** weekly, off-peak, off the :00 mark — e.g. `17 3 * * 0` (Sun 03:17 local). Code-search
quality does not need daily iteration, and a weekly cadence keeps cost bounded and gives time to
review each kept change. Bump to daily only after the loop has proven 3 clean runs.

### Self-sufficient runbook prompt (what the scheduled agent receives each run)

The cron wrapper must hand the agent a prompt that needs zero human context:

```
You are the recurring code-search improver for the repo at
..
Read docs/research/auto/recurring-auto-research-loop.md §3 (the runbook) and follow it EXACTLY,
one experiment, then stop. Keys are in ~/.pi/agent/semantic-search.env (source them).
Hard rules: never push to or break main unless STEP 6 keep is proven green; never commit secrets;
never modify the held-out gold split or the CoIR adapter scoring code on an experiment branch;
respect the per-run token/cost ceiling in §8 and abort if exceeded; if STEP 0.4 says plateaued, exit.
Append your decision to eval/benchmark/ledger.json. Output the final scorecard JSON only.
```

---

## 8. Guardrails (hard limits)

1. **Token / cost ceiling per run.** Set a fixed cap (e.g. `PI` token budget + a USD soft cap of
   $2/run for embeddings+rerank+CoIR-subset). STEP 4.4 runs only a CoIR *subset* (`cosqa`+
   `codesearchnet`), never the full 10-dataset board every run. If the experiment doesn't change
   retrieval quality, skip CoIR entirely. Track spend in `ledger.json`; abort the run if exceeded.
2. **Don't re-embed every run.** Cache the benchmark TurboPuffer namespace keyed by
   `(embedding_model, dimensions, corpus_sha)`. STEP 4 reuses it unless the experiment changes the
   embedder or chunker. The own-repo eval already does this via content-addressed chunk ids +
   manifest (`src/index/Manifest.ts`, incremental re-index ≈5ms) — extend the same gate to the CoIR
   corpus namespace.
3. **Plateau / no-improvement stop.** STEP 0.4: if the last **N=3** runs all REVERTED, stop
   scheduling new experiments and emit a "needs human / needs new research" signal (the backlog is
   exhausted or the easy wins are gone). Reset the counter on any KEEP.
4. **Never break the installed Pi extension.** All work on a branch; main only advances on a proven-
   green keep (STEP 6, gated by typecheck+lint+test). Optionally add a post-keep smoke check that
   `pi` still loads `src/pi/extension.ts` (reuse `scripts/pi-smoke.ts`).
5. **Never commit secrets.** Keys live in `~/.pi/agent/semantic-search.env` (outside the repo) and
   `.gitignore` already excludes `.eval-cache/`, `scratch/`, logs. The loop writes only scorecards
   (`eval/benchmark/*.json`) and `backlog.jsonl` to the repo. Add a guard: the commit step greps the
   staged diff for key patterns (`sk-`, `TURBOPUFFER`, `OPENROUTER`) and aborts on match.
6. **Held-out + adapter immutability.** A guard test asserts the experiment branch did not modify the
   held-out gold split or the CoIR scoring code (clause from §5).

---

## 9. Concrete next actions (in order)

1. Add **`OPENAI_API_KEY`** to `~/.pi/agent/semantic-search.env` (BLOCKER — live eval fails without it).
2. Split `eval/gold.ts` into deterministic **tune (18) / held-out (12)** buckets; expose both to
   `eval/retrieval.ts` and have it emit `{tune:{...}, heldout:{...}}` in the scorecard.
3. Write **`eval/benchmark/baseline.json`** by running the harness on `main` 3× (capture per-metric
   noise stddev for epsilon/tolerance).
4. Build **`eval/benchmark/coir_adapter.py`** (BEIR-style `search()` shelling to the CLI) + add CLI
   `--json` output emitting `docid`+`score`. Run on `cosqa` once to get our real CoIR NDCG@10 number.
5. Seed **`eval/backlog.jsonl`** with the four items in §4 (adapter, rerank-on-CoIR, code embedder,
   RRF-k sweep).
6. Write the loop driver (a `bun` script or a `pi` runbook) implementing §3, with the §6 keep rule
   and §8 guardrails.
7. Schedule via **`launchd`/`cron`** weekly `17 3 * * 0`; supervise the first 3 runs before trusting
   it unattended.

---

## Sources

- CoIR leaderboard (top-8 NDCG@10, datasets): https://archersama.github.io/coir (fetched 2026-06-20)
- CoIR paper (ACL 2025 Main, MTEB/BEIR schema, 10 datasets, NDCG@10): https://arxiv.org/abs/2407.02883 ; https://aclanthology.org/2025.acl-long.1072.pdf
- CoIR code + `coir-eval` pip + custom-model interface: https://github.com/CoIR-team/coir
- "Beyond Retrieval" (CoIR lacks a reranking track — our opening): https://arxiv.org/pdf/2605.04615
- CodeRAG-Bench (retrieval→SWE-bench downstream, 27.4% gain): https://aclanthology.org/2025.findings-naacl.176.pdf
- Karpathy autoresearch loop (propose→implement→run→evaluate→keep/revert, results.tsv, pinned eval shard, simplicity criterion): https://kingy.ai/ai/autoresearch-karpathys-minimal-agent-loop-for-autonomous-llm-experimentation/
- A Self-Improving Coding Agent (branch-per-experiment, gated): https://arxiv.org/html/2504.15228v1
- OpenAI Self-Evolving Agents cookbook (eval-gated retraining loop): https://developers.openai.com/cookbook/examples/partners/self_evolving_agents/autonomous_agent_retraining

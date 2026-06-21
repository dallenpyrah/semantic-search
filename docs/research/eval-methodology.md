# Eval Methodology — Search Quality, Agent Efficiency, Latency/Memory

Research brief for the Effect v4 semantic code-search CLI + Pi agent extension.
Goal: a cheap, reproducible eval harness that lets us iterate search quality and agent
efficiency until the score plateaus, runnable on one machine with the provided keys.

Grounded in: CodeSearchNet challenge (the canonical code-search eval), modern RAG-eval
practice, the SWE-bench / Claw-SWE-Bench agent-efficiency line, Node memory-leak practice,
Effect v4 source (`effect-smol`), and the team's `@plusone/evals` harness pattern.

---

## TL;DR decisions

1. **Three eval suites, one JSON scorecard.** `retrieval`, `agent`, `perf`. Each is a Bun
   script that emits a `scorecard.json` + a human matrix and sets an exit code. Iterate by
   diffing scorecards run-over-run.
2. **Two-tier gold set, built from a real repo, mostly for free.** Tier-1 = symbol/file
   ground truth mined deterministically from the repo (definition site of a symbol named in
   the query). Tier-2 = a small LLM-judged relevance layer on top of the *retrieved* set to
   catch "different-but-correct" hits. Tier-1 is the regression gate; Tier-2 calibrates it.
3. **Retrieval metrics: Recall@k, MRR, nDCG@10, Success@k (k ∈ {1,5,10,20}).** nDCG@10 is the
   headline (CodeSearchNet's metric); Success@1/@10 and MRR are the agent-relevant signals.
4. **Agent efficiency is a joint distribution, not a single number.** Report
   `(solve_rate, tool_calls, total_context_tokens, wall_clock)` as paired with/without-tools
   deltas on a fixed task set, ≥3 seeds. Pass@1 alone is misleading — same correctness can
   cost 3× the tokens.
5. **Latency/perf: index wall-time + p50/p95/p99 search latency via `Metric.summary`,
   watcher steady-state RSS sampled over N hours of synthetic churn, leak = positive RSS
   regression slope after warm-up (ratchet vs sawtooth).**
6. **Determinism is the whole game.** Pin embedding model + dims, fix the repo at a commit
   SHA, fix query set + seeds, set `temperature: 0` for the agent and LLM judge, snapshot the
   index. A non-deterministic eval cannot show a plateau.

---

## 1. Retrieval-quality eval

### 1.1 Why these metrics

- **CodeSearchNet** (Husain et al., 2019, arXiv:1909.09436) is the canonical semantic-code-search
  benchmark. It scores systems with **nDCG over expert relevance annotations** on a fixed set of
  natural-language queries; the large training/eval corpus uses **(docstring, function) pairs** as
  cheap distant-supervision labels (docstring = query, function body = the one relevant document).
  Two takeaways we copy: (a) docstring/symbol-as-query is a free, large-scale label source;
  (b) nDCG is the headline because code search is a ranking problem, not a set-membership problem.
- Modern RAG-eval consensus (Evidently, Confident AI/DeepEval, futureagi, labelyourdata, 2025–2026):
  with labeled gold docs per query use **Precision@k, Recall@k, MRR, nDCG@k**; switch to LLM-judge
  versions only when you lack labels. We have cheap labels for Tier-1, so we use the classical metrics
  there and reserve the LLM judge for Tier-2 calibration.

Metric definitions we implement (binary relevance for Tier-1, graded for Tier-2):

| Metric | Definition (per query, then mean over queries) | What it tells us |
|---|---|---|
| **Recall@k** | `|relevant ∩ top-k| / |relevant|` | Did we surface the answer anywhere in top-k? The agent's real ask. |
| **Success@k** (a.k.a. Hit@k) | `1` if ≥1 relevant in top-k else `0` | Coarse pass/fail per query; easy to read run-over-run. |
| **MRR** | `mean(1 / rank_of_first_relevant)` | Is the answer ranked high? Drives how few results the agent must read. |
| **nDCG@10** | `DCG@10 / IDCG@10`, `DCG = Σ rel_i / log2(i+1)` | Graded ranking quality; headline metric. |

For Tier-1 (single known-relevant file/line) Recall@k collapses toward Success@k and MRR is the
discriminating signal. nDCG@10 only becomes graded once Tier-2 adds multiple relevance levels.

### 1.2 Gold-set construction — cheap and reproducible

**Pin the corpus.** Choose one real repo (candidate: the `effect-smol` vendored tree, or this
project's own repo once it exists), pin it at an explicit commit SHA. The gold set is only valid
against that SHA; record it in the scorecard.

**Tier-1 — deterministic symbol/file ground truth (no LLM, no human).**
The cheapest reliable label: *a query that names a symbol is "answered" by that symbol's definition
site.* Build queries automatically by walking the AST (you already have AST-aware chunking):

- For each exported function/class/type/const `S` defined at `file:line`, emit gold rows:
  - **doc-query**: the symbol's leading docstring/JSDoc (NL → defn). CodeSearchNet-style.
  - **NL-query**: a templated paraphrase, e.g. `"function that <verb-from-name> <object-from-name>"`
    derived from the identifier (`createHttpClient` → `"create http client"`). No model needed.
  - **signature-query**: `"<SymbolName>"` and `"where is <SymbolName> defined"`.
  - relevant = the chunk(s) overlapping `file:line` of `S`'s definition.
- This yields hundreds–thousands of query→(file,line) pairs for free, fully reproducible, and
  regenerable when the repo changes. It is *distant supervision*: noisy but unbiased and cheap.

A second free label source: **commit/PR history.** For a bug-fix commit, the NL = commit subject /
issue title, relevant = the files the commit touched. This is the SWE-bench labeling trick applied
to retrieval and gives realistic "where do I change this?" queries.

Keep Tier-1 to a **curated subset** (e.g. 100–200 hand-checked queries) as the *regression gate*,
plus a larger auto-generated pool for trend tracking. The curated subset is what blocks a regression.

**Tier-2 — LLM-judge relevance on the retrieved set (calibration, not gate).**
Tier-1's weakness: it marks exactly one site relevant, so a retriever that returns an equally-valid
*caller*, *test*, or *re-export* is wrongly penalized. Fix this the standard RAG way — judge the
*actually retrieved* top-k, not a fixed gold list:

- For each query, run the retriever, take top-10, ask an LLM judge (Claude, `temperature: 0`) to
  grade each retrieved chunk on a 0–3 graded scale (3 = directly answers, 2 = strongly related,
  1 = tangential, 0 = irrelevant), returning structured JSON.
- Use the graded labels to compute graded nDCG@10 and to *correct* Tier-1 false-negatives (a Tier-1
  miss that the judge rates ≥2 is a labeling gap, not a retriever failure).
- **Calibrate the judge against the curated Tier-1 subset** (Anyscale's rule: LLM-judges have
  positional/length bias; validate against human-checked gold before trusting). Track judge↔Tier-1
  agreement; if it drops, the judge prompt is drifting.

Cost control: Tier-2 only runs on the curated subset and only top-10, so it's ~100 queries × ~10
short grades per eval run — cheap enough to run every iteration.

### 1.3 Retrieval eval — runnable shape

```ts
// scripts/eval/retrieval.ts  — run: bun scripts/eval/retrieval.ts --repo-sha <sha>
import { Effect } from "effect"

type GoldRow = {
  readonly id: string
  readonly query: string
  readonly relevant: ReadonlyArray<string> // chunk ids that overlap the defn site
  readonly tier: 1 | 2
}
type Retrieved = { readonly chunkId: string; readonly score: number }

const dcg = (rels: ReadonlyArray<number>): number =>
  rels.reduce((acc, rel, i) => acc + rel / Math.log2(i + 2), 0)

const ndcgAt = (ranked: ReadonlyArray<number>, k: number): number => {
  const top = ranked.slice(0, k)
  const ideal = [...ranked].sort((a, b) => b - a).slice(0, k)
  const idcg = dcg(ideal)
  return idcg === 0 ? 0 : dcg(top) / idcg
}

const reciprocalRank = (ranked: ReadonlyArray<boolean>): number => {
  const i = ranked.findIndex(Boolean)
  return i === -1 ? 0 : 1 / (i + 1)
}

const recallAt = (ranked: ReadonlyArray<boolean>, relevantCount: number, k: number): number =>
  relevantCount === 0 ? 0 : ranked.slice(0, k).filter(Boolean).length / relevantCount

const scoreQuery = (gold: GoldRow, hits: ReadonlyArray<Retrieved>) => {
  const relSet = new Set(gold.relevant)
  const binary = hits.map((h) => relSet.has(h.chunkId))
  const graded = hits.map((h) => (relSet.has(h.chunkId) ? 3 : 0)) // Tier-2 overrides with judge grades
  return {
    id: gold.id,
    mrr: reciprocalRank(binary),
    recall_at_10: recallAt(binary, relSet.size, 10),
    success_at_1: binary.slice(0, 1).some(Boolean) ? 1 : 0,
    success_at_10: binary.slice(0, 10).some(Boolean) ? 1 : 0,
    ndcg_at_10: ndcgAt(graded, 10)
  }
}
```

The harness loads the pinned index, runs every gold query through the production search path
(semantic, BM25, and hybrid as separate "systems"), aggregates per-system means, and writes them
into the scorecard. Compare **semantic vs BM25 vs hybrid vs hybrid+rerank** as four columns so the
reranker's contribution is visible.

### 1.4 Gotchas

- **Chunk-boundary aliasing.** "Relevant" is a `file:line`, but retrieval returns chunks. A hit
  counts if its `[startLine,endLine]` overlaps the gold line. Without this, AST re-chunking silently
  tanks recall. Store gold as `(file, line)` and resolve to chunk-ids at score time, not bake time.
- **Train/eval leakage** (Beyond Retrieval, arXiv:2605.04615 warns overlap can inflate metrics up to
  100%). Our embedding model is a frozen API (`text-embedding-3-large`), so there's no training
  leakage on *our* side — but do not also feed docstrings to the indexer if the gold query *is* that
  docstring, or you measure memorization. Either index code-only, or hold out docstring queries.
- **Distant-supervision noise is fine in aggregate.** Don't chase individual Tier-1 misses; trust the
  mean over a fixed query set. That's what makes it cheap.

---

## 2. Agent-efficiency eval

### 2.1 The core insight (primary source)

Claw-SWE-Bench (arXiv:2606.12344, Jun 2026): *"A real coding agent is not a single model call: it
repeatedly reads files, edits code, runs commands… The same Pass@1 can correspond to very different
token usage."* SWE-bench itself (swebench.com) is correctness-only (resolve rate). The efficiency
delta is exactly the gap our tool is supposed to close: fewer file reads / greps to find the right
code → fewer tool calls, fewer context tokens, faster.

So agent efficiency is a **paired A/B**: same task set, same agent, **with our semantic-search tools
vs without** (baseline = grep/read/glob only). Measure the four-tuple and report the delta.

### 2.2 Task set and metrics

**Task set.** 20–40 fixed "find-and-answer" / "find-and-fix" tasks against the pinned repo, each with
a deterministic verifier (this is exactly the `@plusone/evals` pattern: a deterministic
`expectedAnswer` + assertions on the recorded trajectory). Two task shapes:

- **Locate tasks**: "Where is X handled / what file implements Y?" Verified by checking the agent's
  cited file matches gold (cheap, no mutation).
- **Patch tasks** (optional, higher fidelity): SWE-bench-style — apply the agent's edit, run the
  repo's test that the gold commit added; pass = test goes red→green.

**Metrics per task (mean + distribution over seeds):**

| Metric | Source | How to capture |
|---|---|---|
| `solved` (0/1) | deterministic verifier | gold-file match or test red→green |
| `tool_calls` | agent trajectory | count tool invocations until terminal answer |
| `search_tool_calls` | trajectory | of those, how many were our tools (adoption signal) |
| `total_context_tokens` | model usage | sum of input+output tokens across all turns |
| `wall_clock_ms` | `Clock.currentTimeNanos` | start→terminal answer |
| `turns` | trajectory | model round-trips |

Token counting: read `usage` from the model response if exposed; otherwise count with a BPE tokenizer
(`tiktoken`, `o200k_base` for current OpenAI / approximate for Claude). Prefer provider-reported usage
— it's exact.

**Headline efficiency numbers** = paired deltas on the solved-subset:
`Δtool_calls`, `Δtotal_context_tokens`, `Δwall_clock`, and `solve_rate_with − solve_rate_without`.
Report them together — a tool that cuts tokens 40% but drops solve rate is a regression. Plot/record
the `(solve_rate, tokens)` pair, not a scalar.

### 2.3 Repeatability

- `temperature: 0` and a fixed model/version pin. Even then agents are non-deterministic (tool
  ordering, timeouts), so run **≥3 seeds per task** and report mean ± stderr. Artificial Analysis's
  coding-agent index averages **pass@1 across 3 runs** for exactly this reason — adopt that as the floor.
- Record the **full trajectory** (every tool call + args + result, like `@plusone/evals` persists
  function calls) into the scorecard so a regression is debuggable without a re-run.
- Mock nothing in the agent path that affects token/latency counts; mock only nondeterministic
  externalities that don't (e.g. wall-clock for the timestamp line).

### 2.4 Gotcha

- **Token attribution.** "Context tokens" must include tool *results* the agent reads back, not just
  prompts — that's where a verbose search tool blows the budget. Count the bytes/tokens of every tool
  result fed into the next turn. A search tool that returns whole files looks great on tool-call count
  and terrible on tokens.

---

## 3. Latency / memory eval

### 3.1 Index + search latency

- **Index wall-time**: time the full cold index build over the pinned repo; record total, and per
  stage (chunk, embed, upsert). Embedding is network-bound (OpenAI) → also record `embed_calls` and
  `embed_tokens` so cost is visible. Re-run gives incremental-index time.
- **Search latency p50/p95/p99**: drive the gold query set through search and collect latencies in an
  Effect v4 **`Metric.summary`**, which "calculates quantiles over a sliding time window" — exactly
  percentiles. Grounded signature from `effect-smol/packages/effect/src/Metric.ts`:

  ```ts
  import { Effect, Metric } from "effect"

  const searchLatency = Metric.summary("search_latency_ms", {
    maxAge: "60 seconds",
    maxSize: 4096,
    error: 0.01,
    quantiles: [0.5, 0.95, 0.99]
  })

  const timedSearch = (query: string) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeNanos
      const hits = yield* search(query)
      const elapsedMs = Number(yield* Clock.currentTimeNanos - start) / 1_000_000
      yield* Metric.update(searchLatency, elapsedMs)
      return hits
    })

  // after the run:
  const state = yield* Metric.value(searchLatency) // { quantiles: [[0.5, p50], [0.95, p95], ...] }
  ```

  `Clock.currentTimeNanos: Effect<bigint>` and `Clock.currentTimeMillis: Effect<number>` are the
  real v4 signatures (`effect-smol/packages/effect/src/Clock.ts`). Report cold (first query, cache
  cold) and warm separately — embedding the query string is itself a network round-trip and will
  dominate cold p95.

### 3.2 Watcher steady-state memory + leak detection

The watcher is the long-lived process; that's where a leak actually hurts. Methodology (standard
Node practice — DEV/oneuptime/halodoc 2026, "ratchet vs sawtooth"):

1. Start the watcher pointed at a scratch repo. Warm up (let GC settle), record baseline RSS.
2. Drive **synthetic file churn**: a loop that creates/edits/deletes/renames N files per second for
   the test window (drives re-chunk + re-embed + re-upsert through the real watcher path).
3. Sample `process.memoryUsage()` (`rss`, `heapUsed`, `external`, `arrayBuffers`) on a fixed interval
   (e.g. every 5 s) into a CSV/JSONL.
4. **Leak test = linear regression on RSS *after* warm-up.** Healthy: sawtooth — grows under churn,
   GC drops it back to ~baseline; slope ≈ 0. Leaking: ratchet — grows, GCs, never returns to
   baseline; **slope > 0** that persists. Decision rule: fail if post-warmup RSS slope > a small
   threshold (e.g. > 1 MB/min sustained) over the window.
5. For a *full* leak run, do N hours (e.g. 2–8 h) of churn; for CI, a 5–10 min window catches the
   gross ratchet. Run `--expose-gc` and call `global.gc()` before each sample to separate "live
   retained" from "uncollected garbage" — a slope that survives forced GC is a real leak.
6. If the slope flags, capture two heap snapshots (start vs end), diff in Chrome DevTools / via
   `v8.writeHeapSnapshot()`, look for the growing retainer (classic culprits here: an unbounded
   debounce map keyed by path, listeners not removed on unlink, accumulated chunk buffers).

Memory scorecard fields: `rss_baseline_mb`, `rss_p95_mb`, `rss_slope_mb_per_min`,
`leak_suspected` (bool), `churn_events`, `window_minutes`.

---

## 4. Wiring evals as runnable scripts → JSON scorecard

Follow the `@plusone/evals` shape exactly — it's the proven local pattern:

- **Plain Bun scripts**, not Effect CLI (there is no `cli` package in `effect-smol`; the team runs
  `bun src/cli.ts`). Effect is used *inside* for the search/index/metric logic; the script shell is
  thin.
- **IO injection** for testability (the team injects `{ fetch, spawn, now, sleep }`); we inject the
  clock and the embedding client so the harness itself is testable and seedable.
- **One scorecard JSON per suite**, plus a printed matrix (their `formatMatrix`) for humans.
- **Exit codes** drive the iterate-to-plateau loop: `0` pass, `1` regression vs baseline, `2`
  skipped/missing-prereq (their `exitCodeFor` convention).

Commands:

```bash
# retrieval quality (no agent, no mutation) — the fast inner loop
bun scripts/eval/retrieval.ts --repo-sha <sha> --systems semantic,bm25,hybrid,hybrid+rerank

# agent efficiency (with vs without our tools), 3 seeds
bun scripts/eval/agent.ts --repo-sha <sha> --seeds 3 --tasks locate

# latency + memory (perf gates)
bun scripts/eval/perf.ts --repo-sha <sha>
bun scripts/eval/perf.ts --watcher --minutes 10 --churn 5   # CI leak smoke
bun scripts/eval/perf.ts --watcher --hours 4  --churn 20    # full leak run

# combined + scorecard
bun scripts/eval/all.ts --repo-sha <sha> --out scorecards/$(date +%s).json
```

Scorecard schema (single object, machine-diffable):

```jsonc
{
  "meta": { "repoSha": "…", "embeddingModel": "text-embedding-3-large", "dims": 3072,
            "ts": 1750000000, "git": "<eval-code-sha>" },
  "retrieval": {
    "semantic":      { "recall_at_10": 0.74, "mrr": 0.61, "ndcg_at_10": 0.66, "success_at_1": 0.55, "n": 180 },
    "bm25":          { … },
    "hybrid":        { … },
    "hybrid+rerank": { … }
  },
  "agent": {
    "with_tools":    { "solve_rate": 0.85, "tool_calls": 4.2, "context_tokens": 18400, "wall_ms": 21000 },
    "without_tools": { "solve_rate": 0.80, "tool_calls": 11.1, "context_tokens": 52300, "wall_ms": 47000 },
    "delta":         { "tool_calls": -6.9, "context_tokens": -33900, "wall_ms": -26000, "solve_rate": 0.05 },
    "seeds": 3
  },
  "perf": {
    "index_ms": 41000, "embed_calls": 1200, "embed_tokens": 380000,
    "search_ms": { "p50": 180, "p95": 420, "p99": 690 },
    "watcher": { "rss_baseline_mb": 95, "rss_p95_mb": 130, "rss_slope_mb_per_min": 0.2,
                 "leak_suspected": false, "window_minutes": 10, "churn_events": 3000 }
  }
}
```

**Iterate-to-plateau loop.** Keep scorecards in `scorecards/`. A tiny `compare.ts` diffs the latest
two and prints metric deltas; plateau = the headline metrics (nDCG@10, agent Δtokens) stop moving
beyond noise (± stderr) across 2–3 consecutive iterations. Gate CI on: retrieval nDCG@10 ≥ baseline,
agent `context_tokens` not regressed, `leak_suspected == false`.

---

## 5. Citations

- CodeSearchNet Challenge — Husain et al., 2019 — arXiv:1909.09436 (nDCG, docstring/function distant
  supervision, 99-query expert-annotated eval).
- Beyond Retrieval: A Multitask Benchmark and Model for Code Search — arXiv:2605.04615 (train/eval
  overlap can inflate metrics up to 100%).
- CoIR: A Comprehensive Benchmark for Code IR — arXiv:2407.02883 (code-IR metric conventions).
- Claw-SWE-Bench — arXiv:2606.12344, Jun 2026 (same Pass@1 ↔ very different token usage; agents are
  multi-call trajectories).
- SWE-bench — https://www.swebench.com/ (resolve-rate / red→green verification pattern).
- Artificial Analysis coding-agents methodology — https://artificialanalysis.ai/methodology/coding-agents-benchmarking
  (pass@1 averaged across 3 runs).
- RAG eval metric conventions — Evidently (evidentlyai.com/llm-guide/rag-evaluation),
  Confident AI/DeepEval, futureagi, labelyourdata (2025–2026): Precision@k/Recall@k/MRR/nDCG@k with
  labels; LLM-judge versions otherwise.
- Anyscale RAG evaluation docs — https://docs.anyscale.com/rag/evaluation (calibrate LLM-judge against
  human-verified golden sets; positional/length bias).
- Node memory-leak practice — oneuptime (2026-01-26), DEV axiom_agent (2026-04-02, ratchet vs sawtooth),
  halodoc (heap-snapshot diffing).
- Effect v4 source — `effect-smol/packages/effect/src/Metric.ts` (`Metric.summary` quantiles over
  sliding window; `histogram`), `effect-smol/packages/effect/src/Clock.ts`
  (`currentTimeMillis: Effect<number>`, `currentTimeNanos: Effect<bigint>`).
- Team pattern — `plusone/packages/evals/src/runner.ts` (deterministic expected answers, persisted
  tool-call trajectory assertions, `formatMatrix`, `exitCodeFor`, IO injection `{fetch,spawn,now,sleep}`).

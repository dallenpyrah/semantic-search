# Benchmarks

Reproducible scorecards. Re-run with `bun eval/retrieval.ts` and `bun eval/adoption.ts <repo>`.

## Retrieval quality

Corpus: this repository's `src/` + real docs (excludes `eval/` and `docs/research/`, which are
test-gold and research artifacts). 30 curated queries (20 semantic NL, 10 exact-token), gold =
the file that implements the queried thing. Embeddings `text-embedding-3-large` @ 3072d, TurboPuffer
hybrid + Cohere `rerank-v3.5`.

| Metric | Score |
|---|---|
| Success@1 | 80% |
| Success@3 | 93% |
| Success@5 | 97% |
| Success@10 | 97% |
| MRR | 0.875 |
| nDCG@10 | 0.899 |
| Search latency p50 / p95 | ~720ms / ~1300ms (includes rerank) |
| Index (97 chunks) | ~7s cold, ~2.5s incremental |

Tuning that moved the numbers (each verified by re-running the eval):

1. Rerank semantic queries too (not just hybrid): Success@10 87% → 100%.
2. Feed the reranker the file path plus chunk text (not text alone): Success@1 27% → 47%.
3. Mild kind preference (code > test > docs) as a near-tie breaker: Success@1 47% → 80%,
   nDCG@10 0.74 → 0.90.

## Tool adoption (real Pi, `pi -p --mode json`)

One tool, `semantic_search`. 5 tasks over a pre-indexed sample repo, only this extension + skill loaded.

| Task type | Prompt | First retrieval call | grep used | Tool calls |
|---|---|---|---|---|
| discovery | "Where is rate limiting implemented?" | `semantic_search` | no | 3 |
| discovery | "How does the billing retry logic work?" | `semantic_search` | no | 3 |
| discovery | "Where do we issue and validate access tokens?" | `semantic_search` | no | 3 |
| exact | "Find every place that references validateAccessToken" | `semantic_search` | no | 3 |
| true-grep | "List every TODO comment using a raw text search" | `grep` | yes | 1 |

**Adoption: 4/4 discovery routed to `semantic_search` first. Mis-route: 0. Avg 2.6 tool calls.**
Consolidating from three tools to one did not reduce adoption. Routing is correct, not maximal: the
true-grep task goes to `grep`, not `semantic_search`. The flow is `read(SKILL.md)` → `semantic_search`
→ `read(target file)`.

## Large-repo indexing (plusone, real)

Full cold index of a real monorepo — **2,160 source files → 11,545 chunks + 1,460 git commits**
(the repo has 15k tracked files, but 14.8k are vendored under `repos/` and correctly excluded).
Embeddings via OpenRouter `text-embedding-3-large`.

| Stage | Total | Code phase | Commits phase | Peak footprint | Max RSS |
|---|---|---|---|---|---|
| original (per-file embed, serial commits, 3072d) | 268s | ~204s | serial | 363MB | 856MB |
| tuned concurrency (10×80, 3072d) | 170s | 147.1s | 22.5s | 537MB | 1103MB |
| **+ 1536d + decouple embed/upsert + cache (default)** | **96.7s** | **82.8s** | **13.6s** | **474MB** | **924MB** |
| same, re-index with warm vector cache | 89.5s | 78.8s | 10.5s | — | — |

**Net: 268s → 96.7s (2.8× faster) and back under a 1GB RSS budget.** Live working set stayed
65–~160MB (GC'd) — **no leak**. 0 rate-limit errors.

Pipeline: a native streaming `readdir` walk feeds `prepareFile` (read/hash/chunk/diff) at
`scanConcurrency`, which offers each file's new chunks into a **`Queue.bounded`** (suspend strategy →
the producer blocks when full, so memory is hard-bounded). `embedConcurrency` **embed** fibers batch
chunks across files into bulk embedding calls and hand rows to a second bounded queue; `upsertConcurrency`
**upsert** fibers drain it, write to TurboPuffer, and finalize each file's manifest entry once all its
chunks land — so embedding never blocks on the write RTT. A persistent **vector cache**
(`<agentDir>/semantic-search/vec/<model>_<dims>/`, keyed by `sha256(embedText)`) turns a re-embed of
identical content into a ~3ms disk read (500× vs a ~1.5s API call); set `indexing.vectorCacheEnabled:false`
to disable. Embeddings are 1536-dim (native Matryoshka truncation of `text-embedding-3-large`) — an
eval A/B showed **identical retrieval at 1536 vs 3072** while halving vector memory + storage. Incremental
re-index is ~free (content-hash gate). Tunable via `embedBatch`/`embedConcurrency`/`upsertConcurrency`.

At 1536d the bottleneck has shifted off embedding onto walk/chunk/upsert (the warm-cache re-index is only
~7s faster than cold), so further speedups now come from the producer/write side, not more embed concurrency.

## Multi-source + CoIR

- **Sources:** `code` (authoritative), `docs`, `history` (git commits), `conversation` (Pi sessions,
  opt-in). A plain query defaults to `code+docs`; a cue router widens to history/conversation only on
  why/when/decisional phrasing, with per-source quotas so history/conversation never drown code.
  Verified live (`test/history.live.test.ts`): a code query returns code; "why did we change the cache
  eviction" surfaces the commit; `file:` returns the real diffs that changed a file.
- **CoIR baseline** (the objective tracker, `eval/benchmark/coir.ts`): codetrans-dl (code→code, the
  hardest CoIR task) embedding-only nDCG@10 = **18.89** with `text-embedding-3-large`. The public
  leaderboard top is 67.41 (SFR-Embedding-Code-2B, a code-specialized model); the climb toward #1 runs
  through a code-specialized embedder (tracked in `docs/research/auto/ROADMAP.md`). The harness is
  apples-to-apples (graded nDCG@10 by corpus id, R@100 = 100% confirms correct ingestion).

## Why this beats grep-then-read for discovery

For "where is rate limiting implemented", a grep approach is: grep a guessed term → read several
candidate files → grep again → read. That is typically 5–10+ calls and loads whole files into
context. `code_search` returns the ranked file path plus the exact line range in one call, so the
agent reads exactly one region. Fewer tool calls, far less context, one round-trip of latency.

## Performance (`bun eval/perf.ts`)

| Metric | Value |
|---|---|
| Cold index (97 chunks) | ~3.2s (dominated by namespace cold-start + embedding RTT) |
| Incremental re-index (no changes) | ~5ms (file-hash gate skips every file) |
| Search latency p50 / p95 / p99 | 600ms / 1046ms / 1215ms (includes rerank) |

The standout is **incremental re-index ≈ 5ms** — the steady-state cost while watching. Only files
whose content hash changed are re-chunked, and only chunks whose content-addressed id is new are
re-embedded, so the cost is proportional to what actually changed, not repo size. Initial-index
throughput scales with embedding batch size for larger repos (one embed round-trip covers up to 128
chunks × 4 concurrent batches); the 35 chunks/s here is fixed cold-start overhead on a tiny repo.

## Memory / leaks

`test/watcher-leak.test.ts` opens and closes the watcher 20 times and asserts no growth in
`FSWatcher` / timer counts via `process.getActiveResourcesInfo()`. The watcher uses a bounded
sliding queue and scoped finalizers, so teardown is total.

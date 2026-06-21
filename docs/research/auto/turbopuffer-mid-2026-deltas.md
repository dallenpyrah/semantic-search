# TurboPuffer mid-2026: features we are NOT using and should A/B

Research date: 2026-06-20. North star: be #1 on published code-search benchmarks while improving
latency, memory, indexing throughput, and cost. This brief is a **delta** against our current usage —
it does not propose rebuilding what exists. Every benchmark number and non-obvious claim has a URL.

## Current usage (ground truth)

Read from `src/store/Turbopuffer.ts`, `src/store/schema.ts`, `src/search/Search.ts`, `src/config/defaults.ts`,
`docs/BENCHMARKS.md`:

- Schema: `vector: { type: "[3072]f32", ann: true }`, `distance_metric: cosine_distance`. **No quantization** (full f32 stored), no `f16`/`i8`, no dim reduction, single vector column.
- Wire format: vectors sent as **raw JSON arrays** (not base64), via `bodyJsonUnsafe`.
- IDs: **string** `chunk.id` (content-addressed). FTS: `text` (filterable:false), `pathText` BM25, both `stemming:false`, `remove_stopwords:false`, default tokenizer (now `word_v4`).
- Query: multi-query (ANN over `vector` + BM25 over `text` + BM25 over `pathText`), `consistency: "strong"` default, fused with **app-side RRF** in `src/search/fuse.ts` (not native `rerank_by`), then **Cohere rerank-v3.5** via OpenRouter over a `limit*poolMultiplier` pool. App-side `kindBonus` + path-prefix boosts in `fuse.ts`/`Search.ts`.
- Warm: `GET /v1/namespaces/:ns/hint_cache_warm` (still current, not deprecated — confirmed below).
- Eval harness exists: `eval/retrieval.ts` (30 queries: 20 semantic NL + 10 exact-token, gold = implementing file), `eval/perf.ts`, `eval/adoption.ts`. Baseline: Success@1 80 / @5 97 / @10 97, MRR 0.875, nDCG@10 0.899, search p50/p95 ~720ms/~1300ms incl. rerank.

## What TurboPuffer shipped that we are not using (primary sources)

TurboPuffer changelog — https://turbopuffer.com/docs/roadmap (last updated 2026-06-08):

- **2026-06: `i8` vector type** — "75% reduced storage and query cost compared to `f32`". Quantization-aware models match f32 at int8.
- **2025-03: `f16` vector type** — "50% reduced storage and query cost compared to `f32`".
- **2025-01: configurable consistency (strong/eventual)** — "21ms -> 11ms p90 for 1M vectors" with eventual.
- **2026-05: `word_v4` tokenizer** — "~3x faster than `word_v3`" (now the default for new namespaces). `word_v3` = Unicode-aware segmentation (2025-11).
- **2026-03: BM25 `k3`** (query-term-frequency saturation, default 8.0); **multiple vectors per document GA**.
- **2026-02: Regex index** (faster `Regex`/`Glob`/`IGlob`); "query pricing reduced by up to 94%"; attribute values can influence FTS ranking.
- **2026-05: Namespace branching** — instant copy-on-write clones, flat $0.032; **Fuzzy filter** (typo tolerance).
- **2026-04: Namespace pinning** (reserved compute/NVMe for high-QPS); sparse vector search (`{}f16` + `SparseKNN`).
- **2025-12: `kNN` exact search** (100% recall on filtered vector queries); object-storage-native indexing queue (10x faster queue time).
- **2025-10: Read replicas** (scalable read throughput, opt-in).
- **2025-09: ANN v3** — "query 100B+ vectors with p99 of 200ms" (opt-in beta); 5x object-storage throughput.
- **2025-03: base64 client-side vector encoding** — "Up to 50% faster vector bulk upserts" (default in new clients).
- **2024-09: `copy_from_namespace`** (50% discount vs re-upsert); `uuid` type (55% discount vs string).
- Native multi-query `rerank_by: ["RRF"]` (server-side reciprocal rank fusion) — https://turbopuffer.com/docs/query.

ANN engine: TurboPuffer uses **SPFresh** ANN "maintaining >90-95% recall@10 even in large namespaces"
(https://turbopuffer.com/docs/concepts). ANN v3 internally uses RaBitQ (binary) quantization of the
in-memory tree + rescoring against `f16`/`i8` stored vectors — confirmed by independent case study
(Terence Liu, https://terencezl.github.io/blog/2026/02/03/case-study-turbopuffer-ann-v3/): "fp16
wouldn't cause any significant accuracy loss … INT8 in practice leads to less than 0.01 accuracy loss"
with non-uniform scalar quantization. **Implication: TurboPuffer already quantizes our vectors for the
ANN index regardless of stored dtype.** Declaring `f16`/`i8` in the schema changes *stored* precision
(storage + query cost + rescore fidelity), not whether ANN quantization happens.

## The accuracy nuance for OUR model (load-bearing)

Our model is **OpenAI `text-embedding-3-large` @ 3072d**, which is **NOT** in TurboPuffer's list of
quantization-aware models. From https://turbopuffer.com/docs/performance (Use Smaller Vectors):
"For models with quantization-aware training (voyage-4 series, voyage-context-3, embed-v4,
Qwen3-VL-Embedding-8B), `int8` output matches `f32` precision. … The tradeoff with smaller vectors is
typically lower search precision. Consider the cost/performance vs precision tradeoff with your own evals."

Generic int8 scalar-quantization retrieval retention (MTEB Retrieval NDCG@10, 15 benchmarks) —
HuggingFace, https://huggingface.co/blog/embedding-quantization:

| Model (int8, no rescore) | NDCG@10 retention |
|---|---|
| Cohere-embed-english-v3.0 | 100% |
| mxbai-embed-large-v1 (1024d) | 97% |
| e5-base-v2 (768d) | 94.68% |
| all-MiniLM-L6-v2 (384d) | 90.79% |

Binary quantization: ~92.5% retention without rescore, **~96% with float32 rescore** (rescore =
retrieve `rescore_multiplier * top_k` on quantized, re-score that list with the f32 query). int8
quality "greatly" depends on a good **calibration dataset** (per-dimension min/max).

Matryoshka dim reduction for **text-embedding-3-large** specifically: "we see a performance retention
of **93.1% at 12x compression**" (i.e. 3072 -> 256 dims) — same HF source. So truncating dims is NOT
free for our model; 256d loses ~7% NDCG. OpenAI confirms native Matryoshka truncation to 256 or 1024
via the `dimensions` param (https://openai.com/index/new-embedding-models-and-api-updates/), and the
correct way to shorten is the API `dimensions` arg, then L2-renormalize (Weaviate,
https://weaviate.io/blog/openais-matryoshka-embeddings-in-weaviate).

**Net read:** `f16` is effectively free for us (TurboPuffer rescores against it; the case study and
TurboPuffer's own f16 launch both say ~no accuracy loss). `i8` is low-but-nonzero risk for a
non-QAT model (~3-6% raw ANN-recall loss without a good calibration range), but our pipeline has a
**Cohere rerank rescoring stage over the top pool** that recovers most ANN-recall loss — so i8 is a
legitimate eval-gated candidate, not a blind adopt. Dim reduction (256/1024) trades ~7%/less NDCG for
speed/cost and should only be considered if latency/cost dominates; default to keeping 3072.

## The instrumentation primitive that makes all of this A/B-able

`POST /v1/namespaces/:namespace/_debug/recall` (https://turbopuffer.com/docs/recall) samples `num`
random inserted vectors and reports `avg_recall` = ANN-result ∩ exact-result over top_k, plus
`avg_ann_count` / `avg_exhaustive_count`. This is the **same endpoint TurboPuffer uses internally** and
it isolates pure ANN-index recall loss from rerank/fusion effects — exactly what we need to gate i8/f16.
It accepts `rank_by` and `filters`. Billed as queries only when `avg_recall >= 0.9`.

Also: every query response carries a `performance` object — `cache_hit_ratio`, `cache_temperature`
(`hot`/`warm`/`cold`), `server_total_ms`, `query_execution_ms`, `exhaustive_search_count`,
`approx_namespace_size`, `last_included_write_at` (https://turbopuffer.com/docs/query). We currently
ignore this. Capturing it per query gives the benchmark harness server-side latency, cache state, and a
signal for "is the namespace warm" — far better than wall-clock alone.

## Prioritized changes to try (each: change, expected impact, how to A/B)

Ranked by expected ROI for the north star (benchmark rank first, then speed/memory/cost).

### P0 — Instrument first (unblocks everything else)

1. **Capture `performance` + add a recall probe.**
   - Change: parse the `performance` object from every query into our result; add a thin
     `recall(num, top_k, rank_by?)` method calling `/v1/namespaces/:ns/_debug/recall`.
   - Impact: zero product change; gives server `*_ms`, cache temperature, and ground-truth ANN recall.
   - A/B: not a variant — it is the measurement substrate. Add `eval/recall.ts` that prints
     `avg_recall@10` for the current namespace; wire `performance.server_total_ms` and
     `cache_temperature` into `eval/perf.ts` so latency rows separate cold vs warm.
   - Source: https://turbopuffer.com/docs/recall , https://turbopuffer.com/docs/query

### P1 — Cost/memory wins with ~no accuracy risk

2. **Store vectors as `f16` (`[3072]f16`).**
   - Change: `buildSchema` -> `type: "[${dimensions}]f16"`. Requires a **new namespace** (vector type is
     fixed at creation; not changeable in place — https://turbopuffer.com/docs/write). Our namespace
     name already includes a schema signature (`AppConfig.ts` `${prefix}_${SCHEMA_VERSION}_…`), so bump
     the signature to force a fresh namespace. Wire format stays f32 (base64/JSON) — `f16` is storage-only.
   - Impact: ~50% lower stored-vector storage + query cost; negligible accuracy change (TurboPuffer
     rescores against it; case study: "fp16 … no significant accuracy loss").
   - A/B: index a sibling `*_f16` namespace; run `eval/recall.ts` (expect `avg_recall@10` within noise of
     f32) and `eval/retrieval.ts` (expect Success@10 / nDCG@10 unchanged); compare `server_total_ms`.
   - Source: https://turbopuffer.com/docs/write (vector types), https://terencezl.github.io/blog/2026/02/03/case-study-turbopuffer-ann-v3/

3. **Send vectors base64-encoded (little-endian f32).**
   - Change: in `upsert`, encode each `vector` as base64 LE-f32 instead of a JSON number array. The wire
     format is independent of stored dtype.
   - Impact: "Up to 50% faster vector bulk upserts" (changelog 2025-03) — directly improves indexing
     throughput, our explicit goal. No accuracy effect.
   - A/B: time a full re-index of our corpus (and a larger synthetic corpus) JSON vs base64 via
     `eval/perf.ts` cold-index row.
   - Source: https://turbopuffer.com/docs/roadmap , https://turbopuffer.com/docs/write (Vectors: base64 LE-f32)

4. **Batch + parallelize upserts; enable `disable_backpressure` for full re-index only.**
   - Change: ensure `Indexer` batches into ≤512MB requests and writes batches concurrently. For initial
     full index (not incremental watch), set `disable_backpressure: true` and query with eventual
     consistency until indexed.
   - Impact: "up to 50%" batch discount + higher write throughput; backpressure-off avoids 429s on bulk
     load. Incremental watch (our 5ms steady state) is unaffected.
   - A/B: `eval/perf.ts` cold-index throughput on a large repo (e.g. a 50k-chunk corpus) before/after.
   - Source: https://turbopuffer.com/docs/performance (Batch/Concurrent Writes), https://turbopuffer.com/docs/write (disable_backpressure)

### P2 — Accuracy/quality experiments (eval-gated)

5. **Try `i8` (`[3072]i8`) with a calibration range, gated on recall.**
   - Change: separate `*_i8` namespace, `type: "[3072]i8"`, pass int8 values in `[-128,127]`. Compute
     per-dimension min/max from a calibration sample of our embeddings (sentence-transformers
     `quantize_embeddings(..., precision="int8", calibration_embeddings=…)` semantics) so buckets are
     well-formed; OpenAI vectors are L2-normalized so a single symmetric range often suffices.
   - Impact: ~75% lower storage + query cost. Risk: ~3-6% raw ANN-recall loss for a non-QAT model
     without good calibration; our Cohere rerank rescoring should recover most. **Adopt only if**
     `eval/recall.ts` `avg_recall@10` stays ≥ ~0.95 AND `eval/retrieval.ts` Success@10 / nDCG@10 are within
     noise of f32.
   - A/B: index `*_i8`, compare `avg_recall@10`, then full retrieval eval, then `server_total_ms`.
   - Source: https://turbopuffer.com/docs/performance , https://huggingface.co/blog/embedding-quantization

6. **Native server-side RRF (`rerank_by: ["RRF"]`) instead of app-side fuse — only if it wins.**
   - Change: send the multi-query with `rerank_by: ["RRF"]` (optionally `["RRF", {rank_constant}]`),
     receive one fused list. We'd lose our custom `kindBonus` + path-prefix boosts unless folded into
     `rank_by` (see #7).
   - Impact: one fewer app pass + less data shuffling; minor latency. **Caution:** our app-side RRF is
     where our +13pt Success@10 / +0.16 nDCG tuning lives (BENCHMARKS.md items 2-3). Native RRF must
     *match or beat* current nDCG@10 or we keep app-side. This is a refactor, not an obvious win.
   - A/B: run `eval/retrieval.ts` with native RRF (boosts folded into `rank_by`) vs current; require
     nDCG@10 ≥ 0.899.
   - Source: https://turbopuffer.com/docs/query (rerank_by, RRF)

7. **Fold lexical + boosts into a single weighted `rank_by` (Sum/Product/Saturate/rank-by-filter).**
   - Change: one query with `rank_by = ["Sum", [["Product", w_t, ["text","BM25",q]], ["Product", w_p, ["pathText","BM25",q]], ["Product", w_k, ["kind","Eq","code"]] ]]`. `Saturate` maps numeric
     attributes into `[0,1)` for combination; rank-by-filter gives matching docs +1 (×weight). This
     replaces our app-side `kindBonus` and prefix boost with server-side ranking.
   - Impact: fewer round-trips, ranking closer to the index, tunable weights. Could improve exact-token
     queries (our 10 exact queries) by weighting `pathText`/`text` BM25 explicitly.
   - A/B: grid-search `w_t,w_p,w_k` on `eval/retrieval.ts`; keep if nDCG@10 / exact-token Success@1 beat
     baseline. Keep the vector query separate (ANN can't be summed with BM25 in one clause).
   - Source: https://turbopuffer.com/docs/query (FTS operators, Field weights, Rank by filter, Saturate)

8. **Tune BM25 + tokenizer for code (`word_v4`, `k1`, `b`, `k3`, optional stemming off, `ascii_folding`).**
   - Change: confirm new namespaces use `word_v4` (default now; ~3x faster than v3). Code tokens
     (`validateAccessToken`, SKUs, paths) argue for current `stemming:false`. Experiment with `k1` (term
     saturation), `b` (length norm), and the new `k3` (query-term saturation) for exact-token recall.
   - Impact: speed (word_v4) + possible exact-token Success@1 gains. Schema changes for FTS params are
     in-place (rebuild in background).
   - A/B: vary one param at a time, measure exact-token subset of `eval/retrieval.ts`.
   - Source: https://turbopuffer.com/docs/write (full_text_search params), https://turbopuffer.com/docs/roadmap

### P3 — Latency/ops levers (workload-dependent)

9. **Eventual consistency for read-heavy benchmark/serve paths.**
   - Change: switch query `consistency` to `eventual` for the search path (we already plumb it via
     `config.settings.store.consistency`). Keep `strong` only where a query must observe a just-written
     index (e.g. immediately after re-index in tests).
   - Impact: "21ms -> 11ms p90 for 1M vectors"; higher throughput. Risk: ≤128MiB unindexed-write
     staleness (>99.8% of queries consistent; ~100ms staleness only during rare scaling, up to ~1h after
     massive writes). For an interactive code-search tool over a freshly-indexed repo this is acceptable
     **except** right after a large re-index — gate on indexing completion.
   - A/B: measure `server_total_ms` p50/p95 strong vs eventual in `eval/perf.ts`; confirm
     `eval/retrieval.ts` unchanged on a fully-indexed namespace.
   - Source: https://turbopuffer.com/docs/query (consistency), https://turbopuffer.com/docs/roadmap

10. **Namespace branching for benchmark isolation (harness hygiene, not product).**
    - Change: when A/B-ing config against a fixed corpus, `branch_from_namespace` to clone the indexed
      namespace in O(1) (flat $0.032) instead of re-indexing per variant.
    - Impact: makes the recurring auto-research loop cheap and deterministic — same vectors, different
      query config — removing embedding cost/variance from A/Bs. (Note: f16/i8 experiments still need
      fresh indexing since vector dtype is creation-fixed; branching helps query-side experiments #6-9.)
    - A/B: n/a (tooling). Source: https://turbopuffer.com/docs/write (branch_from_namespace), https://turbopuffer.com/docs/pinning

### Not worth it for us (explicitly rejected, with reason)

- **Namespace pinning / replicas** — break-even ~10 QPS on >16GB namespaces
  (https://turbopuffer.com/docs/pinning). Our namespaces are per-repo and small; multi-tenant +
  `hint_cache_warm` (which we already use, and is current) is correct. Revisit only if a single hosted
  namespace sustains >10 QPS.
- **Dim reduction to 256** — 93.1% retention = ~7% nDCG loss for text-embedding-3-large
  (https://huggingface.co/blog/embedding-quantization). Only if latency/cost dominates; default keep 3072.
  1024d (Matryoshka) is a milder option to bench if f16/i8 prove insufficient on cost.
- **Sparse vectors / SparseKNN / multi-vector / late-interaction** — real upside (ColBERT-style late
  interaction is on TurboPuffer's roadmap) but a larger change than a TurboPuffer-config delta; track for
  a future cycle, not this one. Source: https://turbopuffer.com/docs/roadmap

## Benchmark-harness wiring (concrete)

For the recurring auto-research loop, the harness should, per config variant:

1. Index the corpus into a variant namespace (branch where vector dtype is unchanged; fresh index for
   f16/i8). Capture cold-index `server_total_ms` and chunks/s.
2. Call `/_debug/recall` (num≈50, top_k=10) -> `avg_recall@10` (pure ANN recall).
3. Run `eval/retrieval.ts` -> Success@1/5/10, MRR, nDCG@10, split by semantic vs exact-token subset.
4. Run search queries capturing the `performance` object -> p50/p95 `server_total_ms`, `cache_temperature`.
5. Gate: accept a variant only if nDCG@10 ≥ baseline (0.899) AND `avg_recall@10` ≥ ~0.95, then rank by
   `server_total_ms` and cost (storage/query bytes).

External published benchmarks to target for "#1" (for the harness's north star, beyond our internal 30-query
eval) are out of scope of this TurboPuffer brief but should be wired next: CoIR / CodeSearchNet / SWE-bench-retrieval
style code-search evals (track via the separate benchmark-selection research task).

## Blocking unknowns

- **i8 calibration on OpenAI vectors:** TurboPuffer's `[N]i8` expects already-int8 values in `[-128,127]`;
  it does not document server-side calibration. We must compute the quantization range client-side. Unknown
  whether a single global range vs per-dimension ranges matters for L2-normalized text-embedding-3-large at
  3072d — must be measured via `/_debug/recall`. (Mitigation: f16 needs no calibration and captures most of
  the cost win at ~zero risk; do f16 first.)
- **Native RRF parity:** unknown whether `rerank_by: ["RRF"]` reproduces our app-side fuse + boosts
  closely enough to preserve the +13pt Success@10 tuning; must eval before switching. Default: keep app-side
  fuse; treat native RRF as an experiment, not a migration.

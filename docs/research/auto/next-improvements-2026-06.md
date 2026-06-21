All claims verified. Two more confirmations:

- **Double embed concurrency confirmed**: `indexAll` fans out `embedConcurrency` consumers, each calls `embeddings.embed` → `embedViaApi` which *again* does `Effect.forEach(..., {concurrency: embedConcurrency})`. So the real concurrency is `embedConcurrency²`-ish on cold index (10 consumers × up-to-10 inner = potential 100-way embed fan-out). Not flagged by any agent — worth a note.
- **coir.ts does NOT honor `--model`/`--dims`** (lines 169-170 are literals, not `arg()`), and the namespace `coir_..._te3l_3072` mismatches prod's 1536. Falsifiability finding fully confirmed.
- **Watcher error handlers are empty `() => {}`** (confirmed lines), supporting the robustness finding about silent watch death.

I have everything I need. Writing the brief.

---

# Semantic-Search: Decision-Ready Improvement Brief

**Biggest next investment: fix the benchmark harness (`eval/benchmark/coir.ts`) so embedder/reranker swaps are measurable, then swap to a code-specialized embedder (voyage-code-3).** Everything else in the retrieval lens is unfalsifiable until the harness stops hardcoding `te3l`/`3072` (it doesn't even match prod's 1536), and the embedder is the single largest quality lever for the code→code and "explain how X works" tail that the team explicitly wants to cut.

I verified every load-bearing claim against source. Corrections to the agent findings are flagged inline and in the "Downgrades" section.

---

## 1. Ranked improvements

| # | Improvement | Impact | Effort | Conf | Rewrite? | Where (file:fn) |
|---|---|---|---|---|---|---|
| 1 | **Make CoIR harness model/dims-agnostic** (unblocks all measurement) | Enables every retrieval claim below; near-zero cost | S | High | refactor | `eval/benchmark/coir.ts:169-171` |
| 2 | **Return `symbol`+`kind` in results** (already computed, dropped at upsert) | Cuts disambiguation reads on the explain tail; ~10 LOC across 5 files | S | High | none | `schema.ts:28,43,82`, `Search.ts:11`, `fuse.ts:114,166` |
| 3 | **Return full chunk, not 900-char window** (bytes already fetched) | Removes "almost enough" follow-up reads; free | S | High | refactor | `defaults.ts:186`, `fuse.ts:103-124` |
| 4 | **Swap to voyage-code-3 @1024** | Vendor +13.8% nDCG on code retrieval; the real tail win | S | Med-High | none | `Embeddings.ts:9-12`, `AppConfig.ts:61-65`, `defaults.ts:80-84` |
| 5 | **Typed recovery at I/O boundaries** (`catchTag`, not `catch`=`catchAll`) | Stops silent decode/transport/upsert-failure collapse; correctness | M | High | refactor | `Turbopuffer.ts:124-128`, `Indexer.ts` (6 sites) |
| 6 | **Don't record manifest entry when upsert failed** | Closes permanent silent-gap correctness hole | M | High | refactor | `Indexer.ts:238-241,289-297` |
| 7 | **Atomic + checkpointed manifest** (tmp+rename, periodic save) | Crash mid-index = cheap resume vs full re-index + orphans | S | High | refactor | `Manifest.ts:61-66`, `Indexer.ts:318` |
| 8 | **Column-layout + base64 + coalesced upserts** | Largest remaining indexing-wall lever (post-embed-floor) | M | Med-High | refactor | `Turbopuffer.ts:85-88`, `schema.ts`, `Indexer.ts:289-297` |
| 9 | **Add a code-aware reranker option (voyage rerank-2.5)** + deeper pool | +3.26% over cohere; cheapest quality lever, already wired | M | Med | refactor | `Reranker.ts:22-31,69-95`, `defaults.ts:90-96` |
| 10 | **Effect Metric instrumentation** at 4 boundaries | Makes all failure modes above observable; 0 today | M | Med | additive | `Indexer.ts:210-218`, `Embeddings.ts:75-83`, `Search.ts` |
| 11 | **xxHash3 for content/chunk/cache hashing** (Bun-native) | A few seconds off cold index; ~37k SHA passes today | S | Med | none | `hash.ts:3-8`, call sites in `structural.ts`,`Indexer.ts`,`VectorCache.ts` |
| 12 | **Drop dead `chunkHash` + dedupe per-chunk hashing** | Removes 11.5k wasted hashes + a dead column | S | Med | none | `structural.ts:254`, `schema.ts:16,40,54` |
| 13 | **Per-source RRF weights + sweep `rankConstant`** | A few nDCG points on the hybrid half; pure math, no reindex | S | Med | refactor | `fuse.ts:36-58`, `defaults.ts:188` |
| 14 | **Expand secret-redaction set + add conversation delete** | Data-exfil severity (opt-in, but real) | S | High | none | `ConversationIndexer.ts:12-17` |
| 15 | **Chunk header = real signature, not comment** | Raises code-embedder hit rate; A/B-gated | M | Med | refactor | `structural.ts:213-220,236-240` |
| 16 | **Agent-side HyDE via tool description** (no in-search LLM) | Better first-call landing on conceptual queries | S | Med | none (doc) | `tools.ts:26-32` |
| 17 | **`expand` mode on the same tool** (file+lines → range read) | Replaces blind whole-file reads on the tail | M | Med | refactor | `extension.ts:232-256`, `Search.ts` |
| 18 | **Harden CommitIndexer reconcile** (additive-before-destructive) | Stops empty-history window on rebase/force-push | M | Med-High | refactor | `CommitIndexer.ts:106-135` |

---

## Quick wins (do this week — S effort, high/med confidence)

These are small, mostly additive, and several are pure deletions or config:

- **#1 Harness fix** — `coir.ts:169-171`: replace `const modelSlug="te3l"; const dims=3072` literals with `config.settings.embedding.model`/`.dimensions` read inside `program`, and add `--model`/`--dims` flags (the `arg()`/`has()` helpers already exist at lines 38-42) threaded through `AppConfig.layer({...namespaceOverride})`. Today the bench namespace is `coir_..._te3l_3072` while prod is 1536 — **the benchmark has never measured the production config.** This is the highest-ROI 10 lines in the repo.
- **#2 Return `symbol`/`kind`** — `Chunk.symbol` exists (`types.ts:13`) and is computed (`structural.ts:235`) but `rowFromChunk` (`schema.ts:28`) silently drops it. Add to `UpsertRow`, `buildSchema`, `TpufRow`, `ATTRIBUTES`, `toHit`, and the `formatHits` header. A header line `8. src/search/Search.ts:77-163  fn run [code]` lets the agent skip the "is this the definition or a call site?" read. **Requires reindex** but does NOT rotate the namespace (`settingsSignature` at `AppConfig.ts:105-115` doesn't include schema fields) — so existing indexes return empty `symbol` until reindex; gate the formatter on presence.
- **#3 Full-chunk snippet** — `snippetChars=900 < chunkMaxChars=1600` (`defaults.ts:186,99`). The full `row.text` is already fetched from TurboPuffer, then `snippet()` (`fuse.ts:103`) throws ~40% of a function away. Raise `snippetChars` to ≥1600 and let `maxOutputBytes=24_000` do the clipping. 8 hits × ~400 tok ≈ 3.2k tok, far under the 25k tool-response ceiling.
- **#7 Atomic manifest** — `VectorCache.writeOne` already does tmp+rename (`VectorCache.ts:43-48`); `Manifest.save` (`Manifest.ts:65`) does a raw `writeFileString`. Copy the pattern. A torn write makes the loader (`Manifest.ts:48-51`) silently reset to empty → full re-embed + orphan rows.
- **#12 Delete `chunkHash`** — verified write-only (grep: written in 3 files, read nowhere). `contentHash = sha256(raw)` is computed 11.5k times and never used. Remove the column and derive content identity from `chunkId`. Pure liability removal.
- **#14 Redaction** — `SECRET_PATTERNS` (`ConversationIndexer.ts:12-17`) misses AWS `AKIA…`, GitHub `ghp_…`, Slack `xox[baprs]-`, Google `AIza…`, JWTs, PEM blocks. Conversation is opt-in (`conversationEnabled:false`, good) but ships verbatim user text to two network boundaries when on. Add patterns; state plainly that regex redaction is best-effort.

## Bigger bets (measure first, M–L effort)

- **#4 voyage-code-3** — Voyage `/v1/embeddings` is OpenAI-compatible and defaults to 1024 dims, so the existing `OpenAiEmbeddingModel`+`OpenAiClient` path works *unchanged*; this is a `PROVIDERS` table entry (`Embeddings.ts:9-12`) + a `keys.voyage` Option (`AppConfig.ts:61-65`) + `defaults.ts` model/dims. **Caveat verified:** int8/256-dim need Voyage-specific body params (`output_dimension`/`output_dtype`) that `@effect/ai-openai` will NOT pass — start with 1024 f32 (zero new HTTP code), defer quantization to a direct-POST variant like `Reranker.ts`. **Interaction: this rotates the namespace** (`settingsSignature` includes model+dims) → auto full cold reindex (~97s) on rollout. Acceptable, but it's a clean-cutover, not a migration.
- **#8 Column upserts** — verified the premise: `embedStage` (`Indexer.ts:244-253`) offers exactly one `UpsertJob` per embed batch (128 rows = 196,608 JS numbers re-stringified per request, ~90 requests), and `upsertWorker` writes one job at a time with no coalescing. Move to `upsert_columns` + base64 f32, and coalesce N jobs (by byte budget, ~8-16MB) in the worker via `Queue.takeBetween`. TurboPuffer's own docs name this exact bottleneck ("serialization… single-threaded runtimes like Node.js"). **Risk: wrong base64/column encoding silently corrupts vectors** — validate against a live namespace before trusting.
- **#5/#6 Typed failures** — verified: 26 `Effect.catch` (= `catchAll`), 0 `catchTag`. The worst is `Turbopuffer.query:124-128` — the `catch` sits *after* `schemaBodyJson`, so a renamed TurboPuffer field (a `SchemaError`, `httpStatus`→undefined) gets re-wrapped as a generic StoreError with no decode detail, and a real 404 is indistinguishable from an empty namespace. #6 is the highest-severity correctness bug in the repo: `embedStage`/`upsertWorker` swallow failures (`Indexer.ts:252,293`) but `finalize` (`:238-241`) records the manifest entry *unconditionally* → a transient 5xx during cold index makes those files **unsearchable forever** (mtime unchanged → `prepareFile:152-157` skips them permanently). ~1% upsert failure = ~20 silently-missing files per 2160-file index.

---

## 3. Rewrite verdicts (per module)

| Module | Verdict | Scope / Payoff |
|---|---|---|
| **`Search.ts`** | **Refactor, do NOT rewrite** | Extract pure ranking policy (cue regexes, `sourceBonus`, `kindNudge`, `buildFilters`, quotas, fuse→bonus→sort→rerank→diversify orchestration) into `src/search/ranking.ts`. The *interface* (`search/semantic/hybrid/formatted`) is already a good deep module; the problem is policy is trapped in a `Layer.effect` closure, untestable without standing up the layer — exactly the surface the team will iterate on for nDCG tuning. **Note a real latent issue:** `sourceBonus` is applied twice — once pre-rerank (`Search.ts:125`) and again on the reranked score (`:142`). Intentional but undocumented and unverifiable; pin it in the extracted fn + a test. |
| **`Indexer.indexAll`** | **Refactor, NOT a full rewrite** | The architecture agent overstated this. **Verified: the producer is ALREADY a Stream pipeline** (`Indexer.ts:256-268`: `Stream.fromAsyncIterable → mapEffect{concurrency} → runForEach`). Only `embedConsumer`/`upsertWorker` (`:276-297`) use manual `Queue.take` loops + `null` sentinels + a cross-fiber `pending` Map. Convert *those two stages* to `Stream.grouped`/`mapEffect` and delete the sentinel protocol — but the "115-line bespoke DAG" framing is wrong; it's ~40 lines of manual queue draining. Couple this with #6 (carry success through) and #8 (coalesce). **L effort, behind a flag, A/B the probe** — this is the measured hot path (96.7s, 924MB ceiling). **Also unflagged by any agent:** embed concurrency is doubled — `indexAll` runs `embedConcurrency` consumers, each calling `embed`→`embedViaApi` which *again* fans out `{concurrency: embedConcurrency}` (`Embeddings.ts:68-69`). On cold index that's up to ~100-way embed fan-out, not 10. Worth collapsing during the rewrite. |
| **`Turbopuffer.ts`** | **Refactor** | Split the 404-vs-decode error path (#5) + add column/base64 upsert (#8). The deep-module shape is correct; only `upsert` and `query`'s error handling change. |
| **`Manifest.ts`** | **Refactor** | Atomic write (#7) + Schema-decode on load (replace `JSON.parse … as ManifestData` at `:49` with `Schema.decodeUnknown`, distinguish absent-vs-corrupt). Stays an in-memory `Ref`; only persistence changes. |
| **`AppConfig.ts`** | **Refactor (optional), NOT rewrite** | Deep module, good interface. One real impurity: `loadEnvFile` mutates `process.env` (`:163-177`) then reads it back, and `extension.ts:132-149` builds two layers sharing that mutated global. Route through `ConfigProvider.fromMap`/`orElse` + `Effect.withConfigProvider`. **Lower priority** — the env-merge order is currently deterministic (`:172` skips already-set keys), so the namespace-churn risk is latent, not active. |
| **`Reranker.ts`** | **Refactor** | Provider→`{baseUrl,model,key}` table instead of the cohere/free binary (#9). **Keep the graceful-degrade-to-identity** (`:91-95`) — it's exactly right. The `/rerank` POST shape is already Cohere/Voyage-compatible. |
| **`fuse.ts`** | **Refactor (small)** | Per-source RRF weights (#13). Already pure — keep it that way; weights live in config. The hand-tuned boosts (`:52-56`, `0.01`/`0.002`) are magic numbers that fight the RRF — fold into the same sweep. |
| **`structural.ts` / chunker** | **Refactor, do NOT rewrite to tree-sitter yet** | Header-enrichment (#15) is a ~20-line `symbolOf`/`buildChunk` change. A full AST chunker = native-grammar build complexity + Bun/JSC risk; `greedyMerge` already produces coherent top-level spans. **Measure header enrichment on CoIR first.** **Interaction: any chunk-text change invalidates the entire VectorCache** (key is `sha256(embedText)`, and the prefix template is baked in) — and worse, unchanged files keep their *old-template* vectors forever (`:152-157` skip), silently mixing two conventions. **Fix: add a `PROMPT_VERSION` to the cache slug** (`VectorCache.ts:19`) before touching the prefix. |
| **`Watcher.ts`** | **Keep — already correct** | `Effect.acquireRelease` under `Effect.scoped` for both FS and git watchers; the `Stream.fromQueue → groupedWithin → mapEffect{concurrency:1}` pattern is the reference shape. **Only gap:** the `.on("error", () => {})` handlers (verified empty) make a dead watch silently permanent — add `logError` + bounded re-acquire + a low-frequency `Schedule.spaced` safety reconcile. Refactor, not rewrite. |
| **`extension.ts` lifecycle** | **Refactor (small)** | Collapse the three `rt.runFork` fibers tracked in a mutable `Fiber[]` (`:152-175`) into one supervised `Effect.scoped` with `forkScoped` children so `rt.dispose()` alone tears down. Add `tapErrorCause(logError)` so a watcher death is visible. Host contract unchanged. |
| **`VectorCache.ts`** | **Refactor** | Add `PROMPT_VERSION` to slug + reject all-zero/NaN vectors (`:26-34` is length-only). Eviction (unbounded growth — every deleted chunk leaks a vector file forever) is a separate larger change; at minimum expose `clear-cache`. The cold-index stat-storm finding (#skip cache.get when manifest proves new) is real but **Med confidence** — measure it in the probe before building. |

---

## Recommended sequence (with how to measure each)

Baselines to defend: **cold index 96.7s / RSS 924MB / footprint 474MB**, **repo eval S@1 67% / S@5 87% / nDCG@10 0.800**, **CoIR codetrans-dl embedding-only 18.89**.

**Phase 0 — Unblock measurement (1 PR, S):**
1. Fix `coir.ts` (#1) so `--model`/`--dims` flow through `AppConfig.layer` namespaceOverride. **Measure:** run `te3l@1536` (actual prod config) into a fresh namespace — this re-baselines CoIR honestly for the first time. Add a second code→code task (cosqa) so wins aren't single-dataset.

**Phase 1 — Free agent-UX wins (1 PR, S, reindex once):**
2. `symbol`/`kind` return (#2) + full-chunk snippet (#3) + drop `chunkHash` (#12). **Measure:** repo eval nDCG@10 must not drop (#3 surfaces fewer-but-completer hits); on the Pi tail, track tool-calls-to-resolution on "explain how X works" tasks (the actual target metric). One reindex covers all three.

**Phase 2 — Correctness hardening (1-2 PRs, S-M):**
3. Atomic+checkpointed manifest (#7) → typed failures at boundaries (#5) → don't-record-failed-upsert (#6). **Measure:** add a test that kills the process mid-`indexAll` and asserts (a) manifest parses, (b) no file is recorded whose upsert failed, (c) resume re-embeds only the gap. This is also where Metric counters (#10) earn their keep — wire `embed_failures`/`upsert_failures`/`files_failed` so the unhappy path stops being invisible.

**Phase 3 — Embedder swap (1 PR, S code / full reindex, Med-High):**
4. voyage-code-3 @1024 (#4). **Measure:** `coir.ts --model=voyage-code-3 --dims=1024` vs `te3l@1536` into distinct namespaces — this is the number that decides ship/no-ship. Expect CoIR 18.89 → high-20s/30s if the vendor claim holds on *your* data; if it doesn't move ≥5 points, don't pay the second-vendor operational cost. **Interaction: rotates the namespace → full cold reindex.** Do it once, deliberately, not via watcher.

**Phase 4 — Indexing throughput (1 PR, L, behind a flag):**
5. Column+base64+coalesced upserts (#8) + Indexer Stream refactor of the two manual stages (#6 already landed) + collapse the doubled embed concurrency. **Measure:** SEMSEARCH_PROBE on the 15k monorepo — assert wall-time < 96.7s, RSS ceiling ≤ 924MB, chunk-count parity. xxHash3 (#11) folds in here (same one-time cache invalidation as the embedder swap — sequence them together or gate on `SCHEMA_VERSION`).

**Phase 5 — Retrieval polish (parallel, S-M, harness-gated):**
6. Reranker provider table + voyage rerank-2.5 (#9), RRF weights sweep (#13), chunk-header signature (#15), agent-side HyDE (#16). **Measure each independently on `coir.ts`** (use `--no-rerank` to isolate reranker lift); guard against overfitting the 30-query repo eval (saturated and tiny) by treating CoIR as primary.

---

## Adversarial downgrades (low-confidence / overstated claims)

- **"Rewrite the indexAll DAG to Stream" (architecture agent, L)** — **Downgraded from rewrite to refactor.** Verified the producer is already a Stream pipeline; only two stages (`embedConsumer`/`upsertWorker`) are manual. The "115-line bespoke concurrency" framing is inaccurate; it's ~40 lines. Still worth doing (couples with #6/#8), but don't budget for a from-scratch rewrite.
- **Re-tune `limit`/`perFile` defaults (#agent-UX, Conf: low)** — **Keep at low.** Self-flagged low confidence; easy to overfit the saturated 30-query eval. Do it *only* after #2/#3 land and *only* keyed to a response-format/intent, validated on CoIR. Not a standalone win.
- **`expand` mode (#17, Med)** — Sound, but **overloading `file` semantics (history vs expand) is a real ergonomics smell** on a single-tool design the team values. Verified `file` always routes to history (`extension.ts:255`). If pursued, use an explicit `mode` discriminator, not a heuristic. Defer behind #2/#3 (which may shrink the tail enough to not need it).
- **Cold-index cache stat-storm skip (#indexing, Med)** — Real (11.5k guaranteed-miss `readFile` on cold), but a "cold" heuristic that's wrong on a partial prior index would force re-embed (cost). **Measure the storm in the probe before building**; the cheaper `fs.access`/`Bun.file().exists()` variant is the safer first step.
- **CommitIndexer reconcile (#18, Med-High)** — Verified the bug: `setMeta(head)`+`save` run *after* the `Effect.catch` on `indexCommits` (`:130-135`), so a partial commit-embed marks HEAD fully indexed (same durably-wrong pattern as #6). The fix (advance meta only on success; additive-upsert-before-destructive-delete) is correct. **One caveat the agent flagged honestly:** `deleteByFilter` with `NotIn` over up to 2000 shas may hit TurboPuffer filter limits — verify against v2 constraints before relying on it.
- **In-search/server-side HyDE** — Correctly rejected by the agent (adds latency + a generation dependency to the hot path). Only the agent-side, tool-description version (#16) is recommended.
- **Late chunking / tree-sitter AST chunker** — Correctly deferred. Both are large bets with native-module/long-context-model risk; header enrichment (#15) must be measured first.

**Key interactions to never forget:**
- voyage swap (#4) **and** chunk-target changes **both rotate the namespace** → full reindex. Don't stack them in surprise; cut over deliberately.
- Any `embedText`/prefix change (#15) **and** the hash swap (#11) **both invalidate the VectorCache** — add `PROMPT_VERSION` to the slug (`VectorCache.ts:19`) *before* touching either, or unchanged-file vectors silently rot under the old convention.
- `symbol` return (#2) needs a reindex but does **not** rotate the namespace — so old and new rows coexist; gate the formatter on field presence.

**Relevant files:** `/Users/dallen.pyrah/projects/rika-labs/semantic-search/eval/benchmark/coir.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/store/schema.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/store/Turbopuffer.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/index/Indexer.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/index/Manifest.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/index/CommitIndexer.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/embedding/Embeddings.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/embedding/VectorCache.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/search/Search.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/search/fuse.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/rerank/Reranker.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/chunk/structural.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/config/AppConfig.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/config/defaults.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/pi/extension.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/pi/tools.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/index/ConversationIndexer.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/domain/hash.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/domain/types.ts`, `/Users/dallen.pyrah/projects/rika-labs/semantic-search/src/watch/Watcher.ts`.
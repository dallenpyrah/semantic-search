The code confirms the key load-bearing claims. Critically, I found two discrepancies versus the agents' line citations that change the brief:

1. **The cold-index pipeline does NOT call `embedBatchAndUpsert` lines 215-235 via `indexCandidate`.** The cold path is `prepareFile` → queue → `consumer` (line 262) → `embedBatchAndUpsert` (line 215). The `indexCandidate`/`safeIndex` path (line 85) is only used by `reindexPaths` (incremental). So the "decouple embed/upsert" fix targets `embedBatchAndUpsert` (215-235) for cold, and separately `indexCandidate` (119-123) for warm. The agents conflated these in spots.

2. **`embed()` already re-batches AND re-applies concurrency internally** (Embeddings.ts 67-70: `Arr.chunksOf(texts, embedBatch)` with `concurrency: embedConcurrency`). So the consumer fibers (10) each call `embed`, which itself fans out to 10 sub-batches — concurrency is multiplicative, not 10. This materially changes the rate-limiter and batch-size reasoning, and I'll flag it.

I have enough to write the brief.

---

# Indexing Performance: Decision-Ready Research Brief

**Baseline:** cold index of "plusone" = 170s (147s code-embed + 22.5s commits), 537MB live footprint, 1.1GB max RSS. Code phase is I/O-bound (~26% CPU); embedding consumers are the proven bottleneck; producer runs ahead.

## The single biggest lever

**Raise `embedBatch` from 80 toward a token-budgeted ~256-512 AND decouple the TurboPuffer upsert from the embed call** — because the code phase is network-round-trip-bound, and both changes attack round-trips directly: fewer, larger embed requests amortize per-call latency, and pipelining the write removes the upsert RTT from the embedding critical path. Expect the 147s code phase to drop toward ~80-110s combined. Everything else is secondary.

## Critical correction to the agents' premise (verify before acting)

`Embeddings.embed` (Embeddings.ts:67-70) **already re-chunks by `embedBatch` and re-applies `embedConcurrency` internally**. The Indexer's 10 consumer fibers each call `embed`, which itself fans out up to `embedConcurrency=10` sub-requests. **Effective in-flight concurrency is up to 10×10 = 100, not 10**, unless each consumer's batch is ≤80 (one sub-batch). This means:
- The "0-1 429s at concurrency 10" observation is actually at much higher real concurrency when batches exceed 80.
- Raising `embedBatch` to 256 makes each `embed` call fan out to 4 sub-requests (4×10 fibers = 40 concurrent) — **this will increase 429s**, not just amortize latency, unless you also fix the double-concurrency.
- **Action:** when `embed` is called from a context that already controls concurrency (the consumer loop), it should NOT re-fan-out. Either set the internal `concurrency: 1` for the Indexer path, or have the consumer call `embedBatch` (the single-request primitive) directly. This is a prerequisite for safely raising batch size.

## Ranked recommendations

| Rank | Technique | Speed | Memory | Effort | Conf. | Where to change |
|---|---|---|---|---|---|---|
| 1 | Token-budgeted larger embed batch (80→256-512) + fix double-concurrency | High (1.3-2x code phase) | −ve (larger in-flight vectors) | S+ | High | `defaults.ts:101` embedBatch; `Embeddings.ts:65-72` add token-budget chunking + stop double-fan-out |
| 2 | Decouple upsert from embed (pipeline write off critical path) | Med (10-20% code phase) | slightly −ve (bounded 2nd queue) | M | High | `Indexer.ts:215-235` embedBatchAndUpsert + indexAll consumer loop |
| 3 | Cut dimensions 3072→1536 (native MRL) | Med index / High query | **−50% everywhere** | S | High | `defaults.ts:81` dimensions (forces re-index) |
| 4 | Drop redundant `Array.from` vector copy | ~none speed | Med (−290MB throwaway alloc) | S | High | `Embeddings.ts:53` |
| 5 | Stop sending `schema` on every upsert | Low | Low (smaller bodies) | S | Med | `Turbopuffer.ts:88,98,104,111,116` |
| 6 | Provider → OpenAI direct (drop proxy hop) | Med (~7-14s) | neutral | S | High | `defaults.ts:79` provider |
| 7 | Persistent content-hash → vector disk cache | **Very high on re-index/fork**, none cold | neutral (disk) | M | High | new `src/embedding/VectorCache.ts`; wire into `Embeddings.embed` |
| 8 | gzip the upsert body | Low-Med | negligible | S | Med | `Turbopuffer.ts:77-83` write |
| 9 | voyage-code-3 (quality + smaller dims) | Med index / **+13.8% retrieval quality** | −67% at 1024d | M | High | new adapter in `Embeddings.ts`; `defaults.ts` provider/dims |
| 10 | `--smol` + `Bun.gc(true)` at phase boundaries | Low-neg | caps & releases RSS | S | Med | `cli/main.ts`, `pi/extension.ts` |
| 11 | Worker-thread the cold index (release RSS to OS) | neutral | releases full burst | M | Med | `pi/extension.ts:168` only |
| 12 | Intra-run dedup of identical embed texts | Low-Med | neutral-pos | S | High | `Embeddings.embed` |
| 13 | Column-layout upserts (`upsert_columns`) | Low-Med | slightly pos | M | Med | `Turbopuffer.ts` write builder |
| 14 | Disable `filterable` on unused attrs | Low | neutral (server) | S | Med | `schema.ts:43-62` (audit query sites first) |
| 15 | wyhash/xxHash for fileHash/contentHash | None cold, ~5x warm hash slice | slightly pos | S | High | `domain/hash.ts` |
| 16 | Local ONNX embedder (remove network) | Hardware-dependent | **+RSS** | L | Med | new provider; offline backend only |

## Quick wins (S effort — do now)

**#1 Larger token-budgeted batch + fix double-concurrency.** Mechanism: each round-trip pays OpenRouter's ~50-100ms proxy + TLS + queue overhead regardless of payload; amortize it over more chunks. The 300k-token/request and 2048-input caps mean the real ceiling is ~512-900 chunks (~330 tokens/chunk incl. path prefix). **Concrete:** raise `embedBatch` to 256; in `Embeddings.embed` (65-72) replace the count-only `Arr.chunksOf` with a token-budget accumulator (chars/4 heuristic, cap ~250k) AND remove the internal re-fan-out when called from the Indexer (the consumer already controls concurrency). *Source: community.openai.com/t/max-total-embeddings-tokens-per-request/1254699; codewords.ai/blog/openrouter-embedding-models.* **Risk:** without the token budget, large chunks trip 400s; without the concurrency fix, 429s rise.

**#3 Dimensions 3072→1536.** Mechanism: text-embedding-3-large is Matryoshka-trained, so `dimensions=1536` returns a natively-truncated, renormalized vector losing ~1-4 NDCG@10. **Concrete:** set `defaults.ts:81` to 1536. Fully plumbed already — `Embeddings.ts:26-28` passes it to the model, `schema.ts:43` templates `[${dimensions}]f32`, `Turbopuffer.ts:47` reads it. *Source: pinecone.io/learn/openai-embeddings-v3; weaviate.io/blog/openais-matryoshka-embeddings-in-weaviate.* **Risk:** changes namespace signature → full re-index; irreversible without re-embed; **A/B retrieval on YOUR code queries before committing** (MTEB-on-text ≠ code).

**#4 Drop the `Array.from` copy.** Mechanism: `@effect/ai-openai` already materializes each vector as an owned `number[]` (verified: `mapProviderResponse` does `[...entry.embedding]`), so `Array.from(item.vector)` at `Embeddings.ts:53` is a second redundant 3072-element allocation, immediately orphaned. **Concrete:** change line 53 to `response.embeddings.map((item) => item.vector)`. *Source: node_modules/@effect/ai-openai OpenAiEmbeddingModel mapProviderResponse.* **Risk:** none — it's a read-only ReadonlyArray we never mutate. **This is the cleanest free memory win.**

**#5 Stop re-sending `schema` on every write.** Mechanism: `Turbopuffer.ts` sends the full 18-field `schema` on every upsert/delete (lines 88, 98, 104, 111, 116). TurboPuffer v2 only needs schema on namespace create or change. **Concrete:** send schema once (first write per namespace) or when `buildSchema` output changes; drop it from steady-state upserts. **Risk:** verify against live v2 API that schema is optional on subsequent upserts before rolling out — Med confidence, test one call first.

**#6 Provider → OpenAI direct.** Removes the proxy hop (~50-100ms/call) and gives reasoning-friendly explicit limits. **Concrete:** `defaults.ts:79` `provider: "openai"`; zero code change (`clientLayer` already routes). **Risk:** needs funded OpenAI account at sufficient tier; absolute saving shrinks once batches are larger (fewer calls).

## Bigger bets (M/L — sequence deliberately)

**#2 Decouple upsert from embed.** Mechanism: in `embedBatchAndUpsert` (215-235) each consumer does `embed` → `upsert` → manifest-finalize sequentially; the fiber is idle during the ~100-300ms upsert RTT (a ~1-2MB JSON body), time it isn't pulling embed budget. ~144 upserts × ~150ms ≈ 20s of stall (~14% of code phase). **Concrete:** add `Queue.bounded<UpsertJob>(4)` in `indexAll`; split the consumer to embed-then-offer; add a small pool of upsert fibers that drain the queue, call `store.upsert`, then run the `pending.remaining`/`manifest.record` finalize. *Source: turbopuffer.com/docs/performance (parallel writes, per-namespace 32k+ writes/s); Indexer.ts:215-235 direct read.* **Risk (load-bearing):** the `pending` Map mutation + `remaining -= 1` is **already not fiber-safe** across 10 consumers; moving finalize to a separate stage is the chance to fix it with a `Ref`/single finalize fiber. Manifest must record a file ONLY after the upsert containing its last chunk succeeds, or a crash marks files indexed whose vectors never landed.

**#7 Persistent vector cache.** Mechanism: vectors live only in TurboPuffer; a fork/re-clone/branch-switch (namespace derived from root path) re-embeds 100% of identical chunks — full 147s again. Disk cache keyed by `sha256(embedText) + model + dimensions` turns re-index toward ~0 embed time for hits (142MB on disk for this repo). **Concrete:** new `src/embedding/VectorCache.ts` (Effect service over FileSystem), partition hits/misses in `Embeddings.embed`. **Risk:** key MUST include model+dims (mirror `settingsSignature`); atomic writes (temp+rename) or torn vectors corrupt search. **For cross-PATH dedup (vendored/moved files) you must also drop the `// ${path}` prefix from embedText** — separate, quality-sensitive change; path stays a BM25/filter attribute regardless. **This is the highest-leverage lever for the repeat/fork workflows, but zero help on the first cold index.**

**#9 voyage-code-3.** The single biggest *quality* move (+13.8% avg over text-embedding-3-large across 32 code datasets, 32k context so large chunks never truncate, MRL 1024 = −67% storage). **Concrete:** new adapter (Voyage uses `input_type` doc/query + different response shape — not OpenAI-identical), `provider: "voyage"`, `dimensions: 1024`. *Source: blog.voyageai.com/2024/12/04/voyage-code-3; docs.voyageai.com/docs/rate-limits.* **Risk:** new vendor + key + adapter; forces re-index. Treat as a deliberate quality upgrade, not a speed fix.

## Adversarial sanity-check — claims I downgrade or flag

- **"Larger batch = 1.5-2.5x code phase" → downgraded to 1.3-2x.** Amortizing fixed per-call latency only helps the *latency* component; if OpenRouter's per-call time is partly proportional to payload (queue + compute scales with tokens), the win shrinks. And the double-concurrency bug means naive batch-raising raises 429s, eating the gain. Honest range: 1.3-2x, contingent on the concurrency fix.
- **"Decouple = 10-25% off code phase" → keep at 10-20%, hard-capped.** This only reclaims time consumers spend *blocked in upsert*. Since the run already grazes the rate limit, freed embed capacity converts to speed ONLY if the rate ceiling isn't already binding. If you're rate-limited, decoupling buys less than the headline.
- **"Provider=OpenAI saves 7-14s" → shrinks toward 2-4s after batching.** Fewer calls (23 at batch 512) × 50-100ms = 1-2s. The proxy-hop saving is real but small once batches are large. Keep it for the *reasoning-about-limits* benefit, not the wall-clock.
- **gzip (#8): flagged Med.** Two unverified assumptions: (a) Effect's `bodyJsonUnsafe` path has no gzip — confirmed by agent grep; (b) TurboPuffer v2 raw HTTP accepts `Content-Encoding: gzip` — **NOT documented for v2, only inferred from Go/Ruby clients.** Note also `Turbopuffer.ts:59` already sets `Accept-Encoding: identity` (response compression deliberately off). Test one upsert returns 200 before adopting.
- **Column layout (#13) & filterable (#14): Med, magnitude unpublished.** TurboPuffer recommends both but gives no numbers, and the phase is embed-bound, so wall-clock impact on a cold index is likely negligible. Defer.
- **Split ANN/BM25 namespaces:** I **reject for now.** High blast radius (forces two queries + client-side RRF fusion in `query`), and on an embed-bound cold index it won't move the 147s wall clock. Not worth it without evidence index-build latency matters.
- **Local ONNX embedder (#16):** honestly hardware-dependent and a real quality regression vs voyage/OpenAI. Raises RSS (loads model). Only earns its keep as an offline/air-gapped backend, never the default.
- **Producer micro-opts (walk, hashing): correctly framed as ~0% on cold index** (~50ms total producer CPU vs 147s embed). The wyhash swap matters only on warm re-index and 50-500x-larger repos. Don't reorder the cold pipeline for it.

## Key interactions / conflicts

- **Dimension cut, embedText change, model swap, hash-format change ALL rotate the namespace signature → full re-index.** Batch them into ONE re-index, don't pay it four times.
- **Batch size ↑ × memory:** 512 vectors × 3072d × 8B ≈ 12MB/batch; across consumers this is transient but real. Pairs naturally with the dimension cut (1536 halves it) and the `Array.from` drop.
- **Batch size ↑ × concurrency:** because of the double-fan-out, raising batch without fixing concurrency multiplies in-flight requests and 429s. **Fix concurrency first.**
- **Decouple (#2) is the structural foundation** for larger *upsert* batches (accumulate several embed-batches before one write) and for the not-fiber-safe `pending` Map fix. Do it before #13/#14.
- **Vector cache (#7) + path-free embedText:** only the latter unlocks cross-path/vendored dedup; the cache alone dedupes same-path re-indexes.
- **Local embedder removes rate limits AND the OpenRouter dependency but adds CPU + model RSS** — opposite memory direction from every other lever.

## Recommended implementation sequence

Measure every step with `SEMSEARCH_PROBE` (already prints rss/heap/external/pending) + `Effect.timed` on `indexAll`. Baseline to beat: **170s / 537MB / 1.1GB RSS.**

1. **Free wins, no re-index (one PR):** drop `Array.from` (#4) + stop re-sending schema (#5, after a one-upsert live test). Measure RSS delta — expect lower peak footprint, ~same time. *Verify: probe peak RSS drops; index output unchanged.*

2. **Fix double-concurrency, then raise batch (#1).** First make the Indexer path call the single-request primitive (or `concurrency:1`), confirm 429 rate unchanged at batch=80. Then add the token budget, raise `embedBatch` to 256. Measure code-phase time and 429 count at each step. *Verify: 429s ≤ baseline, code phase drops.*

3. **Decouple upsert (#2)** with the `pending`-Map fiber-safety fix. Measure code-phase time. *Verify: no manifest records a file before its vectors persist — kill the process mid-run, confirm that file re-embeds next run.*

4. **A/B dimensions 1536 (#3)** on a held-out set of real code-search queries. If recall holds, commit + single full re-index (also fold in any embedText/provider change here). *Verify: NDCG@10 / recall@k within tolerance; storage and query latency drop.*

5. **Provider → OpenAI (#6)** if account tier supports it — cleaner limits make steps 2-3 easier to reason about.

6. **Persistent vector cache (#7)** — the payoff for the fork/branch/re-clone workflows. Independent of cold-index speed; ship after the cold path is tuned.

7. **Deferred / evidence-gated:** voyage-code-3 (#9, quality upgrade, own re-index), gzip (#8, only if network-bound shows up), column layout (#14)/filterable (#15) (only if TurboPuffer index-build latency is measured to matter), worker-thread (#11, only for the long-lived `pi/extension.ts` path), wyhash (#15, only when warm re-index or huge repos become the workload).

**Files that carry the most leverage:** `src/embedding/Embeddings.ts` (lines 53, 65-72 — copy drop, batch/concurrency), `src/index/Indexer.ts` (lines 215-235 — decouple + fiber-safety), `src/config/defaults.ts` (lines 79, 81, 101 — provider/dims/batch), `src/store/Turbopuffer.ts` (lines 77-116 — schema-on-write, gzip), `src/store/schema.ts` (line 43-62 — dims template, filterable).
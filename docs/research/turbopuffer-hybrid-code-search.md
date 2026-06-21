# TurboPuffer for Hybrid Code Search — Grounding Brief

Researched 2026-06-20. Primary sources: turbopuffer.com/docs (write, query, hybrid,
performance, limits, regions, overview, concepts, architecture) and the official OpenAPI
(`github.com/turbopuffer/turbopuffer-openapi` → `openapi.yml`). SDK reference: `@turbopuffer/turbopuffer` npm **v2.5.0** (latest as of research date). This project builds an **Effect v4 HTTP client** directly against the v2 HTTP API — the Python/TS examples in the docs are translated to raw JSON wire shapes below.

All `$dist`, latency, and limit numbers are quoted from primary docs and cited inline.

---

## TL;DR Decisions

1. **One namespace per repo** (not per-file, not global). Name `{prefix}_{repo_id}` so object-storage prefix listing can enumerate/delete a tenant's namespaces. Namespaces are unlimited and implicitly created on first write. (`/docs/concepts`, `/docs/performance`, dsdev blog)
2. **Single combined namespace with both ANN + BM25** is correct for a code-search MVP. Docs note a *temporary* indexing-throughput caveat for combined ANN+BM25 namespaces and suggest splitting only if indexing throughput suffers — not a correctness issue. (`/docs/performance`)
3. **Hybrid = multi-query (1 HTTP call) + fuse.** Send `{queries:[ANN, BM25], rerank_by:["RRF"]}` to `POST /v2/namespaces/{ns}/query`. Native server-side RRF exists (`rerank_by:["RRF",{rank_constant:60}]`); client-side RRF is also documented and is what you want if you add a cross-encoder reranker stage. (`/docs/query`, `/docs/hybrid`)
4. **`text-embedding-3-large` @ 3072 dims, `[3072]f32`, `ann:true`, `distance_metric:"cosine_distance"`.** Consider `dims:1536` (Matryoshka) or `[N]i8` quantization for ~2x query speed if recall holds in evals. (`/docs/performance`, `/docs/write`)
5. **Batch writes; column format for bulk.** Max request 512 MB; per-namespace write cap 10k writes/s @ 32 MB/s; batch discount up to 50%. Keep raw chunk `text` as `filterable:false` (50% cheaper, faster indexing). (`/docs/limits`, `/docs/write`, `/docs/performance`)
6. **Patches cannot touch vector columns.** On chunk re-embed you must `upsert_rows` the full row. Use `delete_by_filter` on `fileHash`/`path` for file deletes. (`/docs/write`)
7. **Strong consistency is the default and gives read-after-write** (~10ms object-storage floor). Use `consistency:{level:"eventual"}` only for sub-10ms read-heavy paths that tolerate ~100ms–1h staleness. (`/docs/query`, `/docs/concepts`)
8. **Cold query p50 ≈ 874ms (1M docs, uncached); warm p50 ≈ 14ms.** Prewarm with `GET /v1/namespaces/{ns}/hint_cache_warm` when the agent opens a session. (`/docs/architecture`)
9. **Disable HTTP compression, reuse one keep-alive client.** Clients are CPU-bound, not bandwidth-bound; official clients disable gzip by default. (`/docs/overview`, `/docs/performance`)
10. **429 = backpressure.** Writes 429 when unindexed data > 2 GiB; queries 429 above per-namespace QPS (~1k+/s) / 16 concurrent. Retry with backoff. (`/docs/overview`, `/docs/limits`, `/docs/write`)

---

## 1. Transport / Auth / Wire basics

- Base URL is **region-specific**: `https://{region}.turbopuffer.com` (e.g. `https://gcp-us-central1.turbopuffer.com`). Pick the region closest to your backend. (`/docs/regions`)
- Auth: `Authorization: Bearer <API_KEY>`. (`/docs/overview`)
- JSON request+response. **Disable compression** — "for most workloads, disabling compression offers the best performance… clients are typically CPU constrained, not network bandwidth constrained. The official client libraries disable request and response compression by default." (`/docs/overview`)
- **Reuse one HTTP client** (connection pool / keep-alive) to avoid TCP+TLS handshake per request. (`/docs/performance`)
- Error body: `{"status":"error","error":"an error message"}`. (`/docs/overview`)
- Async ops (`copy_from_namespace`, recall eval) use `Prefer: respond-async` → `202` + `Location` to poll. Not needed for write/query. (`/docs/overview`)
- Namespace name regex: `[A-Za-z0-9-_.]{1,128}`. (`/docs/write`)

**Effect implication:** build a single `HttpClient` layer with the region base URL + bearer auth + `Accept-Encoding: identity` baked in, shared across the app. Wrap 429 in a typed `Backpressure` error and retry with `Schedule.exponential`.

---

## 2. Schema definition (v2 write API)

Schema is per-namespace, inferred from data by default. Pass `schema` on a write to override; you can pass it on every write (no perf cost) or only the first. Changing an existing attribute's **type** is an error; you can only online-change `filterable`/`full_text_search`/`regex`/`glob`/`fuzzy`. (`/docs/write`)

### Attribute types relevant to code search
`string`, `int`, `uint`, `float`, `uuid`, `datetime`, `bool`, `[]string`, `[N]f32`/`[N]f16`/`[N]i8` (dense vector), `{}f16` (sparse). All nullable except `id`. (`/docs/write`)

### Vector field
- Named `vector` → auto-inferred as a vector type. Extra vector columns must be **explicitly declared** in schema. Max **2 vector columns** per namespace, fixed at creation. (`/docs/write`, `/docs/limits`)
- Must set `ann: true` to build the ANN index (enables `rank_by` ANN). (`/docs/write`)
- `distance_metric` is namespace-wide, set on the write request body (NOT inside the per-attribute schema): `cosine_distance` (= `1 - cosine_similarity`, range 0–2, lower better) or `euclidean_squared`. **Required** on any write to a namespace that has vector columns (unless copy/branch). (`/docs/write`)
- Max dims for dense vectors: 10,752. (`/docs/limits`)
- Base64 little-endian f32 encoding accepted for vectors and can be faster client+server; `i8`/`f16` schema element type does not change the base64 wire format (always f32 in base64). (`/docs/write`)

### FTS (BM25) field
- `full_text_search: true` (or object) on a `string`/`[]string` attribute. Enabling FTS **sets `filterable:false` by default** — override with `filterable:true` if you also need to filter that field. (`/docs/write`)
- Tunables (object form): `tokenizer` (default `word_v4`), `case_sensitive` (default false), `language` (default `english`), `stemming` (default false), `remove_stopwords` (default false), `ascii_folding`, `max_token_length` (1–254, default 39), BM25 `k1`=1.2, `b`=0.75, `k3`=8.0. (`/docs/write`)
- **Code-search note:** for symbol/path matching, keep `stemming:false` and `remove_stopwords:false` (do NOT stem identifiers). Consider `case_sensitive:false` for ergonomic queries. Long identifiers can exceed `max_token_length` 39 — bump if you index very long symbols.

### Filterable vs non-filterable
- Default `filterable:true` → built into an inverted index, usable in `filters` + recall-aware for ANN. (`/docs/write`, `/docs/concepts`)
- `filterable:false` → **50% storage/write discount + faster indexing**; attribute still returnable, just not filter/sort-able. Use for large raw text blobs. (`/docs/write`, `/docs/performance`)
- Billing: indexed attr billed at 100% × (#indexes). `filterable:true` + `full_text_search:true` = 200% of logical size. Unindexed = 50%. (`/docs/write`)

### Glob filters (important for code-search path filtering)
`Glob`/`IGlob`/`NotGlob` require `glob:true` (or legacy `filterable:true`) on the attribute. Trigram-indexed; anchored patterns (`turbo*`, `*puffer`) are fast, unanchored (`*foo*`) slower, avoid `[a-z]*` full scans. (`/docs/query`, `/docs/performance`, `/docs/concepts`)

---

## 3. Recommended schema for code chunks

Two vector columns max, so we use one (`vector`). `text` is the chunk body (FTS, non-filterable for cost). `pathText` is a separate FTS-tokenized path for filename matching. `path` (exact, glob-filterable) supports directory filters.

### Write request (column-based bulk upsert) — exact JSON wire shape

`POST https://{region}.turbopuffer.com/v2/namespaces/{repo_ns}`

```json
{
  "upsert_columns": {
    "id":        ["a1b2…", "c3d4…"],
    "vector":    [[0.0123, -0.044, "…3072 f32…"], [0.071, 0.002, "…"]],
    "text":      ["export const handler = …", "function parseAst(node) { … }"],
    "path":      ["src/api/handler.ts", "src/ast/parse.ts"],
    "pathText":  ["src api handler ts", "src ast parse ts"],
    "language":  ["typescript", "typescript"],
    "kind":      ["function", "function"],
    "startLine": [10, 42],
    "endLine":   [38, 95],
    "fileHash":  ["sha256:aa…", "sha256:bb…"],
    "chunkHash": ["sha256:11…", "sha256:22…"]
  },
  "distance_metric": "cosine_distance",
  "schema": {
    "id":       "uuid",
    "vector":   { "type": "[3072]f32", "ann": true },
    "text":     { "type": "string",  "full_text_search": { "stemming": false, "remove_stopwords": false }, "filterable": false },
    "path":     { "type": "string",  "glob": true, "filterable": true },
    "pathText": { "type": "string",  "full_text_search": { "stemming": false } },
    "language": { "type": "string",  "filterable": true },
    "kind":     { "type": "string",  "filterable": true },
    "startLine":{ "type": "uint",    "filterable": false },
    "endLine":  { "type": "uint",    "filterable": false },
    "fileHash": { "type": "string",  "filterable": true },
    "chunkHash":{ "type": "string",  "filterable": false }
  }
}
```

Notes:
- `id`: prefer u64 (8 bytes) or UUID-native (16 bytes) over string (36 bytes as UUID string) for speed. If you use a content hash as a string id, it's ≤64 bytes — fine but slower than u64. Recommend deriving a u64 from `chunkHash` or using a UUIDv5 of `path+startLine`. (`/docs/performance`, `/docs/write`)
- `fileHash` filterable → enables `delete_by_filter(["fileHash","Eq", oldHash])` on file change.
- `text` non-filterable: you still get it back in `include_attributes` for reranking, but it's 50% cheaper and doesn't slow indexing.
- `startLine`/`endLine` non-filterable unless you actually do line-range filters; keep them cheap by default.

### Row-based variant (smaller incremental updates)
```json
{ "upsert_rows": [ { "id":"…", "vector":[…], "text":"…", "path":"…", "pathText":"…",
  "language":"typescript", "kind":"function", "startLine":10, "endLine":38,
  "fileHash":"…", "chunkHash":"…" } ], "distance_metric":"cosine_distance", "schema": { … } }
```

### Write response (`WriteResult`)
```json
{ "status":"OK", "message":"…", "rows_affected":2, "rows_upserted":2,
  "billing": { "billable_logical_bytes_written": 12345 },
  "performance": { "server_total_ms": 41 } }
```
(`required: [status, message, rows_affected, billing]`; `rows_upserted/patched/deleted`, `rows_remaining`, `*_ids`, `performance` conditional.) (OpenAPI `WriteResult`)

---

## 4. Writes: upsert vs patch, deletes, batching

| Op | Field | Semantics |
|---|---|---|
| Upsert | `upsert_rows` / `upsert_columns` | Overwrites the **entire** doc. Must include all vector columns. |
| Patch | `patch_rows` / `patch_columns` | Updates only named keys. **Cannot patch vector attributes.** IDs that don't exist are ignored (no insert). |
| Delete by id | `deletes: [id…]` | Whole-doc delete. |
| Delete by filter | `delete_by_filter: <filter>` | Deletes matches; max **5M** rows/request; billed as write + 1 query. Applied *before* other ops in same request. |
| Patch by filter | `patch_by_filter: {filters, patch}` | Max **50k** rows/request; billed as write + 2 queries. |
| Conditional | `upsert_condition`/`patch_condition`/`delete_condition` | Filter syntax + `{"$ref_new":"attr"}` to reference incoming value. Version-check pattern: `["version","Lt",{"$ref_new":"version"}]`. |

(`/docs/write`, `/docs/limits`)

### Key code-search gotchas
- **Re-embedding requires full upsert** — vector can't be patched. On chunk content change, upsert the whole row.
- **File delete**: `{"delete_by_filter": ["path","Eq","src/old.ts"]}` (or by `fileHash`). Applied before upserts in the same request, so you can atomically replace a file's chunks: delete-by-filter old path + upsert new chunks in one call.
- **Incremental sync pattern**: compute `fileHash` per file; if unchanged, skip. If changed, one write request = `delete_by_filter` on path + `upsert_rows` of new chunks.
- **Duplicate id in one request → HTTP 400.** Dedupe chunk ids before sending. (`/docs/write`)
- **Conditional "insert if not exists"**: `upsert_condition: ["id","Eq",null]` (existing docs have non-null id → skipped). Useful to avoid re-writing unchanged chunks if you key by `chunkHash`. (`/docs/write`)

### Batching / throughput
- **Max request size: 512 MB.** (`/docs/limits`, `/docs/write`)
- **Per-namespace write cap: 10k writes/s @ 32 MB/s** (production limit; observed 32k+/s @ 64 MB/s). Global unlimited. (`/docs/limits`)
- **Batch discount up to 50%** — fewer, larger requests are cheaper and faster. Use **column format** for bulk (better serialization/compression). (`/docs/performance`, `/docs/write`)
- **Concurrent writes**: parallelize batches across processes/fibers; single-threaded runtimes (Node) are bottlenecked on serialization+compression, so concurrency is a big win. (`/docs/performance`)
- **Recommended batch sizing (derived):** target large batches but stay well under 512 MB and under ~8 MiB/attribute-value, ~64 MiB/doc. For 3072-dim f32 vectors (~12 KB/vec) plus a few KB text, a few-thousand-chunk batch (~tens of MB) is a safe, efficient unit. Cap by byte size, not row count.
- **Indexing is async** (WAL → indexing nodes). Strongly-consistent queries still exhaustively scan unindexed data. **Writes 429 (backpressure) when unindexed data > 2 GiB.** Set `disable_backpressure:true` only for bulk initial loads (then strong queries error above threshold — use eventual). (`/docs/write`, `/docs/concepts`)
- Group commit batches concurrent writes to the same namespace into one WAL entry automatically. (`/docs/concepts`)

---

## 5. Query API (v2)

`POST /v2/namespaces/{ns}/query`. Body = `QueryConfig` (root: `vector_encoding`, `consistency`) merged with a `Query`. (OpenAPI)

### `rank_by` tuple shapes (exact)
- ANN: `["vector","ANN",[f32…]]` (OpenAPI `RankByAnn`)
- kNN (exact, **requires filters**): `["vector","kNN",[f32…]]`
- BM25: `["content","BM25","quick fox"]` (string) or `["content","BM25",["tok1","tok2"]]` (token array) (OpenAPI `RankByText`)
- Order-by-attribute: `["startLine","asc"]` / `["…","desc"]`
- Weighted/boosted FTS: `["Sum", [["Product",2,["title","BM25","q"]], ["content","BM25","q"]]]`
- Docs with score 0 are excluded from results. (`/docs/query`)

### `filters` syntax (exact)
Tuples `["attr","Op",value]`, combined with `["And",[…]]` / `["Or",[…]]` / `["Not",filter]`.
Ops: `Eq, NotEq, In, NotIn, Contains, NotContains, ContainsAny, NotContainsAny, Lt, Lte, Gt, Gte, AnyLt/Lte/Gt/Gte, Glob, NotGlob, IGlob, NotIGlob, Regex, Fuzzy, ContainsAllTokens, ContainsTokenSequence, ContainsAnyToken`. (`/docs/query`)

Code-search example (scope to language + dir, exclude vendored):
```json
["And", [
  ["language","Eq","typescript"],
  ["path","Glob","src/**"],
  ["path","NotGlob","**/vendor/**"]
]]
```

### Other query fields
- `top_k` = alias for `limit.total`. **Max `limit.total` = 10,000.** (`/docs/query`, `/docs/limits`)
- `limit` can be `N` or `{total, per:{attributes,limit}}`. `per` enables diversification (e.g. ≤2 chunks per file): `{"total":50,"per":{"attributes":["path"],"limit":2}}`. `per` supported for vector + order-by (BM25 on roadmap). (`/docs/query`)
- `include_attributes`: array or `true`. **Return only what you need** — default is just `id`. Big perf lever. Don't return `vector` unless needed. (`/docs/query`, `/docs/performance`)
- `exclude_attributes`: inverse; mutually exclusive with `include_attributes`.
- `consistency`: `{"level":"strong"}` (default, read-after-write, ~10ms floor) or `{"level":"eventual"}` (≤128 MiB unindexed scanned, sub-10ms, 99.8% consistent, up to ~1h stale after big writes). **Set at root, shared by all sub-queries in a multi-query.** (`/docs/query`, `/docs/concepts`)
- `vector_encoding`: `float` (default) or `base64`. Root-level only.

### `$dist` meaning
Per-row special attribute = ranking score. ANN → distance from query vector (cosine_distance 0–2, lower=closer). BM25 → BM25 score (higher=better). Omitted for order-by. RRF → fused RRF score = Σ `1/(rank_constant+rank)`. (`/docs/query`)

### Single-query response (`QueryResult`)
```json
{ "rows": [ {"$dist":0.12,"id":"…","path":"src/api/handler.ts","text":"…"} ],
  "performance": { "cache_hit_ratio":1.0, "cache_temperature":"hot", "server_total_ms":14,
                   "query_execution_ms":9, "exhaustive_search_count":0, "approx_namespace_size":120000 },
  "billing": { "billable_logical_bytes_queried":…, "billable_logical_bytes_returned":… } }
```
(OpenAPI `QueryResult`/`QueryPerformance`. `last_included_write_at` also documented in `/docs/query`.)

---

## 6. Hybrid search (the core pattern)

**Multi-query in ONE HTTP call.** `queries` is mutually exclusive with single-query fields. Up to **16 sub-queries** per request; snapshot-isolated (one consistent DB snapshot). Multi-query is faster than N separate calls. (`/docs/query`, `/docs/limits`)

> SDK note: the TS/Python SDKs expose `ns.multiQuery({queries, rerankBy})`. On the wire this is `POST /v2/namespaces/{ns}/query` with `{queries, rerank_by}` — the `?stainless_overload=multiQuery` suffix is an SDK codegen artifact, **not** a real URL param. Our Effect client posts to the plain `/query` path. (OpenAPI lines 318–345)

### Hybrid multi-query with native RRF — exact JSON wire shape
```json
{
  "consistency": { "level": "strong" },
  "queries": [
    {
      "rank_by": ["vector", "ANN", [0.0123, -0.044, "…3072 f32…"]],
      "limit": 40,
      "filters": ["path", "NotGlob", "**/node_modules/**"],
      "include_attributes": ["path", "text", "language", "kind", "startLine", "endLine"]
    },
    {
      "rank_by": ["text", "BM25", "parse ast node"],
      "limit": 40,
      "filters": ["path", "NotGlob", "**/node_modules/**"],
      "include_attributes": ["path", "text", "language", "kind", "startLine", "endLine"]
    }
  ],
  "rerank_by": ["RRF", { "rank_constant": 60 }]
}
```

Response (`MultiQueryResult`) when `rerank_by` is set = a single fused `results` shape; without it, `results` is an array aligned to `queries` order:
```json
{ "results": [ { "rows": [ {"$dist": 0.0325, "id":"…", "path":"…", "text":"…"} ] } ],
  "performance": {…}, "billing": {…} }
```
(OpenAPI `MultiQueryResult` + `/docs/query` RRF section: "results contain a single list… sorted by descending RRF score… `$dist` = Σ 1/(rank_constant+rank)".)

### Native RRF vs client-side RRF — decision
- **Native** (`rerank_by:["RRF"]`): zero client code, one round-trip, fused list back. `rank_constant` default 60. Requires ≥2 sub-queries, not for aggregations. **Use this as the default hybrid path.** (`/docs/query`)
- **Client-side RRF** (docs `/docs/hybrid` show it, k=60): return both `results` arrays unfused and run RRF in `search.ts`. **Choose this when you add a cross-encoder reranker** — you want the per-arm ranked lists to feed the reranker, or you want to weight arms / inspect arms for debugging. Reference impl (translate to TS):
  ```
  score[id] += 1 / (k + rank)   // k=60, rank 1-based, summed across arms
  ```
- **Weights:** TurboPuffer RRF has no per-arm weight knob (it's rank-based by design — that's the point of RRF). To weight lexical vs semantic, either (a) do client-side weighted RRF, or (b) use a single `rank_by` Sum expression with `Product` boosts for an all-BM25 multi-field score. For true vector+BM25 weighting, client-side is the lever.

### RRF caveat (production, dsdev blog)
> "If one of BM25 or vector search is bad, doing RRF over it will pull down the good results from the one actually performing well." Understanding query intent (symbol/exact vs natural-language) helps decide arm weights. For code search: route exact-symbol queries to BM25-heavy, NL queries to vector-heavy. (dsdev.in agentic-search notes)

### Reranking guidance
- TurboPuffer = **first-stage retrieval only**: "narrow millions of results to dozens for rank fusion and re-ranking." Keep `rank_by` simple, retrieve ~100–1,000 hits, rerank in stage 2. (`/docs/hybrid`, `/docs/performance`)
- Recommended rerankers: **Cohere Rerank, ZeroEntropy, MixedBread, Voyage.** (`/docs/hybrid`)
- Reranker latency (dsdev): depends more on **doc size** than doc count → send smaller chunks; structured-doc reranking is ~2x slower than unstructured. So rerank on the trimmed `text` (or a snippet), not the whole file.
- **Score-based boosts inside `rank_by`** (alternative to a separate reranker): `Saturate`/`Decay`/`Dist`/`Attribute`/`Product` operators let you fold numeric signals (recency, click counts) into the first-stage score. For code search you could `Decay` by file recency or boost by `kind`. Keep weights in [1,3]. (`/docs/query`)

### Optional: server-side embedding
TurboPuffer can auto-embed a string attribute (`schema.text.embed: "model"` or `{model, dims, attribute}`), creating a computed `$embed_<attr>` vector. **Decision: do NOT use** — we control embeddings (`text-embedding-3-large`) client-side for reproducibility, model pinning, and to embed once for both upsert and query. (OpenAPI `AttributeEmbed`)

---

## 7. Namespace design

- **Granularity: one namespace per repo.** "Create one namespace per set of documents expected to be returned in the same query rather than using filters to separate data. Smaller namespaces → better query + indexing performance." (`/docs/concepts`, `/docs/performance`)
- **Naming for object-storage prefix queries** (dsdev, critical): namespaces live under prefixes on S3-like storage and support prefix listing. Put the tenant/owner id **in the prefix**, e.g. `{org}_{repo}` not `repo_{org}` — otherwise you can't list "all namespaces for org X" (needed for bulk delete / compliance / GC of a repo's namespaces). Recommend: `codeidx_{orgId}_{repoId}` or include a schema-version segment `codeidx_v1_{orgId}_{repoId}` so you can reindex into a fresh namespace and cut over.
- **Limits:** namespaces unlimited; ≤500M docs / 2 TB per namespace; ≤1,024 attribute names per namespace; name ≤128 bytes; ≤2 vector columns. (`/docs/limits`)
- **Reindex/migration:** can't change attribute type or delete attribute in place → export + upsert into a new (versioned) namespace, or `branch_from_namespace` (instant copy-on-write clone, flat $0.032) for test/backup. (`/docs/write`, `/docs/performance`)
- **Cold-start latency & caching:** 3-tier cache (object storage → NVMe SSD → memory). First (cold) query reads object storage directly: **p50 ≈ 874ms @ 1M docs** (docs also cite ~400–500ms in best cases); cached/warm: **p50 ≈ 14ms @ 1M docs**. (`/docs/architecture`, `/docs/concepts`)
- **Prewarm:** `GET /v1/namespaces/{ns}/hint_cache_warm` → `202 ACCEPTED`. Cheap + easy; warm caches when the agent session opens (before the user's first query) to kill cold latency. (OpenAPI line 152, dsdev blog, `/docs/performance`)
- **Pin** high-QPS namespaces for reserved always-warm compute (≤256 pinned). Probably unnecessary for a per-repo CLI MVP. (`/docs/performance`, `/docs/limits`)

---

## 8. Performance & operational limits

### Latency expectations (from docs)
| Scenario | p50 |
|---|---|
| Cold/uncached query, 1M docs | ~874 ms (object-storage reads; ~400–500ms best case) |
| Warm query, 1M docs | ~14 ms |
| Consistent (strong) read floor | ~10 ms (object-storage check for latest writes) |
| Eventual-consistency warm | sub-10 ms |
| Write (group-committed) | p50 ~165 ms for 500 kB |
(`/docs/architecture`, `/docs/concepts`)

### Minimize round-trips
- **One multi-query call** for hybrid (not 2). (`/docs/query`)
- **Prewarm** before the first real query. (`/docs/performance`)
- **`include_attributes` minimal** — never return `vector`; return only fields the agent/reranker needs. (`/docs/performance`)
- **Smaller vectors** = faster: 512-dim < 1536 < 3072; f16 < f32; i8 fastest. Consider `text-embedding-3-large` at reduced `dimensions` (Matryoshka) or `[N]i8` quantization, validated by your own recall evals. (`/docs/performance`)
- **Eventual consistency** for read-heavy hot paths. (`/docs/performance`)
- Recall target: 90–95% recall@10 (auto-measured on 1% of traffic). (`/docs/concepts`)

### Regions / gzip / keep-alive
- Choose closest region; cross-cloud adds 1–10ms (acceptable since queries > 10ms). (`/docs/regions`)
- **Disable gzip** (CPU-bound). (`/docs/overview`)
- **Keep-alive / one client** for connection pooling. (`/docs/performance`)

### Rate limits & 429 handling
| Limit | Value |
|---|---|
| Queries per namespace | 1k+/s |
| Concurrent queries per namespace | 16 |
| Queries per multi-query request | 16 |
| Writes per namespace | 10k/s @ 32 MB/s |
| Max unindexed data before write 429 | 2 GiB |
| Max upsert request | 512 MB |
| delete_by_filter rows | 5M / request |
| patch_by_filter rows | 50k / request |
| limit.total | 10,000 |
| Max attribute value | 8 MiB; filterable value 4 KiB; doc 64 MiB; id 64 bytes; attr names 1,024/ns |
(`/docs/limits`)

- **429 causes:** write backpressure (unindexed > 2 GiB) or query QPS/concurrency overflow. Body uses the standard error shape. Retry with exponential backoff + jitter. (`/docs/overview`, `/docs/write`)
- Multi-query sub-queries each count against the 16-concurrent limit; TurboPuffer tolerates *slight* overshoot in practice but don't rely on it. (`/docs/query`, dsdev blog)
- Each sub-query counts against concurrency — a 2-arm hybrid uses 2 of 16.

---

## 9. Effect v4 client sketch (compile-minded shape)

This is the wire contract the Effect HTTP client must satisfy. (Effect v4 service/schema patterns per vendored `effect-smol` LLMS.md; the TurboPuffer-specific shapes are from sources above.)

```ts
// Domain (plain TS data — travels cleanly)
type Region = `aws-${string}` | `gcp-${string}`
type Vector = ReadonlyArray<number>          // length 3072, f32
type RankBy =
  | readonly ["vector", "ANN", Vector]
  | readonly [string, "BM25", string]
  | readonly [string, "asc" | "desc"]
type Filter = readonly [string, string, unknown] | readonly ["And" | "Or", ReadonlyArray<Filter>]

interface MultiQueryBody {
  readonly consistency?: { readonly level: "strong" | "eventual" }
  readonly queries: ReadonlyArray<{
    readonly rank_by: RankBy
    readonly limit: number
    readonly filters?: Filter
    readonly include_attributes?: ReadonlyArray<string>
  }>
  readonly rerank_by?: readonly ["RRF", { readonly rank_constant: number }?]
}

// Effect service: deep module, narrow interface (search / upsert / delete / warm)
//   POST {base}/v2/namespaces/{ns}            -> upsert / delete
//   POST {base}/v2/namespaces/{ns}/query      -> single or multi query
//   GET  {base}/v1/namespaces/{ns}/hint_cache_warm
// Build on Effect HttpClient (effect/unstable/http), bake in:
//   - baseUrl = `https://${region}.turbopuffer.com`
//   - Authorization: Bearer <key>
//   - Accept-Encoding: identity   (gzip off)
//   - retry Backpressure (429) with Schedule.exponential + jitter
//   - decode responses with Schema (QueryResult / MultiQueryResult / WriteResult)
```

Concrete hybrid call body the client serializes (validated against OpenAPI `MultiQueryResult` + `/docs/query`):
```ts
const body: MultiQueryBody = {
  consistency: { level: "strong" },
  queries: [
    { rank_by: ["vector", "ANN", queryEmbedding], limit: 40,
      filters: ["path", "NotGlob", "**/node_modules/**"],
      include_attributes: ["path", "text", "language", "kind", "startLine", "endLine"] },
    { rank_by: ["text", "BM25", rawQuery], limit: 40,
      filters: ["path", "NotGlob", "**/node_modules/**"],
      include_attributes: ["path", "text", "language", "kind", "startLine", "endLine"] }
  ],
  rerank_by: ["RRF", { rank_constant: 60 }]
}
// POST https://gcp-us-central1.turbopuffer.com/v2/namespaces/codeidx_v1_{org}_{repo}/query
// -> { results: [{ rows: [{ $dist, id, path, text, ... }] }], performance, billing }
```

---

## 10. Open / verify-during-build

- **Embedding dims:** confirm `text-embedding-3-large` ANN recall at full 3072 vs Matryoshka-reduced (1536/1024) vs `[N]i8` on *your* code corpus before locking the vector type — type is fixed at namespace creation. Run a small recall eval. (`/docs/write`, `/docs/performance`)
- **Combined vs split ANN/BM25 namespace:** if indexing throughput lags during large reindex, split per docs' temporary workaround. Measure `unindexed_bytes` via metadata endpoint. (`/docs/performance`)
- **Client-side vs native RRF:** start native; switch to client-side RRF when the cross-encoder reranker lands (needed for per-arm weighting + feeding the reranker). (`/docs/query`, `/docs/hybrid`)
- **Region:** pick to match where the CLI/agent backend runs; for a local-dev CLI, latency is dominated by cold-cache + embedding API, not region. (`/docs/regions`)
- Couldn't fetch a machine-readable raw OpenAPI mirror (repo path is `openapi.yml`, fetched via `gh api`); all shapes above cross-checked against it.

### Citations
- https://turbopuffer.com/docs/write • /query • /hybrid • /performance • /limits • /regions • /overview • /concepts • /architecture
- https://github.com/turbopuffer/turbopuffer-openapi (`openapi.yml`: Write, WriteResult, Query, QueryConfig, QueryResult, MultiQueryResult, AttributeSchemaConfig, RankByAnn, RankByText, AttributeEmbed, `hint_cache_warm`)
- https://www.dsdev.in/some-notes-on-agentic-search-and-turbopuffer (namespace prefix naming, multi-query overshoot, RRF caveat, reranker latency, cache warming)
- `@turbopuffer/turbopuffer` npm v2.5.0 (latest)

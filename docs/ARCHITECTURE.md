# Architecture — `pi-semantic-search`

Effect v4 semantic + hybrid code search. One core library; two front-ends (a CLI and a Pi
coding-agent extension). Grounded design; see `docs/research/*` for the evidence behind every
external choice.

## Problem (first principles)

- **True now:** a coding agent finds code with `grep`/`read`. That is exact-match only, costs many
  tool calls, and burns context reading whole files to locate one symbol or concept.
- **Must remain true:** the agent's local `grep` still works; we add capability, never remove it.
  Indexing/watching must not leak memory or spike CPU inside the long-lived Pi process.
- **Want true:** the agent answers "where/how does X work" in *one* tool call, getting back the few
  right spans (path + lines + snippet), ranked, with minimal context spend.

The gap — fast, precise, low-context semantic retrieval over a live-indexed repo — is the work.

## Core trade-off

We trade a small always-on indexing/watching cost and an external vector store (TurboPuffer) +
embedding API (OpenAI) for a large reduction in the agent's tool-calls, context, and time-to-answer.

## Shape: ports & adapters, deep modules

```
                 ┌──────────── front-ends ────────────┐
   CLI (effect/unstable/cli)            Pi extension (session lifecycle + 2 tools)
                 └───────────────┬────────────────────┘
                                 │  yields services from one composed Layer
        ┌────────────────────────┼─────────────────────────────────┐
   Search            Indexer + Watcher                 Config (resolved settings)
   (query side)      (write side)                       (env + global + project json)
        │                  │
   ┌────┴─────┬────────────┼───────────────┬──────────────┐
 VectorStore  Embeddings   Chunker        Reranker        Manifest
 (TurboPuffer (OpenAI      (structural     (OpenRouter     (per-root chunk
  v2 HTTP)    3-large)      cAST split)     rerank, opt.)   bookkeeping cache)
```

Each box is a `Context.Service` with a narrow interface and a `Layer` that hides its dependencies.
Front-ends never touch HTTP, fs, or JSON shapes directly — they yield `Search` / `Indexer` /
`Watcher`.

## Modules (interface = contract)

| Service | Interface (narrow) | Hides |
|---|---|---|
| `SearchConfig` | `resolved: ResolvedConfig` value | env reading, json merge, defaults, namespace derivation |
| `Embeddings` | `embed(texts: string[]) => Effect<number[][]>` | OpenAI client, batching, retry, dims |
| `VectorStore` | `upsert`, `deleteByFilter`, `deleteIds`, `query(MultiQuery)`, `warm`, `ensureSchema` | TurboPuffer v2 wire shapes, HttpClient, gzip-off, retry, schema decode |
| `Reranker` | `rerank(query, docs, topN) => {index,score}[]` | OpenRouter `/rerank`, provider auto-select, graceful degrade |
| `Chunker` | `chunk(path, source) => Chunk[]` | cAST split-then-merge, char budget, context headers, content-hash IDs |
| `Manifest` | `load(root)`, `filesFor`, `diff`, `record`, `save` | on-disk cache layout under agent dir |
| `Indexer` | `indexAll(root)`, `reindexPaths(paths)`, `removePaths`, `clear`, `stats` | walk, hash gates, embed batches, atomic file replace |
| `Watcher` | `run(root): Effect<never>` (scoped) | fs.watch stream, debounce, bounded queue, finalizers |
| `Search` | `semantic(q,opts)`, `hybrid(q,opts) => SearchResult` | multiQuery build, RRF fusion, rerank, diversify, format |

## Key decisions (locked, with rationale)

1. **Embeddings via OpenAI directly** (`text-embedding-3-large`, 3072 dims). Verified working with
   the provided key; OpenRouter embedding coverage is uncertain. OpenRouter is reserved for rerank.
2. **`Context.Service` everywhere** (verified: beta.85 has `Context.Service`, not `Effect.Service`).
   `Layer.effect` for construction (it strips `Scope`; there is no `Layer.scoped` in v4).
3. **HTTP via `NodeHttpClient.layerUndici`** (pooled keep-alive; Effect owns timeouts), gzip off
   (`Accept-Encoding: identity`), bearer as `Redacted`, `retryTransient` + per-attempt timeout
   inside the retried unit, Schema-decoded responses, one client built per layer.
4. **TurboPuffer schema** (one namespace per repo, versioned name `pisem_v1_<slug>_<hash>`):
   `vector [3072]f32 ann cosine_distance`; `text` FTS non-filterable (cheap); `pathText` FTS
   (stemming off); `path` glob+filterable; `language`/`kind`/`fileHash` filterable; lines
   non-filterable. Writes: atomic file replace = `delete_by_filter(path)` + `upsert_rows` in one call.
5. **Hybrid = one multi-query call.** Default path uses TurboPuffer **native RRF**
   (`rerank_by:["RRF",{rank_constant:60}]`) → one fused list, minimal client logic. When a reranker
   is active, omit `rerank_by`, take per-arm lists, fuse client-side, then cross-encoder rerank.
6. **Two agent tools, not three.** `semantic_search` (vector ANN — concepts/behavior, fastest) and
   `hybrid_search` (vector + BM25 text + BM25 path + optional rerank — exact + semantic). No keyword
   tool: the agent already has `grep`.
7. **Chunker = structural cAST split-then-merge**, budgeted by **non-whitespace chars** (target
   1200 / max 1600), **content-addressed IDs** = `hash(path|symbolChain|rawText)` for shift-stable
   incremental reindex, compact context header (`// path` + `// kind symbol` + imports) on the
   *embed text only*. Ships as a leak-free heuristic strategy behind a clean interface; a
   web-tree-sitter AST strategy is a drop-in the evals can promote if it wins.
8. **Incremental indexing:** file-hash gate → re-chunk changed file → diff chunk IDs → embed only
   new/changed → atomic upsert + delete missing. Unchanged chunks never re-embed (cost + latency).
9. **Watcher safety:** `FileSystem.watch` → debounce → **bounded** `Queue` (drop-to-rescan on
   overflow) → indexer. All resources via `acquireRelease`/scoped fibers so teardown is total. Leak
   test asserts no FSWatcher/Timer growth across 20 start/stop cycles.
10. **Reranker is optional and degrades to passthrough** when `OPENROUTER_API_KEY` is absent, so the
    product is correct (hybrid fusion) with zero extra cost when keys are missing.

## Runtime composition

- **CLI:** `Command.run` → `Effect.provide(Layer.mergeAll(NodeServices.layer, AppLayer))` →
  `NodeRuntime.runMain`.
- **Pi:** Pi is not an Effect entrypoint. At `session_start` build a `ManagedRuntime` from `AppLayer`,
  warm the namespace, fork the indexer + watcher as scoped daemons. Tools run small Effects on that
  runtime. At `session_shutdown` dispose the runtime (closes the scope → stops watcher, frees pool).

## Error model

Tagged, Schema-backed (`Schema.TaggedErrorClass`): `ConfigError`, `EmbedError`, `StoreError`,
`RerankError`, `ChunkError`, `IndexError`. External JSON decoded with Schema at the boundary; decode
failures are `StoreError`. No silent fallbacks except the explicit reranker degradation (logged).

## Out of scope (v1)

Keyword tool (agent has grep), multi-repo federation, server-side embedding, local ONNX reranker
(opt-in later), per-arm RRF weight tuning UI.

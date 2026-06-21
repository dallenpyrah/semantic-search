# Reranker Choice for Code Retrieval (Effect v4 semantic-search CLI + Pi extension)

Status: grounded research brief. Date: 2026-06-20.
Credentials available: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TURBOPUFFER_API_KEY`. No Cohere/Voyage/Jina keys.

---

## Decision (TL;DR)

**Primary reranker: Cohere `rerank-v3.5` via the OpenRouter `/api/v1/rerank` endpoint** (hosted cross-encoder, reachable with the `OPENROUTER_API_KEY` we already have).
**Fallback (zero-cost / keys-degraded): the free `nvidia/llama-nemotron-rerank-vl-1b-v2:free` model on the same OpenRouter `/rerank` endpoint**, and below that, no-rerank passthrough (return the hybrid fusion order unchanged).

Rationale in one line: a hosted, purpose-trained cross-encoder beats a listwise LLM on **quality, latency, AND cost simultaneously** — the only axis where listwise wins is "no extra integration," which OpenRouter erases by exposing a real `/rerank` endpoint under the key we already hold.

The core trade-off: **a few ms + ~$0.001/query of an external dependency, vs. a 500MB+ local model download or a 700ms+/16x-cost listwise LLM call.** We pay the small hosted cost; we keep the Pi extension light and the latency tight; we degrade gracefully to a free model and then to no-rerank when keys are missing.

---

## What is actually reachable with only OpenAI + OpenRouter keys

| Path | Reachable? | Endpoint | Cost | Notes |
|---|---|---|---|---|
| **OpenRouter `/rerank` → Cohere rerank-v3.5** | YES | `POST https://openrouter.ai/api/v1/rerank` | **$0.001 per search** (1 query + up to 100 docs = 1 "search unit") | 4,096 token context. This is the recommended primary. |
| **OpenRouter `/rerank` → Cohere Rerank 4 Fast / 4 Pro** | YES | same | higher | Newer Cohere models also routed; v3.5 is the value pick. |
| **OpenRouter `/rerank` → `nvidia/llama-nemotron-rerank-vl-1b-v2:free`** | YES | same | **$0 in / $0 out** | 1.7B multimodal, **10,240 token context**. Free fallback. |
| **OpenAI native rerank** | NO | — | — | OpenAI has **no `/rerank` endpoint**. Only `/embeddings` and `/chat`. Any "OpenAI rerank" is a third-party drop-in server or a chat-based listwise prompt. |
| **Listwise LLM rerank via OpenRouter/OpenAI chat** | YES (works, but worse) | `/chat/completions` | high (see numbers) | gpt-4.1-mini etc. Slower + pricier + uncalibrated. Use only as a top-5 refinement if ever. |
| **Jina reranker** | NO (no key) | `https://api.jina.ai/v1/rerank` | free tier exists but needs `jina_` key | New users get 10M free tokens; free key = 100 RPM / 100K TPM / 2 concurrent. We do **not** have a Jina key, so this is out unless the user adds one. |
| **Voyage rerank-2.5** | NO (no key) | — | — | No key. Out of scope. |
| **Local cross-encoder (bge-reranker-v2-m3 / jina-reranker-v2) via ONNX/transformers.js** | YES (no key) | in-process | $0 but heavy | bge-reranker-v2-m3 = **567.8M params, 2.27GB fp32**, ~280MB-1.1GB quantized. Too heavy for a light Pi extension as a default. |

Key correction vs. naive assumption: **OpenRouter is NOT just chat.** It exposes a first-class `/rerank` router that proxies Cohere's rerankers (and a free NVIDIA reranker) under the OpenAI-style bearer key. This is the single most important finding — it gives us a SOTA hosted cross-encoder with the key we already have, no Cohere account required.

Citations:
- OpenRouter rerank API ref: https://openrouter.ai/docs/api/api-reference/rerank/create-rerank (.md variant for clean spec)
- OpenRouter rerank models collection: https://openrouter.ai/collections/rerank-models
- Cohere rerank-v3.5 on OpenRouter (4,096 context, $0.001/search): https://openrouter.ai/cohere/rerank-v3.5
- Free NVIDIA reranker (1.7B, 10,240 context, $0): https://openrouter.ai/nvidia/llama-nemotron-rerank-vl-1b-v2:free

---

## SOTA evidence: cross-encoder vs. listwise LLM (vendor-neutral numbers)

Source: ZeroEntropy, "Should You Use LLMs for Reranking?" (Sep 2025), 17-benchmark eval (MTEB/BEIR/MS MARCO + domain sets), listwise context capped at 50k tokens.
URL: https://zeroentropy.dev/articles/should-you-use-llms-for-reranking-a-deep-dive-into-pointwise-listwise-and-cross-encoders/

**Average NDCG@10 across all 17 datasets:**

| Model | Avg NDCG@10 | Type |
|---|---|---|
| OpenAI text-embedding-small (no rerank baseline) | 0.6175 | embedding only |
| gpt-4o-mini (listwise) | 0.6632 | LLM listwise |
| gpt-5-mini (listwise) | 0.6980 | LLM listwise |
| gpt-5-nano (listwise) | 0.7116 | LLM listwise |
| gpt-4.1-mini (listwise) | 0.7131 | LLM listwise |
| **Cohere rerank-3.5 (cross-encoder)** | **0.7194** | **hosted cross-encoder** |
| zerank-1 (cross-encoder) | 0.7767 | cross-encoder (no key for us) |

**Latency (p50, 75kb input) and cost (per 1M input tokens):**

| Model | p50 latency | $/1M input tokens |
|---|---|---|
| **Cohere rerank-3.5** | **198 ms** | **$0.050** (ZeroEntropy's metered figure) |
| gpt-4.1-mini listwise | 740 ms | $0.80 (16x) |
| gpt-4o-mini listwise | 1090 ms | $0.60 (12x) |
| gpt-5-mini listwise | 2180 ms | $0.250 |
| gpt-5-nano listwise | 1520 ms | $0.050 |
| zerank-1 | 130 ms | $0.025 |

Reading: **Cohere rerank-3.5 matches or beats every small listwise LLM on NDCG, at ~3.5-11x lower latency.** The listwise LLMs only "spike on narrow tasks" but lose on average, are uncalibrated, and randomly spike several seconds (third-party API jitter) — fatal for an agent tool in the user's inner loop.

> Quote (ZeroEntropy): "while LLMs occasionally spike on narrow tasks, cross-encoders trained for reranking outperform or match them across the board, with far lower latency and cost." Pointwise LLM = "worst of both worlds: slow inference and unreliable outputs." Listwise = "only viable for very small candidate lists (top 5-10) due to context length and latency."

### Code-specific (CoIR)

CoIR (ACL 2025) — https://archersama.github.io/coir/ , paper https://arxiv.org/abs/2407.02883 — is the canonical **code IR benchmark** (10 datasets, 8 tasks: text→code, code→code, code→text, hybrid). Its public leaderboard ranks **retrievers/embedders**, not rerankers (CodeSage-large-v2 ≈ 50.45 avg; Voyage-Code-002 ≈ 26.52; BGE-M3 ≈ 7.37; GTE-Base ≈ 3.24 on the headline metric). Takeaway for us: CoIR proves code retrieval is hard and **embedding choice dominates first-stage recall** — which is why we use text-embedding-3-large for recall and add a reranker for top-k precision. There is no public CoIR reranker leaderboard that crowns a listwise LLM; the rerank literature consistently favors trained cross-encoders for precision-at-low-latency, and Cohere rerank explicitly supports code/multi-aspect reranking.

Conclusion: **no evidence supports paying the listwise LLM tax for code reranking when a hosted cross-encoder is one key away.** Use the cross-encoder.

---

## Local cross-encoder option — and why it's NOT the default

`bge-reranker-v2-m3` (BAAI, Apache-2.0, XLM-RoBERTa-large base):
- **567,755,777 params (567.8M)**, fp32 on-disk = **2.27 GB** (`safetensors.total = 567755777`, `totalFileSize = 2271071852`). Source: https://huggingface.co/BAAI/bge-reranker-v2-m3 (model metadata).
- ONNX for transformers.js: `onnx-community/bge-reranker-v2-m3-ONNX` and `mogolloni/bge-reranker-v2-m3-onnx`. Quantized int8 ≈ ~280-580MB; fp32 ONNX ≈ ~2.2GB.
- Runs in-process via `@huggingface/transformers` (transformers.js v3) or `onnxruntime-node`. CPU latency for a 512-token cross-encoder pass is ~tens of ms/doc but batches of 50-100 docs on CPU push into hundreds of ms to multiple seconds, plus a multi-hundred-MB cold download and resident memory.

`jina-reranker-v2-base-multilingual` ≈ 278M params (smaller, ~half the footprint), also ONNX-able, but **requires a Jina key for the hosted API**; the open weights are usable locally but still a 150-300MB download.

**Verdict for a Pi extension:** a 280MB-2.2GB model download + persistent RAM + slower CPU inference is a real tax on a coding-agent extension that must install fast and stay light. Skip local-by-default. Keep it as an **opt-in offline mode** (`RERANK_PROVIDER=local`) for air-gapped / no-network users who explicitly accept the download. The 567M bge model is the quality pick if chosen; jina-v2 (278M) if footprint matters more.

Citations:
- bge-reranker-v2-m3 size: https://huggingface.co/BAAI/bge-reranker-v2-m3
- ONNX build: https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX
- transformers.js reranking: cross-encoder via `pipeline`/`AutoModelForSequenceClassification`.

---

## Listwise LLM reranker (RankGPT / RankZephyr / setwise) — how, if we ever want it

Approach (RankGPT-style, the toolkit is castorini/rank_llm, https://github.com/castorini/rank_llm; paper https://arxiv.org/abs/2505.19284):
1. Take top-k candidates from hybrid search (k ≤ 20 for a single window).
2. Build a single listwise prompt: numbered passages `[1] ... [2] ...`, instruction "rank by relevance to the query, output permutation as `[3] > [1] > ...`".
3. Call a fast chat model (`openai/gpt-4.1-mini` or `gpt-5-mini` via OpenRouter `/chat/completions`).
4. Parse the permutation; reorder.
5. **Sliding window for >context:** rank windows of size `w` (e.g. 20) with step `s` (e.g. 10) from the bottom of the list upward, carrying the best items forward (bubble-sort style). This is how RankGPT handles 100+ candidates beyond a single prompt.

Why we do NOT make this the default: 740ms-2180ms p50, 12-16x cost, fragile output (invalid indices, extra text, format failures counted against it), and uncalibrated scores that don't blend cleanly with BM25/vector scores. For an agent tool that fires on most searches, that's a bad latency and reliability profile.

When it could earn its place: an **optional ultra-precision pass on the top 5-8 already-cross-encoder-reranked results**, only when the user opts in (`RERANK_REFINE=llm`). "Expensive last, cheap first" — vector/BM25 recall → cross-encoder rerank top-50 → (optional) listwise LLM on top-5.

---

## Recommended request shape (exact, grounded)

### OpenRouter `/rerank` contract (from the OpenAPI spec)

```
POST https://openrouter.ai/api/v1/rerank
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json
```

Request body (required: `documents`, `model`, `query`):
```json
{
  "model": "cohere/rerank-v3.5",
  "query": "where do we validate the turbopuffer api key",
  "documents": [
    "export const validateKey = (k: string) => ...",
    "function loadConfig() { ... }"
  ],
  "top_n": 10
}
```
- `documents`: array of plain strings OR `{ "text": "...", "image": "..." }` objects (multimodal models only).
- `top_n`: integer, number of top results to return.
- Optional `provider` object: routing controls (`order`, `only`, `ignore`, `sort: "latency"|"price"|"throughput"`, `max_price`, `allow_fallbacks`, `data_collection: "deny"`). Set `provider.data_collection = "deny"` for privacy; set `provider.sort = "latency"` to bias toward the fastest endpoint.

Response (200):
```json
{
  "id": "orid_...",
  "model": "cohere/rerank-v3.5",
  "provider": "Cohere",
  "results": [
    { "index": 0, "relevance_score": 0.93, "document": { "text": "..." } },
    { "index": 1, "relevance_score": 0.41, "document": { "text": "..." } }
  ],
  "usage": { "total_tokens": 812, "search_units": 1, "cost": 0.001 }
}
```
- `results` is sorted by relevance descending; each item has `index` (into the original input), `relevance_score` (double), `document` (echo of input).
- `usage.search_units` = Cohere billing unit; `usage.cost` = credits charged.

Errors (typed): 400 BadRequest, 401 Unauthorized, 402 PaymentRequired (out of credits), 404 NotFound, 429 TooManyRequests, 500/502/503/524/529 upstream/overload. The 402/429/5xx set is what your fallback/retry policy must handle.

### Effect v4 (smol) implementation — verified against vendored source

Effect v4 HTTP client lives at `effect/unstable/http`. Verified signatures (paths under `repos/effect-smol/packages/effect/src/unstable/http/`):
- `HttpClient.post(url, options?) : Effect<HttpClientResponse, HttpClientError, HttpClient>` — `HttpClient.ts:158`
- `HttpClientRequest.Options` accepts `{ headers?, body?, acceptJson? }` — `HttpClientRequest.ts:51-59`
- `HttpBody.json(body): Effect<Uint8Array, HttpBodyError>` and `HttpBody.jsonUnsafe(body): Uint8Array` — `HttpBody.ts:217,224`
- `HttpClientResponse.schemaJson(schema)(response): Effect<A, SchemaError | HttpClientError, RD>` — `HttpClientResponse.ts:67`
- `FetchHttpClient.layer` provides the default client — `FetchHttpClient.ts`
- Schema errors are typed; define errors with `Schema.TaggedErrorClass` per LLMS.md.

Compile-minded snippet (uses real v4 API surface):

```ts
import {
  Effect,
  Schema,
  Redacted,
} from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpBody,
  HttpClientResponse,
} from "effect/unstable/http"

// --- Response schema (decode only the fields we use) ---
const RerankResult = Schema.Struct({
  index: Schema.Number,
  relevance_score: Schema.Number,
})
const RerankResponse = Schema.Struct({
  model: Schema.String,
  results: Schema.Array(RerankResult),
})

export class RerankError extends Schema.TaggedErrorClass<RerankError>()(
  "RerankError",
  { message: Schema.String },
) {}

export interface Reranked {
  readonly index: number
  readonly score: number
}

// --- Primary call: OpenRouter /rerank with Cohere rerank-v3.5 ---
export const rerank = Effect.fn("rerank")(function* (
  apiKey: Redacted.Redacted<string>,
  query: string,
  documents: ReadonlyArray<string>,
  topN: number,
) {
  const client = yield* HttpClient.HttpClient
  const body = yield* HttpBody.json({
    model: "cohere/rerank-v3.5",
    query,
    documents,
    top_n: topN,
    provider: { sort: "latency", data_collection: "deny" },
  })

  const response = yield* client.pipe(
    HttpClient.post("https://openrouter.ai/api/v1/rerank", {
      headers: {
        Authorization: `Bearer ${Redacted.value(apiKey)}`,
        "Content-Type": "application/json",
      },
      body,
      acceptJson: true,
    }),
  )

  const decoded = yield* HttpClientResponse.schemaJson(RerankResponse)(response)
  return decoded.results.map(
    (r): Reranked => ({ index: r.index, score: r.relevance_score }),
  )
}, Effect.timeout("4 seconds"),
   Effect.catch((cause) =>
     new RerankError({ message: `rerank failed: ${String(cause)}` })),
)
```

Notes:
- `HttpClient.post` is dual/pipeable; you can also write `client.post(url, options)`. Both shapes exist in v4.
- Prefer `Effect.fn("rerank")` over a function returning `Effect.gen` (LLMS.md rule).
- Wrap the API key in `Redacted` so it never leaks into logs/spans.
- Apply `Effect.timeout` + `Effect.retry` (on 429/5xx) at the client layer; OpenRouter errors map cleanly to those status codes.

---

## Graceful degradation / zero-cost-when-keys-missing

Model the reranker as a **port with three adapters**, selected by available credentials + config:

```
RERANK_PROVIDER (or auto-detect):
  1. "openrouter-cohere"  -> OpenRouter /rerank, model cohere/rerank-v3.5   (needs OPENROUTER_API_KEY)  [PRIMARY]
  2. "openrouter-free"    -> OpenRouter /rerank, model nvidia/...rerank...:free (needs OPENROUTER_API_KEY) [FREE FALLBACK]
  3. "local"             -> bge-reranker-v2-m3 ONNX via transformers.js     (no key, opt-in, heavy)
  4. "none"              -> identity: return hybrid-fusion order unchanged  (always works, $0)
```

Selection rule (keep it boring and explicit):
- If `OPENROUTER_API_KEY` present and `RERANK_PROVIDER` unset → `openrouter-cohere`.
- On 402 (out of credits) or sustained 429 → auto-degrade to `openrouter-free`, then to `none`, logging a warning span each step.
- If `OPENROUTER_API_KEY` absent and `RERANK_PROVIDER` unset → `none` (search still works on hybrid fusion; rerank is a precision boost, not a correctness requirement).
- `local` is never auto-selected (it triggers a large download); only when the user explicitly sets it.

This makes rerank **optional and zero-cost by default when keys are missing** while giving the best result when the OpenRouter key is present. It also keeps the Pi extension light: no model ships in the package; the network adapter is the default.

---

## Latency budget

- Hybrid recall (TurboPuffer vector + BM25): tens of ms.
- Rerank top-50 via OpenRouter Cohere rerank-v3.5: **~200ms p50** (ZeroEntropy metered 198ms; add network RTT to OpenRouter, budget ~250-400ms wall). Set client timeout to ~4s, retry once on 429/5xx, then degrade.
- Free Nemotron fallback: similar order, possibly higher jitter (free tier).
- No-rerank: 0ms.
- (Optional) listwise LLM refinement on top-5: +700-2000ms — opt-in only.

Total agent-tool budget target: keep the default path under ~500ms wall. The cross-encoder fits; listwise as default does not.

---

## Open / blocking unknowns

1. **Exact OpenRouter rerank wall-latency from our region** — ZeroEntropy's 198ms is Cohere-direct metered; OpenRouter adds a proxy hop. Verify empirically with one live call before locking the 500ms budget. (Needs OPENROUTER_API_KEY at build time.)
2. **OpenRouter rerank per-request doc cap** — Cohere semantics = up to 100 docs/search unit; confirm OpenRouter doesn't impose a smaller cap. If reranking >100 candidates, chunk into batches and merge by score.
3. **`cohere/rerank-v3.5` availability/pricing stability on OpenRouter** — model catalog and the free Nemotron model can change; pin model IDs in config and treat 404 as a degrade trigger.
4. **Does the user want to add a Jina key?** If yes, Jina free tier (10M tokens, 100 RPM) + `jina-reranker-v2` is a viable additional adapter — but not assumed here.

---

## Sources

- OpenRouter rerank API (OpenAPI spec, request/response/error schemas): https://openrouter.ai/docs/api/api-reference/rerank/create-rerank
- OpenRouter rerank TS SDK example: https://openrouter.ai/docs/client-sdks/typescript/api-reference/rerank
- OpenRouter rerank models collection: https://openrouter.ai/collections/rerank-models
- Cohere rerank-v3.5 on OpenRouter (4,096 ctx, $0.001/search): https://openrouter.ai/cohere/rerank-v3.5
- Free NVIDIA Nemotron rerank (1.7B, 10,240 ctx, $0): https://openrouter.ai/nvidia/llama-nemotron-rerank-vl-1b-v2:free
- ZeroEntropy reranking deep-dive (NDCG/latency/cost across 17 benchmarks): https://zeroentropy.dev/articles/should-you-use-llms-for-reranking-a-deep-dive-into-pointwise-listwise-and-cross-encoders/
- CoIR benchmark + leaderboard: https://archersama.github.io/coir/ , https://arxiv.org/abs/2407.02883
- RankLLM (listwise toolkit + sliding window): https://github.com/castorini/rank_llm , https://arxiv.org/abs/2505.19284
- bge-reranker-v2-m3 (567.8M params, 2.27GB): https://huggingface.co/BAAI/bge-reranker-v2-m3
- bge-reranker-v2-m3 ONNX for transformers.js: https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX
- Jina reranker API + free tier rate limits (100 RPM / 100K TPM / 2 concurrent; 10M free tokens): https://jina.ai/reranker/ , https://api.jina.ai/redoc
- Effect v4 HTTP client (verified source): `repos/effect-smol/packages/effect/src/unstable/http/{HttpClient,HttpClientRequest,HttpClientResponse,HttpBody,FetchHttpClient}.ts`

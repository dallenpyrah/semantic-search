# Effect v4 embeddings via the `@effect/ai-openai` provider

Grounding brief for the semantic-search CLI / Pi extension. All claims are sourced from the vendored
`effect-smol` (beta.85) tree. v4 ("smol") differs from v3 — everything below is read from real source, not v3 memory.

## TL;DR decisions

1. Use `OpenAiEmbeddingModel.model("text-embedding-3-large", { dimensions: 3072 })` — it returns an
   `AiModel.Model` (a `Layer`) that provides both `EmbeddingModel.EmbeddingModel` and
   `EmbeddingModel.Dimensions`. Pass `dimensions` here to set output size; it is forwarded to the OpenAI
   `dimensions` request param.
2. The generic service `EmbeddingModel.EmbeddingModel` (in `effect/unstable/ai`) is the provider-agnostic
   capability. It exposes `embed(input: string)`, `embedMany(inputs: ReadonlyArray<string>)`, and a
   `RequestResolver` for batching. Your `embed(texts: string[]) => Effect<number[][]>` wraps `embedMany`.
3. There is **NO** built-in `maxBatchSize` / `cache` option on `EmbeddingModel.make` in v4 (unlike v3's
   `@effect/ai`). Batching of individual `embed` calls is done by Effect's request system
   (`Effect.request` + the resolver), and you cap batch size with `RequestResolver.batchN(resolver, n)`.
   Caching is **not** built in — wrap it yourself (see §6).
4. The OpenAI client (`OpenAiClient.layer` / `layerConfig`) needs a `HttpClient.HttpClient` and an API key.
   Point at OpenRouter (or any compat endpoint) via the `apiUrl` option.
5. Retry: `AiError` exposes `isRetryable` and `retryAfter`. HTTP 429 → `RateLimitError` (retryable).
   Use `Effect.retry` + `Schedule.exponential(...).pipe(Schedule.jittered)` filtered on `isRetryable`.
6. For OpenRouter the cleanest path is the **`@effect/ai-openai-compat`** package
   (`OpenAiEmbeddingModel` there) — same API, `model: string` (no literal union), built for compat endpoints.

---

## 1. The generic `EmbeddingModel` service (`effect/unstable/ai/EmbeddingModel`)

File: `packages/effect/src/unstable/ai/EmbeddingModel.ts`.

Service tags:

```ts
// effect/unstable/ai/EmbeddingModel.ts:31-43
export class EmbeddingModel extends Context.Service<EmbeddingModel, Service>()(
  "effect/unstable/ai/EmbeddingModel"
) {}

export class Dimensions extends Context.Service<Dimensions, number>()(
  "effect/unstable/ai/EmbeddingModel/Dimensions"
) {}
```

Service interface (the capability you consume):

```ts
// EmbeddingModel.ts:123-127
export interface Service {
  readonly resolver: RequestResolver.RequestResolver<EmbeddingRequest>
  readonly embed: (input: string) => Effect.Effect<EmbedResponse, AiError.AiError>
  readonly embedMany: (input: ReadonlyArray<string>) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}
```

Return shapes (schema classes):

```ts
// EmbeddingModel.ts:51-80
class EmbeddingUsage { readonly inputTokens: number | undefined }
class EmbedResponse  { readonly vector: ReadonlyArray<number> }              // single
class EmbedManyResponse {
  readonly embeddings: ReadonlyArray<EmbedResponse>                          // index-aligned to inputs
  readonly usage: EmbeddingUsage
}
```

Constructor — the provider plugs in **one** function, `embedMany`:

```ts
// EmbeddingModel.ts:142-190 (signature)
export const make: (params: {
  readonly embedMany: (options: ProviderOptions) => Effect.Effect<ProviderResponse, AiError.AiError>
}) => Effect.Effect<Service>

// ProviderOptions / ProviderResponse (EmbeddingModel.ts:88-103)
interface ProviderOptions  { readonly inputs: ReadonlyArray<string> }
interface ProviderResponse {
  readonly results: Array<Array<number>>
  readonly usage: { readonly inputTokens: number | undefined }
}
```

Behavior worth knowing:
- `make` builds a `RequestResolver<EmbeddingRequest>` so single `embed(x)` calls made concurrently are
  **batched into one provider `embedMany`** by Effect's request scheduler. Results are completed by index.
- `embedMany([])` short-circuits to an empty response (no provider call).
- `embed(input)` = `Effect.request(new EmbeddingRequest({ input }), resolver)` — so it participates in batching.
- `mapProviderResults` validates `results.length === inputs.length` and fails `InvalidOutputError` otherwise.

---

## 2. OpenAI provider model (`@effect/ai-openai/OpenAiEmbeddingModel`)

File: `packages/ai/openai/src/OpenAiEmbeddingModel.ts`.

Model literal type:

```ts
// :23
export type Model = "text-embedding-ada-002" | "text-embedding-3-small" | "text-embedding-3-large"
```

**Primary constructor** — `model(...)`. Returns an `AiModel.Model` (usable as a `Layer`) that provides
`EmbeddingModel | Dimensions` and requires `OpenAiClient`:

```ts
// :50-70
export const model = (
  model: (string & {}) | Model,
  options: {
    readonly dimensions: number
    readonly config?: Omit<typeof Config.Service, "model" | "dimensions">
  }
): AiModel.Model<"openai", EmbeddingModel.EmbeddingModel | EmbeddingModel.Dimensions, OpenAiClient> =>
  AiModel.make(
    "openai",
    model,
    Layer.merge(
      layer({ model, config: { ...options.config, dimensions: options.dimensions } }),
      Layer.succeed(EmbeddingModel.Dimensions, options.dimensions)   // <- dims surfaced as a service
    )
  )
```

So `dimensions` is (a) forwarded into the request config and (b) published as the `Dimensions` service.
The test confirms `model("text-embedding-3-small", { dimensions: 1536 })` makes `yield* EmbeddingModel.Dimensions === 1536`.

**Lower-level `layer(...)`** — provides only `EmbeddingModel.EmbeddingModel` (no `Dimensions`), requires `OpenAiClient`:

```ts
// :104-108
export const layer = (options: {
  readonly model: (string & {}) | Model
  readonly config?: Omit<typeof Config.Service, "model"> | undefined
}): Layer.Layer<EmbeddingModel.EmbeddingModel, never, OpenAiClient>
```

**Config service** (`@effect/ai-openai/OpenAiEmbeddingModel/Config`) is a partial of the encoded
`CreateEmbeddingRequest` minus `input` (so: `model?`, `dimensions?`, `encoding_format?`, `user?`, plus
arbitrary `[x: string]: unknown`). Two ways to set config:
- Static, at layer build: `layer({ model, config: { dimensions, user } })`.
- Per-effect override: `OpenAiEmbeddingModel.withConfigOverride({ model, dimensions, user })(effect)`.
  Precedence (from `make`): `{ model, ...providerConfig, ...Config service from context }` — i.e. the
  context `Config` (set by `withConfigOverride`) wins over the layer's `providerConfig`. Test
  "merges config and applies withConfigOverride precedence" proves request-level override beats provider config.

How the provider calls OpenAI (`make`, :78-96):

```ts
return yield* EmbeddingModel.make({
  embedMany: Effect.fnUntraced(function*({ inputs }) {
    const config = yield* makeConfig                                  // { model, dimensions, ... }
    const response = yield* client.createEmbedding({ ...config, input: inputs })
    return yield* mapProviderResponse(inputs.length, response)
  })
})
```

Provider response validation (`mapProviderResponse`, :134-174) rejects: wrong count, out-of-range index,
duplicate index, and **non-array (base64) embeddings** → all become `AiError` with reason `InvalidOutputError`.
**Gotcha:** the model never requests `encoding_format: "base64"`; if you set it via Config you'll get
`InvalidOutputError` because the validator requires `Array.isArray(entry.embedding)`. Leave it as float (default).

---

## 3. The OpenAI request/response wire schema

File: `packages/ai/openai/src/OpenAiSchema.ts:839-875`.

```ts
export const CreateEmbeddingRequest = Schema.Struct({
  input: Schema.Union([Schema.String, Schema.Array(Schema.String),
                       Schema.Array(Schema.Number), Schema.Array(Schema.Array(Schema.Number))]),
  model: Schema.String,
  encoding_format: Schema.optionalKey(Schema.Literals(["float", "base64"])),
  dimensions: Schema.optionalKey(Schema.Number),     // <- text-embedding-3-* dimension control
  user: Schema.optionalKey(Schema.String)
})

export const CreateEmbeddingResponse = Schema.Struct({
  data: Schema.Array(Embedding),                      // Embedding = { index, embedding, object }
  model: Schema.String,
  object: Schema.optionalKey(Schema.Literal("list")),
  usage: Schema.optionalKey(Schema.Struct({ prompt_tokens: Schema.Number, total_tokens: Schema.Number }))
})
```

`OpenAiClient.createEmbedding` POSTs to `/embeddings` (relative to `apiUrl`) with `HttpBody.jsonUnsafe(payload)`
and decodes via `HttpClientResponse.schemaBodyJson(CreateEmbeddingResponse)`
(`OpenAiClient.ts:263-279`).

text-embedding-3-large native dim is 3072; valid `dimensions` is any value ≤ 3072 (e.g. 256, 1024, 3072).
For TurboPuffer at full fidelity use **3072**.

---

## 4. The OpenAI client + custom baseURL (OpenRouter)

File: `packages/ai/openai/src/OpenAiClient.ts`.

Options (`:108-135`):

```ts
export type Options = {
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly apiUrl?: string | undefined            // default "https://api.openai.com/v1"
  readonly organizationId?: Redacted.Redacted<string> | undefined
  readonly projectId?: Redacted.Redacted<string> | undefined
  readonly transformClient?: ((client: HttpClient.HttpClient) => HttpClient.HttpClient) | undefined
}
```

`apiUrl` is prepended to every request path (`HttpClientRequest.prependUrl(apiUrl)`), and `apiKey` becomes a
bearer token (`OpenAiClient.ts:157-178`). **To target OpenRouter set
`apiUrl: "https://openrouter.ai/api/v1"`.** OpenRouter exposes an OpenAI-compatible `/embeddings`. The
`dimensions` param is sent in the JSON body unchanged, so it passes through to whatever upstream model.

Layers:

```ts
// :304-305  static options
export const layer = (options: Options): Layer.Layer<OpenAiClient, never, HttpClient.HttpClient>

// :314-363  load from Effect Config (recommended for the API key as a redacted secret)
export const layerConfig = (options?: {
  readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined>
  readonly apiUrl?: Config.Config<string>
  readonly organizationId?: Config.Config<Redacted.Redacted<string> | undefined>
  readonly projectId?: Config.Config<Redacted.Redacted<string> | undefined>
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient
}) => Layer.Layer<OpenAiClient, Config.ConfigError, HttpClient.HttpClient>
```

`HttpClient.HttpClient` must be provided by a platform layer, e.g. `FetchHttpClient.layer`
(`effect/unstable/http`) or `@effect/platform-node`'s NodeHttpClient. The client also applies
`HttpClient.filterStatusOk`, so non-2xx becomes an `HttpClientError` which the embedding path maps to `AiError`.

> Note on OpenRouter + embeddings: OpenRouter's embeddings coverage is narrower than chat. If OpenRouter does
> not proxy `text-embedding-3-large`, call OpenAI directly (`apiUrl` default) for embeddings and use OpenRouter
> only for chat/rerank. This is a product limit, not an Effect limit. Verify the model is listed on OpenRouter
> before wiring. The compat package (`@effect/ai-openai-compat`) exists precisely for non-OpenAI compat endpoints
> and takes `model: string`.

---

## 5. Concrete Layer wiring — `embed(texts) => Effect<number[][]>` at 3072 dims

Compile-minded, grounded in the signatures above. Two services: a thin domain service `Embedder` that
yields `embed`, layered over `OpenAiEmbeddingModel.model(...)` + `OpenAiClient.layerConfig(...)` + an HTTP client.

```ts
import { Config, Effect, Layer, Schedule } from "effect"
import { EmbeddingModel } from "effect/unstable/ai"
import type { AiError } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenAiClient, OpenAiEmbeddingModel } from "@effect/ai-openai"

// 1. HTTP client (platform layer).
const HttpLayer = FetchHttpClient.layer

// 2. OpenAI client from Effect Config. For OpenAI proper, omit apiUrl (defaults to api.openai.com/v1).
//    For OpenRouter: apiUrl: Config.succeed("https://openrouter.ai/api/v1").
const ClientLayer = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY")
  // apiUrl: Config.succeed("https://openrouter.ai/api/v1"),
}).pipe(Layer.provide(HttpLayer))

// 3. Embedding model: text-embedding-3-large @ 3072 dims.
//    `model(...)` is an AiModel.Model == a Layer providing EmbeddingModel + Dimensions.
const EmbeddingLayer = OpenAiEmbeddingModel
  .model("text-embedding-3-large", { dimensions: 3072 })
  .pipe(Layer.provide(ClientLayer))

// 4. Domain capability: embed(texts) => number[][]. Retry on retryable AiError (429 etc).
export class Embedder extends Effect.Service<Embedder>()("app/Embedder", {
  effect: Effect.gen(function*() {
    const model = yield* EmbeddingModel.EmbeddingModel
    const dimensions = yield* EmbeddingModel.Dimensions   // 3072

    const retryPolicy = Schedule.exponential("200 millis", 2).pipe(
      Schedule.jittered,
      Schedule.intersect(Schedule.recurs(5))              // cap at 5 retries
    )

    const embed = (texts: ReadonlyArray<string>): Effect.Effect<Array<Array<number>>, AiError.AiError> =>
      model.embedMany(texts).pipe(
        Effect.map((r) => r.embeddings.map((e) => Array.from(e.vector))),
        // only retry transient errors; AiError exposes isRetryable (429 -> RateLimitError -> true)
        Effect.retry({ schedule: retryPolicy, while: (e) => e.isRetryable })
      )

    return { embed, dimensions } as const
  }),
  dependencies: [EmbeddingLayer]
}) {}
```

Usage:

```ts
const program = Effect.gen(function*() {
  const embedder = yield* Embedder
  const vectors = yield* embedder.embed(["chunk a", "chunk b"])   // number[][], length 2, each len 3072
  return vectors
}).pipe(Effect.provide(Embedder.Default))
```

Notes on the snippet:
- `Effect.retry({ schedule, while })` — `while` re-tries only while the predicate holds; `e.isRetryable`
  delegates to the reason (`AiError.ts:1408-1410`). For 429s you can additionally honor `e.retryAfter`
  (a `Duration | undefined`, `AiError.ts:1417-1419`).
- `EmbeddingModel.Dimensions` is available because `model(...)` published it; if you used the lower-level
  `OpenAiEmbeddingModel.layer(...)` you must add `Layer.succeed(EmbeddingModel.Dimensions, 3072)` yourself.
- `Effect.Service` `dependencies` resolves the layer graph so `Embedder.Default` is fully wired except for
  `Config` providers (env), which Effect reads from the default ConfigProvider (process env).

---

## 6. Batching & caching (what's built in vs. what you build)

**Built-in batching:** Single `embed(x)` calls participate in Effect's request batching through the resolver
inside `EmbeddingModel.make`. Concurrent `embed` calls collapse into one `/embeddings` HTTP request. If you
already have a list, call `embedMany(list)` directly — it's a single call with no per-item batching cap.

**Cap batch size:** v4 has no `maxBatchSize` option. To bound how many inputs go in one HTTP call (OpenAI
caps ~2048 inputs / ~8191 tokens per input; large batches risk 400s), use `RequestResolver.batchN`:

```ts
// RequestResolver.ts:678-685
export const batchN: <A extends Request.Any>(self: RequestResolver<A>, n: number) => RequestResolver<A>
```

You can rebuild a capped resolver from the service's `resolver` and drive `embed` calls through it, **or**
simpler: chunk your own array and map `embedMany` over chunks with bounded concurrency:

```ts
import { Array as Arr } from "effect"
const embedChunked = (texts: ReadonlyArray<string>, batch = 256) =>
  Effect.forEach(Arr.chunksOf(texts, batch), (chunk) => embedder.embed(chunk), { concurrency: 4 })
    .pipe(Effect.map(Arr.flatten))
```

**Caching:** Not built in for embeddings in v4. Options:
- Cheap correctness: hash each chunk's content (e.g. sha256 of normalized text + model + dims) and key a
  persistent store (your TurboPuffer index already is the cache — skip re-embedding unchanged chunks).
- In-process memo: wrap `embed` with `Effect.cachedFunction` or a `Cache` keyed on content hash for a single
  run. (Effect v4 `Cache` lives in core; verify the exact module before use.)
- For request-level dedup within a fiber graph, Effect request caching applies only to `Effect.request`
  (the `embed` single path), not to your own `embedMany` chunking.

---

## 7. Rate-limit / retry patterns available

- **Error model:** every failure from the embedding path is a single `AiError`
  (`effect/unstable/ai/AiError.ts:1392`). It carries `module`, `method`, and a `reason` union member.
  `AiError.isRetryable` and `AiError.retryAfter` delegate to the reason.
- **HTTP→reason mapping** (`reasonFromHttpStatus`, `AiError.ts:1531-1559`):
  `400 → InvalidRequestError` (not retryable), `401 → AuthenticationError(InvalidKey)`,
  `403 → AuthenticationError(InsufficientPermissions)`, **`429 → RateLimitError` (always retryable)**,
  `>=500 → InternalProviderError` (retryable), else `UnknownError`.
  `RateLimitError` may carry `retryAfter: Duration` (`AiError.ts:395-420`).
- **Retry:** `Effect.retry(effect, { schedule, while })` (`Effect.ts:3916`). Compose schedules:
  `Schedule.exponential(base, factor)` (`Schedule.ts:1962`), `Schedule.jittered` (`:2301`),
  `Schedule.recurs(n)` (`:2404`), `Schedule.spaced(d)` (`:2607`). Filter on `e.isRetryable` to avoid
  retrying auth/quota/invalid-request failures.
- **Distributed/throughput rate limiting** (proactive, not reactive): `effect/unstable/persistence/RateLimiter`
  provides `RateLimiter` service with `makeWithRateLimiter` → `withLimiter({ key, cost? })(effect)` and
  `makeSleep`. Backed by a `RateLimiterStore`. Use this to stay under OpenAI RPM/TPM rather than only
  reacting to 429s.
- **Honor `retryAfter`:** for a 429 you can branch — `Effect.catchTag` is not applicable (single tag), use
  `Effect.catchIf((e) => e.isRetryable, (e) => e.retryAfter ? Effect.sleep(e.retryAfter).pipe(Effect.andThen(retry)) : ...)`,
  or feed a `Schedule` that reads the duration. Simplest robust default: exponential + jitter + cap, filtered
  by `isRetryable`, as in §5.

---

## 8. OpenRouter-specific path (compat package)

`@effect/ai-openai-compat/OpenAiEmbeddingModel` mirrors the OpenAI one exactly but `Model = string`
(no literal union) and `Config` keys off the compat client's `CreateEmbeddingRequestJson`. Same
`model(modelId, { dimensions })`, same `layer`, same `withConfigOverride`, same `InvalidOutputError`
validation (rejects base64). Use the compat `OpenAiClient` from that package with `apiUrl` pointed at the
compat endpoint. Choose compat when the endpoint isn't literally OpenAI.

---

## 9. Citations (file paths in vendored effect-smol, beta.85)

- `packages/effect/src/unstable/ai/EmbeddingModel.ts` — generic service, `make`, `embed`/`embedMany`, response shapes.
- `packages/effect/src/unstable/ai/Model.ts` — `AiModel.make`, `Model` = Layer + provider/model name tags.
- `packages/effect/src/unstable/ai/AiError.ts` — `AiError` (1392), `RateLimitError` (395), `reasonFromHttpStatus` (1531), `isRetryable`/`retryAfter`.
- `packages/ai/openai/src/OpenAiEmbeddingModel.ts` — `model`, `layer`, `Config`, `withConfigOverride`, `make`, base64 rejection.
- `packages/ai/openai/src/OpenAiClient.ts` — `Options` (apiKey/apiUrl/org/project/transformClient), `layer`, `layerConfig`, `createEmbedding` → POST `/embeddings`.
- `packages/ai/openai/src/OpenAiConfig.ts` — `withClientTransform` for HttpClient transforms.
- `packages/ai/openai/src/OpenAiSchema.ts:839-875` — `CreateEmbeddingRequest` (input/model/encoding_format/dimensions/user), `CreateEmbeddingResponse`.
- `packages/ai/openai/test/OpenAiEmbeddingModel.test.ts` — dims service, index reordering, config precedence, error cases.
- `packages/ai/openai-compat/src/OpenAiEmbeddingModel.ts` — compat variant (`Model = string`).
- `packages/effect/src/RequestResolver.ts:678-685` — `batchN` to cap batch size.
- `packages/effect/src/Effect.ts:3916` (`retry`), `:7952` (`request`); `packages/effect/src/Schedule.ts` (exponential/jittered/recurs/spaced).
- `packages/effect/src/unstable/persistence/RateLimiter.ts` — proactive rate limiting.

## 10. Blocking unknowns to verify before build

- Whether OpenRouter actually proxies `text-embedding-3-large` (product coverage). If not, embeddings go
  straight to OpenAI; OpenRouter only for chat/rerank.
- Exact v4 `Cache` / `cachedFunction` module path/signature if you want in-process embedding memoization
  (not strictly needed — TurboPuffer + content hash is the real cache).
- The HTTP client platform layer you'll standardize on (`FetchHttpClient.layer` vs NodeHttpClient) — both
  satisfy `HttpClient.HttpClient`; pick per runtime.

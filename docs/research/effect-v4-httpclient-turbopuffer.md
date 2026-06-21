# Effect v4 (`effect-smol`) HttpClient → TurboPuffer REST API

Grounding brief for the TurbopufferClient service. All Effect APIs verified against vendored
source at `<effect-source>`. TurboPuffer
facts verified against official docs (turbopuffer.com) and the official TS/Ruby clients.

---

## TL;DR decisions

1. **Layer:** provide `NodeHttpClient.layerUndici` (undici + pooled `Agent`, keep-alive by default). Use `FetchHttpClient.layer` only for non-Node/edge.
2. **Build the client once** in the service layer: take `HttpClient.HttpClient`, then `HttpClient.mapRequest(flow(prependUrl(baseUrl), bearerToken(apiKey), acceptJson))` + `filterStatusOk` + `retryTransient`.
3. **Body:** `HttpClientRequest.bodyJsonUnsafe(payload)` (sync; sets `content-type: application/json` + `content-length`). Use `bodyJson` only if you want JSON-stringify errors in the error channel.
4. **Decode:** `HttpClientResponse.schemaBodyJson(QueryResponse)` after `Effect.flatMap`. Fails with `SchemaError | HttpClientError`.
5. **Retry:** `HttpClient.retryTransient({ schedule: Schedule.exponential("250 millis").pipe(Schedule.either(Schedule.spaced("10 seconds")), Schedule.jittered), times: 4 })`. It already treats `TransportError`, timeouts, and 408/429/500/502/503/504 as transient.
6. **Timeout:** per-request `Effect.timeout("30 seconds")` on the decoded effect → adds `Cause.TimeoutError`, which `retryTransient` recognizes as transient.
7. **Abort/interruption:** automatic. The client wires an `AbortController` to the fetch/undici signal and aborts on Effect interruption — you do nothing.
8. **Keep-alive:** undici `Agent` is created as a scoped resource and pooled; `layerUndici` owns its lifecycle. node:http path (`layerNodeHttp`) uses a pooled `http.Agent`/`https.Agent`.
9. **Streaming large bodies:** `HttpClientRequest.bodyStream(stream, { contentType, contentLength })`. For responses, `response.stream` (Stream of `Uint8Array`) or `HttpClientResponse.stream(effect)`.

---

## 1. Module map (vendored paths)

| Concern | Module | Path |
|---|---|---|
| Client service + combinators | `HttpClient` | `packages/effect/src/unstable/http/HttpClient.ts` |
| Build/modify requests | `HttpClientRequest` | `.../HttpClientRequest.ts` |
| Read/decode responses | `HttpClientResponse` | `.../HttpClientResponse.ts` |
| Typed errors | `HttpClientError` | `.../HttpClientError.ts` |
| JSON/stream bodies | `HttpBody` | `.../HttpBody.ts` |
| Fetch layer | `FetchHttpClient` | `.../FetchHttpClient.ts` |
| Node layers (undici / node:http) | `NodeHttpClient` | `packages/platform-node/src/NodeHttpClient.ts` |
| Canonical worked example | ai-docs | `ai-docs/src/50_http-client/10_basics.ts` |
| Schedule (retry policy) | `Schedule` | `packages/effect/src/Schedule.ts` |

Import root: `effect/unstable/http` re-exports `HttpClient`, `HttpClientRequest`, `HttpClientResponse`,
`FetchHttpClient`, etc. Node layers come from `@effect/platform-node` (`NodeHttpClient`).

```ts
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { NodeHttpClient } from "@effect/platform-node"
```

---

## 2. Exact API signatures (from source)

### Building a request

```ts
// HttpClientRequest.ts
export const post: (url: string | URL, options?: Options.NoUrl) => HttpClientRequest   // make("POST")
export const bearerToken: {
  (token: string | Redacted.Redacted): (self: HttpClientRequest) => HttpClientRequest
  (self: HttpClientRequest, token: string | Redacted.Redacted): HttpClientRequest
}   // sets header `Authorization: Bearer ${token}`  (Redacted-safe)
export const acceptJson: (self: HttpClientRequest) => HttpClientRequest   // Accept: application/json
export const prependUrl: { (path: string): (self) => HttpClientRequest; (self, path: string) }
export const bodyJsonUnsafe: { (body: unknown): (self) => HttpClientRequest; (self, body) }  // sync
export const bodyJson: {                                                                     // effectful
  (body: unknown): (self) => Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError>
  (self, body): Effect.Effect<HttpClientRequest, HttpBody.HttpBodyError>
}
export const setHeader: { (key, value): (self) => HttpClientRequest; (self, key, value) }
export const bodyStream: {
  (body: Stream.Stream<Uint8Array, unknown>,
   options?: { contentType?: string; contentLength?: number }): (self) => HttpClientRequest
  (self, body, options?): HttpClientRequest
}
```

`bodyJsonUnsafe` → `HttpBody.jsonUnsafe(body)` → `text(JSON.stringify(body), "application/json")`, and
`setBody` then sets `content-type` + `content-length` headers automatically (`HttpClientRequest.ts:539`).

> Gotcha: `Authorization`, when built via `bearerToken`, is redacted in span attributes/`toJSON`
> only if the header name is in `Headers.CurrentRedactedNames`. The token string itself is sent
> as-is. Pass a `Redacted.Redacted` to keep it out of logs.

### Sending + the client surface

`HttpClient.HttpClient` is a `Context.Service`. Its instance interface (`HttpClient.With<E,R>`):

```ts
readonly execute: (request: HttpClientRequest) => Effect.Effect<HttpClientResponse, E, R>
readonly get/post/put/patch/del/head/options:
  (url: string | URL, options?: HttpClientRequest.Options.NoUrl) => Effect.Effect<HttpClientResponse, E, R>
```

For a prebuilt request use `client.execute(request)`. For a one-liner use `client.post(url, { ... })`.

### Combinators used to configure the client (all `dual`, pipe-friendly)

```ts
// HttpClient.ts
export const mapRequest: (f: (a: HttpClientRequest) => HttpClientRequest) => (self) => HttpClient.With<E,R>
export const filterStatusOk: <E,R>(self: HttpClient.With<E,R>) => HttpClient.With<E | HttpClientError, R>
export const filterStatus: (f: (status: number) => boolean) => (self) => HttpClient.With<E | HttpClientError, R>
export const retry:  // Schedule OR Effect.Retry.Options
  <E, O extends Effect.Retry.Options<E>>(options: O) => (self) => Retry.Return<R,E,O>
  | <B,E,ES,R1>(policy: Schedule.Schedule<B, E, ES, R1>) => (self) => HttpClient.With<E | ES, R1 | R>
export const retryTransient: {
  (options: {
     retryOn?: "errors-only" | "response-only" | "errors-and-responses"   // default "errors-and-responses"
     while?: Predicate.Predicate<E | ES>
     schedule?: Schedule.Schedule<B, Input, ES, R1>
     times?: number
  }): (self) => HttpClient.With<E | ES, R1 | R>
  (schedule): (self) => HttpClient.With<E | ES, R1 | R>   // bare-schedule overload
}
export const transformResponse: (f: (eff) => eff) => (self) => HttpClient.With<E1,R1>  // escape hatch
export const withScope: (self) => HttpClient.With<E, R | Scope.Scope>  // tie request to a Scope
```

**`retryTransient` already classifies transient (HttpClient.ts:1495-1513):**
- `Cause.isTimeoutError(error)` (so `Effect.timeout` failures retry)
- `TransportError` (network/DNS/connection)
- `StatusCodeError` whose response status ∈ `{408, 429, 500, 502, 503, 504}`

`retryOn` controls whether it retries on the error channel, on transient *responses* (pre-filter), or
both. With `filterStatusOk` upstream, transient statuses become `StatusCodeError`, so
`retryOn: "errors-only"` (or default `"errors-and-responses"`) both work.

### Decoding the response

```ts
// HttpClientResponse.ts
export const schemaBodyJson: <S extends Schema.Top>(schema: S, options?: ParseOptions) =>
  (self: HttpClientResponse) => Effect.Effect<S["Type"], Schema.SchemaError | HttpClientError, S["DecodingServices"]>
export const filterStatusOk: (self) => Effect.Effect<HttpClientResponse, HttpClientError>
export const matchStatus: (cases: { [status:number]: fn; "2xx"?: fn; "4xx"?: fn; "5xx"?: fn; orElse: fn }) => ...
// raw accessors on the response object:
//   self.json   : Effect<Schema.Json, HttpClientError>
//   self.text   : Effect<string, HttpClientError>
//   self.stream : Stream<Uint8Array, HttpClientError>
//   self.status : number   (sync getter)
```

`schemaBodyJson` reads `self.json`, then decodes `{ status, headers, body }` through
`Schema.toCodecJson(schema)` — so the schema decodes the JSON **body**.

### Typed errors (HttpClientError.ts)

`HttpClientError` is a single `Data.TaggedError("HttpClientError")` carrying `reason`:

```ts
type RequestError  = TransportError | EncodeError | InvalidUrlError
type ResponseError = StatusCodeError | DecodeError | EmptyBodyError
// access:  err.reason._tag, err.request, err.response (undefined for request-phase errors)
// StatusCodeError.reason.response.status  → the HTTP status
```

So you catch `HttpClientError` (one tag) and branch on `error.reason._tag`. Schema decode failures
surface separately as `Schema.SchemaError`.

---

## 3. Layer choice & base URL / default headers

### Layers

```ts
// NodeHttpClient.ts
export const layerUndici: Layer.Layer<HttpClient>            // undici + scoped Agent (recommended)
export const layerUndiciNoDispatcher: Layer.Layer<HttpClient, never, Dispatcher>
export const layerNodeHttp: Layer.Layer<HttpClient>          // node:http + pooled http/https Agent
export const layerFetch: Layer.Layer<HttpClient>             // re-export of FetchHttpClient.layer
// FetchHttpClient.ts
export const layer: Layer.Layer<HttpClient>                  // global fetch
```

- **`NodeHttpClient.layerUndici`** — default for this CLI. Creates an undici `Agent` via
  `Effect.acquireRelease` (`makeDispatcher`), pooled + keep-alive, destroyed on layer teardown.
  Undici deliberately disables its own timeouts (`headersTimeout: 60*60*1000`, `bodyTimeout: 0`) and
  leaves timeouts to `Effect.timeout` (NodeHttpClient.ts:116-118). This is exactly what we want.
- **`FetchHttpClient.layer`** — uses global `fetch`. Connection pooling/keep-alive is whatever the
  Node fetch (undici) global agent does. Fewer knobs; fine for edge/Bun. `FetchHttpClient.RequestInit`
  service lets you inject default `RequestInit`.
- **`layerNodeHttp`** — node:http with explicit `Http.Agent`/`Https.Agent` (keep-alive pooling). Use
  if you need fine `AgentOptions` (`layerAgentOptions(options)`).

### Base URL + default headers — the canonical pattern (ai-docs/src/50_http-client/10_basics.ts)

```ts
const client = (yield* HttpClient.HttpClient).pipe(
  HttpClient.mapRequest(flow(
    HttpClientRequest.prependUrl("https://api.turbopuffer.com"),
    HttpClientRequest.bearerToken(apiKey),
    HttpClientRequest.acceptJson
  )),
  HttpClient.filterStatusOk,
  HttpClient.retryTransient({ schedule, times: 4 })
)
```

`prependUrl` joins path segments (handles slashes), so per-call you pass only the path
(`/v2/namespaces/${ns}/query`). `mapRequest` runs once per request in `preprocess`.

> Region note: TurboPuffer base URL is region-specific, e.g.
> `https://gcp-us-central1.turbopuffer.com`. Read region from config; default `api.turbopuffer.com`
> redirects. Keep it a Config value, not a constant.

---

## 4. Per-request timeout, retry, abort

### Timeout
```ts
import * as Effect from "effect/Effect"
client.execute(req).pipe(
  Effect.flatMap(HttpClientResponse.schemaBodyJson(QueryResponse)),
  Effect.timeout("30 seconds")   // adds Cause.TimeoutError to the error channel
)
```
`Effect.timeout(self, "30 seconds")` interrupts the effect on expiry; interruption aborts the
underlying request (see Abort). Put the timeout **inside** the retried unit if you want each attempt
bounded, or outside if you want a total budget. Because the client owns retry, the cleanest layout is:
client-level `retryTransient` (whole-request retries) + per-call `Effect.timeout` on the decode
pipeline so a single hung attempt becomes a transient `TimeoutError` that the next attempt retries.

### Retry — production schedule (verified pattern, ai-docs/src/06_schedule/10_schedules.ts)
```ts
import { Schedule } from "effect"
// exponential(base, factor=2): delay = base * factor^(attempt-1)
// jittered: ±20% (0.8x–1.2x).  either(spaced(cap)): caps the delay.
const tpufRetrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.either(Schedule.spaced("10 seconds")),  // cap delay at 10s
  Schedule.jittered                                 // add jitter
)
// then on the client:
HttpClient.retryTransient({ schedule: tpufRetrySchedule, times: 4 })
```
`times` caps total attempts. `retryTransient` only retries transient failures (above), so 4xx like
401/404/422 fail fast. To also retry a custom error add `while`.

### Abort / Effect interruption — automatic
`HttpClient.make` wraps every send in `Effect.uninterruptibleMask` + `Effect.matchCauseEffect`; on a
cause with interrupts it calls `controller.abort()` (HttpClient.ts:613-634). The `AbortController.signal`
is passed straight into fetch/undici/node:http. Additionally a `FinalizationRegistry` aborts orphaned
responses, and reading the body wraps it in `Effect.onInterrupt(... controller.abort())`
(`InterruptibleResponse`). **You never construct or wire an AbortController yourself.** `Effect.timeout`,
fiber interruption, and `Scope` teardown (`HttpClient.withScope`) all abort the in-flight request.

---

## 5. Streaming + connection reuse

- **Large request body (streamed upload):**
  `HttpClientRequest.bodyStream(stream, { contentType: "application/json", contentLength })`.
  Sets `duplex: "half"` on fetch and pipes via undici/NodeSink. For TurboPuffer *queries* the body is
  small JSON — `bodyJsonUnsafe` is correct; reserve streaming for bulk **writes** (large upsert batches).
- **Large response body:** `self.stream` (Stream of `Uint8Array`) or `HttpClientResponse.stream(effect)`;
  combine with `Ndjson`/`Msgpack` channels for NDJSON. `schemaBodyJson` buffers full body — fine for
  query results (bounded by `top_k`), not for unbounded exports.
- **Keep-alive / pooling:** `layerUndici` pools through one scoped `Agent` for the layer's lifetime.
  `layerNodeHttp` uses one `http.Agent` + one `https.Agent` (keep-alive). Build the client **once** in
  the service layer and reuse it — do not create a client per request, or you lose pooling and span
  config. Undici disables transport timeouts so Effect owns them.

---

## 6. TurboPuffer query endpoint (grounded)

- **Endpoint:** `POST /v2/namespaces/:namespace/query` (turbopuffer.com/docs/query).
- **Auth:** `Authorization: Bearer <API_KEY>` (turbopuffer.com/docs/auth). Region-specific host, e.g.
  `https://gcp-us-central1.turbopuffer.com`.
- **Content type:** `application/json`.
- **Request body (key fields, from official TS/Ruby clients + docs):**
  - `rank_by`: e.g. `["vector", "ANN", <embedding number[]>]` for vector ANN, or
    `["<attr>", "BM25", "<query text>"]` for full-text. Hybrid = multiple queries (`queries: [...]`).
  - `top_k`: number of results.
  - `filters`: filter DSL, e.g. `["name", "Eq", "foo"]` / boolean combinators.
  - `include_attributes`: `true` | `string[]` to return stored attributes.
  - `consistency`: optional read consistency.
- **Response body:** `{ rows: Array<{ id, "$dist"?: number, ...attributes }>, billing?: {...}, performance?: {...} }`.
  The official TS client reads `result.rows`; each row has `id`, distance, and requested attributes.
  (npmjs.com/package/@turbopuffer/turbopuffer; turbopuffer-ruby README.)
- **Errors:** non-2xx returns JSON error; with `filterStatusOk` it becomes `StatusCodeError`
  (`error.reason.response.status`). 404 = namespace/route not found (fail fast), 429 = rate limit
  (transient, retried), 5xx (transient, retried).

> Verify exact field names against the live API on first integration (the rendered docs page
> truncates under extraction). Model the response schema permissively: decode `rows` strictly, keep
> `billing`/`performance` optional, and allow unknown attributes per row.

---

## 7. Concrete `TurbopufferClient` service (compile-minded)

```ts
import { Context, Effect, Layer, flow, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { NodeHttpClient } from "@effect/platform-node"

// ---- Schemas ---------------------------------------------------------------
const QueryRow = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  $dist: Schema.optional(Schema.Number)
  // attributes vary per namespace; decode strictly only what you index on,
  // or use Schema.Struct({...}, { key: Schema.String, value: Schema.Unknown }) style record for extras
})
class QueryResponse extends Schema.Class<QueryResponse>("QueryResponse")({
  rows: Schema.Array(QueryRow),
  billing: Schema.optional(Schema.Unknown),
  performance: Schema.optional(Schema.Unknown)
}) {}

export interface QueryInput {
  readonly namespace: string
  readonly rankBy: ReadonlyArray<unknown>     // e.g. ["vector","ANN", embedding]
  readonly topK: number
  readonly filters?: unknown
  readonly includeAttributes?: boolean | ReadonlyArray<string>
}

// ---- Error -----------------------------------------------------------------
export class TurbopufferError extends Schema.TaggedErrorClass<TurbopufferError>()("TurbopufferError", {
  cause: Schema.Defect
}) {}

// ---- Retry policy: capped exponential + jitter, max 4 attempts -------------
const retrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.either(Schedule.spaced("10 seconds")),
  Schedule.jittered
)

// ---- Service ---------------------------------------------------------------
export class Turbopuffer extends Context.Service<Turbopuffer, {
  query(input: QueryInput): Effect.Effect<QueryResponse, TurbopufferError>
}>()("semantic-search/turbopuffer/Turbopuffer") {
  static layer = (config: { readonly baseUrl: string; readonly apiKey: string }) =>
    Layer.effect(
      Turbopuffer,
      Effect.gen(function*() {
        const client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(flow(
            HttpClientRequest.prependUrl(config.baseUrl),
            HttpClientRequest.bearerToken(config.apiKey),
            HttpClientRequest.acceptJson
          )),
          HttpClient.filterStatusOk,
          HttpClient.retryTransient({ schedule: retrySchedule, times: 4 })
        )

        const query = Effect.fn("Turbopuffer.query")(function*(input: QueryInput) {
          yield* Effect.annotateCurrentSpan({ namespace: input.namespace, topK: input.topK })

          const body = {
            rank_by: input.rankBy,
            top_k: input.topK,
            ...(input.filters !== undefined ? { filters: input.filters } : {}),
            ...(input.includeAttributes !== undefined
              ? { include_attributes: input.includeAttributes }
              : {})
          }

          return yield* HttpClientRequest.post(
            `/v2/namespaces/${input.namespace}/query`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),   // sets content-type + content-length
            client.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(QueryResponse)),
            Effect.timeout("30 seconds"),             // per-attempt budget → transient on expiry
            Effect.mapError((cause) => new TurbopufferError({ cause }))
          )
        })

        return Turbopuffer.of({ query })
      })
    ).pipe(Layer.provide(NodeHttpClient.layerUndici))
}
```

Types line up: `client.execute` → `Effect<HttpClientResponse, HttpClientError>`;
`schemaBodyJson(QueryResponse)` → `Effect<QueryResponse, SchemaError | HttpClientError>`;
`Effect.timeout` adds `TimeoutError`; final `mapError` collapses all into `TurbopufferError`. The
client's `retryTransient` retries `TimeoutError` + `TransportError` + transient `StatusCodeError`
before the error ever reaches `query`'s pipeline (retry wraps the whole `execute`+decode is NOT —
note ordering below).

> **Ordering gotcha:** `retryTransient` lives on the **client** and only wraps the request/response
> phase (`execute`). It does **not** see `schemaBodyJson` decode errors or the outer `Effect.timeout`
> placed after `client.execute`. If you want a hung attempt to be retried, put the `Effect.timeout`
> on the client transport — use `HttpClient.transformResponse(Effect.timeout("30 seconds"))` **before**
> `retryTransient`, so the timeout is inside the retried unit:
>
> ```ts
> const client = base.pipe(
>   HttpClient.filterStatusOk,
>   HttpClient.transformResponse(Effect.timeout("30 seconds")), // per-attempt, retryable
>   HttpClient.retryTransient({ schedule: retrySchedule, times: 4 })
> )
> ```
>
> Keep the outer `Effect.timeout` only as a hard total ceiling if you want one. Decode errors
> (`SchemaError`) are not retried — correct, since a schema mismatch is not transient.

---

## 8. Gotchas summary

- `retryTransient` schedule **input type** depends on `retryOn`. With `filterStatusOk` upstream,
  transient statuses are already `StatusCodeError`s, so `retryOn` default (`"errors-and-responses"`)
  is fine; the schedule's `Input` is `HttpClientResponse | E`.
- `bodyJsonUnsafe` throws synchronously on non-serializable input (BigInt, cycles). Inputs here are
  plain arrays/numbers, so safe; if uncertain, use `bodyJson` and handle `HttpBodyError`.
- `schemaBodyJson` decodes the **body**, treating `{status, headers, body}` as the codec input;
  define the schema over the body shape only.
- Build the client **once** in the layer; per-request reconstruction loses undici pooling and tracing.
- Undici intentionally has no transport timeout — Effect owns it. Always set a timeout.
- `bearerToken` accepts `Redacted.Redacted`; pass the API key as `Redacted` to keep it out of logs/spans.
- Per-request overrides go through `client.post(url, options)` or by composing `HttpClientRequest`
  combinators then `client.execute(req)` — both honored by `preprocess`/`postprocess`.
- For request-scoped abort tied to a `Scope`, use `HttpClient.withScope` (adds `Scope.Scope` to R).

---

## Citations

- Effect v4 source (vendored): `packages/effect/src/unstable/http/{HttpClient,HttpClientRequest,HttpClientResponse,HttpClientError,HttpBody,Headers,FetchHttpClient}.ts`; `packages/platform-node/src/NodeHttpClient.ts`; `packages/effect/src/{Effect,Schedule}.ts`.
- Worked examples: `ai-docs/src/50_http-client/10_basics.ts`, `ai-docs/src/06_schedule/10_schedules.ts`.
- Tests: `packages/effect/test/unstable/http/HttpClient.test.ts` (`retryTransient`, abort-on-stream-end).
- TurboPuffer: turbopuffer.com/docs/query (POST `/v2/namespaces/:namespace/query`), turbopuffer.com/docs/auth (`Authorization: Bearer`), npmjs.com/package/@turbopuffer/turbopuffer (`rank_by`/`filters`/`.rows`), github.com/turbopuffer/turbopuffer-ruby (`rank_by: ["vector","ANN", ...]`).

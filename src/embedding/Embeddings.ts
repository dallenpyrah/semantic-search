import { Array as Arr, Context, Effect, Layer, Redacted, Schedule, Schema, flow } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppConfig, requireKey } from "../config/AppConfig.ts"
import { EmbedError } from "../domain/errors.ts"
import { VectorCache } from "./VectorCache.ts"

const PROVIDERS = {
  openrouter: { url: "https://openrouter.ai/api/v1", keyName: "OPENROUTER_API_KEY" },
  openai: { url: "https://api.openai.com/v1", keyName: "OPENAI_API_KEY" }
} as const

const EmbeddingResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ index: Schema.Number, embedding: Schema.Array(Schema.Number) }))
})

const retrySchedule = Schedule.exponential("200 millis", 2).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5))
)

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown })?.message
  return typeof message === "string" ? message : String(error)
}

export class Embeddings extends Context.Service<Embeddings, {
  embed(
    texts: ReadonlyArray<string>
  ): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError>
  readonly dimensions: number
}>()("semantic-search/Embeddings") {
  static layer = Layer.effect(
    Embeddings,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const cache = yield* VectorCache
      const indexing = config.settings.indexing
      const embedding = config.settings.embedding
      const dimensions = embedding.dimensions
      const provider = PROVIDERS[embedding.provider]
      const key = embedding.provider === "openai" ? config.keys.openai : config.keys.openrouter
      const apiKey = yield* requireKey(key, provider.keyName)
      const baseUrl = embedding.baseUrl ?? provider.url

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(baseUrl),
            HttpClientRequest.bearerToken(Redacted.value(apiKey)),
            HttpClientRequest.acceptJson
          )
        ),
        HttpClient.filterStatusOk,
        HttpClient.transformResponse(Effect.timeout("60 seconds"))
      )

      const embedBatch = (batch: ReadonlyArray<string>) =>
        HttpClientRequest.post("/embeddings").pipe(
          HttpClientRequest.bodyJsonUnsafe({ model: embedding.model, input: batch, dimensions }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(EmbeddingResponse)),
          Effect.map((response) =>
            [...response.data]
              .sort((left, right) => left.index - right.index)
              .map((item) => item.embedding as ReadonlyArray<number>)
          ),
          Effect.retry(retrySchedule),
          Effect.mapError(
            (error) =>
              new EmbedError({
                message: `embedding request failed: ${messageOf(error)}`,
                retryable: true,
                cause: error
              })
          )
        )

      const embedViaApi = (texts: ReadonlyArray<string>) =>
        Effect.forEach(Arr.chunksOf(texts, indexing.embedBatch), embedBatch, {
          concurrency: indexing.embedConcurrency
        }).pipe(Effect.map((results) => results.flat()))

      const embed = Effect.fn("Embeddings.embed")(function* (texts: ReadonlyArray<string>) {
        if (texts.length === 0) return [] as ReadonlyArray<ReadonlyArray<number>>
        if (!indexing.vectorCacheEnabled) return yield* embedViaApi(texts)
        const keys = texts.map((text) => cache.keyOf(text))
        const cached = yield* cache.get(keys)
        const missIdx: Array<number> = []
        for (let i = 0; i < texts.length; i += 1) if (cached[i] === undefined) missIdx.push(i)
        if (missIdx.length === 0) return cached as ReadonlyArray<ReadonlyArray<number>>
        const fresh = yield* embedViaApi(missIdx.map((i) => texts[i]!))
        const results = cached.slice()
        for (let j = 0; j < missIdx.length; j += 1) results[missIdx[j]!] = fresh[j]!
        yield* cache.put(missIdx.map((i, j) => [keys[i]!, fresh[j]!] as const))
        return results as ReadonlyArray<ReadonlyArray<number>>
      })

      return Embeddings.of({ embed, dimensions })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(VectorCache.layer))
}

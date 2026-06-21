import { Array as Arr, Context, Effect, Layer, Schedule } from "effect"
import { EmbeddingModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { OpenAiClient, OpenAiEmbeddingModel } from "@effect/ai-openai"
import { AppConfig, requireKey } from "../config/AppConfig.ts"
import { EmbedError } from "../domain/errors.ts"

const PROVIDERS = {
  openrouter: { url: "https://openrouter.ai/api/v1", keyName: "OPENROUTER_API_KEY" },
  openai: { url: "https://api.openai.com/v1", keyName: "OPENAI_API_KEY" }
} as const

const clientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const provider = PROVIDERS[config.settings.embedding.provider]
    const key = config.settings.embedding.provider === "openai" ? config.keys.openai : config.keys.openrouter
    const apiKey = yield* requireKey(key, provider.keyName)
    return OpenAiClient.layer({ apiKey, apiUrl: config.settings.embedding.baseUrl ?? provider.url })
  })
).pipe(Layer.provide(FetchHttpClient.layer))

const modelLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    return OpenAiEmbeddingModel.model(config.settings.embedding.model, {
      dimensions: config.settings.embedding.dimensions
    })
  })
).pipe(Layer.provide(clientLayer))

const retrySchedule = Schedule.exponential("200 millis", 2).pipe(
  Schedule.jittered,
  Schedule.both(Schedule.recurs(5))
)

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
      const model = yield* EmbeddingModel.EmbeddingModel
      const indexing = config.settings.indexing
      const dimensions = config.settings.embedding.dimensions

      const embedBatch = (batch: ReadonlyArray<string>) =>
        model.embedMany(batch).pipe(
          Effect.map((response) => response.embeddings.map((item) => Array.from(item.vector))),
          Effect.retry({ schedule: retrySchedule, while: (error) => error.isRetryable }),
          Effect.mapError(
            (error) =>
              new EmbedError({
                message: `embedding request failed: ${error.message}`,
                retryable: error.isRetryable,
                cause: error
              })
          )
        )

      const embed = Effect.fn("Embeddings.embed")(function* (texts: ReadonlyArray<string>) {
        if (texts.length === 0) return [] as ReadonlyArray<ReadonlyArray<number>>
        const batches = Arr.chunksOf(texts, indexing.embedBatch)
        const results = yield* Effect.forEach(batches, embedBatch, {
          concurrency: indexing.embedConcurrency
        })
        return results.flat()
      })

      return Embeddings.of({ embed, dimensions })
    })
  ).pipe(Layer.provide(modelLayer))
}

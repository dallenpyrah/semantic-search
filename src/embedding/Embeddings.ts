import { Context, Effect, Layer, Option, Redacted, Schedule, Schema, flow } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AppConfig, requireKey } from "../config/AppConfig.ts"
import { EmbedError } from "../domain/errors.ts"
import {
  DEFAULT_EMBEDDING_REQUEST_TOKEN_BUDGET,
  classifyEmbeddingHttpStatus,
  embeddingInputTokenLimit,
  prepareEmbeddingInput,
  providerErrorMessage,
  providerErrorStatus,
  splitEmbeddingRequests,
  type PreparedEmbeddingInput
} from "./EmbeddingInput.ts"
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

class EmbeddingRequestFailure extends Error {
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(
    message: string,
    options: {
      readonly retryable: boolean
      readonly status?: number
      readonly cause?: unknown
    }
  ) {
    super(message, { cause: options.cause })
    this.name = "EmbeddingRequestFailure"
    this.retryable = options.retryable
    this.status = options.status
  }
}

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown })?.message
  return typeof message === "string" ? message : String(error)
}

const preview = (body: string): string => body.slice(0, 400)

const providerErrorBody = (json: unknown, body: string): string => providerErrorMessage(json) ?? preview(body)

const normalizeFailure = (endpoint: string, error: unknown): EmbeddingRequestFailure =>
  error instanceof EmbeddingRequestFailure
    ? error
    : new EmbeddingRequestFailure(`${endpoint} failed: ${messageOf(error)}`, {
        retryable: true,
        cause: error
      })

const failForStatus = (
  endpoint: string,
  status: number,
  body: string,
  cause?: unknown
): Effect.Effect<never, EmbeddingRequestFailure> => {
  const classification = classifyEmbeddingHttpStatus(status)
  return Effect.fail(
    new EmbeddingRequestFailure(`${endpoint} -> HTTP ${status}: ${preview(body)}`, {
      retryable: classification.retryable,
      status,
      cause
    })
  )
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
        HttpClient.transformResponse(Effect.timeout("60 seconds"))
      )

      const maxInputTokens = embeddingInputTokenLimit(indexing.embedTokenCap)
      const endpoint = `POST ${baseUrl}/embeddings`

      const embedBatch = (batch: ReadonlyArray<PreparedEmbeddingInput>) =>
        HttpClientRequest.post("/embeddings").pipe(
          HttpClientRequest.bodyJsonUnsafe({ model: embedding.model, input: batch.map((input) => input.text), dimensions }),
          client.execute,
          Effect.flatMap((response) =>
            response.text.pipe(
              Effect.flatMap((body: string) =>
                response.status < 200 || response.status >= 300
                  ? failForStatus(endpoint, response.status, body)
                  : Effect.try({
                      try: () => JSON.parse(body) as unknown,
                      catch: (cause) =>
                        new EmbeddingRequestFailure(`non-JSON embeddings response (HTTP ${response.status}): ${preview(body)}`, {
                          retryable: false,
                          status: response.status,
                          cause
                        })
                    }).pipe(
                      Effect.flatMap((json) => {
                        const errorStatus = providerErrorStatus(json)
                        if (errorStatus !== undefined) {
                          const classification = classifyEmbeddingHttpStatus(errorStatus)
                          return Effect.fail(
                            new EmbeddingRequestFailure(
                              `${endpoint} -> provider error HTTP ${errorStatus}: ${providerErrorBody(json, body)}`,
                              {
                                retryable: classification.retryable,
                                status: errorStatus
                              }
                            )
                          )
                        }
                        const decoded = Schema.decodeUnknownOption(EmbeddingResponse)(json)
                        return Option.isSome(decoded)
                          ? Effect.succeed(decoded.value)
                          : Effect.fail(
                              new EmbeddingRequestFailure(
                                `unexpected embeddings response (HTTP ${response.status}): ${preview(body)}`,
                                {
                                  retryable: false,
                                  status: response.status
                                }
                              )
                            )
                      })
                    )
              )
            )
          ),
          Effect.flatMap((response) => {
            const sorted = [...response.data].sort((left, right) => left.index - right.index)
            if (
              sorted.length !== batch.length ||
              sorted.some((item, index) => item.index !== index)
            ) {
              return Effect.fail(
                new EmbeddingRequestFailure(`unexpected embeddings response indexes for ${batch.length} inputs`, {
                  retryable: false
                })
              )
            }
            return Effect.succeed(sorted.map((item) => item.embedding as ReadonlyArray<number>))
          }),
          Effect.mapError((error) => normalizeFailure(endpoint, error)),
          Effect.retry({ schedule: retrySchedule, while: (error: EmbeddingRequestFailure) => error.retryable }),
          Effect.mapError(
            (error) =>
              new EmbedError({
                message: `embedding request failed: ${messageOf(error)}`,
                retryable: error.retryable,
                cause: error
              })
          )
        )

      const embedViaApi = (texts: ReadonlyArray<string>) => {
        const prepared = texts.map((text) => prepareEmbeddingInput(text, maxInputTokens))
        return Effect.forEach(
          splitEmbeddingRequests(prepared, {
            maxInputsPerRequest: indexing.embedBatch,
            maxTokensPerRequest: DEFAULT_EMBEDDING_REQUEST_TOKEN_BUDGET
          }),
          embedBatch,
          { concurrency: 1 }
        ).pipe(Effect.map((results) => results.flat()))
      }

      const embed = Effect.fn("Embeddings.embed")(function* (texts: ReadonlyArray<string>) {
        if (texts.length === 0) return [] as ReadonlyArray<ReadonlyArray<number>>
        if (!indexing.vectorCacheEnabled) return yield* embedViaApi(texts)
        const prepared = texts.map((text) => prepareEmbeddingInput(text, maxInputTokens))
        const keys = prepared.map((input) => cache.keyOf(input.text))
        const cached = yield* cache.get(keys)
        const missIdx: Array<number> = []
        for (let i = 0; i < texts.length; i += 1) if (cached[i] === undefined) missIdx.push(i)
        if (missIdx.length === 0) return cached as ReadonlyArray<ReadonlyArray<number>>
        const fresh = yield* Effect.forEach(
          splitEmbeddingRequests(
            missIdx.map((i) => prepared[i]!),
            {
              maxInputsPerRequest: indexing.embedBatch,
              maxTokensPerRequest: DEFAULT_EMBEDDING_REQUEST_TOKEN_BUDGET
            }
          ),
          embedBatch,
          { concurrency: 1 }
        ).pipe(Effect.map((results) => results.flat()))
        const results = cached.slice()
        for (let j = 0; j < missIdx.length; j += 1) results[missIdx[j]!] = fresh[j]!
        yield* cache.put(missIdx.map((i, j) => [keys[i]!, fresh[j]!] as const))
        return results as ReadonlyArray<ReadonlyArray<number>>
      })

      return Embeddings.of({ embed, dimensions })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(VectorCache.layer))
}

import { Context, Effect, Layer, Option, Redacted, Schema, flow } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppConfig } from "../config/AppConfig.ts"

export interface Ranking {
  readonly index: number
  readonly score: number
}

const RerankResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      relevance_score: Schema.Number
    })
  )
})

const identity = (count: number, topN: number): ReadonlyArray<Ranking> =>
  Array.from({ length: Math.min(count, topN) }, (_, index) => ({ index, score: 0 }))

type Provider = "openrouter-cohere" | "openrouter-free" | "none"

const resolveProvider = (
  configured: "auto" | "openrouter-cohere" | "openrouter-free" | "none",
  hasKey: boolean
): Provider => {
  if (configured === "none") return "none"
  if (configured === "auto") return hasKey ? "openrouter-cohere" : "none"
  return hasKey ? configured : "none"
}

export class Reranker extends Context.Service<Reranker, {
  readonly enabled: boolean
  rerank(
    query: string,
    documents: ReadonlyArray<string>,
    topN: number
  ): Effect.Effect<ReadonlyArray<Ranking>>
}>()("semantic-search/Reranker") {
  static layer = Layer.effect(
    Reranker,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const rerank = config.settings.rerank
      const provider = resolveProvider(rerank.provider, Option.isSome(config.keys.openrouter))

      if (provider === "none" || Option.isNone(config.keys.openrouter)) {
        return Reranker.of({
          enabled: false,
          rerank: (_query, documents, topN) => Effect.succeed(identity(documents.length, topN))
        })
      }

      const apiKey = config.keys.openrouter.value
      const model = provider === "openrouter-free" ? rerank.freeModel : rerank.model
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(rerank.baseUrl),
            HttpClientRequest.bearerToken(Redacted.value(apiKey)),
            HttpClientRequest.acceptJson
          )
        ),
        HttpClient.filterStatusOk,
        HttpClient.transformResponse(Effect.timeout("6 seconds"))
      )

      const call = Effect.fn("Reranker.rerank")(function* (
        query: string,
        documents: ReadonlyArray<string>,
        topN: number
      ) {
        if (documents.length === 0) return [] as ReadonlyArray<Ranking>
        const decoded = yield* HttpClientRequest.post("/rerank").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            model,
            query,
            documents,
            top_n: Math.min(topN, documents.length),
            provider: { sort: "latency", data_collection: "deny" }
          }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(RerankResponse))
        )
        return decoded.results.map((result) => ({ index: result.index, score: result.relevance_score }))
      })

      return Reranker.of({
        enabled: true,
        rerank: (query, documents, topN) =>
          call(query, documents, topN).pipe(
            Effect.catch(() => Effect.succeed(identity(documents.length, topN)))
          )
      })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

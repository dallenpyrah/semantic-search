import { Context, Effect, Layer, Option, Redacted, Schedule, flow } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, FetchHttpClient } from "effect/unstable/http"
import { AppConfig, requireKey } from "../config/AppConfig.ts"
import { StoreError } from "../domain/errors.ts"
import {
  buildSchema,
  type MultiQueryBody,
  MultiQueryResponse,
  type UpsertRow
} from "./schema.ts"

const retrySchedule = Schedule.exponential("250 millis").pipe(
  Schedule.either(Schedule.spaced("10 seconds")),
  Schedule.jittered
)

const httpStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined
  const reason = (error as { reason?: unknown }).reason
  if (typeof reason !== "object" || reason === null) return undefined
  const response = (reason as { response?: unknown }).response
  if (typeof response !== "object" || response === null) return undefined
  const status = (response as { status?: unknown }).status
  return typeof status === "number" ? status : undefined
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export class Turbopuffer extends Context.Service<Turbopuffer, {
  readonly namespace: string
  upsert(rows: ReadonlyArray<UpsertRow>): Effect.Effect<void, StoreError>
  replaceFile(path: string, rows: ReadonlyArray<UpsertRow>): Effect.Effect<void, StoreError>
  deleteIds(ids: ReadonlyArray<string>): Effect.Effect<void, StoreError>
  deleteFiles(paths: ReadonlyArray<string>): Effect.Effect<void, StoreError>
  deleteByFilter(filter: unknown): Effect.Effect<void, StoreError>
  query(body: MultiQueryBody): Effect.Effect<MultiQueryResponse, StoreError>
  warm(): Effect.Effect<void>
  clear(): Effect.Effect<void, StoreError>
}>()("semantic-search/Turbopuffer") {
  static layer = Layer.effect(
    Turbopuffer,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const apiKey = yield* requireKey(config.keys.turbopuffer, "TURBOPUFFER_API_KEY")
      const namespace = config.namespace
      const dimensions = config.settings.embedding.dimensions
      const consistency = config.settings.store.consistency
      const baseUrl =
        config.settings.store.baseUrl ?? `https://${config.settings.store.region}.turbopuffer.com`
      const schema = buildSchema(dimensions)

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(baseUrl),
            HttpClientRequest.bearerToken(Redacted.value(apiKey)),
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("Accept-Encoding", "identity")
          )
        ),
        HttpClient.filterStatusOk,
        HttpClient.transformResponse(Effect.timeout("30 seconds")),
        HttpClient.retryTransient({ schedule: retrySchedule, times: 4 })
      )

      const toStoreError = (error: unknown): StoreError => {
        const status = httpStatus(error)
        return new StoreError({
          message: `turbopuffer request failed: ${messageOf(error)}`,
          status,
          namespaceMissing: status === 404,
          cause: error
        })
      }

      const write = (body: Record<string, unknown>): Effect.Effect<void, StoreError> =>
        HttpClientRequest.post(`/v2/namespaces/${namespace}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
          client.execute,
          Effect.asVoid,
          Effect.mapError(toStoreError)
        )

      const upsert = (rows: ReadonlyArray<UpsertRow>): Effect.Effect<void, StoreError> =>
        rows.length === 0
          ? Effect.void
          : write({ distance_metric: "cosine_distance", schema, upsert_rows: rows })

      const replaceFile = (
        path: string,
        rows: ReadonlyArray<UpsertRow>
      ): Effect.Effect<void, StoreError> =>
        write({
          distance_metric: "cosine_distance",
          schema,
          delete_by_filter: ["path", "Eq", path],
          ...(rows.length > 0 ? { upsert_rows: rows } : {})
        })

      const deleteIds = (ids: ReadonlyArray<string>): Effect.Effect<void, StoreError> =>
        ids.length === 0
          ? Effect.void
          : write({ distance_metric: "cosine_distance", schema, deletes: ids })

      const deleteFiles = (paths: ReadonlyArray<string>): Effect.Effect<void, StoreError> =>
        paths.length === 0
          ? Effect.void
          : write({
              distance_metric: "cosine_distance",
              schema,
              delete_by_filter: ["Or", paths.map((path) => ["path", "Eq", path])]
            })

      const deleteByFilter = (filter: unknown): Effect.Effect<void, StoreError> =>
        write({ distance_metric: "cosine_distance", schema, delete_by_filter: filter })

      const query = Effect.fn("Turbopuffer.query")(function* (body: MultiQueryBody) {
        const withConsistency: MultiQueryBody = { consistency: { level: consistency }, ...body }
        const response = yield* HttpClientRequest.post(`/v2/namespaces/${namespace}/query`).pipe(
          HttpClientRequest.bodyJsonUnsafe(withConsistency),
          client.execute,
          Effect.map(Option.some),
          Effect.catch((error) =>
            httpStatus(error) === 404
              ? Effect.succeed(Option.none<HttpClientResponse.HttpClientResponse>())
              : Effect.fail(toStoreError(error))
          )
        )
        if (Option.isNone(response)) return new MultiQueryResponse({ results: [] })
        return yield* HttpClientResponse.schemaBodyJson(MultiQueryResponse)(response.value).pipe(
          Effect.mapError(
            (error) =>
              new StoreError({
                message: `turbopuffer response did not match the expected schema (API change?): ${messageOf(error)}`,
                status: undefined,
                namespaceMissing: false,
                cause: error
              })
          )
        )
      })

      const warm = (): Effect.Effect<void> =>
        HttpClientRequest.get(`/v1/namespaces/${namespace}/hint_cache_warm`).pipe(
          client.execute,
          Effect.asVoid,
          Effect.catch(() => Effect.void)
        )

      const clear = (): Effect.Effect<void, StoreError> =>
        HttpClientRequest.make("DELETE")(`/v1/namespaces/${namespace}`).pipe(
          client.execute,
          Effect.asVoid,
          Effect.catch((error) =>
            httpStatus(error) === 404 ? Effect.void : Effect.fail(toStoreError(error))
          )
        )

      return Turbopuffer.of({
        namespace,
        upsert,
        replaceFile,
        deleteIds,
        deleteFiles,
        deleteByFilter,
        query,
        warm,
        clear
      })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

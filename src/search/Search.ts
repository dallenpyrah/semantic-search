import { Context, Duration, Effect, Layer } from "effect"
import { AppConfig } from "../config/AppConfig.ts"
import { Embeddings } from "../embedding/Embeddings.ts"
import { Reranker } from "../rerank/Reranker.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import type { EmbedError, StoreError } from "../domain/errors.ts"
import type { SearchMode, SearchOptions, SearchResult } from "../domain/types.ts"
import type { SubQuery } from "../store/schema.ts"
import { type Candidate, diversify, formatHits, fuse, toHit } from "./fuse.ts"

const ATTRIBUTES = ["text", "path", "language", "kind", "startLine", "endLine"]

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min

const kindBonus = (kind: unknown): number =>
  kind === "code" ? 0.04 : kind === "test" ? -0.01 : kind === "docs" ? -0.015 : -0.005

const buildFilters = (options: SearchOptions): unknown => {
  const filters: Array<unknown> = []
  if (options.language && options.language.trim().length > 0) {
    filters.push(["language", "Eq", options.language.trim().toLowerCase()])
  }
  if (options.kind) filters.push(["kind", "Eq", options.kind])
  if (filters.length === 0) return undefined
  if (filters.length === 1) return filters[0]
  return ["And", filters]
}

export class Search extends Context.Service<Search, {
  semantic(query: string, options: SearchOptions): Effect.Effect<SearchResult, EmbedError | StoreError>
  hybrid(query: string, options: SearchOptions): Effect.Effect<SearchResult, EmbedError | StoreError>
  formatted(result: SearchResult): string
}>()("semantic-search/Search") {
  static layer = Layer.effect(
    Search,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const embeddings = yield* Embeddings
      const store = yield* Turbopuffer
      const reranker = yield* Reranker
      const defaults = config.settings.search
      const poolMultiplier = config.settings.rerank.poolMultiplier

      const formatted = (result: SearchResult): string =>
        formatHits(result.query, result.hits, defaults.maxOutputBytes)

      const run = Effect.fn("Search.run")(function* (
        mode: SearchMode,
        query: string,
        options: SearchOptions
      ) {
        const trimmed = query.trim()
        const limit = clamp(options.limit ?? defaults.limit, 1, defaults.maxLimit)
        const perFile = clamp(options.perFile ?? defaults.perFile, 1, limit)
        const empty: SearchResult = {
          query: trimmed,
          mode,
          namespace: store.namespace,
          hits: [],
          candidates: 0,
          reranked: false,
          tookMs: 0
        }
        if (trimmed.length === 0) return empty

        const candidates = Math.max(defaults.minCandidates, limit * defaults.candidateMultiplier)
        const filters = buildFilters(options)
        const [vector] = yield* embeddings.embed([trimmed])
        if (!vector) return empty

        const queries: ReadonlyArray<SubQuery> =
          mode === "semantic"
            ? [{ rank_by: ["vector", "ANN", vector], top_k: candidates, filters, include_attributes: ATTRIBUTES }]
            : [
                { rank_by: ["vector", "ANN", vector], top_k: candidates, filters, include_attributes: ATTRIBUTES },
                { rank_by: ["text", "BM25", trimmed], top_k: candidates, filters, include_attributes: ATTRIBUTES },
                {
                  rank_by: ["pathText", "BM25", trimmed],
                  top_k: Math.min(candidates, 40),
                  filters,
                  include_attributes: ATTRIBUTES
                }
              ]

        const response = yield* store.query({ queries })
        const lists = response.results.map((result) => result.rows ?? [])
        const sourceNames = mode === "semantic" ? ["semantic"] : ["semantic", "text", "path"]
        const fused = fuse(lists, sourceNames, trimmed, defaults.rankConstant, options.pathPrefix)
        if (fused.length === 0) return empty

        const wantRerank = options.rerank ?? true
        let ordered: ReadonlyArray<Candidate> = fused
        let reranked = false
        if (wantRerank && reranker.enabled && fused.length > 1) {
          const poolSize = Math.min(fused.length, limit * poolMultiplier)
          const pool = fused.slice(0, poolSize)
          const documents = pool.map(
            (candidate) => `${String(candidate.row.path ?? "")}\n\n${String(candidate.row.text ?? "")}`
          )
          const rankings = yield* reranker.rerank(trimmed, documents, poolSize)
          if (rankings.length > 0) {
            const head = rankings
              .map((ranking) => {
                const candidate = pool[ranking.index]
                return candidate
                  ? { ...candidate, score: ranking.score + kindBonus(candidate.row.kind) }
                  : undefined
              })
              .filter((candidate): candidate is Candidate => candidate !== undefined)
              .sort((left, right) => right.score - left.score)
            ordered = [...head, ...fused.slice(poolSize)]
            reranked = true
          }
        }

        const diversified = diversify(ordered, limit, perFile, options.pathPrefix)
        const hits = diversified.map((candidate) => toHit(candidate, trimmed, defaults.snippetChars))
        return {
          query: trimmed,
          mode,
          namespace: store.namespace,
          hits,
          candidates: fused.length,
          reranked,
          tookMs: 0
        }
      })

      const timed = (mode: SearchMode, query: string, options: SearchOptions) =>
        Effect.timed(run(mode, query, options)).pipe(
          Effect.map(([duration, result]) => ({
            ...result,
            tookMs: Math.round(Duration.toMillis(duration))
          }))
        )

      return Search.of({
        semantic: (query, options) => timed("semantic", query, options),
        hybrid: (query, options) => timed("hybrid", query, options),
        formatted
      })
    })
  )
}

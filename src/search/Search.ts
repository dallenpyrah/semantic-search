import { Context, Duration, Effect, Layer } from "effect"
import { AppConfig } from "../config/AppConfig.ts"
import { Embeddings } from "../embedding/Embeddings.ts"
import { Reranker } from "../rerank/Reranker.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import type { EmbedError, StoreError } from "../domain/errors.ts"
import type { SearchMode, SearchOptions, SearchResult, SourceType } from "../domain/types.ts"
import type { SubQuery } from "../store/schema.ts"
import { type Candidate, diversify, formatHits, fuse, rerankDoc, toHit } from "./fuse.ts"

const ATTRIBUTES = [
  "text", "path", "language", "kind", "symbol", "startLine", "endLine",
  "source", "sha", "committedAt", "author", "ts", "role"
]

const SOURCE_QUOTAS: Record<string, number> = { history: 2, conversation: 2, docs: 3 }
const HISTORY_CUES = /\b(when (was|did)|who (wrote|changed|added|created)|history of|introduced|git log|the commit|changelog|recently changed|last (changed|modified|edited)|over time)\b/i
const CONVO_CUES = /\b(what did we (decide|choose|agree)|did we (decide|discuss|agree)|we (discussed|decided|agreed|chose)|past (decision|discussion)|earlier (decided|discussed)|the rationale|our decision)\b/i
const CAUSAL_CUES = /\b(why (did|do|was|were|is|are) (we|it|this|that|the)|why .* (change|changed|switch|switched|move|moved|remove|removed|add|added|introduce))\b/i

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : min

const resolveSources = (query: string, options: SearchOptions): ReadonlyArray<SourceType> => {
  if (options.source && options.source.length > 0) return options.source
  const sources: Array<SourceType> = ["code", "docs"]
  const causal = CAUSAL_CUES.test(query)
  if (causal || HISTORY_CUES.test(query)) sources.push("history")
  if (causal || CONVO_CUES.test(query)) sources.push("conversation")
  return sources
}

const sourceBonus = (source: unknown, requested: ReadonlySet<string>): number => {
  switch (source) {
    case "code":
      return 0.03
    case "docs":
      return 0
    case "history":
    case "conversation":
      return requested.has(String(source)) ? 0.02 : -0.06
    default:
      return 0
  }
}

const kindNudge = (kind: unknown): number => (kind === "test" ? -0.01 : 0)

const buildFilters = (sources: ReadonlyArray<SourceType>, options: SearchOptions): unknown => {
  const filters: Array<unknown> = [["source", "In", sources]]
  if (options.language && options.language.trim().length > 0) {
    filters.push(["language", "Eq", options.language.trim().toLowerCase()])
  }
  if (options.kind) filters.push(["kind", "Eq", options.kind])
  return filters.length === 1 ? filters[0] : ["And", filters]
}

export class Search extends Context.Service<Search, {
  search(mode: SearchMode, facets: ReadonlyArray<string>, options: SearchOptions): Effect.Effect<SearchResult, EmbedError | StoreError>
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
        rawFacets: ReadonlyArray<string>,
        options: SearchOptions
      ) {
        const facets = Array.from(new Set(rawFacets.map((f) => f.trim()).filter(Boolean)))
        const subPerFacet = mode === "hybrid" ? 3 : 1
        const cappedFacets = facets.slice(0, Math.max(1, Math.floor(16 / subPerFacet)))
        const queryLabel = cappedFacets.join(" / ")
        const limit = clamp(options.limit ?? defaults.limit, 1, defaults.maxLimit)
        const perFile = clamp(options.perFile ?? defaults.perFile, 1, limit)
        const empty: SearchResult = {
          query: queryLabel,
          mode,
          namespace: store.namespace,
          hits: [],
          candidates: 0,
          reranked: false,
          tookMs: 0
        }
        if (cappedFacets.length === 0) return empty

        const sources = resolveSources(queryLabel, options)
        const requested = new Set<string>(sources)
        const filters = buildFilters(sources, options)
        const candidates = Math.max(defaults.minCandidates, limit * defaults.candidateMultiplier)
        const vectors = yield* embeddings.embed(cappedFacets)

        const queries: Array<SubQuery> = []
        const sourceNames: Array<string> = []
        cappedFacets.forEach((facet, index) => {
          const vector = vectors[index]!
          queries.push({ rank_by: ["vector", "ANN", vector], top_k: candidates, filters, include_attributes: ATTRIBUTES })
          sourceNames.push("semantic")
          if (mode === "hybrid") {
            queries.push({ rank_by: ["text", "BM25", facet], top_k: candidates, filters, include_attributes: ATTRIBUTES })
            sourceNames.push("text")
            queries.push({ rank_by: ["pathText", "BM25", facet], top_k: Math.min(candidates, 40), filters, include_attributes: ATTRIBUTES })
            sourceNames.push("path")
          }
        })

        const response = yield* store.query({ queries })
        const lists = response.results.map((result) => result.rows ?? [])
        const fusedRaw = fuse(lists, sourceNames, queryLabel, defaults.rankConstant, options.pathPrefix)
        const fused = fusedRaw
          .map((candidate) => ({
            ...candidate,
            score: candidate.score + sourceBonus(candidate.row.source, requested) + kindNudge(candidate.row.kind)
          }))
          .sort((left, right) => right.score - left.score)
        if (fused.length === 0) return empty

        const wantRerank = options.rerank ?? true
        let ordered: ReadonlyArray<Candidate> = fused
        let reranked = false
        if (wantRerank && reranker.enabled && fused.length > 1) {
          const poolSize = Math.min(fused.length, limit * poolMultiplier)
          const pool = fused.slice(0, poolSize)
          const rankings = yield* reranker.rerank(queryLabel, pool.map(rerankDoc), poolSize)
          if (rankings.length > 0) {
            const head = rankings
              .map((ranking) => {
                const candidate = pool[ranking.index]
                return candidate
                  ? { ...candidate, score: ranking.score + sourceBonus(candidate.row.source, requested) }
                  : undefined
              })
              .filter((candidate): candidate is Candidate => candidate !== undefined)
              .sort((left, right) => right.score - left.score)
            ordered = [...head, ...fused.slice(poolSize)]
            reranked = true
          }
        }

        const diversified = diversify(ordered, limit, perFile, options.pathPrefix, SOURCE_QUOTAS)
        const hits = diversified.map((candidate) => toHit(candidate, queryLabel, defaults.snippetChars))
        return {
          query: queryLabel,
          mode,
          namespace: store.namespace,
          hits,
          candidates: fused.length,
          reranked,
          tookMs: 0
        }
      })

      const timed = (mode: SearchMode, facets: ReadonlyArray<string>, options: SearchOptions) =>
        Effect.timed(run(mode, facets, options)).pipe(
          Effect.map(([duration, result]) => ({ ...result, tookMs: Math.round(Duration.toMillis(duration)) }))
        )

      return Search.of({
        search: (mode, facets, options) => timed(mode, facets, options),
        semantic: (query, options) => timed("semantic", [query], options),
        hybrid: (query, options) => timed("hybrid", [query], options),
        formatted
      })
    })
  )
}

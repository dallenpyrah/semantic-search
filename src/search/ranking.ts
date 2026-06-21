import type { SearchOptions, SourceType } from "../domain/types.ts"

export const SOURCE_QUOTAS: Record<string, number> = { history: 2, conversation: 2, docs: 3 }

const HISTORY_CUES = /\b(when (was|did)|who (wrote|changed|added|created)|history of|introduced|git log|the commit|changelog|recently changed|last (changed|modified|edited)|over time)\b/i
const CONVO_CUES = /\b(what did we (decide|choose|agree)|did we (decide|discuss|agree)|we (discussed|decided|agreed|chose)|past (decision|discussion)|earlier (decided|discussed)|the rationale|our decision)\b/i
const CAUSAL_CUES = /\b(why (did|do|was|were|is|are) (we|it|this|that|the)|why .* (change|changed|switch|switched|move|moved|remove|removed|add|added|introduce))\b/i

export const resolveSources = (query: string, options: SearchOptions): ReadonlyArray<SourceType> => {
  if (options.source && options.source.length > 0) return options.source
  const sources: Array<SourceType> = ["code", "docs"]
  const causal = CAUSAL_CUES.test(query)
  if (causal || HISTORY_CUES.test(query)) sources.push("history")
  if (causal || CONVO_CUES.test(query)) sources.push("conversation")
  return sources
}

export const sourceBonus = (source: unknown, requested: ReadonlySet<string>): number => {
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

export const kindNudge = (kind: unknown): number => (kind === "test" ? -0.01 : 0)

export const buildFilters = (sources: ReadonlyArray<SourceType>, options: SearchOptions): unknown => {
  const filters: Array<unknown> = [["source", "In", sources]]
  if (options.language && options.language.trim().length > 0) {
    filters.push(["language", "Eq", options.language.trim().toLowerCase()])
  }
  if (options.kind) filters.push(["kind", "Eq", options.kind])
  return filters.length === 1 ? filters[0] : ["And", filters]
}

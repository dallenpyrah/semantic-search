import type { SearchHit } from "../domain/types.ts"
import type { TpufRow } from "../store/schema.ts"

export interface Candidate {
  readonly id: string
  readonly row: TpufRow
  readonly score: number
  readonly sources: ReadonlyArray<string>
}

export const tokenize = (value: string): ReadonlyArray<string> =>
  value
    .toLowerCase()
    .split(/[^a-z0-9_.$/-]+/)
    .filter((token) => token.length >= 2)
    .slice(0, 12)

export const normalizePrefix = (prefix: string | undefined): string | undefined => {
  if (!prefix || prefix.trim().length === 0) return undefined
  return prefix.trim().replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase()
}

export const fuse = (
  lists: ReadonlyArray<ReadonlyArray<TpufRow>>,
  sourceNames: ReadonlyArray<string>,
  query: string,
  rankConstant: number,
  pathPrefix: string | undefined
): ReadonlyArray<Candidate> => {
  const scores = new Map<string, number>()
  const rows = new Map<string, TpufRow>()
  const sources = new Map<string, Set<string>>()
  const tokens = tokenize(query)
  const prefix = normalizePrefix(pathPrefix)

  lists.forEach((list, listIndex) => {
    const source = sourceNames[listIndex] ?? `source-${listIndex}`
    list.forEach((row, rank) => {
      const id = String(row.id)
      rows.set(id, row)
      scores.set(id, (scores.get(id) ?? 0) + 1 / (rankConstant + rank + 1))
      const set = sources.get(id) ?? new Set<string>()
      set.add(source)
      sources.set(id, set)
    })
  })

  for (const [id, row] of rows) {
    let boost = 0
    const path = String(row.path ?? "").toLowerCase()
    const text = String(row.text ?? "").toLowerCase()
    if (prefix && path.startsWith(prefix)) boost += 0.02
    for (const token of tokens) {
      if (path.includes(token)) boost += 0.01
      if (text.includes(token)) boost += 0.002
    }
    scores.set(id, (scores.get(id) ?? 0) + boost)
  }

  return Array.from(rows.keys())
    .map((id) => ({
      id,
      row: rows.get(id)!,
      score: scores.get(id) ?? 0,
      sources: Array.from(sources.get(id) ?? [])
    }))
    .sort((left, right) => right.score - left.score)
}

export const diversify = (
  candidates: ReadonlyArray<Candidate>,
  limit: number,
  perFile: number,
  pathPrefix: string | undefined,
  sourceQuotas?: Record<string, number>
): ReadonlyArray<Candidate> => {
  const prefix = normalizePrefix(pathPrefix)
  const counts = new Map<string, number>()
  const sourceCounts = new Map<string, number>()
  const selected: Array<Candidate> = []
  for (const candidate of candidates) {
    const path = String(candidate.row.path ?? "")
    if (prefix && !path.toLowerCase().startsWith(prefix)) continue
    const source = String(candidate.row.source ?? "code")
    const quota = sourceQuotas?.[source]
    if (quota !== undefined && (sourceCounts.get(source) ?? 0) >= quota) continue
    const count = counts.get(path) ?? 0
    if (count >= perFile) continue
    selected.push(candidate)
    counts.set(path, count + 1)
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1)
    if (selected.length >= limit) break
  }
  if (selected.length >= limit || !prefix) return selected
  for (const candidate of candidates) {
    if (selected.includes(candidate)) continue
    selected.push(candidate)
    if (selected.length >= limit) break
  }
  return selected
}

const snippet = (text: string, query: string, maxChars: number): string => {
  const normalized = text.replace(/\s+$/g, "")
  if (normalized.length <= maxChars) return normalized
  const tokens = tokenize(query)
  const lower = normalized.toLowerCase()
  const hit = tokens.map((token) => lower.indexOf(token)).find((position) => position >= 0) ?? 0
  const start = Math.max(0, hit - Math.floor(maxChars / 3))
  const end = Math.min(normalized.length, start + maxChars)
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`
}

export const toHit = (candidate: Candidate, query: string, snippetChars: number): SearchHit => {
  const row = candidate.row
  return {
    id: candidate.id,
    source: String(row.source ?? "code"),
    path: String(row.path ?? "unknown"),
    language: String(row.language ?? ""),
    kind: String(row.kind ?? ""),
    symbol: String(row.symbol ?? ""),
    startLine: typeof row.startLine === "number" ? row.startLine : 0,
    endLine: typeof row.endLine === "number" ? row.endLine : 0,
    snippet: snippet(String(row.text ?? ""), query, snippetChars),
    score: candidate.score,
    sources: candidate.sources
  }
}

const isoDate = (ts: unknown): string =>
  typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : ""

export const rerankDoc = (candidate: Candidate): string => {
  const row = candidate.row
  const source = String(row.source ?? "code")
  const text = String(row.text ?? "")
  if (source === "history") {
    const sha = String(row.sha ?? "").slice(0, 7)
    return `[commit ${sha} ${isoDate(row.committedAt)} ${String(row.author ?? "")}]\n${text}`
  }
  if (source === "conversation") {
    return `[conversation ${isoDate(row.ts)} ${String(row.role ?? "")}]\n${text}`
  }
  return `${String(row.path ?? "")}\n\n${text}`
}

export const locationOf = (hit: SearchHit): string => {
  if (hit.source === "history") return hit.path
  if (hit.source === "conversation") return hit.path
  return hit.startLine && hit.endLine ? `${hit.path}:${hit.startLine}-${hit.endLine}` : hit.path
}

export const formatHits = (
  query: string,
  hits: ReadonlyArray<SearchHit>,
  maxBytes: number
): string => {
  if (hits.length === 0) {
    return `No indexed results for ${JSON.stringify(query)}. The index may still be warming.`
  }
  const lines = [`Results for ${JSON.stringify(query)} (live code is authoritative; history/conversation are context):`]
  let bytes = lines[0]!.length
  for (let i = 0; i < hits.length; i += 1) {
    const hit = hits[i]!
    const tag = hit.source === "code" ? "" : `[${hit.source}] `
    const decl = [hit.kind, hit.symbol].filter((part) => part && part !== "code").join(" ").trim()
    const label = decl ? `  ${decl}` : ""
    const block = `\n${i + 1}. ${tag}${locationOf(hit)}${label} [${hit.sources.join("+")}; ${hit.score.toFixed(4)}]\n${hit.snippet}`
    bytes += block.length
    if (bytes > maxBytes) break
    lines.push(block)
  }
  return lines.join("\n")
}

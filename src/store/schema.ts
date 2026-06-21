import { Schema } from "effect"
import type { Chunk } from "../domain/types.ts"

export interface UpsertRow {
  readonly id: string
  readonly vector: ReadonlyArray<number>
  readonly text: string
  readonly pathText: string
  readonly path: string
  readonly language: string
  readonly kind: string
  readonly startLine: number
  readonly endLine: number
  readonly fileHash: string
  readonly chunkHash: string
}

export const pathText = (path: string): string => path.replace(/[/_.-]+/g, " ").trim()

export const rowFromChunk = (chunk: Chunk, vector: ReadonlyArray<number>): UpsertRow => ({
  id: chunk.id,
  vector,
  text: chunk.rawText,
  pathText: pathText(chunk.path),
  path: chunk.path,
  language: chunk.language,
  kind: chunk.kind,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  fileHash: chunk.fileHash,
  chunkHash: chunk.contentHash
})

export const buildSchema = (dimensions: number): Record<string, unknown> => ({
  vector: { type: `[${dimensions}]f32`, ann: true },
  text: { type: "string", full_text_search: { stemming: false, remove_stopwords: false }, filterable: false },
  pathText: { type: "string", full_text_search: { stemming: false, remove_stopwords: false } },
  path: { type: "string", glob: true, filterable: true },
  language: { type: "string", filterable: true },
  kind: { type: "string", filterable: true },
  startLine: { type: "uint", filterable: false },
  endLine: { type: "uint", filterable: false },
  fileHash: { type: "string", filterable: true },
  chunkHash: { type: "string", filterable: false }
})

export type RankBy =
  | readonly ["vector", "ANN", ReadonlyArray<number>]
  | readonly [string, "BM25", string]
  | readonly [string, "asc" | "desc"]

export interface SubQuery {
  readonly rank_by: RankBy
  readonly top_k: number
  readonly filters?: unknown
  readonly include_attributes?: ReadonlyArray<string>
}

export interface MultiQueryBody {
  readonly consistency?: { readonly level: "strong" | "eventual" }
  readonly queries: ReadonlyArray<SubQuery>
  readonly rerank_by?: readonly [string, { readonly rank_constant: number }]
}

export const TpufRow = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  "$dist": Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  pathText: Schema.optional(Schema.String),
  language: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  startLine: Schema.optional(Schema.Number),
  endLine: Schema.optional(Schema.Number)
})

export type TpufRow = typeof TpufRow.Type

export class MultiQueryResponse extends Schema.Class<MultiQueryResponse>("MultiQueryResponse")({
  results: Schema.Array(Schema.Struct({ rows: Schema.optional(Schema.Array(TpufRow)) }))
}) {}

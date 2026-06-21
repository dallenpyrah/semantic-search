export type ChunkKind = "code" | "docs" | "config" | "test"

export type SourceType = "code" | "docs" | "history" | "conversation"

export const ALL_SOURCES: ReadonlyArray<SourceType> = ["code", "docs", "history", "conversation"]

export interface Chunk {
  readonly id: string
  readonly source: SourceType
  readonly path: string
  readonly language: string
  readonly kind: ChunkKind
  readonly symbol: string
  readonly startLine: number
  readonly endLine: number
  readonly startByte: number
  readonly endByte: number
  readonly rawText: string
  readonly embedText: string
  readonly contentHash: string
  readonly fileHash: string
}

export interface SearchHit {
  readonly id: string
  readonly source: string
  readonly path: string
  readonly language: string
  readonly kind: string
  readonly startLine: number
  readonly endLine: number
  readonly snippet: string
  readonly score: number
  readonly sources: ReadonlyArray<string>
}

export interface SearchResult {
  readonly query: string
  readonly mode: SearchMode
  readonly namespace: string
  readonly hits: ReadonlyArray<SearchHit>
  readonly candidates: number
  readonly reranked: boolean
  readonly tookMs: number
}

export type SearchMode = "semantic" | "hybrid"

export interface SearchOptions {
  readonly limit: number
  readonly pathPrefix?: string
  readonly language?: string
  readonly kind?: ChunkKind
  readonly source?: ReadonlyArray<SourceType>
  readonly rerank?: boolean
  readonly perFile?: number
}

export interface IndexStats {
  readonly namespace: string
  readonly root: string
  readonly files: number
  readonly chunks: number
}

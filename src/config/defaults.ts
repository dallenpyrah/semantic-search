import { DEFAULT_INCLUDE_EXTENSIONS } from "../chunk/language.ts"

export interface IndexingConfig {
  readonly maxFileBytes: number
  readonly chunkTargetChars: number
  readonly chunkMaxChars: number
  readonly chunkMinChars: number
  readonly embedTokenCap: number
  readonly embedBatch: number
  readonly embedConcurrency: number
  readonly upsertConcurrency: number
  readonly upsertBatch: number
  readonly vectorCacheEnabled: boolean
  readonly debounceMs: number
  readonly maxQueueSize: number
  readonly scanConcurrency: number
  readonly historyEnabled: boolean
  readonly historyMaxCommits: number
  readonly conversationEnabled: boolean
  readonly conversationMaxSessions: number
  readonly includeExtensions: ReadonlyArray<string>
  readonly includeDirs: ReadonlyArray<string>
  readonly excludeDirs: ReadonlyArray<string>
  readonly excludeFiles: ReadonlyArray<string>
  readonly excludePathPatterns: ReadonlyArray<string>
}

export interface EmbeddingConfig {
  readonly provider: "openrouter" | "openai"
  readonly model: string
  readonly dimensions: number
  readonly baseUrl?: string
}

export interface StoreConfig {
  readonly region: string
  readonly baseUrl?: string
  readonly namespacePrefix: string
  readonly consistency: "strong" | "eventual"
}

export interface RerankConfig {
  readonly provider: "auto" | "openrouter-cohere" | "openrouter-free" | "none"
  readonly model: string
  readonly freeModel: string
  readonly baseUrl: string
  readonly poolMultiplier: number
}

export interface SearchDefaults {
  readonly limit: number
  readonly maxLimit: number
  readonly candidateMultiplier: number
  readonly minCandidates: number
  readonly perFile: number
  readonly snippetChars: number
  readonly maxOutputBytes: number
  readonly rankConstant: number
}

export interface Settings {
  readonly embedding: EmbeddingConfig
  readonly store: StoreConfig
  readonly rerank: RerankConfig
  readonly indexing: IndexingConfig
  readonly search: SearchDefaults
}

export interface SettingsOverride {
  readonly embedding?: Partial<EmbeddingConfig>
  readonly store?: Partial<StoreConfig>
  readonly rerank?: Partial<RerankConfig>
  readonly indexing?: Partial<IndexingConfig>
  readonly search?: Partial<SearchDefaults>
}

export const SCHEMA_VERSION = "v2"

export const defaultSettings: Settings = {
  embedding: {
    provider: "openrouter",
    model: "text-embedding-3-large",
    dimensions: 1536
  },
  store: {
    region: "gcp-us-central1",
    namespacePrefix: "pisem",
    consistency: "strong"
  },
  rerank: {
    provider: "auto",
    model: "cohere/rerank-v3.5",
    freeModel: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
    baseUrl: "https://openrouter.ai/api/v1",
    poolMultiplier: 4
  },
  indexing: {
    maxFileBytes: 1_000_000,
    chunkTargetChars: 1200,
    chunkMaxChars: 1600,
    chunkMinChars: 80,
    embedTokenCap: 8000,
    embedBatch: 128,
    embedConcurrency: 10,
    upsertConcurrency: 4,
    upsertBatch: 256,
    vectorCacheEnabled: true,
    debounceMs: 400,
    maxQueueSize: 4096,
    scanConcurrency: 16,
    historyEnabled: true,
    historyMaxCommits: 2000,
    conversationEnabled: false,
    conversationMaxSessions: 40,
    includeExtensions: DEFAULT_INCLUDE_EXTENSIONS,
    includeDirs: [],
    excludeDirs: [
      ".git",
      ".hg",
      ".svn",
      "node_modules",
      "bower_components",
      "vendor",
      "third_party",
      "dist",
      "build",
      "out",
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".angular",
      ".vite",
      ".parcel-cache",
      "coverage",
      ".turbo",
      ".cache",
      ".context",
      "logs",
      ".logs",
      ".venv",
      "venv",
      "__pycache__",
      "__snapshots__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".gradle",
      "target",
      "tmp",
      "temp",
      ".pnpm-store",
      ".yarn",
      ".bun",
      "repos",
      "subagent-reports"
    ],
    excludeFiles: [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "deno.lock",
      "cargo.lock",
      "poetry.lock",
      "pipfile.lock",
      "uv.lock",
      "go.sum",
      "gemfile.lock",
      "composer.lock"
    ],
    excludePathPatterns: [
      "**/*.min.js",
      "**/*.min.css",
      "**/*.map",
      "**/*.snap",
      "**/*.lock"
    ]
  },
  search: {
    limit: 8,
    maxLimit: 25,
    candidateMultiplier: 6,
    minCandidates: 40,
    perFile: 3,
    snippetChars: 900,
    maxOutputBytes: 24_000,
    rankConstant: 60
  }
}

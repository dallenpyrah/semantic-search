import type { SearchMode } from "../src/domain/types.ts"

export interface GoldCase {
  readonly query: string
  readonly mode: SearchMode
  readonly expected: ReadonlyArray<string>
}

export const goldSet: ReadonlyArray<GoldCase> = [
  { query: "where do we split source code into chunks", mode: "semantic", expected: ["src/chunk/structural.ts"] },
  { query: "how are text embeddings batched and retried", mode: "semantic", expected: ["src/embedding/Embeddings.ts"] },
  { query: "turbopuffer hybrid multi query request", mode: "semantic", expected: ["src/store/Turbopuffer.ts"] },
  { query: "reciprocal rank fusion of search results", mode: "semantic", expected: ["src/search/fuse.ts"] },
  { query: "watch the filesystem for changes and debounce", mode: "semantic", expected: ["src/watch/Watcher.ts"] },
  { query: "incremental index manifest persisted to disk", mode: "semantic", expected: ["src/index/Manifest.ts"] },
  { query: "reranker that falls back gracefully without an api key", mode: "semantic", expected: ["src/rerank/Reranker.ts"] },
  { query: "decide which files and directories to ignore", mode: "semantic", expected: ["src/index/ignore.ts"] },
  { query: "resolve configuration from environment and json files", mode: "semantic", expected: ["src/config/AppConfig.ts"] },
  { query: "descriptions for the agent search tools", mode: "semantic", expected: ["src/pi/tools.ts"] },
  { query: "pi extension session start and shutdown lifecycle", mode: "semantic", expected: ["src/pi/extension.ts"] },
  { query: "command line interface subcommands for search and index", mode: "semantic", expected: ["src/cli/main.ts"] },
  { query: "detect the programming language from a file extension", mode: "semantic", expected: ["src/chunk/language.ts"] },
  { query: "default excluded directories and chunk size settings", mode: "semantic", expected: ["src/config/defaults.ts"] },
  { query: "content addressed hashing for chunk identity", mode: "semantic", expected: ["src/domain/hash.ts"] },
  { query: "tagged error types for the domain", mode: "semantic", expected: ["src/domain/errors.ts"] },
  { query: "compose all the service layers into one runtime", mode: "semantic", expected: ["src/runtime/layers.ts"] },
  { query: "the indexer that embeds and upserts changed chunks", mode: "semantic", expected: ["src/index/Indexer.ts"] },
  { query: "build the turbopuffer schema for code chunks", mode: "semantic", expected: ["src/store/schema.ts"] },
  { query: "run a search and format the ranked hits", mode: "semantic", expected: ["src/search/Search.ts"] },

  { query: "chunkSource", mode: "hybrid", expected: ["src/chunk/structural.ts"] },
  { query: "OpenAiEmbeddingModel", mode: "hybrid", expected: ["src/embedding/Embeddings.ts"] },
  { query: "delete_by_filter", mode: "hybrid", expected: ["src/store/Turbopuffer.ts"] },
  { query: "groupedWithin debounce", mode: "hybrid", expected: ["src/watch/Watcher.ts"] },
  { query: "shouldIndexFile", mode: "hybrid", expected: ["src/index/ignore.ts"] },
  { query: "Schema.TaggedErrorClass", mode: "hybrid", expected: ["src/domain/errors.ts"] },
  { query: "rowFromChunk", mode: "hybrid", expected: ["src/store/schema.ts"] },
  { query: "requireKey openrouter", mode: "hybrid", expected: ["src/config/AppConfig.ts", "src/rerank/Reranker.ts"] },
  { query: "diversify per file limit", mode: "hybrid", expected: ["src/search/fuse.ts"] },
  { query: "code_search code_grep tool", mode: "hybrid", expected: ["src/pi/tools.ts"] }
]

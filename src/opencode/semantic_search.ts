import { tool } from "@opencode-ai/plugin"
import { Effect, Fiber, ManagedRuntime } from "effect"
import { basename, resolve } from "node:path"
import { AppConfig } from "../config/AppConfig.ts"
import { CommitIndexer } from "../index/CommitIndexer.ts"
import { ConversationIndexer } from "../index/ConversationIndexer.ts"
import { GitHistory } from "../index/GitHistory.ts"
import { Indexer } from "../index/Indexer.ts"
import { Search } from "../search/Search.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { Watcher } from "../watch/Watcher.ts"
import { type AppError, type AppServices, appLayer, configLayer } from "../runtime/layers.ts"
import { type SearchMode, type SearchOptions, type SourceType } from "../domain/types.ts"
import { semanticSearchTool } from "../pi/tools.ts"

interface SearchParams {
  readonly query?: string
  readonly queries?: ReadonlyArray<string>
  readonly mode?: SearchMode
  readonly source?: ReadonlyArray<SourceType>
  readonly file?: string
  readonly lines?: string
  readonly limit?: number
  readonly pathPrefix?: string
  readonly language?: string
}

type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppError>

interface RuntimeState {
  readonly root: string
  readonly enabled: boolean
  readonly namespace: string
  readonly projectName: string
  readonly disabledReason: string
  readonly runtime?: AppRuntime
  readonly fibers: ReadonlyArray<Fiber.Fiber<unknown, unknown>>
}

const runtimes = new Map<string, Promise<RuntimeState>>()

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const toOptions = (params: SearchParams, source?: ReadonlyArray<SourceType>): SearchOptions => ({
  limit: typeof params.limit === "number" ? params.limit : 8,
  pathPrefix: params.pathPrefix?.trim() ? params.pathPrefix.trim() : undefined,
  language: params.language?.trim() ? params.language.trim() : undefined,
  source
})

const facetsOf = (params: SearchParams): ReadonlyArray<string> => {
  const fromArray = (params.queries ?? []).map((q) => q.trim()).filter(Boolean)
  if (fromArray.length > 0) return fromArray
  const single = params.query?.trim()
  return single ? [single] : []
}

const startRuntime = async (root: string): Promise<RuntimeState> => {
  const probe = await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* AppConfig
      return { missing: config.missingRequired, namespace: config.namespace }
    }).pipe(Effect.provide(configLayer({ root, trusted: true })))
  ).catch(() => ({ missing: ["configuration"], namespace: "" }))

  if (probe.missing.length > 0) {
    return {
      root,
      enabled: false,
      namespace: probe.namespace,
      projectName: basename(root),
      disabledReason: `code search disabled; set ${probe.missing.join(", ")}`,
      fibers: []
    }
  }

  const runtime = ManagedRuntime.make(appLayer({ root, trusted: true }))
  const supervised = (name: string, effect: Effect.Effect<unknown, never, AppServices>) =>
    runtime.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(`semantic-search: ${name} fiber failed`, cause))))

  const fibers = [
    supervised(
      "warm",
      Effect.gen(function* () {
        const store = yield* Turbopuffer
        yield* store.warm()
      })
    ),
    supervised(
      "watch",
      Effect.gen(function* () {
        const watcher = yield* Watcher
        yield* Effect.scoped(watcher.run())
      })
    ),
    supervised(
      "index",
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.indexAll()
        const commits = yield* CommitIndexer
        yield* commits.run()
        const conversations = yield* ConversationIndexer
        yield* conversations.run()
      })
    )
  ]

  return { root, enabled: true, namespace: probe.namespace, projectName: basename(root), disabledReason: "", runtime, fibers }
}

const runtimeFor = (root: string): Promise<RuntimeState> => {
  const resolved = resolve(root)
  const existing = runtimes.get(resolved)
  if (existing) return existing
  const started = startRuntime(resolved)
  runtimes.set(resolved, started)
  return started
}

const runSearch = async (state: RuntimeState, params: SearchParams, signal: AbortSignal) => {
  if (!state.runtime || !state.enabled) return { output: state.disabledReason, metadata: { enabled: false } }
  const facets = facetsOf(params)
  if (facets.length === 0) return { output: "query or queries is required", metadata: { enabled: true, error: "missing query" } }
  const mode: SearchMode = params.mode === "semantic" ? "semantic" : "hybrid"

  try {
    const { value, formatted } = await state.runtime.runPromise(
      Effect.gen(function* () {
        const search = yield* Search
        const value = yield* search.search(mode, facets, toOptions(params, params.source))
        return { value, formatted: search.formatted(value) }
      }),
      { signal }
    )
    return {
      title: `semantic_search: ${facets.join(" | ")}`,
      output: formatted,
      metadata: {
        namespace: value.namespace,
        mode: value.mode,
        returned: value.hits.length,
        candidates: value.candidates,
        reranked: value.reranked,
        tookMs: value.tookMs,
        hits: value.hits.map((hit) => ({
          path: hit.path,
          startLine: hit.startLine,
          endLine: hit.endLine,
          score: hit.score,
          sources: hit.sources
        }))
      }
    }
  } catch (error) {
    return { output: `code search failed: ${messageOf(error)}`, metadata: { enabled: true, error: messageOf(error) } }
  }
}

const runFileHistory = async (state: RuntimeState, params: SearchParams, signal: AbortSignal) => {
  if (!state.runtime || !state.enabled) return { output: state.disabledReason, metadata: { enabled: false } }
  const file = params.file?.trim()
  if (!file) return { output: "file is required", metadata: { enabled: true, error: "missing file" } }
  try {
    const output = await state.runtime.runPromise(
      Effect.gen(function* () {
        const history = yield* GitHistory
        return yield* history.fileLog(file, { lines: params.lines, limit: params.limit })
      }),
      { signal }
    )
    return { title: `semantic_search history: ${file}`, output, metadata: { source: "history", file, lines: params.lines ?? null } }
  } catch (error) {
    return { output: `git history failed: ${messageOf(error)}`, metadata: { enabled: true, error: messageOf(error) } }
  }
}

export default tool({
  description: semanticSearchTool.description,
  args: {
    query: tool.schema.string().optional().describe("Natural-language description or symbol/string to find."),
    queries: tool.schema
      .array(tool.schema.string())
      .min(2)
      .max(5)
      .optional()
      .describe("2-5 distinct facets to retrieve and merge in one parallel call."),
    mode: tool.schema.enum(["hybrid", "semantic"]).optional().describe("hybrid uses semantic + exact-token search; semantic is meaning-only."),
    source: tool.schema
      .array(tool.schema.enum(["code", "docs", "history", "conversation"]))
      .optional()
      .describe("Force sources to search: code, docs, history, conversation."),
    file: tool.schema.string().optional().describe("Repository-relative file path for actual commit messages and diffs that changed it."),
    lines: tool.schema.string().optional().describe("Optional line range like 40-80 to scope file history."),
    limit: tool.schema.number().int().min(1).max(30).optional().describe("Maximum ranked results, default 8."),
    pathPrefix: tool.schema.string().optional().describe("Restrict to a repository-relative directory prefix."),
    language: tool.schema.string().optional().describe("Restrict to a language, e.g. typescript, python, go, rust, markdown.")
  },
  async execute(args, context) {
    const root = context.worktree || context.directory
    const state = await runtimeFor(root)
    context.metadata({ title: state.enabled ? `Semantic Search: ${state.projectName}` : "Semantic Search Disabled", metadata: { namespace: state.namespace } })
    return args.file?.trim() ? runFileHistory(state, args, context.abort) : runSearch(state, args, context.abort)
  }
})

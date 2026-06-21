import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Effect, Fiber, ManagedRuntime } from "effect"
import { Type } from "typebox"
import { basename } from "node:path"
import { AppConfig } from "../config/AppConfig.ts"
import { CommitIndexer } from "../index/CommitIndexer.ts"
import { ConversationIndexer } from "../index/ConversationIndexer.ts"
import { GitHistory } from "../index/GitHistory.ts"
import { Indexer } from "../index/Indexer.ts"
import { Search } from "../search/Search.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { Watcher } from "../watch/Watcher.ts"
import { type AppError, type AppServices, appLayer, configLayer } from "../runtime/layers.ts"
import { ALL_SOURCES, type SearchMode, type SearchOptions, type SourceType } from "../domain/types.ts"
import { semanticSearchTool } from "./tools.ts"

const searchParameters = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Natural-language description or symbol/string to find — the code, behavior, concept, or error you want"
    })
  ),
  queries: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 2,
      maxItems: 5,
      description:
        "2-5 DISTINCT facets to retrieve and merge in one parallel call (use instead of query for multi-faceted tasks)"
    })
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("hybrid"), Type.Literal("semantic")], {
      description: "'hybrid' (default; semantic + exact-token) or 'semantic' (meaning only, fastest)"
    })
  ),
  source: Type.Optional(
    Type.Array(Type.Union(ALL_SOURCES.map((s) => Type.Literal(s))), {
      description: "Force which sources to search: code, docs, history (git commits), conversation. Omit for smart default."
    })
  ),
  file: Type.Optional(
    Type.String({ description: "Repository-relative file path: returns the actual commit messages and diffs that changed it" })
  ),
  lines: Type.Optional(
    Type.String({ description: "Optional line range like 40-80 to scope the file's change history" })
  ),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 30, description: "Maximum ranked results (default 8)" })
  ),
  pathPrefix: Type.Optional(
    Type.String({ description: "Restrict to a repository-relative directory prefix, e.g. packages/api" })
  ),
  language: Type.Optional(
    Type.String({ description: "Restrict to a language, e.g. typescript, python, go, rust, markdown" })
  )
})

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

interface ToolResult {
  content: Array<{ type: "text"; text: string }>
  details: Record<string, unknown>
}

type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppError>

interface RuntimeState {
  readonly enabled: boolean
  readonly namespace: string
  readonly projectName: string
  readonly disabledReason: string
}

const textResult = (text: string, details: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  details
})

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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export default function semanticSearchExtension(pi: ExtensionAPI) {
  let runtime: AppRuntime | undefined
  let fibers: Array<Fiber.Fiber<unknown, unknown>> = []
  let state: RuntimeState = {
    enabled: false,
    namespace: "",
    projectName: "",
    disabledReason: "code search index not started"
  }

  const stop = async () => {
    const current = runtime
    const running = fibers
    runtime = undefined
    fibers = []
    if (current) {
      for (const fiber of running) {
        await current.runPromise(Fiber.interrupt(fiber)).catch(() => {})
      }
      await current.dispose().catch(() => {})
    }
  }

  const start = async (cwd: string, trusted: boolean) => {
    await stop()
    const probe = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* AppConfig
        return { missing: config.missingRequired, namespace: config.namespace }
      }).pipe(Effect.provide(configLayer({ root: cwd, trusted })))
    ).catch(() => ({ missing: ["configuration"], namespace: "" }))

    if (probe.missing.length > 0) {
      state = {
        enabled: false,
        namespace: probe.namespace,
        projectName: basename(cwd),
        disabledReason: `code search disabled; set ${probe.missing.join(", ")}`
      }
      return
    }

    const rt = ManagedRuntime.make(appLayer({ root: cwd, trusted }))
    runtime = rt
    state = { enabled: true, namespace: probe.namespace, projectName: basename(cwd), disabledReason: "" }
    const supervised = (name: string, effect: Effect.Effect<unknown, never, AppServices>) =>
      rt.runFork(effect.pipe(Effect.tapCause((cause) => Effect.logError(`semantic-search: ${name} fiber failed`, cause))))
    fibers = [
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
  }

  const runSearch = async (
    params: SearchParams,
    signal: AbortSignal | undefined
  ): Promise<ToolResult> => {
    const rt = runtime
    if (!rt || !state.enabled) return textResult(state.disabledReason, { enabled: false })
    const facets = facetsOf(params)
    if (facets.length === 0) return textResult("query or queries is required", { enabled: true, error: "missing query" })
    const mode: SearchMode = params.mode === "semantic" ? "semantic" : "hybrid"
    const program = Effect.gen(function* () {
      const search = yield* Search
      const options = toOptions(params, params.source)
      const value = yield* search.search(mode, facets, options)
      return { value, formatted: search.formatted(value) }
    })
    try {
      const { value, formatted } = await rt.runPromise(program, signal ? { signal } : undefined)
      return textResult(formatted, {
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
      })
    } catch (error) {
      return textResult(`code search failed: ${messageOf(error)}`, {
        enabled: true,
        error: messageOf(error)
      })
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx.cwd, ctx.isProjectTrusted())
    if (!ctx.hasUI) return
    if (state.enabled) {
      ctx.ui.notify(`code search ready for ${state.projectName}`, "info")
    } else {
      ctx.ui.notify(state.disabledReason, "warning")
    }
  })

  pi.on("session_shutdown", async () => {
    await stop()
  })

  const runFileHistory = async (params: SearchParams, signal: AbortSignal | undefined): Promise<ToolResult> => {
    const rt = runtime
    if (!rt || !state.enabled) return textResult(state.disabledReason, { enabled: false })
    const file = params.file?.trim()
    if (!file) return textResult("file is required", { enabled: true, error: "missing file" })
    try {
      const text = await rt.runPromise(
        Effect.gen(function* () {
          const history = yield* GitHistory
          return yield* history.fileLog(file, { lines: params.lines, limit: params.limit })
        }),
        signal ? { signal } : undefined
      )
      return textResult(text, { source: "history", file, lines: params.lines ?? null })
    } catch (error) {
      return textResult(`git history failed: ${messageOf(error)}`, { enabled: true, error: messageOf(error) })
    }
  }

  pi.registerTool({
    ...semanticSearchTool,
    parameters: searchParameters,
    execute: (_toolCallId: string, params: SearchParams, signal?: AbortSignal) =>
      params.file?.trim() ? runFileHistory(params, signal) : runSearch(params, signal)
  })
}

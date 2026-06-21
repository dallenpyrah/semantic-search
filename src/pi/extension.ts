import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Effect, Fiber, ManagedRuntime } from "effect"
import { Type } from "typebox"
import { basename } from "node:path"
import { AppConfig } from "../config/AppConfig.ts"
import { Indexer } from "../index/Indexer.ts"
import { Search } from "../search/Search.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { Watcher } from "../watch/Watcher.ts"
import { type AppError, type AppServices, appLayer, configLayer } from "../runtime/layers.ts"
import type { SearchMode, SearchOptions } from "../domain/types.ts"
import { codeGrepTool, codeSearchTool } from "./tools.ts"

const searchParameters = Type.Object({
  query: Type.String({
    description:
      "Natural-language description of the code, behavior, concept, symbol, or error you are looking for"
  }),
  limit: Type.Optional(
    Type.Number({ minimum: 1, maximum: 25, description: "Maximum ranked snippets to return (default 8)" })
  ),
  pathPrefix: Type.Optional(
    Type.String({ description: "Restrict to a repository-relative directory prefix, e.g. packages/api" })
  ),
  language: Type.Optional(
    Type.String({ description: "Restrict to a language, e.g. typescript, python, go, rust, markdown" })
  )
})

interface SearchParams {
  readonly query: string
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

const toOptions = (params: SearchParams, rerank: boolean): SearchOptions => ({
  limit: typeof params.limit === "number" ? params.limit : 8,
  pathPrefix: params.pathPrefix?.trim() ? params.pathPrefix.trim() : undefined,
  language: params.language?.trim() ? params.language.trim() : undefined,
  rerank
})

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
    fibers = [
      rt.runFork(
        Effect.gen(function* () {
          const store = yield* Turbopuffer
          yield* store.warm()
        })
      ),
      rt.runFork(
        Effect.gen(function* () {
          const watcher = yield* Watcher
          yield* Effect.scoped(watcher.run())
        })
      ),
      rt.runFork(
        Effect.gen(function* () {
          const indexer = yield* Indexer
          yield* indexer.indexAll()
        })
      )
    ]
  }

  const runSearch = async (
    mode: SearchMode,
    params: SearchParams,
    signal: AbortSignal | undefined
  ): Promise<ToolResult> => {
    const rt = runtime
    if (!rt || !state.enabled) return textResult(state.disabledReason, { enabled: false })
    const query = params.query?.trim()
    if (!query) return textResult("query is required", { enabled: true, error: "missing query" })
    const rerank = mode === "hybrid"
    const program = Effect.gen(function* () {
      const search = yield* Search
      const options = toOptions({ ...params, query }, rerank)
      const value = mode === "semantic"
        ? yield* search.semantic(query, options)
        : yield* search.hybrid(query, options)
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

  pi.registerTool({
    ...codeSearchTool,
    parameters: searchParameters,
    execute: (_toolCallId: string, params: SearchParams, signal?: AbortSignal) =>
      runSearch("semantic", params, signal)
  })

  pi.registerTool({
    ...codeGrepTool,
    parameters: searchParameters,
    execute: (_toolCallId: string, params: SearchParams, signal?: AbortSignal) =>
      runSearch("hybrid", params, signal)
  })
}

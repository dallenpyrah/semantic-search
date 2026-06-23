import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { ALL_SOURCES, type SearchMode, type SearchOptions, type SourceType } from "../domain/types.ts"
import { GitHistory } from "../index/GitHistory.ts"
import { runtimeFor, stopRuntime } from "../opencode/runtime.ts"
import { semanticSearchTool } from "../pi/tools.ts"
import { Search } from "../search/Search.ts"

interface PluginLogger {
  log: (...args: ReadonlyArray<unknown>) => void
}

interface PluginUI {
  notify: (message: string) => Promise<void>
}

interface PluginCommandContext {
  readonly ui: PluginUI
}

interface PluginToolContext {
  readonly logger: PluginLogger
}

interface PluginCommandOptions {
  readonly title: string
  readonly category?: string
  readonly description?: string
}

interface PluginToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: {
    readonly type: "object"
    readonly properties?: Record<string, unknown>
    readonly required?: ReadonlyArray<string>
    readonly [key: string]: unknown
  }
  readonly execute: (input: Record<string, unknown>, ctx: PluginToolContext) => Promise<string | void>
}

interface PluginAPI {
  readonly logger: PluginLogger
  on: (event: "session.start", handler: () => Promise<void> | void) => unknown
  registerCommand: (
    id: string,
    options: PluginCommandOptions,
    handler: (ctx: PluginCommandContext) => Promise<void> | void
  ) => unknown
  registerTool: (definition: PluginToolDefinition) => unknown
}

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

const sourceSet = new Set<string>(ALL_SOURCES)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const rootCandidate = (): string => {
  if (process.env.SEMANTIC_SEARCH_ROOT?.trim()) return resolve(process.env.SEMANTIC_SEARCH_ROOT.trim())
  if (process.env.PWD?.trim()) return resolve(process.env.PWD.trim())
  return process.cwd()
}

const projectRoot = (): string => {
  const cwd = rootCandidate()
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim()
  } catch {
    return cwd
  }
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined

const stringArrayValue = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  return strings.length > 0 ? strings : undefined
}

const sourceArrayValue = (value: unknown): ReadonlyArray<SourceType> | undefined => {
  if (!Array.isArray(value)) return undefined
  const sources = value.filter((item): item is SourceType => typeof item === "string" && sourceSet.has(item))
  return sources.length > 0 ? sources : undefined
}

const limitValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(30, Math.floor(value))) : undefined

const paramsOf = (input: Record<string, unknown>): SearchParams => ({
  query: stringValue(input.query),
  queries: stringArrayValue(input.queries),
  mode: input.mode === "semantic" ? "semantic" : input.mode === "hybrid" ? "hybrid" : undefined,
  source: sourceArrayValue(input.source),
  file: stringValue(input.file),
  lines: stringValue(input.lines),
  limit: limitValue(input.limit),
  pathPrefix: stringValue(input.pathPrefix),
  language: stringValue(input.language)
})

const toOptions = (params: SearchParams): SearchOptions => ({
  limit: params.limit ?? 8,
  pathPrefix: params.pathPrefix?.trim() ? params.pathPrefix.trim() : undefined,
  language: params.language?.trim() ? params.language.trim() : undefined,
  source: params.source
})

const facetsOf = (params: SearchParams): ReadonlyArray<string> => {
  const fromArray = (params.queries ?? []).map((query) => query.trim()).filter(Boolean)
  if (fromArray.length > 0) return fromArray
  const single = params.query?.trim()
  return single ? [single] : []
}

const statsLine = (parts: ReadonlyArray<string>): string => `\n\n[semantic_search: ${parts.join(" · ")}]`

export default function semanticSearchAmpPlugin(amp: PluginAPI) {
  const root = projectRoot()
  let started: Promise<void> | undefined

  const start = async () => {
    const state = await runtimeFor(root)
    amp.logger.log(
      state.enabled
        ? `semantic-search: indexer started for ${state.root} (${state.namespace})`
        : `semantic-search: ${state.disabledReason}`
    )
  }

  const ensureStarted = () => {
    started ??= start().catch((error) => {
      started = undefined
      throw error
    })
    return started
  }

  amp.on("session.start", async () => {
    await ensureStarted().catch((error) => {
      amp.logger.log("semantic-search: failed to start", error)
    })
  })

  amp.registerCommand(
    "semantic-search-status",
    {
      title: "Semantic Search Status",
      category: "semantic-search",
      description: "Show whether the semantic-search Amp plugin is indexed and ready."
    },
    async (ctx) => {
      const state = await runtimeFor(root)
      await ctx.ui.notify(
        state.enabled
          ? `Semantic search is enabled for ${state.projectName}. Namespace: ${state.namespace}`
          : state.disabledReason
      )
    }
  )

  amp.registerCommand(
    "semantic-search-stop",
    {
      title: "Semantic Search Stop",
      category: "semantic-search",
      description: "Stop the semantic-search indexer/watcher for this Amp plugin process."
    },
    async (ctx) => {
      await stopRuntime(root)
      started = undefined
      await ctx.ui.notify("Semantic search stopped. It will restart on the next search or session start.")
    }
  )

  amp.registerCommand(
    "semantic-search-restart",
    {
      title: "Semantic Search Restart",
      category: "semantic-search",
      description: "Restart the semantic-search indexer/watcher for this repository."
    },
    async (ctx) => {
      await stopRuntime(root)
      started = undefined
      await ensureStarted()
      const state = await runtimeFor(root)
      await ctx.ui.notify(
        state.enabled
          ? `Semantic search restarted for ${state.projectName}. Namespace: ${state.namespace}`
          : state.disabledReason
      )
    }
  )

  amp.registerTool({
    name: semanticSearchTool.name,
    description: semanticSearchTool.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Natural-language description or symbol/string to find."
        },
        queries: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          items: { type: "string" },
          description: "2-5 distinct facets to retrieve and merge in one parallel call."
        },
        mode: {
          type: "string",
          enum: ["hybrid", "semantic"],
          description: "hybrid uses semantic + exact-token search; semantic is meaning-only."
        },
        source: {
          type: "array",
          items: { type: "string", enum: ALL_SOURCES },
          description: "Force sources to search: code, docs, history, conversation."
        },
        file: {
          type: "string",
          description: "Repository-relative file path for actual commit messages and diffs that changed it."
        },
        lines: {
          type: "string",
          description: "Optional line range like 40-80 to scope file history."
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 30,
          description: "Maximum ranked results, default 8."
        },
        pathPrefix: {
          type: "string",
          description: "Restrict to a repository-relative directory prefix."
        },
        language: {
          type: "string",
          description: "Restrict to a language, e.g. typescript, python, go, rust, markdown."
        }
      },
      required: []
    },
    async execute(input, ctx) {
      await ensureStarted()
      const params = paramsOf(input)
      const state = await runtimeFor(root)
      if (!state.runtime || !state.enabled) return state.disabledReason

      const file = params.file?.trim()
      if (file) {
        try {
          const output = await state.runtime.runPromise(
            Effect.gen(function* () {
              const history = yield* GitHistory
              return yield* history.fileLog(file, { lines: params.lines, limit: params.limit })
            })
          )
          return `${output}${statsLine([`file=${file}`, `namespace=${state.namespace}`])}`
        } catch (error) {
          ctx.logger.log("semantic-search history failed", error)
          return `git history failed: ${messageOf(error)}`
        }
      }

      const facets = facetsOf(params)
      if (facets.length === 0) return "query or queries is required"
      const mode: SearchMode = params.mode === "semantic" ? "semantic" : "hybrid"

      try {
        const { value, formatted } = await state.runtime.runPromise(
          Effect.gen(function* () {
            const search = yield* Search
            const value = yield* search.search(mode, facets, toOptions(params))
            return { value, formatted: search.formatted(value) }
          })
        )
        return `${formatted}${statsLine([
          `${value.candidates} candidates`,
          value.reranked ? "reranked" : "fused",
          `${value.tookMs}ms`,
          `namespace=${value.namespace}`
        ])}`
      } catch (error) {
        ctx.logger.log("semantic-search failed", error)
        return `code search failed: ${messageOf(error)}`
      }
    }
  })
}

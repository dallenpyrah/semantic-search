#!/usr/bin/env bun
import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { resolve } from "node:path"
import { AppConfig } from "../config/AppConfig.ts"
import { Indexer } from "../index/Indexer.ts"
import { Search } from "../search/Search.ts"
import { Watcher } from "../watch/Watcher.ts"
import { appLayer, configLayer } from "../runtime/layers.ts"
import type { SearchMode, SearchResult } from "../domain/types.ts"

const provideApp = <A, E>(root: string, effect: Effect.Effect<A, E, Indexer | Search | Watcher | AppConfig>) =>
  Effect.provide(effect, appLayer({ root: resolve(root), trusted: true }))

const printResult = (result: SearchResult, json: boolean, search: Search["Service"]) =>
  json
    ? Console.log(JSON.stringify(result, null, 2))
    : Console.log(`${search.formatted(result)}\n\n[${result.candidates} candidates · ${result.reranked ? "reranked" : "fused"} · ${result.tookMs}ms]`)

const index = Command.make(
  "index",
  { path: Argument.directory("path", { mustExist: true }).pipe(Argument.withDefault(".")) },
  Effect.fn("cli.index")(function* (cfg) {
    yield* provideApp(
      cfg.path,
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* Console.log(`Indexing ${resolve(cfg.path)} ...`)
        const stats = yield* indexer.indexAll()
        yield* Console.log(
          `Indexed ${stats.files} files / ${stats.chunks} chunks into ${stats.namespace}`
        )
      })
    )
  })
).pipe(Command.withDescription("Embed and index a codebase into TurboPuffer"))

const search = Command.make(
  "search",
  {
    query: Argument.string("query").pipe(Argument.variadic({ min: 1 })),
    path: Flag.directory("root").pipe(Flag.withDefault(".")),
    limit: Flag.integer("limit").pipe(Flag.withAlias("l"), Flag.withDefault(8)),
    mode: Flag.choice("mode", ["semantic", "hybrid"]).pipe(Flag.withDefault("hybrid")),
    pathPrefix: Flag.string("path").pipe(Flag.optional),
    language: Flag.string("language").pipe(Flag.optional),
    json: Flag.boolean("json")
  },
  Effect.fn("cli.search")(function* (cfg) {
    const query = cfg.query.join(" ")
    yield* provideApp(
      cfg.path,
      Effect.gen(function* () {
        const svc = yield* Search
        const options = {
          limit: cfg.limit,
          pathPrefix: cfg.pathPrefix._tag === "Some" ? cfg.pathPrefix.value : undefined,
          language: cfg.language._tag === "Some" ? cfg.language.value : undefined
        }
        const result =
          cfg.mode === ("semantic" satisfies SearchMode)
            ? yield* svc.semantic(query, options)
            : yield* svc.hybrid(query, options)
        yield* printResult(result, cfg.json, svc)
      })
    )
  })
).pipe(Command.withDescription("Search the index (semantic or hybrid)"))

const watch = Command.make(
  "watch",
  { path: Argument.directory("path", { mustExist: true }).pipe(Argument.withDefault(".")) },
  Effect.fn("cli.watch")(function* (cfg) {
    yield* provideApp(
      cfg.path,
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const watcher = yield* Watcher
        yield* Console.log(`Indexing ${resolve(cfg.path)} ...`)
        const stats = yield* indexer.indexAll()
        yield* Console.log(`Watching ${stats.files} files in ${stats.namespace} (Ctrl+C to stop)`)
        yield* Effect.scoped(watcher.run())
      })
    )
  })
).pipe(Command.withDescription("Index then watch for changes and keep the index fresh"))

const status = Command.make(
  "status",
  { path: Argument.directory("path", { mustExist: true }).pipe(Argument.withDefault(".")), json: Flag.boolean("json") },
  Effect.fn("cli.status")(function* (cfg) {
    yield* provideApp(
      cfg.path,
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const config = yield* AppConfig
        const stats = yield* indexer.stats()
        yield* cfg.json
          ? Console.log(JSON.stringify({ ...stats, missingRequired: config.missingRequired }, null, 2))
          : Console.log(
              `namespace=${stats.namespace}\nfiles=${stats.files} chunks=${stats.chunks}\nmissing=${config.missingRequired.join(",") || "none"}`
            )
      })
    )
  })
).pipe(Command.withDescription("Show index status for the project"))

const clear = Command.make(
  "clear",
  {
    path: Argument.directory("path", { mustExist: true }).pipe(Argument.withDefault(".")),
    force: Flag.boolean("force").pipe(Flag.withAlias("f"))
  },
  Effect.fn("cli.clear")(function* (cfg) {
    if (!cfg.force) {
      yield* Console.log("Refusing to clear without --force")
      return
    }
    yield* provideApp(
      cfg.path,
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.clear()
        yield* Console.log("Index cleared")
      })
    )
  })
).pipe(Command.withDescription("Delete the project index"))

const config = Command.make(
  "config",
  { path: Argument.directory("path", { mustExist: true }).pipe(Argument.withDefault(".")) },
  Effect.fn("cli.config")(function* (cfg) {
    yield* Effect.provide(
      Effect.gen(function* () {
        const resolved = yield* AppConfig
        yield* Console.log(
          JSON.stringify(
            {
              root: resolved.root,
              namespace: resolved.namespace,
              missingRequired: resolved.missingRequired,
              embedding: resolved.settings.embedding,
              store: resolved.settings.store,
              rerank: { provider: resolved.settings.rerank.provider, model: resolved.settings.rerank.model },
              indexing: {
                chunkTargetChars: resolved.settings.indexing.chunkTargetChars,
                chunkMaxChars: resolved.settings.indexing.chunkMaxChars,
                excludeDirs: resolved.settings.indexing.excludeDirs
              }
            },
            null,
            2
          )
        )
      }),
      configLayer({ root: resolve(cfg.path), trusted: true })
    )
  })
).pipe(Command.withDescription("Print the resolved configuration"))

const root = Command.make("semsearch").pipe(
  Command.withDescription("Semantic and hybrid code search backed by TurboPuffer and OpenAI"),
  Command.withSubcommands([index, search, watch, status, clear, config])
)

root.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)

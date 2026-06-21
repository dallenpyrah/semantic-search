import { Context, Duration, Effect, Layer, Path, Queue, Scope, Stream } from "effect"
import { watch as nodeWatch } from "node:fs"
import { AppConfig } from "../config/AppConfig.ts"
import { Indexer } from "../index/Indexer.ts"
import { compileRules, isWatchRelevant } from "../index/ignore.ts"

export class Watcher extends Context.Service<Watcher, {
  run(): Effect.Effect<void, never, Scope.Scope>
}>()("semantic-search/Watcher") {
  static layer = Layer.effect(
    Watcher,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const path = yield* Path.Path
      const indexer = yield* Indexer
      const root = config.root
      const rules = compileRules(config.settings.indexing)
      const debounce = Duration.millis(config.settings.indexing.debounceMs)
      const capacity = config.settings.indexing.maxQueueSize

      const run = (): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const queue = yield* Queue.sliding<string>(capacity)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const watcher = nodeWatch(root, { recursive: true }, (_event, filename) => {
                if (!filename) return
                const rel = String(filename).split(path.sep).join("/")
                if (!isWatchRelevant(rel, rules)) return
                Queue.offerUnsafe(queue, path.join(root, String(filename)))
              })
              watcher.on("error", () => {})
              return watcher
            }),
            (watcher) => Effect.sync(() => watcher.close())
          )
          yield* Stream.fromQueue(queue).pipe(
            Stream.groupedWithin(capacity, debounce),
            Stream.mapEffect((batch) => indexer.reindexPaths(Array.from(new Set(batch))), {
              concurrency: 1
            }),
            Stream.runDrain
          )
        })

      return Watcher.of({ run })
    })
  )
}

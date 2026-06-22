import { Effect, Fiber, ManagedRuntime } from "effect"
import { basename, resolve } from "node:path"
import { AppConfig } from "../config/AppConfig.ts"
import { CommitIndexer } from "../index/CommitIndexer.ts"
import { ConversationIndexer } from "../index/ConversationIndexer.ts"
import { Indexer } from "../index/Indexer.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { Watcher } from "../watch/Watcher.ts"
import { type AppError, type AppServices, appLayer, configLayer } from "../runtime/layers.ts"

type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppError>

export interface RuntimeState {
  readonly root: string
  readonly enabled: boolean
  readonly namespace: string
  readonly projectName: string
  readonly disabledReason: string
  readonly runtime?: AppRuntime
  readonly fibers: ReadonlyArray<Fiber.Fiber<unknown, unknown>>
}

const runtimes = new Map<string, Promise<RuntimeState>>()

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

export const runtimeFor = (root: string): Promise<RuntimeState> => {
  const resolved = resolve(root)
  const existing = runtimes.get(resolved)
  if (existing) return existing
  const started = startRuntime(resolved)
  runtimes.set(resolved, started)
  return started
}

export const stopRuntime = async (root: string): Promise<void> => {
  const resolved = resolve(root)
  const current = runtimes.get(resolved)
  if (!current) return
  runtimes.delete(resolved)
  const state = await current
  if (!state.runtime) return
  for (const fiber of state.fibers) {
    await state.runtime.runPromise(Fiber.interrupt(fiber)).catch(() => {})
  }
  await state.runtime.dispose().catch(() => {})
}

export const stopAllRuntimes = async (): Promise<void> => {
  await Promise.all(Array.from(runtimes.keys()).map((root) => stopRuntime(root)))
}

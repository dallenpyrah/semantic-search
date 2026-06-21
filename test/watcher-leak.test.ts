import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppConfig } from "../src/config/AppConfig.ts"
import { Indexer } from "../src/index/Indexer.ts"
import { Watcher } from "../src/watch/Watcher.ts"

const stubIndexer = Layer.succeed(
  Indexer,
  Indexer.of({
    indexAll: () =>
      Effect.succeed({ namespace: "stub", root: "stub", files: 0, chunks: 0 }),
    reindexPaths: () => Effect.void,
    clear: () => Effect.void,
    stats: () => Effect.succeed({ namespace: "stub", root: "stub", files: 0, chunks: 0 })
  })
)

const resourceCounts = () => {
  const info = (process as { getActiveResourcesInfo?: () => ReadonlyArray<string> }).getActiveResourcesInfo?.() ?? []
  const counts = new Map<string, number>()
  for (const name of info) counts.set(name, (counts.get(name) ?? 0) + 1)
  return counts
}

const countOf = (counts: Map<string, number>, names: ReadonlyArray<string>) =>
  names.reduce((total, name) => total + (counts.get(name) ?? 0), 0)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("watcher resource lifecycle", () => {
  test("repeated start/stop cycles do not leak watchers or timers", async () => {
    const root = mkdtempSync(join(tmpdir(), "semsearch-leak-"))
    writeFileSync(join(root, "seed.ts"), "export const x = 1\n")

    const layer = Watcher.layer.pipe(
      Layer.provide(stubIndexer),
      Layer.provide(AppConfig.layer({ root, trusted: true })),
      Layer.provide(NodeServices.layer)
    )

    const cycle = Effect.scoped(
      Effect.gen(function* () {
        const watcher = yield* Watcher
        yield* Effect.forkScoped(watcher.run())
        yield* Effect.sleep("20 millis")
      })
    ).pipe(Effect.provide(layer))

    await Effect.runPromise(cycle)
    await sleep(30)
    const baseline = resourceCounts()

    for (let i = 0; i < 20; i += 1) {
      await Effect.runPromise(cycle)
    }
    await sleep(50)
    if (typeof Bun !== "undefined") Bun.gc(true)
    const after = resourceCounts()

    const watcherNames = ["FSWatcher", "FSEventWrap", "StatWatcher"]
    const timerNames = ["Timeout", "Timer", "Immediate"]
    expect(countOf(after, watcherNames)).toBeLessThanOrEqual(countOf(baseline, watcherNames))
    expect(countOf(after, timerNames)).toBeLessThanOrEqual(countOf(baseline, timerNames) + 1)
  }, 30_000)
})

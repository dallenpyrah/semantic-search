import { Effect } from "effect"
import { resolve } from "node:path"
import { Indexer } from "../src/index/Indexer.ts"
import { Search } from "../src/search/Search.ts"
import { appLayer } from "../src/runtime/layers.ts"
import { goldSet } from "./gold.ts"

const repoArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
const repo = resolve(repoArg ?? resolve(import.meta.dirname, ".."))

const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024)

const percentile = (values: ReadonlyArray<number>, p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

const program = Effect.gen(function* () {
  const indexer = yield* Indexer
  const search = yield* Search

  const indexStart = Date.now()
  const stats = yield* indexer.indexAll()
  const indexMs = Date.now() - indexStart

  const reindexStart = Date.now()
  yield* indexer.indexAll()
  const reindexMs = Date.now() - reindexStart

  const latencies: Array<number> = []
  for (let round = 0; round < 2; round += 1) {
    for (const gold of goldSet) {
      const result =
        gold.mode === "semantic"
          ? yield* search.semantic(gold.query, { limit: 8 })
          : yield* search.hybrid(gold.query, { limit: 8 })
      latencies.push(result.tookMs)
    }
  }
  return { stats, indexMs, reindexMs, latencies }
})

const main = async () => {
  const rssStart = rss()
  const { stats, indexMs, reindexMs, latencies } = await Effect.runPromise(
    Effect.provide(program, appLayer({ root: repo, trusted: true }))
  )
  const rssEnd = rss()

  const scorecard = {
    repo,
    files: stats.files,
    chunks: stats.chunks,
    indexColdMs: indexMs,
    indexIncrementalMs: reindexMs,
    chunksPerSecondCold: Math.round((stats.chunks / Math.max(1, indexMs)) * 1000),
    searchLatency: {
      samples: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Math.max(...latencies)
    },
    memory: { rssStartMb: rssStart, rssEndMb: rssEnd, deltaMb: rssEnd - rssStart }
  }
  process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`)
  process.stdout.write(
    `\nindex cold ${indexMs}ms (${scorecard.chunksPerSecondCold} chunks/s), incremental ${reindexMs}ms\n` +
      `search p50=${scorecard.searchLatency.p50}ms p95=${scorecard.searchLatency.p95}ms p99=${scorecard.searchLatency.p99}ms\n` +
      `rss ${rssStart}MB -> ${rssEnd}MB (Δ${rssEnd - rssStart}MB)\n`
  )
}

await main()

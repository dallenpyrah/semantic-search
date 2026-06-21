import { Effect } from "effect"
import { resolve } from "node:path"
import { Indexer } from "../src/index/Indexer.ts"
import { Search } from "../src/search/Search.ts"
import { appLayer } from "../src/runtime/layers.ts"
import type { SearchResult } from "../src/domain/types.ts"
import { type GoldCase, goldSet } from "./gold.ts"

const KS = [1, 3, 5, 10] as const

const rankOf = (result: SearchResult, expected: ReadonlyArray<string>): number => {
  for (let i = 0; i < result.hits.length; i += 1) {
    if (expected.includes(result.hits[i]!.path)) return i + 1
  }
  return 0
}

const percentile = (values: ReadonlyArray<number>, p: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]!
}

interface CaseResult {
  readonly gold: GoldCase
  readonly rank: number
  readonly tookMs: number
  readonly candidates: number
  readonly reranked: boolean
  readonly topPath: string
}

const repoArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
const repo = resolve(repoArg ?? resolve(import.meta.dirname, ".."))

const program = Effect.gen(function* () {
  const indexer = yield* Indexer
  const search = yield* Search

  const indexStart = Date.now()
  const stats = yield* indexer.indexAll()
  const indexMs = Date.now() - indexStart

  const results: Array<CaseResult> = []
  for (const gold of goldSet) {
    const result =
      gold.mode === "semantic"
        ? yield* search.semantic(gold.query, { limit: 10 })
        : yield* search.hybrid(gold.query, { limit: 10 })
    results.push({
      gold,
      rank: rankOf(result, gold.expected),
      tookMs: result.tookMs,
      candidates: result.candidates,
      reranked: result.reranked,
      topPath: result.hits[0]?.path ?? "(none)"
    })
  }
  return { stats, indexMs, results }
})

const main = async () => {
  const { stats, indexMs, results } = await Effect.runPromise(
    Effect.provide(program, appLayer({ root: repo, trusted: true }))
  )

  const total = results.length
  const found = results.filter((r) => r.rank > 0)
  const mrr = results.reduce((sum, r) => sum + (r.rank > 0 ? 1 / r.rank : 0), 0) / total
  const ndcg =
    results.reduce((sum, r) => sum + (r.rank > 0 && r.rank <= 10 ? 1 / Math.log2(r.rank + 1) : 0), 0) /
    total
  const successAt = Object.fromEntries(
    KS.map((k) => [k, results.filter((r) => r.rank > 0 && r.rank <= k).length / total])
  )
  const latencies = results.map((r) => r.tookMs)

  const scorecard = {
    repo,
    namespace: stats.namespace,
    files: stats.files,
    chunks: stats.chunks,
    indexMs,
    queries: total,
    mrr: Number(mrr.toFixed(4)),
    ndcg10: Number(ndcg.toFixed(4)),
    successAt,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      mean: Math.round(latencies.reduce((a, b) => a + b, 0) / total)
    },
    misses: results
      .filter((r) => r.rank === 0)
      .map((r) => ({ query: r.gold.query, mode: r.gold.mode, expected: r.gold.expected, got: r.topPath }))
  }

  process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`)
  process.stdout.write(
    `\nindex: ${stats.files} files / ${stats.chunks} chunks in ${indexMs}ms\n` +
      `Success@1=${(successAt[1]! * 100).toFixed(0)}% @3=${(successAt[3]! * 100).toFixed(0)}% @5=${(successAt[5]! * 100).toFixed(0)}% @10=${(successAt[10]! * 100).toFixed(0)}%  MRR=${scorecard.mrr}  nDCG@10=${scorecard.ndcg10}\n` +
      `latency p50=${scorecard.latency.p50}ms p95=${scorecard.latency.p95}ms  found ${found.length}/${total}\n`
  )
  if (scorecard.misses.length > 0) {
    process.stdout.write(`\nMISSES:\n`)
    for (const miss of scorecard.misses) {
      process.stdout.write(`  [${miss.mode}] "${miss.query}" -> expected ${miss.expected.join("|")}, got ${miss.got}\n`)
    }
  }
  if (process.argv.includes("--ranks")) {
    process.stdout.write(`\nRANKS (worst first):\n`)
    for (const r of [...results].sort((a, b) => (b.rank || 99) - (a.rank || 99))) {
      const flag = r.rank === 1 ? "  " : r.rank === 0 ? "XX" : "* "
      process.stdout.write(`  ${flag} rank=${r.rank || "miss"} [${r.gold.mode}] "${r.gold.query}" -> got ${r.topPath}\n`)
    }
  }
}

await main()

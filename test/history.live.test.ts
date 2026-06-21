import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommitIndexer } from "../src/index/CommitIndexer.ts"
import { Indexer } from "../src/index/Indexer.ts"
import { Search } from "../src/search/Search.ts"
import { Turbopuffer } from "../src/store/Turbopuffer.ts"
import { appLayer } from "../src/runtime/layers.ts"

const live = Boolean(process.env.OPENAI_API_KEY && process.env.TURBOPUFFER_API_KEY)

const git = (root: string, args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })

const seedRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "semsearch-history-"))
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "t@t.co"])
  git(root, ["config", "user.name", "Tester"])
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "cache.ts"), "export class Cache { get(k: string) { return undefined } }\n")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "feat: add a simple in-memory cache"])
  writeFileSync(
    join(root, "src", "cache.ts"),
    "export class Cache {\n  private ttlMs = 60000\n  get(k: string) { return undefined }\n}\n"
  )
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "fix: switch cache eviction to a 60s TTL to stop stale reads"])
  return root
}

describe.skipIf(!live)("git history indexing + source weighting", () => {
  test("indexes commits, surfaces history on why/when queries, keeps code authoritative", async () => {
    const root = seedRepo()
    const layer = appLayer({ root, trusted: true })

    const program = Effect.gen(function* () {
      const indexer = yield* Indexer
      const commits = yield* CommitIndexer
      const search = yield* Search
      const store = yield* Turbopuffer

      yield* indexer.indexAll()
      const indexed = yield* commits.run()

      const codeHit = yield* search.search("semantic", ["in memory cache implementation"], { limit: 5 })
      const historyHit = yield* search.search("hybrid", ["why did we change the cache eviction"], { limit: 5, source: ["history"] })
      const whyHit = yield* search.search("semantic", ["why did we decide to change cache eviction to a ttl"], { limit: 5 })

      yield* store.clear()
      return { indexed, codeHit, historyHit, whyHit }
    })

    const result = await Effect.runPromise(Effect.provide(program, layer))

    expect(result.indexed).toBeGreaterThanOrEqual(2)
    expect(result.codeHit.hits[0]?.source).toBe("code")
    expect(result.codeHit.hits[0]?.path).toBe("src/cache.ts")
    expect(result.historyHit.hits.length).toBeGreaterThan(0)
    expect(result.historyHit.hits[0]?.source).toBe("history")
    expect(result.historyHit.hits.some((h) => h.snippet.toLowerCase().includes("ttl"))).toBe(true)
    expect(result.whyHit.hits.some((h) => h.source === "history")).toBe(true)
  }, 90_000)
})

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Indexer } from "../src/index/Indexer.ts"
import { Search } from "../src/search/Search.ts"
import { appLayer } from "../src/runtime/layers.ts"

const live = Boolean(process.env.OPENAI_API_KEY && process.env.TURBOPUFFER_API_KEY)

const seedRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "semsearch-pipeline-"))
  mkdirSync(join(root, "src", "auth"), { recursive: true })
  mkdirSync(join(root, "src", "util"), { recursive: true })
  mkdirSync(join(root, "node_modules", "junk"), { recursive: true })
  writeFileSync(
    join(root, "src", "auth", "session.ts"),
    "export function authenticateRequest(token: string) {\n  const claims = verifyJwt(token)\n  if (!claims) throw new Error('unauthorized')\n  return claims\n}\n"
  )
  writeFileSync(
    join(root, "src", "util", "csv.ts"),
    "export const parseCsv = (input: string) => input.split('\\n').map((line) => line.split(','))\n"
  )
  writeFileSync(
    join(root, "src", "util", "retry.ts"),
    "export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {\n  let last\n  for (let i = 0; i < attempts; i++) { try { return await fn() } catch (e) { last = e } }\n  throw last\n}\n"
  )
  writeFileSync(join(root, "node_modules", "junk", "index.ts"), "export const ignored = true\n")
  return root
}

describe.skipIf(!live)("index + search pipeline", () => {
  test("indexes a repo, searches it, reflects edits, ignores node_modules", async () => {
    const root = seedRepo()
    const layer = appLayer({ root, trusted: true })

    const program = Effect.gen(function* () {
      const indexer = yield* Indexer
      const search = yield* Search

      const stats = yield* indexer.indexAll()

      const authQuery = yield* search.hybrid("how do we authenticate an incoming request", {
        limit: 5
      })
      const retryQuery = yield* search.semantic("retry a failing async operation", { limit: 5 })

      writeFileSync(
        join(root, "src", "util", "retry.ts"),
        "export async function withBackoff<T>(fn: () => Promise<T>) {\n  return fn()\n}\n"
      )
      yield* indexer.reindexPaths([join(root, "src", "util", "retry.ts")])
      const afterEdit = yield* search.semantic("exponential backoff retry helper", { limit: 5 })

      yield* indexer.clear()
      return { stats, authQuery, retryQuery, afterEdit }
    })

    const result = await Effect.runPromise(Effect.provide(program, layer))

    expect(result.stats.files).toBe(3)
    expect(result.stats.chunks).toBeGreaterThanOrEqual(3)

    const authPaths = result.authQuery.hits.map((h) => h.path)
    expect(authPaths[0]).toBe("src/auth/session.ts")
    expect(authPaths.some((p) => p.includes("node_modules"))).toBe(false)

    expect(result.retryQuery.hits[0]?.path).toBe("src/util/retry.ts")
    expect(result.afterEdit.hits.some((h) => h.snippet.includes("withBackoff"))).toBe(true)
  }, 90_000)
})

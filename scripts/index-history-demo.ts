import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommitIndexer } from "../src/index/CommitIndexer.ts"
import { GitHistory } from "../src/index/GitHistory.ts"
import { Indexer } from "../src/index/Indexer.ts"
import { Search } from "../src/search/Search.ts"
import { Turbopuffer } from "../src/store/Turbopuffer.ts"
import { Watcher } from "../src/watch/Watcher.ts"
import { appLayer } from "../src/runtime/layers.ts"

const git = (root: string, args: ReadonlyArray<string>) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ok = (b: boolean) => (b ? "PASS" : "FAIL")

const seed = (): string => {
  const root = mkdtempSync(join(tmpdir(), "semsearch-demo-"))
  git(root, ["init", "-q"]); git(root, ["config", "user.email", "t@t.co"]); git(root, ["config", "user.name", "T"])
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "src", "auth.ts"), "export function login(user: string) { return verify(user) }\n")
  writeFileSync(join(root, "src", "cache.ts"), "export class Cache { get(k: string) { return undefined } }\n")
  writeFileSync(join(root, "src", "legacy.ts"), "export const oldHelper = () => 'remove me later'\n")
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "feat: initial auth, cache, legacy"])
  return root
}

const main = async () => {
  const root = seed()
  const layer = appLayer({ root, trusted: true })
  const run = <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromise(Effect.provide(e, layer) as Effect.Effect<A, E, never>)

  const svc = <A>(f: (s: { indexer: Indexer["Service"]; commits: CommitIndexer["Service"]; search: Search["Service"]; history: GitHistory["Service"]; store: Turbopuffer["Service"] }) => Effect.Effect<A, any, any>) =>
    run(Effect.gen(function* () {
      return yield* f({
        indexer: yield* Indexer, commits: yield* CommitIndexer, search: yield* Search, history: yield* GitHistory, store: yield* Turbopuffer
      })
    }))

  const found = (r: { hits: ReadonlyArray<{ path: string; snippet: string }> }, needle: string) =>
    r.hits.some((h) => h.snippet.toLowerCase().includes(needle.toLowerCase()))

  try {
    // 1. COLD INDEX + COMMITS
    let t = Date.now()
    const stats = await svc((s) => s.indexer.indexAll())
    const coldMs = Date.now() - t
    const commitsN = await svc((s) => s.commits.run())
    console.log(`\n1. COLD INDEX: ${stats.files} files / ${stats.chunks} chunks in ${coldMs}ms; commits indexed: ${commitsN}`)

    // 2. INCREMENTAL NO-OP
    t = Date.now(); await svc((s) => s.indexer.indexAll()); const incMs = Date.now() - t
    console.log(`2. INCREMENTAL (no change): ${incMs}ms  [${ok(incMs < coldMs / 2)}]`)

    // 3. MODIFY a file
    writeFileSync(join(root, "src", "cache.ts"), "export class Cache {\n  private ttlMs = 60000\n  get(k: string) { return undefined }\n}\n")
    await svc((s) => s.indexer.reindexPaths([join(root, "src", "cache.ts")]))
    const mod = await svc((s) => s.search.search("semantic", ["cache ttl eviction"], { limit: 5 }))
    console.log(`3. MODIFY file: new content searchable: ${ok(found(mod, "ttlMs"))}`)

    // 4. ADD a file
    writeFileSync(join(root, "src", "ratelimit.ts"), "export function rateLimit(maxPerMinute: number) { return (req) => req }\n")
    await svc((s) => s.indexer.reindexPaths([join(root, "src", "ratelimit.ts")]))
    const add = await svc((s) => s.search.search("hybrid", ["rateLimit max per minute middleware"], { limit: 5 }))
    console.log(`4. ADD file: indexed + searchable: ${ok(add.hits.some((h) => h.path === "src/ratelimit.ts"))}`)

    // 5. DELETE a file
    rmSync(join(root, "src", "legacy.ts"))
    await svc((s) => s.indexer.reindexPaths([join(root, "src", "legacy.ts")]))
    const del = await svc((s) => s.search.search("hybrid", ["oldHelper remove me later legacy"], { limit: 8 }))
    console.log(`5. DELETE file: removed from index (oldHelper gone): ${ok(!del.hits.some((h) => h.path === "src/legacy.ts"))}`)

    // 6. NEW COMMIT -> incremental commit indexing
    git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fix: cache uses a 60s TTL; add rate limiter; drop legacy helper"])
    const newCommits = await svc((s) => s.commits.run())
    const histSearch = await svc((s) => s.search.search("hybrid", ["why did the cache change to a ttl"], { limit: 5, source: ["history"] }))
    console.log(`6. NEW COMMIT: incremental commits indexed: ${newCommits} [${ok(newCommits === 1)}]; history search finds it: ${ok(found(histSearch, "ttl"))}`)

    // 7. FILE HISTORY (real diffs)
    const fileLog = await svc((s) => s.history.fileLog("src/cache.ts", { limit: 5 }))
    const commitsInLog = (fileLog.match(/=== commit/g) ?? []).length
    console.log(`7. FILE HISTORY src/cache.ts: ${commitsInLog} commits, shows diff (+ttlMs): ${ok(fileLog.includes("ttlMs") && fileLog.includes("=== commit"))}`)

    // 8. WATCHER GIT-SYNC (end-to-end, no manual calls): a live commit must auto-index
    const before = await svc((s) => s.search.search("hybrid", ["telemetry span tracing addition"], { limit: 5, source: ["history"] }))
    const beforeHit = found(before, "telemetry")
    const watchProgram = Effect.scoped(Effect.gen(function* () {
      const watcher = yield* Watcher
      yield* Effect.forkScoped(watcher.run())
      yield* Effect.sleep("500 millis")
      yield* Effect.promise(async () => {
        writeFileSync(join(root, "src", "telemetry.ts"), "export const span = (name: string) => tracer.start(name)\n")
        git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "feat: add telemetry span tracing helper"])
        await sleep(6000)
      })
    }))
    await run(watchProgram)
    const afterCode = await svc((s) => s.search.search("hybrid", ["telemetry span tracer start"], { limit: 5 }))
    const afterHist = await svc((s) => s.search.search("hybrid", ["telemetry span tracing addition"], { limit: 5, source: ["history"] }))
    console.log(`8. WATCHER GIT-SYNC (live commit, no manual index):`)
    console.log(`     new file auto-indexed: ${ok(afterCode.hits.some((h) => h.path === "src/telemetry.ts"))}`)
    console.log(`     new commit auto-indexed to history: ${ok(!beforeHit && found(afterHist, "telemetry"))}`)

    await svc((s) => s.store.clear())
    console.log("\ncleaned up namespace")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()

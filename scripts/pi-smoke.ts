import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import semanticSearchExtension from "../src/pi/extension.ts"

interface Handler {
  (event: unknown, ctx: unknown): Promise<unknown> | unknown
}

interface RegisteredTool {
  name: string
  label: string
  description: string
  promptSnippet?: string
  promptGuidelines?: ReadonlyArray<string>
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>
}

const handlers = new Map<string, Handler>()
const tools = new Map<string, RegisteredTool>()
const notes: Array<string> = []

const pi = {
  on: (event: string, handler: Handler) => handlers.set(event, handler),
  registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
  registerCommand: () => {},
  sendMessage: () => {},
  sendUserMessage: () => {}
}

const ctx = {
  cwd: "",
  hasUI: true,
  isProjectTrusted: () => true,
  ui: {
    notify: (message: string) => notes.push(message)
  }
}

const seedRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "semsearch-pi-smoke-"))
  mkdirSync(join(root, "src", "auth"), { recursive: true })
  mkdirSync(join(root, "src", "cache"), { recursive: true })
  writeFileSync(
    join(root, "src", "auth", "middleware.ts"),
    "export function requireAuth(req, res, next) {\n  const token = req.headers.authorization\n  if (!validateToken(token)) return res.status(401).end()\n  next()\n}\n"
  )
  writeFileSync(
    join(root, "src", "cache", "lru.ts"),
    "export class LruCache<K, V> {\n  private map = new Map<K, V>()\n  get(key: K) { return this.map.get(key) }\n  set(key: K, value: V) { this.map.set(key, value) }\n}\n"
  )
  return root
}

const main = async () => {
  const root = seedRepo()
  ctx.cwd = root
  try {
    semanticSearchExtension(pi as never)
    console.log("registered tools:", [...tools.keys()].join(", "))
    const search = tools.get("code_search")
    const grep = tools.get("code_grep")
    if (!search || !grep) throw new Error("expected code_search and code_grep tools")
    console.log("code_search snippet:", search.promptSnippet)

    const start = handlers.get("session_start")
    if (!start) throw new Error("no session_start handler")
    const t0 = Date.now()
    await start({ reason: "startup" }, ctx)
    console.log("session_start done, notes:", JSON.stringify(notes))

    await new Promise((resolve) => setTimeout(resolve, 6000))

    const result = (await search.execute("call-1", {
      query: "where do we validate the authorization token on a request"
    })) as { content: Array<{ text: string }>; details: Record<string, unknown> }
    console.log("\n=== code_search result ===")
    console.log(result.content[0]?.text?.slice(0, 600))
    console.log("details:", JSON.stringify(result.details).slice(0, 400))
    console.log("elapsed total ms:", Date.now() - t0)

    const grepResult = (await grep.execute("call-2", { query: "LruCache" })) as {
      content: Array<{ text: string }>
    }
    console.log("\n=== code_grep result ===")
    console.log(grepResult.content[0]?.text?.slice(0, 400))

    const shutdown = handlers.get("session_shutdown")
    if (shutdown) await shutdown({ reason: "quit" }, ctx)
    console.log("\nsession_shutdown done")

    const topPath = (result.details.hits as Array<{ path: string }> | undefined)?.[0]?.path
    if (topPath !== "src/auth/middleware.ts") {
      throw new Error(`expected auth middleware top hit, got ${topPath}`)
    }
    console.log("\nSMOKE OK")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()

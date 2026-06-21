import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

interface Task {
  readonly id: string
  readonly type: string
  readonly prompt: string
  readonly expect: string
}

const tasks: ReadonlyArray<Task> = [
  {
    id: "t1-watcher-gitsync",
    type: "discovery",
    prompt:
      "How does this project's file watcher keep the search index in sync when I switch git branches or run git pull? Find the relevant code and explain briefly, then stop.",
    expect: "src/watch/Watcher.ts — watches .git/logs/HEAD, on git-ref change runs indexAll reconcile + CommitIndexer"
  },
  {
    id: "t2-rerank-degrade",
    type: "how-it-works",
    prompt:
      "How are search results reranked, and what happens if there is no OpenRouter API key? Locate the code and answer, then stop.",
    expect: "src/rerank/Reranker.ts — Cohere rerank-v3.5 via OpenRouter; degrades to identity passthrough when no key"
  },
  {
    id: "t3-multifacet-pipeline",
    type: "multi-faceted",
    prompt:
      "Explain how embeddings, the TurboPuffer vector store, and the reranker fit together in the search pipeline. Then stop.",
    expect: "Embeddings.ts + Turbopuffer.ts + Reranker.ts orchestrated by Search.ts — ideally one queries[] call"
  },
  {
    id: "t4-why-v2",
    type: "history-why",
    prompt:
      "Why was the namespace schema version bumped to v2 in this project? Find out and explain, then stop.",
    expect: "git history — commit 'fix: bump namespace SCHEMA_VERSION to v2 so the source field is fully populated'"
  },
  {
    id: "t5-file-history",
    type: "history-file",
    prompt:
      "Show me how src/search/Search.ts has changed recently — what commits touched it and what did they do? Then stop.",
    expect: "semantic_search with file: src/search/Search.ts -> commit messages + diffs"
  },
  {
    id: "t6-resolveSources",
    type: "exact-symbol",
    prompt:
      "Find the definition of the function that decides which sources (code/history/conversation) a query searches, and explain its routing rule. Then stop.",
    expect: "src/search/Search.ts resolveSources — default code+docs, cue router adds history/conversation"
  },
  {
    id: "t7-todos-grep",
    type: "true-grep",
    prompt:
      "List every TODO comment in the codebase using a raw exhaustive text search. Then stop.",
    expect: "should use built-in grep, not semantic_search (raw exhaustive sweep)"
  }
]

const PI = process.env.PI_BIN ?? "pi"
const REPO = resolve(import.meta.dirname, "..")
const EXT = join(REPO, "src", "pi", "extension.ts")
const SKILL = join(REPO, "skills", "code-search")
const OUT = join(REPO, "eval", ".cache", "sessions")

interface Parsed {
  readonly toolCalls: ReadonlyArray<string>
  readonly searchArgs: ReadonlyArray<Record<string, unknown>>
  readonly answer: string
}

const parse = (ndjson: string): Parsed => {
  const toolCalls: Array<string> = []
  const searchArgs: Array<Record<string, unknown>> = []
  let answer = ""
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue
    let entry: { type?: string; message?: { role?: string; toolName?: string; content?: unknown } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    const message = entry.message
    if (!message) continue
    if (entry.type === "message_start" && message.role === "toolResult" && message.toolName) {
      toolCalls.push(message.toolName)
    }
    if (entry.type === "message_end" && message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue
        const b = block as { type?: string; name?: string; arguments?: Record<string, unknown>; text?: string }
        if (b.type === "toolCall" && b.name === "semantic_search" && b.arguments) searchArgs.push(b.arguments)
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) answer = b.text
      }
    }
  }
  return { toolCalls, searchArgs, answer }
}

const run = (task: Task) => {
  const started = Date.now()
  const result = spawnSync(
    PI,
    ["-p", "--mode", "json", "-ne", "-e", EXT, "-ns", "--skill", SKILL, "-a", task.prompt],
    { cwd: REPO, encoding: "utf8", timeout: 180_000, maxBuffer: 96 * 1024 * 1024 }
  )
  const ms = Date.now() - started
  const ndjson = result.stdout ?? ""
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, `${task.id}.ndjson`), ndjson)
  const parsed = parse(ndjson)
  const retrieval = parsed.toolCalls.filter((c) => ["semantic_search", "grep", "find", "bash"].includes(c))
  writeFileSync(
    join(OUT, `${task.id}.answer.txt`),
    `TASK (${task.type}): ${task.prompt}\nEXPECT: ${task.expect}\n\nTOOLS: ${parsed.toolCalls.join(", ")}\nSEARCH ARGS: ${JSON.stringify(parsed.searchArgs)}\n\nANSWER:\n${parsed.answer}\n`
  )
  return {
    id: task.id,
    type: task.type,
    tools: parsed.toolCalls,
    firstRetrieval: retrieval[0] ?? "none",
    searchCalls: parsed.searchArgs.length,
    searchArgs: parsed.searchArgs,
    usedGrep: parsed.toolCalls.includes("grep"),
    ms,
    answer: parsed.answer.slice(0, 400)
  }
}

const rows = tasks.map(run)
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, "scorecard.json"), JSON.stringify(rows, null, 2))

for (const row of rows) {
  process.stdout.write(
    `\n[${row.type}] ${row.id}\n` +
      `  tools: ${row.tools.join(" → ") || "(none)"}\n` +
      `  first retrieval: ${row.firstRetrieval} | semantic_search calls: ${row.searchCalls} | grep: ${row.usedGrep} | ${Math.round(row.ms / 1000)}s\n` +
      `  search args: ${JSON.stringify(row.searchArgs)}\n` +
      `  answer: ${row.answer.replace(/\n/g, " ").slice(0, 240)}\n`
  )
}
const disc = rows.filter((r) => r.type !== "true-grep")
const adopted = disc.filter((r) => r.firstRetrieval === "semantic_search").length
process.stdout.write(
  `\n=== ${adopted}/${disc.length} non-grep tasks used semantic_search first; grep-task used grep: ${rows.find((r) => r.type === "true-grep")?.usedGrep}; full traces in eval/.cache/sessions/ ===\n`
)

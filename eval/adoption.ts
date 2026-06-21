import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

interface Task {
  readonly prompt: string
  readonly intended: "semantic_search" | "code_grep" | "grep"
}

const tasks: ReadonlyArray<Task> = [
  { prompt: "Where is rate limiting implemented in this codebase? Find it, then stop.", intended: "semantic_search" },
  { prompt: "How does the billing retry logic work? Locate it, then stop.", intended: "semantic_search" },
  { prompt: "Where do we issue and validate access tokens? Find it, then stop.", intended: "semantic_search" },
  { prompt: "Find every place that references validateAccessToken, then stop.", intended: "semantic_search" },
  { prompt: "List every TODO comment in the codebase using a raw text search, then stop.", intended: "grep" }
]

const RETRIEVAL = new Set(["semantic_search", "grep", "find", "bash", "ls"])

const PI = "/Users/dallen.pyrah/.bun/bin/pi"
const EXT = resolve(import.meta.dirname, "..", "src", "pi", "extension.ts")
const SKILL = resolve(import.meta.dirname, "..", "skills", "code-search")
const repo = process.argv[2]

if (!repo) {
  process.stderr.write("usage: bun eval/adoption.ts <pre-indexed-repo>\n")
  process.exit(1)
}

const parseCalls = (ndjson: string): Array<string> => {
  const calls: Array<string> = []
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; toolName?: string } }
      if (entry.type === "message_start" && entry.message?.role === "toolResult" && entry.message.toolName) {
        calls.push(entry.message.toolName)
      }
    } catch {
      continue
    }
  }
  return calls
}

const run = (task: Task) => {
  const result = spawnSync(
    PI,
    ["-p", "--mode", "json", "-ne", "-e", EXT, "-ns", "--skill", SKILL, "-a", task.prompt],
    { cwd: repo, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
  )
  const calls = parseCalls(result.stdout ?? "")
  const retrieval = calls.filter((call) => RETRIEVAL.has(call))
  const first = retrieval[0] ?? "none"
  const usedGrep = calls.includes("grep")
  const usedOurs = calls.includes("semantic_search")
  return { task, calls, first, usedGrep, usedOurs }
}

const rows = tasks.map(run)

let adopted = 0
let misroute = 0
let totalCalls = 0
for (const row of rows) {
  const ours = row.first === "semantic_search"
  if (row.task.intended === "grep") {
    if (ours) misroute += 1
  } else if (ours) {
    adopted += 1
  }
  totalCalls += row.calls.length
  process.stdout.write(
    `[${row.task.intended}] first=${row.first} ours=${row.usedOurs} grep=${row.usedGrep} calls=${row.calls.length} (${row.calls.join(",")})\n  "${row.task.prompt.slice(0, 60)}"\n`
  )
}

const discovery = tasks.filter((t) => t.intended !== "grep").length
process.stdout.write(
  `\nADOPTION: ${adopted}/${discovery} discovery tasks routed to semantic_search first` +
    ` | mis-route ${misroute} | avg tool calls ${(totalCalls / tasks.length).toFixed(1)}\n`
)

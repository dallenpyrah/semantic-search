import { Context, Effect, Layer } from "effect"
import { AppConfig } from "../config/AppConfig.ts"
import { git } from "./git.ts"

const parseLines = (lines: string | undefined): { start: number; end: number } | undefined => {
  if (!lines) return undefined
  const match = /^\s*(\d+)\s*[-:,]\s*(\d+)\s*$/.exec(lines)
  if (!match) {
    const single = /^\s*(\d+)\s*$/.exec(lines)
    if (single) {
      const n = Number(single[1])
      return { start: Math.max(1, n - 5), end: n + 5 }
    }
    return undefined
  }
  return { start: Number(match[1]), end: Number(match[2]) }
}

export class GitHistory extends Context.Service<GitHistory, {
  fileLog(
    path: string,
    options: { readonly lines?: string; readonly limit?: number; readonly maxBytes?: number }
  ): Effect.Effect<string>
}>()("semantic-search/GitHistory") {
  static layer = Layer.effect(
    GitHistory,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const root = config.root

      const fileLog = (
        path: string,
        options: { readonly lines?: string; readonly limit?: number; readonly maxBytes?: number }
      ): Effect.Effect<string> =>
        Effect.gen(function* () {
          const clean = path.trim().replace(/^@/, "").replace(/^\.\//, "")
          if (!clean) return "Provide a repository-relative file path."
          const limit = Math.max(1, Math.min(options.limit ?? 10, 30))
          const maxBytes = options.maxBytes ?? 18_000
          const range = parseLines(options.lines)

          const isRepo = yield* git(root, ["rev-parse", "--git-dir"])
          if (!isRepo.ok) return "This project is not a git repository."

          const args = range
            ? ["log", `-L${range.start},${range.end}:${clean}`, "-n", String(limit), "--date=short"]
            : [
                "log",
                "--follow",
                "-p",
                "-M",
                "-n",
                String(limit),
                "--date=short",
                "--pretty=format:%n=== commit %h — %ad — %an ===%n%s%n%b",
                "--",
                clean
              ]
          const result = yield* git(root, args)
          const out = result.out.trim()
          if (out.length === 0) {
            return `No git history found for ${clean}. It may be untracked, new, or outside this repository.`
          }
          const header =
            `Git history for ${clean}${range ? ` (lines ${range.start}-${range.end})` : ""} — ` +
            `historical diffs and messages, newest first. The current file on disk is the source of truth.\n`
          const body = out.length > maxBytes ? `${out.slice(0, maxBytes)}\n… (truncated; increase limit or narrow lines)` : out
          return `${header}\n${body}`
        })

      return GitHistory.of({ fileLog })
    })
  )
}

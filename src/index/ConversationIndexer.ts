import { Array as Arr, Context, Effect, Layer, Option } from "effect"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../config/AppConfig.ts"
import { Embeddings } from "../embedding/Embeddings.ts"
import { Manifest } from "./Manifest.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { shortHash } from "../domain/hash.ts"
import type { UpsertRow } from "../store/schema.ts"

const META_KEY = "conversationsLastRun"
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*\S+/gi,
  /\b[A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S+/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g
]

const redact = (text: string): string =>
  SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[redacted]"), text)

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block): block is { type?: string; text?: string } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim()
}

interface Turn {
  readonly sessionId: string
  readonly ts: number
  readonly index: number
  readonly user: string
  readonly assistant: string
}

const parseSession = (file: string): { sessionId: string; ts: number; cwd: string; turns: ReadonlyArray<Turn> } | undefined => {
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return undefined
  let header: { id?: string; cwd?: string; timestamp?: string }
  try {
    header = JSON.parse(lines[0]!) as typeof header
  } catch {
    return undefined
  }
  if (header.cwd === undefined || !header.id) return undefined
  const sessionId = header.id
  const ts = Math.floor(new Date(header.timestamp ?? Date.now()).getTime() / 1000)
  const turns: Array<Turn> = []
  let pendingUser: string | undefined
  let index = 0
  for (const line of lines.slice(1)) {
    let entry: { type?: string; message?: { role?: string; content?: unknown } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    if (entry.type !== "message" || !entry.message) continue
    const role = entry.message.role
    if (role === "user") {
      pendingUser = textOf(entry.message.content)
    } else if (role === "assistant" && pendingUser !== undefined) {
      const assistant = textOf(entry.message.content)
      if (pendingUser.length >= 8 && assistant.length >= 8) {
        turns.push({ sessionId, ts, index, user: pendingUser.slice(0, 800), assistant: assistant.slice(0, 1600) })
        index += 1
      }
      pendingUser = undefined
    }
  }
  return { sessionId, ts, cwd: header.cwd, turns }
}

const turnDoc = (turn: Turn): string =>
  redact(`User: ${turn.user}\n\nAssistant: ${turn.assistant}`)

const rowOf = (turn: Turn, vector: ReadonlyArray<number>): UpsertRow => ({
  id: `conv:${shortHash(`${turn.sessionId}\n${turn.index}\n${turn.user}`, 40)}`,
  source: "conversation",
  vector,
  text: turnDoc(turn),
  pathText: turn.user.slice(0, 200),
  path: `session:${turn.sessionId.slice(0, 8)}#${turn.index}`,
  language: "conversation",
  kind: "conversation",
  startLine: 0,
  endLine: 0,
  fileHash: turn.sessionId,
  sessionId: turn.sessionId,
  ts: turn.ts,
  role: "turn"
})

export class ConversationIndexer extends Context.Service<ConversationIndexer, {
  run(): Effect.Effect<number>
}>()("semantic-search/ConversationIndexer") {
  static layer = Layer.effect(
    ConversationIndexer,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const embeddings = yield* Embeddings
      const store = yield* Turbopuffer
      const manifest = yield* Manifest
      const root = config.root
      const indexing = config.settings.indexing

      const candidateDir = () => {
        const slug = `--${root.replace(/^\//, "").replace(/\//g, "-")}--`
        return join(config.agentDir, "sessions", slug)
      }

      const sessionFiles = (since: number): ReadonlyArray<string> => {
        const dir = candidateDir()
        if (!existsSync(dir)) return []
        let entries: ReadonlyArray<string>
        try {
          entries = readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
        } catch {
          return []
        }
        return entries
          .map((name) => join(dir, name))
          .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
          .filter((entry) => entry.mtime > since)
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, indexing.conversationMaxSessions)
          .map((entry) => entry.file)
      }

      const run = (): Effect.Effect<number> =>
        Effect.gen(function* () {
          if (!indexing.conversationEnabled) {
            const purged = yield* manifest.getMeta(META_KEY)
            if (Option.isSome(purged)) {
              yield* store.deleteByFilter(["source", "Eq", "conversation"]).pipe(Effect.catch(() => Effect.void))
              yield* manifest.setMeta(META_KEY, "")
              yield* manifest.save()
            }
            return 0
          }
          const lastRun = yield* manifest.getMeta(META_KEY)
          const since = Option.match(lastRun, { onNone: () => 0, onSome: (value) => Number(value) || 0 })
          const files = sessionFiles(since)
          const turns: Array<Turn> = []
          for (const file of files) {
            const parsed = parseSession(file)
            if (parsed && parsed.cwd === root) for (const turn of parsed.turns) turns.push(turn)
          }
          if (turns.length > 0) {
            yield* Effect.forEach(
              Arr.chunksOf(turns, 96),
              (batch) =>
                Effect.gen(function* () {
                  const vectors = yield* embeddings.embed(batch.map(turnDoc))
                  yield* store.upsert(batch.map((turn, i) => rowOf(turn, vectors[i]!)))
                }),
              { concurrency: 1, discard: true }
            ).pipe(Effect.catch((error) => Effect.logWarning("semantic-search: conversation indexing failed", error)))
          }
          yield* manifest.setMeta(META_KEY, String(Date.now()))
          yield* manifest.save()
          return turns.length
        })

      return ConversationIndexer.of({ run })
    })
  )
}

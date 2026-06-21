import { Array as Arr, Context, Effect, Layer, Option } from "effect"
import { AppConfig } from "../config/AppConfig.ts"
import { Embeddings } from "../embedding/Embeddings.ts"
import { Manifest } from "./Manifest.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { git } from "./git.ts"
import type { UpsertRow } from "../store/schema.ts"

const RS = String.fromCharCode(0x1e)
const US = String.fromCharCode(0x1f)
const META_KEY = "commitsLastSha"

interface Commit {
  readonly sha: string
  readonly author: string
  readonly committedAt: number
  readonly subject: string
  readonly body: string
  readonly paths: ReadonlyArray<string>
}

const parseLog = (out: string): ReadonlyArray<Commit> => {
  const commits: Array<Commit> = []
  for (const record of out.split(RS)) {
    if (record.trim().length === 0) continue
    const parts = record.split(US)
    if (parts.length < 6) continue
    const sha = parts[0]!.trim()
    if (!sha) continue
    const paths = parts[5]!
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    commits.push({
      sha,
      author: parts[1]!.trim(),
      committedAt: Number(parts[2]!.trim()) || 0,
      subject: parts[3]!.trim(),
      body: parts[4]!.trim(),
      paths: Array.from(new Set(paths)).slice(0, 40)
    })
  }
  return commits
}

const commitDoc = (commit: Commit): string => {
  const files = commit.paths.length > 0 ? `\nFiles: ${commit.paths.join(", ")}` : ""
  return `${commit.subject}\n${commit.body.slice(0, 1500)}${files}`.trim()
}

const rowOf = (commit: Commit, vector: ReadonlyArray<number>): UpsertRow => {
  const shaShort = commit.sha.slice(0, 7)
  return {
    id: `commit:${commit.sha}`,
    source: "history",
    vector,
    text: commitDoc(commit),
    pathText: `${commit.subject} ${commit.paths.join(" ")}`.trim(),
    path: `commit:${shaShort}`,
    language: "git",
    kind: "commit",
    startLine: 0,
    endLine: 0,
    fileHash: commit.sha,
    chunkHash: commit.sha,
    sha: commit.sha,
    committedAt: commit.committedAt,
    author: commit.author,
    isMerge: false
  }
}

const LOG_FORMAT = `--pretty=format:${RS}%H${US}%an${US}%ct${US}%s${US}%b${US}`

export class CommitIndexer extends Context.Service<CommitIndexer, {
  run(): Effect.Effect<number>
}>()("semantic-search/CommitIndexer") {
  static layer = Layer.effect(
    CommitIndexer,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const embeddings = yield* Embeddings
      const store = yield* Turbopuffer
      const manifest = yield* Manifest
      const root = config.root
      const indexing = config.settings.indexing

      const indexCommits = (commits: ReadonlyArray<Commit>) =>
        Effect.forEach(
          Arr.chunksOf(commits, indexing.embedBatch),
          (batch) =>
            embeddings
              .embed(batch.map(commitDoc))
              .pipe(Effect.flatMap((vectors) => store.upsert(batch.map((commit, i) => rowOf(commit, vectors[i]!))))),
          { concurrency: indexing.embedConcurrency, discard: true }
        )

      const run = (): Effect.Effect<number> =>
        Effect.gen(function* () {
          if (!indexing.historyEnabled) return 0
          const gitDir = yield* git(root, ["rev-parse", "--git-dir"])
          if (!gitDir.ok) return 0
          const head = (yield* git(root, ["rev-parse", "HEAD"])).out.trim()
          if (!head) return 0

          const lastShaOption = yield* manifest.getMeta(META_KEY)
          let range: ReadonlyArray<string> = ["-n", String(indexing.historyMaxCommits), "HEAD"]
          if (Option.isSome(lastShaOption)) {
            const lastSha = lastShaOption.value
            if (lastSha === head) return 0
            const ancestor = yield* git(root, ["merge-base", "--is-ancestor", lastSha, "HEAD"])
            if (ancestor.ok) {
              range = [`${lastSha}..HEAD`]
            } else {
              yield* store.deleteByFilter(["source", "Eq", "history"]).pipe(Effect.catch(() => Effect.void))
            }
          }

          const log = yield* git(root, [
            "log",
            "--no-merges",
            "--reverse",
            "--date=unix",
            LOG_FORMAT,
            "--name-only",
            ...range
          ])
          const commits = parseLog(log.out)
          if (commits.length > 0) {
            yield* indexCommits(commits).pipe(
              Effect.catch((error) => Effect.logWarning("semantic-search: commit indexing failed", error))
            )
          }
          yield* manifest.setMeta(META_KEY, head)
          yield* manifest.save()
          return commits.length
        })

      return CommitIndexer.of({ run })
    })
  )
}

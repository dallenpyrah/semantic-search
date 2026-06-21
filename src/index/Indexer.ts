import { Context, Effect, FileSystem, Layer, Option, Path, Queue, Stream } from "effect"
import { readdir, stat } from "node:fs/promises"
import { AppConfig } from "../config/AppConfig.ts"
import { Chunker } from "../chunk/Chunker.ts"
import { Embeddings } from "../embedding/Embeddings.ts"
import { type FileEntry, Manifest } from "./Manifest.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { type UpsertRow, rowFromChunk } from "../store/schema.ts"
import { sha256 } from "../domain/hash.ts"
import type { Chunk, IndexStats } from "../domain/types.ts"
import { compileRules, shouldConsiderFile, shouldEnterDir, shouldIndexFile } from "./ignore.ts"

interface Candidate {
  readonly rel: string
  readonly abs: string
  readonly size: number
  readonly mtimeMs: number
}

const looksBinary = (bytes: Uint8Array): boolean => {
  const length = Math.min(bytes.length, 8000)
  for (let i = 0; i < length; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}

const decoder = new TextDecoder("utf-8", { fatal: false })

export class Indexer extends Context.Service<Indexer, {
  indexAll(): Effect.Effect<IndexStats>
  reindexPaths(paths: ReadonlyArray<string>): Effect.Effect<void>
  clear(): Effect.Effect<void>
  stats(): Effect.Effect<IndexStats>
}>()("semantic-search/Indexer") {
  static layer = Layer.effect(
    Indexer,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const chunker = yield* Chunker
      const embeddings = yield* Embeddings
      const store = yield* Turbopuffer
      const manifest = yield* Manifest
      const root = config.root
      const rules = compileRules(config.settings.indexing)
      const concurrency = config.settings.indexing.scanConcurrency

      const relOf = (abs: string) => path.relative(root, abs).split(path.sep).join("/")

      async function* walkGen(dir: string): AsyncGenerator<Candidate> {
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const abs = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (shouldEnterDir(entry.name, rules)) yield* walkGen(abs)
            continue
          }
          if (!entry.isFile()) continue
          const rel = relOf(abs)
          if (!shouldConsiderFile(rel, rules)) continue
          let info
          try {
            info = await stat(abs)
          } catch {
            continue
          }
          if (!shouldIndexFile(rel, info.size, rules)) continue
          yield { rel, abs, size: info.size, mtimeMs: info.mtimeMs }
        }
      }

      const removeFromIndex = (rel: string): Effect.Effect<void> =>
        manifest.remove(rel).pipe(
          Effect.flatMap((ids) => store.deleteIds(ids)),
          Effect.catch(() => Effect.void)
        )

      const indexCandidate = Effect.fn("Indexer.indexCandidate")(function* (candidate: Candidate) {
        const entry = yield* manifest.fileEntry(candidate.rel)
        if (
          Option.isSome(entry) &&
          entry.value.size === candidate.size &&
          entry.value.mtimeMs === candidate.mtimeMs
        ) {
          return
        }
        const bytes = yield* fs.readFile(candidate.abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!bytes) return
        if (looksBinary(bytes)) {
          yield* removeFromIndex(candidate.rel)
          return
        }
        const content = decoder.decode(bytes)
        const fileHash = sha256(content)
        const prev = Option.getOrUndefined(entry)
        if (prev && prev.fileHash === fileHash) {
          yield* manifest.record(candidate.rel, {
            fileHash,
            chunkIds: prev.chunkIds,
            size: candidate.size,
            mtimeMs: candidate.mtimeMs
          })
          return
        }
        const chunks = yield* chunker.chunk(candidate.rel, content, fileHash)
        const prevIds = prev ? prev.chunkIds : []
        const prevSet = new Set(prevIds)
        const nextIds = chunks.map((chunk) => chunk.id)
        const nextSet = new Set(nextIds)
        const toEmbed = chunks.filter((chunk) => !prevSet.has(chunk.id))
        const toDelete = prevIds.filter((id) => !nextSet.has(id))
        if (toEmbed.length > 0) {
          const vectors = yield* embeddings.embed(toEmbed.map((chunk) => chunk.embedText))
          const rows = toEmbed.map((chunk, i) => rowFromChunk(chunk, vectors[i]!))
          yield* store.upsert(rows)
        }
        if (toDelete.length > 0) yield* store.deleteIds(toDelete)
        yield* manifest.record(candidate.rel, {
          fileHash,
          chunkIds: nextIds,
          size: candidate.size,
          mtimeMs: candidate.mtimeMs
        })
      })

      const safeIndex = (candidate: Candidate): Effect.Effect<void> =>
        indexCandidate(candidate).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`semantic-search: failed to index ${candidate.rel}`, error)
          )
        )

      const stats = (): Effect.Effect<IndexStats> =>
        manifest.stats().pipe(
          Effect.map((counts) => ({
            namespace: config.namespace,
            root,
            files: counts.files,
            chunks: counts.chunks
          }))
        )

      const prepareFile = Effect.fn("Indexer.prepareFile")(function* (candidate: Candidate) {
        const entry = yield* manifest.fileEntry(candidate.rel)
        if (
          Option.isSome(entry) &&
          entry.value.size === candidate.size &&
          entry.value.mtimeMs === candidate.mtimeMs
        ) {
          return undefined
        }
        const bytes = yield* fs.readFile(candidate.abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!bytes) return undefined
        if (looksBinary(bytes)) {
          yield* removeFromIndex(candidate.rel)
          return undefined
        }
        const content = decoder.decode(bytes)
        const fileHash = sha256(content)
        const prev = Option.getOrUndefined(entry)
        const next: FileEntry = {
          fileHash,
          chunkIds: [],
          size: candidate.size,
          mtimeMs: candidate.mtimeMs
        }
        if (prev && prev.fileHash === fileHash) {
          yield* manifest.record(candidate.rel, { ...next, chunkIds: prev.chunkIds })
          return undefined
        }
        const chunks = yield* chunker.chunk(candidate.rel, content, fileHash)
        const prevIds = prev ? prev.chunkIds : []
        const prevSet = new Set(prevIds)
        const nextIds = chunks.map((chunk) => chunk.id)
        const nextSet = new Set(nextIds)
        const toEmbed = chunks.filter((chunk) => !prevSet.has(chunk.id))
        const toDelete = prevIds.filter((id) => !nextSet.has(id))
        const fileEntry: FileEntry = { ...next, chunkIds: nextIds }
        if (toEmbed.length === 0) {
          if (toDelete.length > 0) yield* store.deleteIds(toDelete).pipe(Effect.catch(() => Effect.void))
          yield* manifest.record(candidate.rel, fileEntry)
          return undefined
        }
        return { rel: candidate.rel, entry: fileEntry, toEmbed, toDelete }
      })

      interface Pending {
        readonly entry: FileEntry
        readonly toDelete: ReadonlyArray<string>
        remaining: number
      }

      interface UpsertJob {
        readonly rows: ReadonlyArray<UpsertRow>
        readonly paths: ReadonlyArray<string>
      }

      const indexAll = (): Effect.Effect<IndexStats> =>
        Effect.gen(function* () {
          const seen = new Set<string>()
          const pending = new Map<string, Pending>()
          let processed = 0
          const probe = process.env.SEMSEARCH_PROBE
            ? setInterval(() => {
                const m = process.memoryUsage()
                process.stderr.write(
                  `[probe] rss=${(m.rss / 1048576) | 0}MB heap=${(m.heapUsed / 1048576) | 0}MB ` +
                    `external=${(m.external / 1048576) | 0}MB pending=${pending.size} processed=${processed}\n`
                )
              }, 2000)
            : undefined

          const embedBatch = config.settings.indexing.embedBatch
          const consumers = config.settings.indexing.embedConcurrency
          const upsertWorkers = Math.max(1, config.settings.indexing.upsertConcurrency)
          const chunkQueue = yield* Queue.bounded<Chunk | null>(embedBatch)
          const upsertQueue = yield* Queue.bounded<UpsertJob | null>(upsertWorkers + 2)

          const finalize = (paths: ReadonlyArray<string>): Effect.Effect<void> =>
            Effect.gen(function* () {
              const completed: Array<{ rel: string; entry: FileEntry; toDelete: ReadonlyArray<string> }> = []
              for (const path of paths) {
                const p = pending.get(path)
                if (!p) continue
                p.remaining -= 1
                if (p.remaining === 0) {
                  pending.delete(path)
                  completed.push({ rel: path, entry: p.entry, toDelete: p.toDelete })
                }
              }
              for (const done of completed) {
                if (done.toDelete.length > 0) yield* store.deleteIds(done.toDelete).pipe(Effect.catch(() => Effect.void))
                yield* manifest.record(done.rel, done.entry)
              }
            })

          const embedStage = (batch: ReadonlyArray<Chunk>): Effect.Effect<void> =>
            embeddings.embed(batch.map((chunk) => chunk.embedText)).pipe(
              Effect.flatMap((vectors) =>
                Queue.offer(upsertQueue, {
                  rows: batch.map((chunk, i) => rowFromChunk(chunk, vectors[i]!)),
                  paths: batch.map((chunk) => chunk.path)
                })
              ),
              Effect.catch((error) => Effect.logWarning("semantic-search: embed batch failed", error))
            )

          const producer = Effect.gen(function* () {
            yield* Stream.fromAsyncIterable(walkGen(root), (cause) => cause).pipe(
              Stream.mapEffect(
                (candidate) => {
                  seen.add(candidate.rel)
                  return prepareFile(candidate).pipe(Effect.catch(() => Effect.succeed(undefined)))
                },
                { concurrency, unordered: true }
              ),
              Stream.runForEach((prep) => {
                if (!prep) return Effect.void
                pending.set(prep.rel, { entry: prep.entry, toDelete: prep.toDelete, remaining: prep.toEmbed.length })
                return Queue.offerAll(chunkQueue, prep.toEmbed)
              }),
              Effect.catch(() => Effect.void)
            )
            yield* Effect.forEach(Array.from({ length: consumers }), () => Queue.offer(chunkQueue, null), {
              discard: true
            })
          })

          const embedConsumer = Effect.gen(function* () {
            const buffer: Array<Chunk> = []
            while (true) {
              const item = yield* Queue.take(chunkQueue)
              if (item === null) {
                if (buffer.length > 0) yield* embedStage(buffer.splice(0))
                return
              }
              buffer.push(item)
              if (buffer.length >= embedBatch) yield* embedStage(buffer.splice(0))
            }
          })

          const upsertWorker = Effect.gen(function* () {
            while (true) {
              const job = yield* Queue.take(upsertQueue)
              if (job === null) return
              const ok = yield* store.upsert(job.rows).pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning("semantic-search: upsert failed, leaving files for retry next run", error).pipe(
                    Effect.as(false)
                  )
                )
              )
              processed += job.rows.length
              if (ok) yield* finalize(job.paths)
            }
          })

          const embedPhase = Effect.gen(function* () {
            yield* Effect.all([producer, ...Array.from({ length: consumers }, () => embedConsumer)], {
              concurrency: "unbounded",
              discard: true
            })
            yield* Effect.forEach(Array.from({ length: upsertWorkers }), () => Queue.offer(upsertQueue, null), {
              discard: true
            })
          })

          yield* Effect.all([embedPhase, ...Array.from({ length: upsertWorkers }, () => upsertWorker)], {
            concurrency: "unbounded",
            discard: true
          })

          if (probe) clearInterval(probe)
          const known = yield* manifest.knownPaths()
          const removed = known.filter((rel) => !seen.has(rel))
          yield* Effect.forEach(removed, removeFromIndex, { concurrency, discard: true })
          yield* manifest.save()
          return yield* stats()
        })

      const reindexPaths = (paths: ReadonlyArray<string>): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            paths,
            (abs) =>
              Effect.gen(function* () {
                const rel = relOf(abs)
                if (rel.startsWith("..")) return
                const info = yield* fs.stat(abs).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info || info.type !== "File") {
                  yield* removeFromIndex(rel)
                  return
                }
                const size = Number(info.size)
                if (!shouldIndexFile(rel, size, rules)) {
                  yield* removeFromIndex(rel)
                  return
                }
                const mtimeMs = Option.match(info.mtime, {
                  onNone: () => 0,
                  onSome: (date) => date.getTime()
                })
                yield* safeIndex({ rel, abs, size, mtimeMs })
              }),
            { concurrency, discard: true }
          )
          yield* manifest.save()
        })

      const clear = (): Effect.Effect<void> =>
        store.clear().pipe(
          Effect.catch(() => Effect.void),
          Effect.andThen(manifest.reset()),
          Effect.andThen(manifest.save())
        )

      return Indexer.of({ indexAll, reindexPaths, clear, stats })
    })
  )
}

import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"
import { AppConfig } from "../config/AppConfig.ts"

const FileEntrySchema = Schema.Struct({
  fileHash: Schema.String,
  chunkIds: Schema.Array(Schema.String),
  size: Schema.Number,
  mtimeMs: Schema.Number
})

export type FileEntry = typeof FileEntrySchema.Type

const ManifestSchema = Schema.Struct({
  version: Schema.Number,
  root: Schema.String,
  namespace: Schema.String,
  files: Schema.Record(Schema.String, FileEntrySchema),
  meta: Schema.Record(Schema.String, Schema.String)
})

type ManifestData = typeof ManifestSchema.Type

const decodeManifest = Schema.decodeUnknownOption(ManifestSchema)

const VERSION = 2

export class Manifest extends Context.Service<Manifest, {
  fileEntry(path: string): Effect.Effect<Option.Option<FileEntry>>
  record(path: string, entry: FileEntry): Effect.Effect<void>
  remove(path: string): Effect.Effect<ReadonlyArray<string>>
  knownPaths(): Effect.Effect<ReadonlyArray<string>>
  stats(): Effect.Effect<{ readonly files: number; readonly chunks: number }>
  getMeta(key: string): Effect.Effect<Option.Option<string>>
  setMeta(key: string, value: string): Effect.Effect<void>
  reset(): Effect.Effect<void>
  save(): Effect.Effect<void>
}>()("semantic-search/Manifest") {
  static layer = Layer.effect(
    Manifest,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(config.cacheDir, "manifest.json")

      const empty: ManifestData = {
        version: VERSION,
        root: config.root,
        namespace: config.namespace,
        files: {},
        meta: {}
      }

      const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const parsed = text === undefined ? undefined : yield* Effect.try(() => JSON.parse(text) as unknown).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const decoded = parsed === undefined ? Option.none<ManifestData>() : decodeManifest(parsed)
      if (text !== undefined && Option.isNone(decoded)) {
        yield* Effect.logWarning("semantic-search: manifest corrupt or outdated, starting fresh")
      }
      const loaded = Option.getOrElse(decoded, () => empty)
      const initial =
        loaded.version === VERSION &&
        loaded.root === config.root &&
        loaded.namespace === config.namespace
          ? loaded
          : empty

      const ref = yield* Ref.make<ManifestData>(initial)

      const save = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const data = yield* Ref.get(ref)
          yield* fs.makeDirectory(config.cacheDir, { recursive: true })
          const tmp = `${file}.${process.pid}.tmp`
          yield* fs.writeFileString(tmp, `${JSON.stringify(data)}\n`)
          yield* fs.rename(tmp, file)
        }).pipe(Effect.catch(() => Effect.void))

      return Manifest.of({
        fileEntry: (p) =>
          Ref.get(ref).pipe(Effect.map((data) => Option.fromNullishOr(data.files[p]))),
        record: (p, entry) =>
          Ref.update(ref, (data) => ({ ...data, files: { ...data.files, [p]: entry } })),
        remove: (p) =>
          Ref.modify(ref, (data) => {
            const existing = data.files[p]
            if (!existing) return [[] as ReadonlyArray<string>, data]
            const files = { ...data.files }
            delete files[p]
            return [existing.chunkIds, { ...data, files }]
          }),
        knownPaths: () => Ref.get(ref).pipe(Effect.map((data) => Object.keys(data.files))),
        stats: () =>
          Ref.get(ref).pipe(
            Effect.map((data) => {
              const files = Object.keys(data.files)
              let chunks = 0
              for (const key of files) chunks += data.files[key]!.chunkIds.length
              return { files: files.length, chunks }
            })
          ),
        getMeta: (key) =>
          Ref.get(ref).pipe(Effect.map((data) => Option.fromNullishOr(data.meta[key]))),
        setMeta: (key, value) =>
          Ref.update(ref, (data) => ({ ...data, meta: { ...data.meta, [key]: value } })),
        reset: () => Ref.set(ref, empty),
        save
      })
    })
  )
}

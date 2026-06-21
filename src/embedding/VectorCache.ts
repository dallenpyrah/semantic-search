import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { AppConfig } from "../config/AppConfig.ts"
import { sha256 } from "../domain/hash.ts"

const FLOAT_BYTES = 4

export class VectorCache extends Context.Service<VectorCache, {
  keyOf(text: string): string
  get(keys: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ReadonlyArray<number> | undefined>>
  put(entries: ReadonlyArray<readonly [string, ReadonlyArray<number>]>): Effect.Effect<void>
}>()("semantic-search/VectorCache") {
  static layer = Layer.effect(
    VectorCache,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dims = config.settings.embedding.dimensions
      const slug = `${config.settings.embedding.model.replace(/[^a-zA-Z0-9]+/g, "-")}_${dims}`
      const root = path.join(config.agentDir, "semantic-search", "vec", slug)
      const concurrency = config.settings.indexing.scanConcurrency
      const fileOf = (key: string) => path.join(root, key.slice(0, 2), key)

      const keyOf = (text: string) => sha256(text)

      const readOne = (key: string): Effect.Effect<ReadonlyArray<number> | undefined> =>
        fs.readFile(fileOf(key)).pipe(
          Effect.map((bytes) =>
            bytes.byteLength === dims * FLOAT_BYTES
              ? (Array.from(new Float32Array(bytes.slice().buffer)) as ReadonlyArray<number>)
              : undefined
          ),
          Effect.catch(() => Effect.succeed(undefined))
        )

      const get = (keys: ReadonlyArray<string>) => Effect.forEach(keys, readOne, { concurrency })

      const writeOne = ([key, vector]: readonly [string, ReadonlyArray<number>]): Effect.Effect<void> =>
        Effect.gen(function* () {
          const file = fileOf(key)
          yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.catch(() => Effect.void))
          const f32 = Float32Array.from(vector)
          const tmp = `${file}.${process.pid}.tmp`
          yield* fs
            .writeFile(tmp, new Uint8Array(f32.buffer))
            .pipe(
              Effect.flatMap(() => fs.rename(tmp, file)),
              Effect.catch(() => Effect.void)
            )
        })

      const put = (entries: ReadonlyArray<readonly [string, ReadonlyArray<number>]>) =>
        Effect.forEach(entries, writeOne, { concurrency, discard: true })

      return VectorCache.of({ keyOf, get, put })
    })
  )
}

import { Context, Effect, Layer } from "effect"
import { AppConfig } from "../config/AppConfig.ts"
import { ChunkError } from "../domain/errors.ts"
import type { Chunk } from "../domain/types.ts"
import { type ChunkBudget, chunkSource } from "./structural.ts"

export class Chunker extends Context.Service<Chunker, {
  chunk(
    path: string,
    source: string,
    fileHash: string
  ): Effect.Effect<ReadonlyArray<Chunk>, ChunkError>
}>()("semantic-search/Chunker") {
  static layer = Layer.effect(
    Chunker,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const budget: ChunkBudget = {
        targetChars: config.settings.indexing.chunkTargetChars,
        maxChars: config.settings.indexing.chunkMaxChars,
        embedCharCap: config.settings.indexing.embedTokenCap * 4
      }
      const chunk = Effect.fn("Chunker.chunk")(function* (
        path: string,
        source: string,
        fileHash: string
      ) {
        return yield* Effect.try({
          try: () => chunkSource(path, source, fileHash, budget),
          catch: (cause) => new ChunkError({ message: `failed to chunk ${path}`, path, cause })
        })
      })
      return Chunker.of({ chunk })
    })
  )
}

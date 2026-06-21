import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppConfig } from "../src/config/AppConfig.ts"
import { Embeddings } from "../src/embedding/Embeddings.ts"
import { Turbopuffer } from "../src/store/Turbopuffer.ts"
import { rowFromChunk } from "../src/store/schema.ts"
import type { Chunk } from "../src/domain/types.ts"

const live = Boolean(process.env.OPENAI_API_KEY && process.env.TURBOPUFFER_API_KEY)

const chunkOf = (id: string, path: string, text: string): Chunk => ({
  id,
  source: "code",
  path,
  language: "typescript",
  kind: "code",
  symbol: id,
  startLine: 1,
  endLine: 1,
  startByte: 0,
  endByte: text.length,
  rawText: text,
  embedText: text,
  contentHash: id,
  fileHash: "f"
})

describe.skipIf(!live)("live store + embeddings round trip", () => {
  test("embed, upsert, hybrid query returns the relevant chunk first", async () => {
    const root = mkdtempSync(join(tmpdir(), "semsearch-live-"))
    const layer = Layer.mergeAll(Embeddings.layer, Turbopuffer.layer).pipe(
      Layer.provide(AppConfig.layer({ root, trusted: true })),
      Layer.provide(NodeServices.layer)
    )

    const program = Effect.gen(function* () {
      const embeddings = yield* Embeddings
      const store = yield* Turbopuffer

      const chunks = [
        chunkOf("auth", "src/auth/jwt.ts", "export const verifyJwt = (token: string) => jwt.verify(token, secret)"),
        chunkOf("docs", "docs/auth.md", "Authentication validates sessions using bearer tokens and a refresh flow"),
        chunkOf("csv", "src/util/csv.ts", "export const parseCsv = (s: string) => s.split(',').map((x) => x.trim())")
      ]
      const vectors = yield* embeddings.embed(chunks.map((c) => c.rawText))
      const rows = chunks.map((c, i) => rowFromChunk(c, vectors[i]!))
      yield* store.upsert(rows)

      const queryVector = (yield* embeddings.embed(["where do we verify authentication tokens?"]))[0]!
      const attrs = ["path", "text", "language", "kind", "startLine", "endLine"]
      const response = yield* store.query({
        queries: [
          { rank_by: ["vector", "ANN", queryVector], top_k: 5, include_attributes: attrs },
          { rank_by: ["text", "BM25", "verify authentication tokens"], top_k: 5, include_attributes: attrs }
        ],
        rerank_by: ["RRF", { rank_constant: 60 }]
      })
      yield* store.clear()

      return { dimensions: embeddings.dimensions, response }
    })

    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result.dimensions).toBe(3072)
    const rows = result.response.results[0]?.rows ?? []
    const paths = rows.map((r) => r.path)
    expect(rows.length).toBeGreaterThan(0)
    expect(["src/auth/jwt.ts", "docs/auth.md"]).toContain(rows[0]?.path ?? "")
    expect(paths.indexOf("src/util/csv.ts")).toBe(paths.length - 1)
  }, 60_000)
})

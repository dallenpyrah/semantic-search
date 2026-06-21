import { Array as Arr, Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AppConfig } from "../../src/config/AppConfig.ts"
import { Embeddings } from "../../src/embedding/Embeddings.ts"
import { Reranker } from "../../src/rerank/Reranker.ts"
import { Turbopuffer } from "../../src/store/Turbopuffer.ts"
import type { MultiQueryBody, SubQuery, UpsertRow } from "../../src/store/schema.ts"
import { fuse } from "../../src/search/fuse.ts"
import { loadSplit } from "./hf.ts"
import { type Qrels, type Run, score, toTrecRun } from "./metrics.ts"

interface Source {
  readonly repo: string
  readonly config: string
  readonly split: string
}
interface TaskSpec {
  readonly corpus: Source
  readonly queries: Source
  readonly qrels: Source & { readonly qKey: string; readonly dKey: string }
}

const TASKS: Record<string, TaskSpec> = {
  cosqa: {
    corpus: { repo: "CoIR-Retrieval/cosqa", config: "corpus", split: "corpus" },
    queries: { repo: "CoIR-Retrieval/cosqa", config: "queries", split: "queries" },
    qrels: { repo: "CoIR-Retrieval/cosqa", config: "default", split: "test", qKey: "query-id", dKey: "corpus-id" }
  },
  "codetrans-dl": {
    corpus: { repo: "CoIR-Retrieval/codetrans-dl-queries-corpus", config: "default", split: "corpus" },
    queries: { repo: "CoIR-Retrieval/codetrans-dl-queries-corpus", config: "default", split: "queries" },
    qrels: { repo: "CoIR-Retrieval/codetrans-dl-qrels", config: "default", split: "test", qKey: "query_id", dKey: "corpus_id" }
  }
}

const arg = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

const taskName = arg("task", "codetrans-dl")
const mode = arg("mode", "hybrid") as "embedding" | "semantic" | "hybrid"
const limit = Number(arg("limit", "100"))
const maxQueries = Number(arg("max-queries", "0"))
const rerankOn = !has("no-rerank") && mode !== "embedding"
const spec = TASKS[taskName]
if (!spec) throw new Error(`unknown task ${taskName}; known: ${Object.keys(TASKS).join(", ")}`)

const CACHE = join(import.meta.dirname, ".cache")
const ATTRS = ["text", "path", "language", "kind"]

const program = Effect.gen(function* () {
  const config = yield* AppConfig
  const embeddings = yield* Embeddings
  const store = yield* Turbopuffer
  const reranker = yield* Reranker
  const namespace = config.namespace

  const corpusRows = yield* Effect.promise(() => loadSplit(spec.corpus.repo, spec.corpus.config, spec.corpus.split))
  const queryRows = yield* Effect.promise(() => loadSplit(spec.queries.repo, spec.queries.config, spec.queries.split))
  const qrelRows = yield* Effect.promise(() => loadSplit(spec.qrels.repo, spec.qrels.config, spec.qrels.split))

  const qrels: Qrels = new Map()
  for (const row of qrelRows) {
    const qid = String(row[spec.qrels.qKey])
    const did = String(row[spec.qrels.dKey])
    const sc = Number(row["score"] ?? 1)
    if (!qrels.has(qid)) qrels.set(qid, new Map())
    qrels.get(qid)!.set(did, sc)
  }
  let testQids = Array.from(qrels.keys()).sort()
  if (maxQueries > 0) testQids = testQids.slice(0, maxQueries)
  const qidSet = new Set(testQids)
  const queryText = new Map<string, string>()
  for (const row of queryRows) {
    const id = String(row["_id"])
    if (qidSet.has(id)) queryText.set(id, String(row["text"] ?? ""))
  }

  const corpus = corpusRows.map((row) => ({
    id: String(row["_id"]),
    text: String(row["text"] ?? ""),
    language: String(row["language"] ?? "code").toLowerCase()
  }))

  mkdirSync(CACHE, { recursive: true })
  const marker = join(CACHE, `${namespace}.indexed`)
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== String(corpus.length)) {
    yield* Effect.log(`indexing ${corpus.length} corpus docs into ${namespace} ...`)
    let done = 0
    for (const batch of Arr.chunksOf(corpus, 256)) {
      const vectors = yield* embeddings.embed(batch.map((doc) => doc.text))
      const rows: ReadonlyArray<UpsertRow> = batch.map((doc, i) => ({
        id: doc.id,
        source: "code",
        vector: vectors[i]!,
        text: doc.text,
        pathText: doc.id,
        path: doc.id,
        language: doc.language,
        kind: "code",
        startLine: 1,
        endLine: 1,
        fileHash: doc.id,
        chunkHash: doc.id
      }))
      yield* store.upsert(rows)
      done += batch.length
      yield* Effect.log(`  upserted ${done}/${corpus.length}`)
    }
    writeFileSync(marker, String(corpus.length))
  } else {
    yield* Effect.log(`corpus already indexed in ${namespace} (${corpus.length} docs)`)
  }

  const run: Run = new Map()
  const runScores = new Map<string, Map<string, number>>()
  const queryVectors = yield* embeddings.embed(testQids.map((qid) => queryText.get(qid) ?? ""))

  const start = Date.now()
  yield* Effect.forEach(
    testQids,
    (qid, index) =>
      Effect.gen(function* () {
        const vector = queryVectors[index]!
        const text = queryText.get(qid) ?? ""
        const queries: ReadonlyArray<SubQuery> =
          mode === "hybrid"
            ? [
                { rank_by: ["vector", "ANN", vector], top_k: 200, include_attributes: ATTRS },
                { rank_by: ["text", "BM25", text], top_k: 200, include_attributes: ATTRS }
              ]
            : [{ rank_by: ["vector", "ANN", vector], top_k: 200, include_attributes: ATTRS }]
        const body: MultiQueryBody = { queries }
        const response = yield* store.query(body)
        const lists = response.results.map((r) => r.rows ?? [])
        const sourceNames = mode === "hybrid" ? ["semantic", "text"] : ["semantic"]
        let fused = fuse(lists, sourceNames, text, 60, undefined)

        if (rerankOn && reranker.enabled && fused.length > 1) {
          const poolSize = Math.min(fused.length, 100)
          const pool = fused.slice(0, poolSize)
          const rankings = yield* reranker.rerank(text, pool.map((c) => String(c.row.text ?? "")), poolSize)
          if (rankings.length > 0) {
            const head = rankings
              .map((r) => pool[r.index])
              .filter((c): c is (typeof pool)[number] => c !== undefined)
            fused = [...head, ...fused.slice(poolSize)]
          }
        }

        const ranked = fused.slice(0, limit).map((c) => c.id)
        run.set(qid, ranked)
        const sm = new Map<string, number>()
        fused.slice(0, limit).forEach((c, r) => sm.set(c.id, fused.length - r))
        runScores.set(qid, sm)
      }),
    { concurrency: 8, discard: true }
  )
  const queryMs = Date.now() - start

  return { qrels, run, runScores, namespace, corpusSize: corpus.length, queries: testQids.length, queryMs }
})

const main = async () => {
  const modelSlug = "te3l"
  const dims = 3072
  const namespaceOverride = `coir_${taskName}_${modelSlug}_${dims}`
  const result = await Effect.runPromise(
    Effect.provide(
      program,
      Layer.mergeAll(Embeddings.layer, Turbopuffer.layer, Reranker.layer).pipe(
        Layer.provideMerge(AppConfig.layer({ root: process.cwd(), trusted: true, namespaceOverride })),
        Layer.provide(NodeServices.layer)
      )
    )
  )

  const card = score(result.qrels, result.run)
  const scorecard = {
    task: taskName,
    mode,
    rerank: rerankOn,
    namespace: result.namespace,
    corpusSize: result.corpusSize,
    queries: result.queries,
    queryMs: result.queryMs,
    msPerQuery: Math.round(result.queryMs / Math.max(1, result.queries)),
    ndcg10: card.ndcg[10] ?? 0,
    mrr10: card.mrr[10] ?? 0,
    recall: card.recall,
    success: card.success
  }
  process.stdout.write(`${JSON.stringify(scorecard, null, 2)}\n`)
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(
    join(CACHE, `run_${taskName}_${mode}${rerankOn ? "_rr" : ""}.trec`),
    toTrecRun(result.run, result.runScores, `semsearch-${mode}`)
  )
  process.stdout.write(
    `\nCoIR ${taskName} [${mode}${rerankOn ? "+rerank" : ""}]  nDCG@10=${(scorecard.ndcg10 * 100).toFixed(2)}  ` +
      `MRR@10=${(scorecard.mrr10 * 100).toFixed(2)}  R@10=${((scorecard.recall[10] ?? 0) * 100).toFixed(2)}  ` +
      `R@100=${((scorecard.recall[100] ?? 0) * 100).toFixed(2)}  ${scorecard.msPerQuery}ms/q\n`
  )
}

await main()

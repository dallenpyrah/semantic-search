export type Qrels = Map<string, Map<string, number>>
export type Run = Map<string, ReadonlyArray<string>>

const dcg = (gains: ReadonlyArray<number>): number => {
  let sum = 0
  for (let i = 0; i < gains.length; i += 1) {
    sum += (2 ** gains[i]! - 1) / Math.log2(i + 2)
  }
  return sum
}

const ndcgAt = (ranked: ReadonlyArray<string>, rel: Map<string, number>, k: number): number => {
  const gains = ranked.slice(0, k).map((id) => rel.get(id) ?? 0)
  const ideal = Array.from(rel.values()).sort((a, b) => b - a).slice(0, k)
  const idcg = dcg(ideal)
  return idcg === 0 ? 0 : dcg(gains) / idcg
}

const recallAt = (ranked: ReadonlyArray<string>, rel: Map<string, number>, k: number): number => {
  const relevant = Array.from(rel.entries()).filter(([, score]) => score > 0).map(([id]) => id)
  if (relevant.length === 0) return 0
  const top = new Set(ranked.slice(0, k))
  const hit = relevant.filter((id) => top.has(id)).length
  return hit / relevant.length
}

const successAt = (ranked: ReadonlyArray<string>, rel: Map<string, number>, k: number): number => {
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    if ((rel.get(ranked[i]!) ?? 0) > 0) return 1
  }
  return 0
}

const reciprocalRankAt = (ranked: ReadonlyArray<string>, rel: Map<string, number>, k: number): number => {
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    if ((rel.get(ranked[i]!) ?? 0) > 0) return 1 / (i + 1)
  }
  return 0
}

export interface Scorecard {
  readonly queries: number
  readonly ndcg: Record<number, number>
  readonly recall: Record<number, number>
  readonly success: Record<number, number>
  readonly mrr: Record<number, number>
}

export const score = (
  qrels: Qrels,
  run: Run,
  ndcgKs: ReadonlyArray<number> = [10],
  recallKs: ReadonlyArray<number> = [1, 5, 10, 100],
  mrrKs: ReadonlyArray<number> = [10]
): Scorecard => {
  const qids = Array.from(qrels.keys()).filter((qid) => (qrels.get(qid)?.size ?? 0) > 0)
  const n = qids.length || 1
  const mean = (fn: (qid: string) => number) => qids.reduce((sum, qid) => sum + fn(qid), 0) / n

  const ndcg: Record<number, number> = {}
  const recall: Record<number, number> = {}
  const success: Record<number, number> = {}
  const mrr: Record<number, number> = {}
  const ranked = (qid: string) => run.get(qid) ?? []
  const rel = (qid: string) => qrels.get(qid) ?? new Map<string, number>()

  for (const k of ndcgKs) ndcg[k] = Number(mean((qid) => ndcgAt(ranked(qid), rel(qid), k)).toFixed(5))
  for (const k of recallKs) {
    recall[k] = Number(mean((qid) => recallAt(ranked(qid), rel(qid), k)).toFixed(5))
    success[k] = Number(mean((qid) => successAt(ranked(qid), rel(qid), k)).toFixed(5))
  }
  for (const k of mrrKs) mrr[k] = Number(mean((qid) => reciprocalRankAt(ranked(qid), rel(qid), k)).toFixed(5))

  return { queries: qids.length, ndcg, recall, success, mrr }
}

export const toTrecRun = (run: Run, scores: Map<string, Map<string, number>>, tag: string): string => {
  const lines: Array<string> = []
  for (const [qid, ranked] of run) {
    const qScores = scores.get(qid)
    ranked.forEach((docid, rank) => {
      const s = qScores?.get(docid) ?? 1 / (rank + 1)
      lines.push(`${qid} Q0 ${docid} ${rank + 1} ${s.toFixed(6)} ${tag}`)
    })
  }
  return lines.join("\n")
}

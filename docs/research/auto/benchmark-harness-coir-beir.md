# Benchmark Harness: run CoIR/BEIR against OUR retriever, score leaderboard-comparable nDCG@10

Status: grounding brief for an auto-research/improve loop. Self-contained and runnable in this repo.
Date: 2026-06-20. Author: research subagent.

## Decision (one screen)

Build a **Bun harness that loads a CoIR dataset from HuggingFace as raw files, materializes the
corpus as one-file-per-doc on disk, indexes it ONCE into a dedicated TurboPuffer namespace via our
existing `Indexer`, runs the benchmark queries through our `Search` returning ranked benchmark
doc-ids, emits a TREC run file, and scores it with a 15-line Python step using `pytrec-eval-terrier`
(the exact library BEIR/CoIR use).** Do NOT port scoring to TS — pin to the canonical evaluator so
the number is apples-to-apples with the leaderboard.

- First target dataset: **CodeTrans-DL** (`CoIR-Retrieval/codetrans-dl-*`) — 180 test queries, 816
  corpus docs. Smallest in CoIR → cheapest first run (~816 embeds, one-time). Leaderboard baseline:
  OpenAI-Ada-002 = **53.34** nDCG@10; top model Voyage-Code-002 = **72.77**. Our stack uses
  `text-embedding-3-large` (newer than Ada-002), so > 53.34 is the floor we must clear; beating
  ~72.77 is the "#1" north star on this slice.
- Core trade-off: **one cross-language process boundary (Bun → Python scoring) vs. re-implementing
  trec_eval's nDCG/MRR in TS and risking silent metric drift.** We take the boundary; the run file is
  a stable, debuggable artifact and the Python step is dependency-frozen.

## Problem, from first principles

- **True now:** our retriever indexes *filesystem files*, chunks them (cAST), embeds chunks, and
  returns ranked **chunks** carrying `{path, startLine, endLine, score}`. Our internal eval scores
  binary single-gold over file paths (`eval/retrieval.ts`) — not comparable to any leaderboard.
- **Must remain true:** we do not rebuild the pipeline. Index-once, cache embeddings across runs,
  pinned dataset version, fixed sample. Score with the *same* evaluator the leaderboard uses.
- **Want true:** feed a benchmark whose unit of retrieval is a *corpus document* (not our chunk),
  get a single nDCG@10 that sits on the CoIR scale, and make it reproducible + cheap so an autonomous
  agent can run it every iteration and watch the number move.

The gap: (1) a corpus-doc → file mapping so our chunk results roll up to benchmark doc-ids; (2) a
pinned loader for CoIR's BEIR-schema data; (3) the canonical scorer.

---

## 1. Benchmark data format (CoIR / CodeSearchNet / BEIR-style)

CoIR is **schema-identical to BEIR/MTEB** (the paper states it aligns to "the same data schema as
MTEB and BEIR for easy cross-benchmark evaluation"). Three logical components:

- **corpus**: documents. Fields: `_id` (string), `text` (string), `title` (string, optional).
  Source: `https://arxiv.org/html/2407.02883v1`, `beir` wiki Load-your-custom-dataset.
- **queries**: Fields: `_id` (string), `text` (string).
- **qrels**: relevance judgments. Three columns: `query-id`, `corpus-id`, `score` (int, graded
  relevance; for code retrieval usually binary 1). Tab-separated, header row present.

### Canonical on-disk BEIR layout (what `GenericDataLoader` expects)
```
<dataset>/
  corpus.jsonl        # {"_id": "doc1", "title": "...", "text": "..."}
  queries.jsonl       # {"_id": "q1", "text": "..."}
  qrels/
    test.tsv          # header: query-id<TAB>corpus-id<TAB>score   then rows
```
Source: https://github.com/beir-cellar/beir/wiki/Load-your-custom-dataset

### How CoIR ships on HuggingFace (the actual download)
CoIR's `coir.data_loader` constructs two HF repos per task:
- `CoIR-Retrieval/{task}-queries-corpus` — has splits **`corpus`** and **`queries`**, JSON rows with
  `_id`, `text`, `title` (corpus) / `_id`, `text` (queries).
- `CoIR-Retrieval/{task}-qrels` — split **`test`**, TSV-ish rows `query_id, corpus_id, score(int)`.

Special case: `codesearchnet` and `codesearchnet-ccr` expand into per-language subtasks
(`go, java, javascript, ruby, python, php`) loaded separately.
Source: https://raw.githubusercontent.com/CoIR-team/coir/main/coir/data_loader.py

The 10 CoIR datasets (HF org `CoIR-Retrieval`): `codetrans-dl`, `stackoverflow-qa`, `apps`,
`codefeedback-mt`, `codefeedback-st`, `codetrans-contest`, `synthetic-text2sql`, `cosqa`,
`codesearchnet`, `codesearchnet-ccr`.  Source: https://github.com/coir-team/coir

### Dataset sizes (pick cheap first; from CoIR paper Table 2)
| Dataset | #test queries | #corpus | Lang |
|---|---|---|---|
| **CodeTrans-DL** | 180 | 816 | Python | ← cheapest, start here |
| CodeTrans-Contest | 446 | ~1K | C++/Python |
| CoSQA | 500 | 21K | Python |
| StackOverflow-QA | ~2K | 20K | mixed |
| APPS | ~3.8K | 9K | Python |
Source: https://arxiv.org/html/2407.02883v1

### How to load (recommended: raw files, no coir/beir python at index time)
We do NOT need the `coir` python package to *index* — it only matters for *download* and *scoring*.
Two equivalent download paths:

**(a) `datasets` (pinned revision) — recommended for reproducibility:**
```python
# scripts/bench_fetch.py  (run once per dataset; writes BEIR-layout files)
from datasets import load_dataset
import json, os, sys
task = sys.argv[1]                 # e.g. "codetrans-dl"
rev  = sys.argv[2]                 # pinned commit sha of the HF dataset repo
out  = f"eval/bench/data/{task}"
os.makedirs(f"{out}/qrels", exist_ok=True)
qc = load_dataset(f"CoIR-Retrieval/{task}-queries-corpus", revision=rev)
qr = load_dataset(f"CoIR-Retrieval/{task}-qrels", revision=rev)
with open(f"{out}/corpus.jsonl","w") as f:
    for r in qc["corpus"]:
        f.write(json.dumps({"_id": r["_id"], "title": r.get("title",""), "text": r["text"]})+"\n")
with open(f"{out}/queries.jsonl","w") as f:
    for r in qc["queries"]:
        f.write(json.dumps({"_id": r["_id"], "text": r["text"]})+"\n")
with open(f"{out}/qrels/test.tsv","w") as f:
    f.write("query-id\tcorpus-id\tscore\n")
    for r in qr["test"]:
        f.write(f'{r["query-id"]}\t{r["corpus-id"]}\t{int(r["score"])}\n')
```
Pin `rev` (the dataset repo commit) so the corpus never silently changes. `huggingface-cli` can fetch
the sha; record it in the scorecard.

**(b) Bun-native (no python for fetch):** HF serves parquet over HTTPS; you can read it from Bun, but
`datasets` is the path of least resistance and we already need python for scoring. Keep fetch in
python, keep the index+search in Bun.

---

## 2. How official evaluators compute the metrics (exact, apples-to-apples)

CoIR vendors **BEIR's `EvaluateRetrieval`** (`coir.beir.retrieval.evaluation`), which wraps
**`pytrec_eval`** (CoIR pins `pytrec-eval-terrier`, a drop-in fork that fixes install — same numbers).
Sources: coir `evaluation.py`, https://github.com/cvangysel/pytrec_eval,
https://pypi.org/project/pytrec-eval-terrier/

### pytrec_eval contract (THE scoring API)
- `qrels`  : `{query_id: {doc_id: relevance_int}}`
- `run`    : `{query_id: {doc_id: score_float}}`
- evaluator: `pytrec_eval.RelevanceEvaluator(qrels, {measure_strings})`
- `evaluator.evaluate(run)` → `{query_id: {measure_name: value}}`, you average across queries.
Source: https://github.com/cvangysel/pytrec_eval

### Exact measure strings BEIR constructs (verbatim shape)
```python
map_string       = "map_cut."  + ",".join(map(str, k_values))   # e.g. "map_cut.1,3,5,10,100,1000"
ndcg_string      = "ndcg_cut." + ",".join(map(str, k_values))
recall_string    = "recall."   + ",".join(map(str, k_values))
precision_string = "P."        + ",".join(map(str, k_values))
evaluator = pytrec_eval.RelevanceEvaluator(qrels, {map_string, ndcg_string, recall_string, precision_string})
scores = evaluator.evaluate(results)
# read keys: scores[qid][f"ndcg_cut_{k}"], [f"recall_{k}"], [f"P_{k}"], [f"map_cut_{k}"]
# aggregate: ndcg[f"NDCG@{k}"] = round(sum(scores[qid][f"ndcg_cut_{k}"] for qid in scores)/len(scores), 5)
```
Default `k_values = [1, 3, 5, 10, 100, 1000]`.
Source: https://raw.githubusercontent.com/beir-cellar/beir/main/beir/retrieval/evaluation.py

### nDCG@10 formula (what `ndcg_cut_10` is)
For one query, with relevance `rel_i` at rank position i (1-indexed) in the *retrieved* order:
```
DCG@10  = Σ_{i=1..10}  (2^{rel_i} - 1) / log2(i + 1)
IDCG@10 = DCG@10 of the ideal ordering (qrels sorted by rel desc)
nDCG@10 = DCG@10 / IDCG@10
```
Reported value = mean of per-query nDCG@10, rounded to 5 dp. trec_eval uses the `2^rel - 1` gain
form. For binary qrels (code retrieval is usually rel∈{0,1}), `2^1-1 = 1`, so it reduces to
`Σ 1/log2(rank+1)` over the relevant hits in top-10 divided by IDCG.

### MRR formula (BEIR `mrr(qrels, results, k_values)`)
```python
for rank, hit in enumerate(top_hits[query_id][0:k]):   # top_hits sorted by score desc
    if hit[0] in query_relevant_docs:
        MRR[f"MRR@{k}"] += 1.0 / (rank + 1)
        break
# then divide by #queries, round 5dp
```
Source: https://raw.githubusercontent.com/beir-cellar/beir/main/beir/retrieval/custom_metrics.py
NOTE: BEIR's MRR is **MRR@k** (cut at k); it is NOT pytrec_eval's `recip_rank` (which is uncut).
The leaderboard's primary metric is **nDCG@10**, so optimize and report that; report MRR@10 too.

### Recall@k
`recall_k` (pytrec_eval) = (#relevant docs retrieved in top-k) / (#relevant docs in qrels), averaged.

---

## 3. Harness architecture (index-once, cache, reproducible)

```
                 ┌─────────────────────── one-time per (dataset,rev,config) ──────────────────────┐
 HF dataset      │  bench_fetch.py        materialize          Indexer.indexAll()                 │
 (pinned rev) ──►│  corpus/queries/qrels ─► eval/bench/work/<task>/corpus/<docid>.<ext> ──► TPUF  │
                 │                          (1 file per corpus doc)            namespace=bench_…   │
                 └────────────────────────────────────────────────────────────────────────────────┘
                                                         │ cached: namespace persists; manifest gates re-embed
                                                         ▼
 queries.jsonl ─► Search.semantic/hybrid(query, {limit:100, rerank, perFile:large}) ─► chunk hits
                                                         │ rollup: chunk.path → doc_id, keep max score per doc
                                                         ▼
                                          run: {qid: {docid: score}}  ──►  run.trec (TREC format)
                                                         │
                                                         ▼
                                  bench_score.py (pytrec-eval-terrier)  ──►  nDCG@10, MRR@10, Recall@{1,10,100}
```

### Corpus-doc → file mapping (the crux)
Our `Indexer` only indexes filesystem files and our `SearchHit` carries `path` (and chunk `id`), not
an arbitrary doc-id. So **make the doc-id recoverable from the path**: write each corpus doc to
`work/<task>/corpus/<sanitized_doc_id>.<ext>` where `<ext>` is chosen from the dataset language
(`.py`, `.go`, `.java`, …) so our cAST chunker treats it as code. Keep a sidecar
`docid_map.json: {relpath -> _id}` because `_id` may contain chars unsafe for filenames (sanitize +
map; do not try to reverse the sanitization).

Why this is the right seam: it reuses the entire pipeline (walk → chunk → embed → upsert → hybrid →
rerank) with **zero changes to src/**. The benchmark is just "a repo on disk." Our chunker may split
a doc into N chunks; that is fine — see rollup.

### Chunk → doc rollup (chunks are not the retrieval unit; docs are)
A corpus doc can produce multiple chunks. Our `Search` already de-dups per file via `diversify` +
`perFile`, but for benchmarking we want **document-level scoring**: collapse all chunk hits for a doc
to one entry, score = max chunk score (BEIR convention for passage→doc is max-pool). Set `perFile`
high (e.g. = limit) so diversify doesn't drop the 2nd chunk before we roll up, request `limit=100`
(we need top-100 for Recall@100 and trec_eval cuts), then:
```
docScore[doc_id] = max over chunk hits with that doc_id of hit.score
```
Map `hit.path` → `doc_id` via `docid_map.json`. Emit those (doc_id, score) pairs as the run.

### Cost control / reproducibility
- **Index once.** Namespace = `bench_<schemaVer>_<task>_<configsig>`. Our `Indexer` manifest +
  content-addressed chunk ids mean re-runs re-embed nothing (manifest gate skips unchanged files;
  chunk ids are content hashes). Across harness runs the TPUF namespace persists → **zero re-embed
  cost** for query-only iterations.
- **Pin dataset rev** (HF commit sha) in fetch + scorecard. Pin `text-embedding-3-large@3072d`,
  rerank model, fusion constants — all already in our `settingsSignature`, which feeds the namespace,
  so a config change → new namespace → honest re-index (no stale mixing).
- **Fixed subset for fast iters:** sample first N query-ids deterministically (sorted, take N) and
  restrict qrels to them. Full run only on "candidate is better" gate. CodeTrans-DL is already tiny
  (180q/816docs) — run it in full; subsample only the big ones (StackOverflow-QA, APPS).
- One-time embed cost for CodeTrans-DL corpus: 816 docs × few chunks ≈ < $0.05 at 3-large pricing.

---

## 4. Run our system AS a retriever returning benchmark doc-ids

Yes. The harness wraps `Search` so its output is `{qid: {benchmark_doc_id: score}}`. The key contract:
**every doc-id we emit must be a real `corpus-id` from the dataset** (else pytrec_eval ignores it; it
only credits ids that appear in qrels' universe, but unjudged retrieved docs still occupy ranks and
depress nDCG — exactly as the leaderboard sees them). Because we materialized one file per corpus doc
and map path→doc-id, every hit maps to a valid corpus-id by construction. Docs we never retrieve
simply don't appear in the run — trec_eval treats missing as not-retrieved (correct).

Edge: if our chunker drops a doc (e.g. file too small / filtered by `shouldIndexFile`), that doc is
unindexed and can't be retrieved → it silently caps recall. **Verification check:** after indexing,
assert `indexed_doc_ids ⊇ corpus_ids` (or log the gap). A coverage < 100% is a real, reportable
limitation, not a bug to hide — it's a chunking/ignore-rule finding the improve-loop should act on.

---

## 5. Bun vs Python: emit run file, score in tiny Python (DECISION)

**Decision: (b) Bun harness emits a TREC run file; score with a ~15-line Python step using
`pytrec-eval-terrier`.** Do not port scoring to TS.

Why: trec_eval's nDCG has subtle tie-breaking and gain/discount conventions; a TS re-implementation
risks a silent half-point drift that invalidates leaderboard comparison. The Python step is frozen
(`pip install pytrec-eval-terrier==0.5.10`, `beir` optional for MRR util), deterministic, and the run
file is an inspectable artifact. The cross-language boundary is one subprocess call, logged.

### Exact TREC run file format (what bench_score.py reads)
```
<query_id> Q0 <doc_id> <rank> <score> <run_tag>
```
- space- or tab-separated; 6 columns; `Q0` is a literal placeholder; `rank` is 1-based int;
  `score` float desc; `run_tag` an arbitrary system name (e.g. `semsearch-hybrid`).
- Example line: `q17 Q0 doc_842 1 0.8123 semsearch-hybrid`
- pytrec_eval ignores `rank` and re-sorts by `score` — so `score` must be the source of truth and
  strictly carry our final ordering (use the reranked/fused score; if ties matter, add a tiny
  epsilon by descending rank so ties resolve to our order).
Sources: https://github.com/usnistgov/trec_eval, BEIR evaluation.

### qrels file format (already produced by bench_fetch as test.tsv; convert for trec_eval if needed)
trec_eval qrels: `<query_id> 0 <doc_id> <relevance>` (space/tab). Our `test.tsv` is BEIR
`query-id<TAB>corpus-id<TAB>score` with header — `pytrec_eval` in-python wants the **dict** form, so
bench_score.py reads test.tsv into `{qid:{docid:int(score)}}` directly; no trec_eval CLI needed.

### bench_score.py (the entire scorer)
```python
# scripts/bench_score.py  <data_dir> <run.trec>  ->  prints JSON scorecard
import sys, json, pytrec_eval
data_dir, run_path = sys.argv[1], sys.argv[2]
qrels = {}
with open(f"{data_dir}/qrels/test.tsv") as f:
    next(f)                                   # skip header
    for line in f:
        q, d, s = line.rstrip("\n").split("\t")
        qrels.setdefault(q, {})[d] = int(s)
run = {}
with open(run_path) as f:
    for line in f:
        q, _q0, d, _rank, score, _tag = line.split()
        run.setdefault(q, {})[d] = float(score)
ks = [1, 3, 5, 10, 100]
ev = pytrec_eval.RelevanceEvaluator(
    qrels, {f"ndcg_cut.{','.join(map(str,ks))}",
            f"recall.{','.join(map(str,ks))}",
            f"map_cut.{','.join(map(str,ks))}",
            "recip_rank"})
per = ev.evaluate(run)
n = len(per)
def avg(key): return round(sum(per[q][key] for q in per)/n, 5)
out = {
  "queries": n,
  "ndcg@10":   avg("ndcg_cut_10"),
  "ndcg@1":    avg("ndcg_cut_1"),
  "recall@10": avg("recall_10"),
  "recall@100":avg("recall_100"),
  "map@10":    avg("map_cut_10"),
  "mrr":       avg("recip_rank"),   # uncut MRR; for MRR@10 use BEIR mrr() util
}
print(json.dumps(out, indent=2))
```
Note: `recip_rank` is uncut MRR. If you want leaderboard-exact **MRR@10**, import BEIR's `mrr`:
`from beir.retrieval.custom_metrics import mrr; mrr(qrels, run, [10])`. nDCG@10 is the headline metric
either way and is fully covered above.

---

## Files to build (this repo)

```
eval/bench/
  fetch.ts            # Effect: shell out to scripts/bench_fetch.py (or pure-Bun parquet read), pin rev
  materialize.ts      # write corpus.jsonl docs -> work/<task>/corpus/<sanitized>.<ext> + docid_map.json
  run.ts              # MAIN: appLayer({root: work/<task>, trusted:true}); Indexer.indexAll();
                      #   for each query: Search.hybrid(q,{limit:100,perFile:100}); rollup chunk->doc (max);
                      #   write run.trec; assert corpus coverage; then spawn scripts/bench_score.py
  metrics.ts          # OPTIONAL TS sanity-check nDCG@10 to cross-check python (not the source of truth)
scripts/
  bench_fetch.py      # HF download -> BEIR-layout files (pinned revision)
  bench_score.py      # pytrec-eval-terrier -> JSON scorecard  (see above, verbatim)
docs/research/auto/benchmark-harness-coir-beir.md   # this file
```

### Commands (end-to-end, CodeTrans-DL)
```bash
# 0. one-time python deps (frozen)
python3 -m pip install "pytrec-eval-terrier==0.5.10" "datasets>=2.19" "beir>=2.0"

# 1. fetch + pin (writes eval/bench/data/codetrans-dl/{corpus,queries.jsonl,qrels/test.tsv})
python3 scripts/bench_fetch.py codetrans-dl <PINNED_HF_REV>

# 2. materialize corpus to a repo-on-disk + index-once + search + emit run.trec + score
bun eval/bench/run.ts --task codetrans-dl --mode hybrid --limit 100
#    -> prints {"ndcg@10": ..., "mrr": ..., "recall@10": ...}
```
Requires env: `OPENAI_API_KEY`, `TURBOPUFFER_API_KEY`, `OPENROUTER_API_KEY` (rerank). Namespace is
derived from config signature, so the index persists and re-runs are query-only (no re-embed).

---

## Comparison targets (CoIR leaderboard, nDCG@10)

| Dataset | OpenAI-Ada-002 | Top model | Top = |
|---|---|---|---|
| **CodeTrans-DL** | 53.34 | 72.77 | Voyage-Code-002 |
| StackOverflow-QA | 72.4 | 91.54 | E5-Mistral |
| CoSQA | 28.88 | 31.27 | E5-Mistral |
| CodeSearchNet | 74.21 | 74.21 | OpenAI-Ada-002 |
| **Overall mean** | 45.59 (Ada-002) | 67.41 | SFR-Embedding-Code-2B_R |

Leaderboard top-5 mean nDCG@10: SFR-Embedding-Code-2B_R 67.41, CodeSage-large-v2 64.18,
SFR-Embedding-Code-400M_R 61.89, CodeSage-large 61.04, Voyage-Code-002 56.26.
Sources: https://archersama.github.io/coir/ , https://arxiv.org/html/2407.02883v1
NOTE: `text-embedding-3-large` is NOT on the public CoIR leaderboard — running it through our harness
produces a genuinely new, citable data point. Our advantage is the **full pipeline** (hybrid BM25+ANN
fusion + Cohere rerank-v3.5), not just the embedder, so we can plausibly clear Ada-002 and contend
with the dense-only top models on per-dataset slices.

---

## Risks / blocking unknowns

- **MRR definition mismatch:** leaderboard MRR@k ≠ pytrec_eval `recip_rank` (uncut). Use BEIR's
  `mrr()` for leaderboard-exact MRR@10. nDCG@10 (headline) is unaffected. (Resolved above.)
- **Corpus coverage < 100%:** our `shouldIndexFile`/ignore rules or tiny-file filters may drop some
  corpus docs → caps Recall. Must assert coverage and report it; it's a real finding, not hidden.
- **CodeTrans-DL docs are whole programs:** if a doc exceeds our chunk-max it splits into many chunks;
  max-pool rollup handles scoring, but verify `perFile` doesn't prune the winning chunk pre-rollup
  (set perFile≈limit).
- **HF revision sha:** must capture the exact dataset commit; `datasets` defaults to latest. Pin it.
- **Score ties:** pytrec_eval re-sorts by score and breaks ties by doc-id internally → can differ
  from our order on exact-tie scores. Add epsilon-by-rank to preserve our ordering deterministically.
- **`text-embedding-3-large` not on leaderboard:** comparison is to Ada-002 / Voyage as proxies; our
  number is new. State it as "our pipeline vs published models," not "same embedder."

## Next exact action

Write `scripts/bench_fetch.py` + `scripts/bench_score.py` (verbatim above) and `eval/bench/run.ts`
(materialize → `appLayer({root: work/codetrans-dl})` → `Indexer.indexAll()` → loop
`Search.hybrid(q,{limit:100,perFile:100})` → max-pool chunk→doc via `docid_map.json` → emit
`run.trec` → spawn `bench_score.py`). Run on CodeTrans-DL; target nDCG@10 > 53.34 (Ada-002 floor),
stretch > 72.77 (#1 on this slice).

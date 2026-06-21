# Published Code-Search Retrieval Benchmarks & Current SOTA

Grounding brief for the recurring "be #1 on real code-search benchmarks" auto-loop.
Every benchmark number below has a cited primary source. Dates reflect what was published.
This is a **delta** brief: it assumes the existing system (text-embedding-3-large @3072d ->
TurboPuffer hybrid vector+BM25 -> RRF -> Cohere rerank-v3.5) and the existing eval harness at
`eval/retrieval.ts` already work. It proposes what to ADD, not rebuild.

---

## TL;DR Decision

**Target CoIR first.** It is the only code-retrieval benchmark with (a) a public leaderboard, (b) a
one-line pip install (`coir-eval`), (c) BEIR/MTEB-standard nDCG@10 scoring, (d) sub-datasets small
enough to run for cents, and (e) listed entries for the exact models we already use (OpenAI, Voyage,
CodeSage). "#1" is unambiguous there: **avg nDCG@10 across 10 datasets**.

- **Number to beat for a credible public claim:** **67.41** avg nDCG@10 — Salesforce
  `SFR-Embedding-Code-2B_R`, CoIR leaderboard rank #1 (since 2025-02-18). Second is `CodeSage-large-v2`
  at **64.18**. ([leaderboard](https://archersama.github.io/coir/))
- **The honest framing for us:** the leaderboard ranks *single bi-encoder embedding models*. Our
  system is a *pipeline* (hybrid + RRF + reranker). The OpenAI entry on the board is bare
  `OpenAI-Ada-002 = 45.59`; there is **no** `text-embedding-3-large` row and **no** hybrid+rerank
  pipeline row. That is the opening: **a hybrid+rerank pipeline on text-embedding-3-large is a
  configuration nobody on the public board has submitted**, and rerankers reliably add several nDCG@10
  points on top of a bi-encoder. We can plausibly land between CodeSage-large-v2 (64.18) and SFR-2B
  (67.41), and on *text-to-code* sub-tasks specifically we may exceed both.
- **Cheapest representative subset for the inner loop:** **`codetrans-dl`** (816 queries / 816 corpus)
  + **`cosqa`** (500 queries / 20,604 corpus). codetrans-dl is code-to-code (hard, discriminating);
  cosqa is web-query->code (closest to our agent use case). Together ~1,300 queries, ~21k docs,
  ~21k embeddings = **well under $1 per full run** with text-embedding-3-large.

---

## 1. CoIR — Code Information Retrieval (ACL 2025 Main)  ← PRIMARY TARGET

- **Paper:** https://arxiv.org/abs/2407.02883 · ACL 2025 long paper
  https://aclanthology.org/2025.acl-long.1072 · accepted ACL 2025 Main 2025-05-18.
- **Leaderboard:** https://archersama.github.io/coir/ (also mirrored on MTEB
  https://huggingface.co/spaces/mteb/leaderboard).
- **Pip package:** `pip install coir-eval` · repo https://github.com/CoIR-team/coir
- **HF org (all data):** https://huggingface.co/CoIR-Retrieval

**What it measures.** Code retrieval breadth. 10 curated datasets, 8 sub-tasks, 7 domains, ~2M docs
total. 4 primary task families: **Text-to-Code, Code-to-Code, Code-to-Text, Hybrid Code QA**.
**Headline metric: nDCG@10** (BEIR convention; cosine similarity ranking, top-10 cut). Scripts also
emit MAP/Recall/Precision. ([paper §Implementation Details](https://arxiv.org/html/2407.02883v1))

**The 10 datasets, tasks, and exact sizes** (sizes from HF datasets-server; #query = qrels rows):

| Dataset (HF: `CoIR-Retrieval/...`) | Task | #Query (test) | #Corpus | Cost to run |
|---|---|---|---|---|
| `apps` | Text->Code (contest) | 8,765 | 8,765 | medium |
| `cosqa` | Web-query->Code (Python) | 500 | 20,604 | **cheap** |
| `synthetic-text2sql` | Text->SQL | 5,851 | 105,890 | medium |
| `CodeSearchNet` | Code->Text (6 langs) | 52,561 | 52,561 | expensive |
| `CodeSearchNet-ccr` | Code-context->Code (6 langs) | ~52k | ~1M | **most expensive** |
| `codetrans-contest` | Code->Code (cross-lang) | 1,008 | 1,008 | **cheap** |
| `codetrans-dl` | Code->Code (DL frameworks) | 816 | 816 | **cheapest** |
| `stackoverflow-qa` | Hybrid QA | 1,202 | 19,931 | cheap |
| `codefeedback-st` | Hybrid QA single-turn | ~31k | 156k | expensive |
| `codefeedback-mt` | Hybrid QA multi-turn | 13,227 | 66,383 | expensive |

(Sizes: codetrans-dl/contest confirmed via datasets-server `/size`; cosqa qrels=20,604 corpus,
500 test queries; SO-QA/codefeedback from paper §3.)

**Data layout per dataset** (3 HF repos each):
`{name}-queries-corpus` (configs `queries`, `corpus`, each a single parquet) and `{name}-qrels`
(query_id, corpus_id, score). The `coir-eval` loader joins them; you can also load parquet directly.

**Current leaderboard SOTA (avg nDCG@10), as of 2026-06 — https://archersama.github.io/coir/:**

| Rank | Model | Params (M) | Avg nDCG@10 | Notable per-task |
|---|---|---|---|---|
| 1 | Salesforce/SFR-Embedding-Code-2B_R | 2000 | **67.41** | StackOverflowQA 90.54, CSN-CCR 85.77 |
| 2 | CodeSage-large-v2 | 1300 | **64.18** | CodeSearchNet 94.26 (best NL->code summary) |
| 3 | Salesforce/SFR-Embedding-Code-400M_R | 400 | 61.89 | apps 48.57 |
| 4 | CodeSage-large | 1300 | 61.04 | CSN 90.58 |
| 5 | Voyage-Code-002 | – | 56.26 | text2sql 69.26 (best), CodeTrans-DL 27.28 |
| 6 | E5-Mistral | 7000 | 55.18 | StackOverflowQA 91.54 |
| 7 | E5-Base-v2 | 110 | 50.90 | |
| 8 | **OpenAI-Ada-002** | – | **45.59** | CSN 74.21, text2sql 58.32 |
| 9 | BGE-Base-en-v1.5 | 110 | 42.77 | |
| 10 | BGE-M3 | 567 | 39.31 | |

Key per-task SOTA highs (whoever holds them): `CodeSearchNet` (code-summary) **94.26** CodeSage-large-v2;
`CodeSearchNet-CCR` **85.77** SFR-2B; `cosqa` **36.31** SFR-2B (cosqa is hard for everyone — note how
low all scores are: even #1 is 36); `synthetic-text2sql` **69.26** Voyage-Code-002; `codetrans-dl`
**34.85** SFR-400M (a near-tie; this task is brutal — top score is ~33-35, so it discriminates models
sharply); `StackOverFlowQA` **91.54** E5-Mistral; `codefeedback-mt` **57.16** CodeSage-large-v2.

**Why CoIR is #1 to target:** public leaderboard + pip + standard metric + our exact models listed +
cheap subsets exist. **No `text-embedding-3-large` and no hybrid/rerank pipeline are on the board** —
that gap is our wedge.

**External adopters** (trust signal): Jina, Qwen3-Embedding, BGE-code-v1, Salesforce SFR, Voyage, GTE,
NV-Embed, OpenAI, Google all report CoIR. ([CoIR README](https://github.com/CoIR-team/coir))

---

## 2. CodeSearchNet (CSN) — 6 languages, MRR

- **Original challenge:** https://arxiv.org/abs/1909.09436 (Husain et al. 2019). Corpus ~2M functions,
  6 languages (Go, Java, JavaScript, PHP, Python, Ruby). 99 NL queries in the original challenge set;
  the widely-used eval is the per-language test split with **MRR** over 1,000-distractor pools.
- **HF:** `code_search_net` (raw) / `CoIR-Retrieval/CodeSearchNet*` (CoIR's nDCG@10 reframing).
- **Headline metric:** **MRR** (mean reciprocal rank), averaged over the 6 languages.

**Current SOTA (MRR avg over 6 langs):**
- CodeRankEmbed (137M, CoRNStack) — strongest open retriever for text-to-code; per-lang CSN nDCG@10
  ~76-78. https://arxiv.org/abs/2412.01007 (CoRNStack, rev 2025-03).
- CoCoSoDa — **0.727** avg MRR. https://arxiv.org/abs/2204.03293 (2023; "outperforms 18 baselines").
- UniXcoder — **0.713** avg MRR. https://github.com/microsoft/CodeBERT/tree/master/UniXcoder
- GraphCodeBERT ~0.70; CodeBERT ~0.69.

**Caveat (do NOT pick CSN as the target):** CSN is heavily overfit and the paper that introduced CoIR
explicitly calls CSN out for overfitting and domain narrowness
([CoIR §2](https://arxiv.org/html/2407.02883v1)). "Beating CSN" is a weak, contested claim. Run it
only as a *cross-check* via CoIR's `CodeSearchNet` sub-dataset (which already converts it to nDCG@10).

---

## 3. CoSQA / CoSQA+ — web-query -> code

- **CoSQA** (Huang 2021): 20,604 labeled (real Bing query, Python function) pairs. Lives inside CoIR as
  the `cosqa` sub-dataset — **run it via CoIR**, no separate harness needed.
- **CoSQA+** (Gong/Wu 2024): https://arxiv.org/abs/2406.11589 ·
  https://github.com/DeepSoftwareAnalytics/CoSQA_Plus · HF `paper 2406.11589`.
  Fixes CoSQA's ~51% mismatched-code problem; one-to-**N** matching (a query has multiple valid codes).
  **New metric: MMRR (Mean Multi-choice Reciprocal Rank)**, not standard MRR/nDCG.
  Reference numbers: CodeBERT fine-tuned on CoSQA+ gets **MMRR 0.902** vs 0.850 on CoSQA (CSN-Python).
  Corpus: 1,156,085 CSN Python functions + ~148k StaQC snippets.
- **Decision:** CoSQA via CoIR (cheap, standard metric, on leaderboard). Treat **CoSQA+** as a
  secondary, agent-relevant target later — but its MMRR metric and 1.3M corpus make it a bigger lift
  and it has **no live leaderboard**, so it cannot back a "#1" claim yet.

---

## 4. Repo-level / agent-relevant (RepoEval, CrossCodeEval, SWE-bench-Lite, CodeRAG-Bench)

These match our *actual* agent use case (find the right file/region in a real repo) better than CoIR,
but **none has a public retrieval-only leaderboard** with comparable, citable nDCG numbers — so they
are strong *internal* eval targets, weak public "#1" claims.

- **CodeRAG-Bench** (NAACL 2025 Findings): https://aclanthology.org/2025.findings-naacl.176/ ·
  https://github.com/code-rag-bench/code-rag-bench. Retrieval-augmented code *generation* across 6
  tasks (basic / open-domain / repo-level). Retrieval is scored by recall/nDCG of canonical docs, but
  the headline is end-to-end pass@1, not a retrieval leaderboard. Useful for "does our retriever
  improve a downstream agent" experiments.
- **RepoEval / CrossCodeEval / RepoBench:** repo-level code *completion* with retrieval context. Metric
  is exact-match / edit-sim of completions, plus retrieval recall@k. Survey index:
  https://github.com/allanj/repo-level-codegen-papers. Agent-relevant, no retrieval leaderboard.
- **SWE-bench Lite:** https://www.swebench.com/lite.html — 300 GitHub issues; "retrieval" here =
  file localization recall (does the patch touch the retrieved file). It is an *agent* benchmark, not
  a retrieval leaderboard; a "file localization recall@k" sub-metric is the agent-relevant slice.
- **CoQuIR** (2025-08, quality-aware code IR): https://arxiv.org/html/2506.11066v2 — newer, niche.

**Decision:** keep one repo-level signal (CodeRAG-Bench retrieval recall, or a SWE-bench-Lite file-
localization recall@10) as an *internal* north-star for agent-relevance, but **do not** gate the
public "#1" claim on these.

---

## 5. MTEB code tasks (not distinct from CoIR)

CoIR is **integrated into MTEB** (task names: `AppsRetrieval`, `CodeFeedbackMT/ST`,
`CodeTransOceanContest/DL`, `CosQA`, `SyntheticText2SQL`, `StackOverflowQA`,
`COIRCodeSearchNetRetrieval`, `CodeSearchNetCCRetrieval`). The MTEB "code retrieval" leaderboard *is*
the CoIR datasets re-scored. ([CoIR README MTEB usage](https://github.com/CoIR-team/coir)) Numbers
differ slightly between the CoIR and MTEB boards (different pooling/normalization —
https://github.com/CoIR-team/coir/issues/17). **Pick ONE board and report against it consistently.**
Recommend the **CoIR board** because it lists Voyage-Code and OpenAI rows directly.

---

## 6. 2025-2026 newer benchmark: CoREB ("Beyond Retrieval")

- **Paper:** https://arxiv.org/abs/2605.04615 ("Beyond Retrieval: A Multitask Benchmark and Model for
  Code Search", Ant Group, 2026). Data + model released.
- **What's new and why it matters to US specifically:** it is the first benchmark built for the *full
  pipeline* (retrieval **+ reranking**), with **graded relevance** and **contamination control**
  (counterfactually-rewritten LiveCodeBench problems, 5 languages, timed releases). Tasks:
  text-to-code, code-to-text, code-to-code. Metric: **nDCG@10**.
- **Four findings to internalize:**
  1. Code-specialized embeddings dominate code-to-code (~2x over general encoders).
  2. **Short keyword queries — the format closest to real developer search — collapse every model to
     near-zero nDCG@10.** (Direct relevance: our agent queries are short. This is a known failure mode
     to design against.)
  3. Off-the-shelf rerankers are *task-asymmetric*: up to a 12-pt swing on code-to-code, and **no
     baseline reranker is net-positive across all three tasks.** (Our Cohere rerank-v3.5 may *hurt*
     code-to-code — must measure per-task, not just overall.)
  4. Their fine-tuned `CoREB-Reranker` is the first net-positive-everywhere reranker.
- **Decision:** CoREB is the best *research* target (it rewards exactly our pipeline shape) but has
  **no public leaderboard yet**, so it cannot back a public "#1" claim today. Add it as a second-stage
  internal benchmark to validate reranker choices and to test the short-query failure mode.

---

## DECISION: target order, exact numbers, cheapest loop

**Rank of benchmarks to target:**
1. **CoIR (avg nDCG@10)** — public board, pip, our models listed, cheap subsets. **Claim "#1" here.**
2. **CoREB** — internal; validates our pipeline (rerank) and short-query robustness. No public board.
3. **CodeRAG-Bench / SWE-bench-Lite file-localization recall** — internal agent-relevance north star.
4. **CSN MRR** — cross-check only (overfit/contested).
5. **CoSQA+ MMRR** — later; agent-relevant but custom metric, no board.

**Exact public numbers to beat (CoIR avg nDCG@10):**
- Beat **64.18** (CodeSage-large-v2) to be a top-3 public system.
- Beat **67.41** (SFR-Embedding-Code-2B_R) to claim **#1**.
- Floor / "we already crush bare OpenAI": **45.59** (OpenAI-Ada-002) — our pipeline must blow past this
  or something is wrong with the adapter.

**Cheapest representative subset for the recurring inner loop** (run every iteration):
- `codetrans-dl` (816q / 816c, code-to-code, top score only ~35 so it discriminates hard) +
  `cosqa` (500q / 20,604c, web-query->code, agent-shaped, top score only ~36).
- ~1,300 queries, ~21k corpus docs, ~22k embeddings. With text-embedding-3-large at $0.13/1M tokens
  and ~150 tok/doc avg, embedding cost ≈ **$0.0004** + per-query embeds — i.e. **cents per run**.
- Run the **full 10-dataset suite** only on promotion gates (when the cheap subset improves), to get
  the leaderboard-comparable avg. CSN/CSN-CCR/codefeedback are the expensive long pole.

**The metric mismatch to fix in the harness (load-bearing):** the existing `eval/retrieval.ts` scores
by **file path** against a filesystem repo (`rankOf` matches `hit.path`). CoIR gives a **corpus of
(corpus_id, text) docs + qrels keyed by corpus_id**. The harness needs a second mode that:
(1) ingests CoIR `corpus` parquet directly as documents (bypass the cAST chunker — each corpus row is
one "chunk"; set `id = corpus_id`, `path = corpus_id`), (2) runs `Search.semantic`/`hybrid` per query,
(3) scores nDCG@10 by **corpus_id** present in qrels, with **graded** relevance (qrels `score`), not
the current binary first-hit MRR. nDCG@10 must use the standard graded formula
`DCG = sum(rel_i / log2(i+1))` normalized by ideal DCG, not the current
`1/log2(rank+1)` first-relevant-only approximation.

---

## Concrete next actions (for the harness build)

**A. Install + smoke-test coir-eval as the ground-truth scorer** (cross-checks our own nDCG math):
```bash
python -m venv .venv-coir && . .venv-coir/bin/activate
pip install coir-eval
# Loads codetrans-dl (816q/816c) from HF, ~seconds:
python - <<'PY'
import coir
from coir.evaluation import COIR
tasks = coir.get_tasks(tasks=["codetrans-dl"])
print({t: (len(d.queries), len(d.corpus)) for t,d in
       [(t, coir.get_tasks(tasks=[t])[t]) for t in ["codetrans-dl"]]})
PY
```

**B. Pull the cheap subset as parquet for our own (Effect) harness** — no Python at eval time:
```bash
# queries + corpus + qrels for the two cheap datasets
for ds in codetrans-dl cosqa; do
  huggingface-cli download CoIR-Retrieval/${ds}-queries-corpus --repo-type dataset \
    --local-dir ./bench/coir/${ds}
  huggingface-cli download CoIR-Retrieval/${ds}-qrels --repo-type dataset \
    --local-dir ./bench/coir/${ds}-qrels
done
```

**C. Harness delta (TypeScript/Effect), reusing existing `Search` + `Turbopuffer`:**
- New `eval/coir.ts`: read corpus parquet -> upsert each row as a document (id=corpus_id, embedText=text,
  path=corpus_id, kind="code") via a thin "ingest pre-chunked docs" path (skip `Chunker`).
- Read queries parquet + qrels -> per query call `search.semantic(q, {limit:10})`.
- Score graded nDCG@10 by corpus_id; aggregate mean across queries, then mean across datasets.
- Emit a scorecard shaped like the existing one, plus a `coirLeaderboardDelta` field vs 64.18 / 67.41.
- Gate: cheap subset (codetrans-dl + cosqa) every loop; full 10 only when the subset improves.

**D. Pipeline experiments the auto-loop should sweep (ranked by expected CoIR lift):**
1. Per-task reranker on/off (CoREB finding #3: Cohere rerank-v3.5 may hurt code-to-code like
   codetrans-dl — **measure, do not assume**).
2. Swap/augment the embedding model: add **voyage-code-3** (1024d, 32k ctx) as an alt embedder — Voyage
   reports it beats text-embedding-3-large by 13.8% on their 32-dataset code suite
   (https://blog.voyageai.com/2024/12/04/voyage-code-3/; note: their suite, not CoIR avg). Or
   **CodeRankEmbed (137M, open)** for text-to-code (https://arxiv.org/abs/2412.01007).
3. Short-query robustness (CoREB finding #2): test keyword-only queries; consider query expansion.
4. Hybrid weight / RRF k sweep; BM25 on/off per task.

---

## Blocking unknowns / things to verify before trusting numbers

- **Voyage "78.48%" and "+13.80%" are on Voyage's own 32-dataset suite, NOT CoIR avg nDCG@10.** Do not
  put them on the same axis as the CoIR leaderboard. Source: voyage-code-3 blog (cited above).
- **CoIR vs MTEB board numbers differ** for the same model (pooling/normalization;
  https://github.com/CoIR-team/coir/issues/17). Lock to **one** board (recommend CoIR) before claiming.
- **No `text-embedding-3-large` row exists on the CoIR board** — only `OpenAI-Ada-002 (45.59)`. Our
  baseline must be *measured by us* with `coir-eval` to be comparable; we cannot cite an existing row.
- **codetrans-dl absolute scores are tiny (~33-35 for the best models).** A few points of nDCG@10 swing
  is large here. Good for a sensitive inner loop, but expect high variance — average codetrans-dl with
  cosqa, don't tune on codetrans-dl alone.
- **CoSQA+ MMRR and CoREB are custom/no-board** — confirmed no public leaderboard exists for either as
  of 2026-06; they can't back a "#1" claim, only internal validation.

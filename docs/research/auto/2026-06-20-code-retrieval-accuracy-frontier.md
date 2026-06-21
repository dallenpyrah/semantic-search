# Code-Retrieval Accuracy Frontier — Ranked Experiment Backlog (Auto-Research)

Status: grounded research brief. Date: 2026-06-20. Source mode: Parallel CLI + WebFetch, primary
sources only. Every benchmark number below carries a URL.

North star: make this tool **#1 on published code-search benchmarks** (CoIR / MTEB-Code) while
improving speed, memory, and indexing. This brief gives (a) what to build now — a benchmark harness on
a *public* dataset — and (b) a ranked backlog of accuracy experiments for the autonomous loop.

Current system (do not rebuild — propose deltas only):
- Embed: OpenAI `text-embedding-3-large` @ 3072d (via OpenAI key).
- Store: TurboPuffer (vector ANN cosine + BM25 text + BM25 path).
- Fuse: RRF (`rank_constant=60`), native or client-side.
- Rerank: Cohere `rerank-v3.5` via OpenRouter `/rerank` (degrades to free NVIDIA reranker → passthrough).
- Chunk: structural cAST split-then-merge, ~1200/1600 non-ws char budget, content-addressed IDs.
- Internal eval (own repo, 30 queries): Success@10 97%, MRR 0.875, nDCG@10 0.899.

Keys on hand: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TURBOPUFFER_API_KEY`. No Voyage/Jina/Cohere-native key.

---

## TL;DR decision

**Highest-ROI change to try first: swap the embedding model from `text-embedding-3-large` to a
purpose-trained code embedder.** Embeddings set the candidate ceiling; reranking and fusion only
reorder what embeddings surfaced. `text-embedding-3-large` is the weakest published link in the stack.

Two embedding paths, both reachable today:
1. **`voyage-code-3`** (needs a new Voyage key, 200M free tokens) — the strongest published code retriever, **+13.80% avg over `text-embedding-3-large`**, **92.28 vs 77.64 nDCG@10** on Voyage's code suite.
   https://www.mongodb.com/company/blog/voyage-code-3-more-accurate-code-retrieval-lower-dimensional-quantized-embeddings
2. **`qwen/qwen3-embedding-4b`** (already reachable via OpenRouter embeddings API, **no new vendor**) — Qwen3-Embedding is SOTA-class on MTEB-Code and Apache-2.0. `$0.02/M tokens`, 33K context.
   https://openrouter.ai/qwen/qwen3-embedding-4b

The core trade-off: **a one-time re-embed of the corpus + a new provider/key + a 3072→{1024,2048} dimension change in the TurboPuffer schema, in exchange for a large, published accuracy jump that no reranker tweak can match.** Reranking is downstream of recall; if the right span isn't in the candidate pool, no reranker recovers it.

**Blocking unknown before any swap:** we have **no public benchmark harness**. The 30-query own-repo eval cannot prove "#1 on a benchmark" and is too small/overfit to rank experiments. **Build the CoIR harness first (Experiment 0); it is the measurement instrument every other experiment depends on.**

---

## Experiment 0 (PREREQUISITE) — Public benchmark harness on CoIR

You cannot climb a leaderboard you don't measure. The internal 30-query eval is a smoke test, not a
benchmark. CoIR is the standard, MTEB-schema-compatible code-retrieval benchmark (ACL 2025 Main).

- Paper: https://aclanthology.org/2025.acl-long.1072.pdf
- Leaderboard: https://archersama.github.io/coir
- Code + datasets (pip `coir-eval`, HF datasets `CoIR-Retrieval/*`): https://github.com/coir-team/coir

CoIR = 10 datasets / 8 task types / 7 domains, ~2M docs. Tasks: Text-to-Code (CodeSearchNet,
CosQA, Text2SQL), Code-to-Text (CSN-CCR), Code-to-Code (CodeTransOcean, StackOverflow-QA), and
hybrid (CodeFeedback). Metric: **nDCG@10** (same metric we already report — clean apples-to-apples).

Start with the cheap, high-signal subsets so each experiment run is minutes, not hours:
- `CoSQA` (web query → Python function; ~20k corpus) — closest to our "where is X" agent use case.
- `CodeSearchNet` (NL → code, 6 languages) — the canonical NL-to-code task.
- `CodeFeedback-ST` (hybrid NL+code → code) — exercises hybrid path.

Harness shape (mirror `eval/retrieval.ts`, swap gold source):

```ts
// eval/coir.ts — index a CoIR corpus split, run its queries, score nDCG@10 / MRR / Success@k
// 1. Download via HF: datasets CoIR-Retrieval/CodeSearchNet, CoIR-Retrieval/cosqa, etc.
//    Each has {corpus: {_id, text}, queries: {_id, text}, qrels: {query-id, corpus-id, score}}.
// 2. Index corpus docs as synthetic "chunks" (text only — corpus rows are already units).
// 3. For each query: search.semantic(q) (CoIR is NL→code; semantic, not hybrid).
// 4. Score with qrels: nDCG@10 over graded rels; Success@k; MRR. Reuse retrieval.ts math.
// 5. Emit JSON scorecard per dataset + macro-avg, plus a per-query miss list.
```

Download (one dataset, ~minutes):
```bash
# python side, once: pip install coir-eval datasets
python - <<'PY'
from datasets import load_dataset
for split in ["corpus","queries"]:
    load_dataset("CoIR-Retrieval/cosqa", split, split="train").to_json(f"eval/data/cosqa_{split}.jsonl")
load_dataset("CoIR-Retrieval/cosqa","qrels",split="test").to_json("eval/data/cosqa_qrels.jsonl")
PY
```

Acceptance: harness reproduces a published `text-embedding-3-large` CoIR number within a couple points
(sanity that our pipeline isn't lossy), then becomes the scoreboard for Experiments 1–9. The leaderboard
publishes `OpenAI-Ada-002 = 45.59` avg; `text-embedding-3-large` self-reports `65.17` avg (per Qodo's
table, below) — reproduce ~65 on the subset to validate the harness.

**Caveat to log:** CoIR corpus rows are pre-chunked passages, so CoIR measures the *embedding+rerank*
quality, not our chunker. To benchmark chunking (Experiment 8) we need a repo-level task
(SWE-bench-Lite file localization or RepoEval); note this as a second harness, lower priority.

---

## Embedding models RIGHT NOW (the candidate ceiling)

All numbers are nDCG@10 unless stated. `text-embedding-3-large` is our baseline.

| Model | Size | Code-bench score | vs te-3-large | Reachable with our keys? | License |
|---|---|---|---|---|---|
| **voyage-code-3** | API | **92.28** (Voyage code suite @1024d) / +13.80% avg over te-3-large | **+14.6 nDCG pts / +13.8%** | NO — needs Voyage key (200M tokens free) | proprietary |
| **Qodo-Embed-1-7B** | 7B | **71.5** CoIR avg | **+6.3 pts** | self-host (HF), not on OpenRouter embed | commercial |
| **Qodo-Embed-1-1.5B** | 1.5B | **68.53** CoIR avg | **+3.4 pts** | self-host (HF, OpenRAIL++-M) | open weights |
| **SFR-Embedding-Code-2B_R** | 2B | **67.41** CoIR avg (leaderboard #1 open) | **+2.2 pts** | self-host (HF) | research/Salesforce |
| **jina-code-embeddings-1.5b** | 1.5B | **79.04** overall / 78.94 MTEB-Code | (own scale; ≈ voyage-code-3) | self-host (HF, CC-BY-NC) or Jina API | CC-BY-NC 4.0 |
| **jina-code-embeddings-0.5b** | 0.5B | **78.41** overall / 78.72 MTEB-Code | (own scale) | self-host (HF) | CC-BY-NC 4.0 |
| **gemini-embedding-001** | API | **77.38** overall / 76.48 MTEB-Code (per Jina table) | strong | needs Google key | proprietary |
| **CodeSage-large-v2** | 1.3B | **64.18** CoIR avg | ≈ baseline | self-host (HF) | open |
| **nomic-embed-code** | 7B | "beats voyage-code-3 + te-3-large on CodeSearchNet" (no exact # published in blog) | claimed > | self-host (HF, Apache-2.0) | Apache-2.0 |
| **Qwen3-Embedding-8B** | 8B | MTEB-Code class-leading (8B ≈ 4B); Qwen3-Reranker MTEB-Code = 81.22 | strong | **8B self-host; 4B on OpenRouter** | Apache-2.0 |
| **Qwen3-Embedding-4B** | 4B | MTEB-Code SOTA-class | strong | **YES — OpenRouter embeddings API** | Apache-2.0 |
| `text-embedding-3-large` (baseline) | API | **65.17** CoIR avg / 77.64 on Voyage suite | — | YES (OpenAI) | proprietary |

Sources:
- voyage-code-3 +13.80% over OpenAI-v3-large, +16.81% over CodeSage; 92.28 vs 77.64 vs 71.38 @1024d; 32K ctx; dims {2048,1024,512,256}; quant {float,int8,uint8,binary,ubinary}: https://www.mongodb.com/company/blog/voyage-code-3-more-accurate-code-retrieval-lower-dimensional-quantized-embeddings and https://blog.voyageai.com/2024/12/04/voyage-code-3
- Qodo-Embed-1: 7B=71.5, 1.5B=68.53 CoIR avg; te-3-large=65.17; SFR-2_R=67.41: https://www.qodo.ai/blog/qodo-embed-1-code-embedding-code-retrieval/
- jina-code-embeddings: 1.5b=79.04 overall/78.94 MTEB-Code, 0.5b=78.41/78.72; voyage-code-3=79.23/79.84; gemini-embedding-001=77.38/76.48; 32K ctx; dims 1536(1.5b)/896(0.5b): https://jina.ai/news/jina-code-embeddings-sota-code-retrieval-at-0-5b-and-1-5b/
- CoIR static leaderboard (SFR-2B=67.41, CodeSage-large-v2=64.18, Voyage-Code-002=56.26, Ada-002=45.59): https://archersama.github.io/coir
- nomic-embed-code 7B, Apache-2.0, "outperforms Voyage Code 3 and OpenAI Embed 3 Large on CodeSearchNet": https://www.nomic.ai/news/introducing-state-of-the-art-nomic-embed-code
- Qwen3-Embedding 0.6/4/8B, 32K ctx, MRL dims {1024/2560/4096}, Apache-2.0: https://huggingface.co/Qwen/Qwen3-Embedding-8B ; on OpenRouter: https://openrouter.ai/qwen/qwen3-embedding-4b
- SFR-Embedding-Code-2B_R model card: https://huggingface.co/Salesforce/SFR-Embedding-Code-2B_R

**Reachability reality:**
- **voyage-code-3** — strongest published, but needs a **new Voyage account/key** (NOT on OpenRouter; OpenRouter embeddings catalog has no Voyage). 200M free tokens covers our whole corpus many times over. Voyage pricing page: https://docs.voyageai.com/docs/pricing
- **qwen/qwen3-embedding-4b** — **zero new vendor**: it's on the OpenRouter embeddings endpoint we already auth against. This is the *frictionless* upgrade. Slug `qwen/qwen3-embedding-4b`, `$0.02/M`, 33K ctx: https://openrouter.ai/qwen/qwen3-embedding-4b
- All open-weights models (Qodo, SFR, jina-code, nomic, CodeSage) need **self-hosting** (transformers/ONNX) — heavy for a light Pi extension; defer to a "local embed adapter" track.

**Expected gain:** swapping te-3-large → voyage-code-3 is the single largest published delta in this
brief (**+13.8% / +14.6 nDCG pts** on code). qwen3-embedding-4b is the low-friction proxy for that
gain (no exact head-to-head vs voyage on identical CoIR splits is published — **measure it via Exp 0**).

---

## Rerankers beyond Cohere rerank-v3.5

We already rerank with `cohere/rerank-v3.5` on OpenRouter. The frontier moved; the upgrade is one slug change.

| Reranker | Code-relevant score | vs rerank-v3.5 | Reachable with our keys? |
|---|---|---|---|
| **zerank-2** (ZeroEntropy) | #1 ELO (1638) on agentset reranker eval | best | needs ZeroEntropy key (or HF self-host) |
| **cohere/rerank-4-pro** | ELO 1629 (≈ zerank-2); 33K ctx | strong upgrade | **YES — OpenRouter, slug `cohere/rerank-4-pro`, $0.0025/search** |
| **zerank-1** | nDCG@10 **0.7683 vs 0.7091** Cohere-3.5 (+8.4%); up to +18% in some domains | **+8.4% nDCG** | ZeroEntropy API ($0.025/M, half Cohere) or **zerank-1-small Apache-2.0 self-host** |
| **voyage rerank-2.5** | **+7.94% over Cohere rerank-v3.5**; beats Qwen3-Reranker-8B by +2.25%; 32K ctx, instruction-following | **+7.94%** | needs Voyage key |
| **Qwen3-Reranker-8B** | MTEB-Code **81.22** (4B=81.20, 0.6B=75.41) | strong on code | self-host (HF, Apache-2.0) |
| **Cohere rerank-v3.5** (baseline) | nDCG@10 0.7091 (ZeroEntropy eval); ELO 1451 | — | YES (OpenRouter) |
| jina-reranker-v2 | ELO 1327 (weakest in agentset eval) | below baseline | needs Jina key / self-host |

Sources:
- zerank-1 = 0.7683 vs Cohere-3.5 0.7091 nDCG@10, +18% in Finance/STEM, $0.025/M, zerank-1-small Apache-2.0: https://zeroentropy.dev/articles/announcing-zeroentropy-s-first-rerankers-zerank-1-and-zerank-1-small/
- voyage rerank-2.5 +7.94% over Cohere-v3.5, beats Qwen3-Reranker-8B +2.25%, 32K ctx, instruction-following: https://blog.voyageai.com/2025/08/11/rerank-2-5/
- agentset reranker ELO leaderboard (zerank-2 1638 > Cohere-4-pro 1629 > zerank-1 1573 > voyage-2.5 1544 > Qwen3-8B 1473 > Cohere-3.5 1451 > jina-v2 1327): https://github.com/agentset-ai/reranker-eval
- Qwen3-Reranker MTEB-Code 81.22/81.20/75.41, Apache-2.0: https://qwenlm.github.io/blog/qwen3-embedding/
- Cohere rerank-4-pro on OpenRouter, 33K ctx, $0.0025/search, released 2026-04-06: https://openrouter.ai/cohere/rerank-4-pro

**Reachability reality:** the *frictionless* reranker upgrade is **`cohere/rerank-4-pro` on OpenRouter**
(same `/rerank` endpoint, one slug change in `defaults.ts`). It tops the public ELO eval alongside
zerank-2 and gives 33K context (our current v3.5 is 4,096 — relevant because we feed `path + text`).
zerank-1/voyage-2.5 show bigger *published* deltas but need a new vendor key.

---

## Query-side techniques

| Technique | Evidence + number | Reachable? | Cost |
|---|---|---|---|
| **Instruction prefix on the query** | Qwen3 + jina-code + voyage are *instruction-trained*; vendors report task instructions improve retrieval (voyage rerank-2.5 instruction-following: +8.13% avg on domain sets). Code embedders expect a task prefix (e.g. "Given a code search query, retrieve relevant code"). | YES (free) | 0 latency |
| **HyDE for code (generate hypothetical code/answer, embed that)** | Adaptive-HyDE on Stack Overflow Java/Python: **+1.30 LLM-judge pts (≈+27%)** vs question-only retrieval; lifts coverage to 80–100%. | YES (1 LLM call) | +1 LLM round-trip latency |
| **Query rewriting / multi-query** | Query-Rewriting-for-RAG (RRR) and repo-level RAG surveys show consistent recall lift from LLM-expanded/rewritten queries; multi-query → union → RRF raises recall before rerank. | YES | +1 LLM call |
| **Multi-query → RRF (no LLM)** | We already RRF across vector+text+path arms. Adding 1–2 paraphrase arms is a cheap recall widener. | YES (embed-only if paraphrases are templated) | +N embeds |

Sources:
- Adaptive HyDE for developer support, +1.30 LLM-judge (~27%), 80–100% coverage, Stack Overflow Java/Python, all-mpnet-base-v2: https://arxiv.org/html/2507.16754v1 (abs: https://arxiv.org/abs/2507.16754)
- Query Rewriting for RAG (RRR): https://arxiv.org/abs/2305.14283
- Repo-level RAG survey (query expansion, RepoGraph signals): https://arxiv.org/html/2510.04905v1
- Instruction-following rerank gain (voyage rerank-2.5): https://blog.voyageai.com/2025/08/11/rerank-2-5/

**Note on HyDE for an interactive agent tool:** HyDE adds an LLM round-trip *per query*. Our p50 is
~720ms; an extra generation call could 2–3x that. HyDE's win is largest when the query is a vague NL
question and the corpus is code (exactly the discovery case). **Gate it:** only run HyDE on `semantic`
queries flagged "exploratory," not on `hybrid`/exact-token queries. The instruction-prefix win is
*free* (no extra call) and should be the first query-side experiment.

---

## Late-interaction / multi-vector (ColBERT-style) for code

| Aspect | Finding |
|---|---|
| Accuracy | Late interaction (per-token MaxSim) consistently beats single-vector dense on hard retrieval; ColBERTv2 is the reference. Strong for code where exact identifiers matter. |
| Cost | **Storage blows up**: one vector *per token* vs one per chunk → ~10–100x index size; specialized index (PLAID) needed. TurboPuffer is single-vector ANN — **no native multi-vector**. |
| Reachability | Would require a ColBERT index (self-host PLAID or a multi-vector store), not TurboPuffer. Large build-out. |

Sources:
- ColBERTv2 (lightweight late interaction, PLAID): https://arxiv.org/abs/2112.01488
- ColBERT vs dense single-vector production tradeoff (storage 10x+, indexing complexity): https://suhasbhairav.com/blog/colbert-vs-dense-embeddings-late-interaction-retrieval-vs-single-vector-representation

**Verdict: defer.** Late interaction is the highest *ceiling* but the worst *ROI* here — it breaks the
TurboPuffer single-vector assumption (Architecture decision #4) and multiplies index size/cost. The
cross-encoder reranker already gives us late-interaction-quality precision on the *top-K pool* at a
fraction of the storage cost. Revisit only if a published code benchmark shows ColBERT-for-code beating
voyage-code-3 + rerank by a margin worth a new store.

---

## Chunking / representation improvements

We already do structural cAST split-then-merge — this matches the SOTA paper, so the win here is
*representation enrichment*, not re-chunking.

| Technique | Evidence | Delta for us |
|---|---|---|
| **AST split-then-merge (cAST)** | CAST (EMNLP 2025 Findings): AST-aware split-then-merge with greedy token-budget merge beats fixed-size/recursive chunking on retrieval Recall and downstream RAG pass@k. We already implement this. | Already captured — confirm our merge is greedy-by-token, not by char, on the embed text. |
| **Add symbol/signature/docstring context to embed text** | Our BENCHMARKS already proved "feed reranker path+text: Success@1 27%→47%". Same logic on the *embed* side: prepend signature + docstring + symbol chain. | Likely repeats the +20pt Success@1 pattern; A/B on CoIR. |
| **Repo-graph signals (imports, call edges, file path)** | Repo-level RAG survey: RepoGraph/structural signals improve repo-level retrieval. We already index `path` (BM25) + context header. | Incremental; add caller/callee to embed text for definitions. |

Sources:
- CAST structural chunking via AST (EMNLP 2025 Findings): https://aclanthology.org/2025.findings-emnlp.430.pdf (CMU copy: https://www.cs.cmu.edu/~sherryw/assets/pubs/2025-cast.pdf)
- Repo-level RAG / RepoGraph survey: https://arxiv.org/html/2510.04905v1
- Our own prior result (path+text in reranker → +20pt Success@1): `docs/BENCHMARKS.md`

---

## RANKED EXPERIMENT BACKLOG (technique → expected gain → reachability → A/B)

Ordered by ROI = (published gain × probability it transfers) / (integration cost).

**0. CoIR harness `eval/coir.ts`** — *prerequisite, not optional.*
   Gain: enables all measurement. Reach: HF datasets + existing eval math. A/B: reproduce te-3-large ≈65 CoIR avg on cosqa/CodeSearchNet subset. **Do this first.**

**1. Embedding swap → `qwen/qwen3-embedding-4b` (frictionless) and/or `voyage-code-3` (max).**
   Gain: **+13.8% / +14.6 nDCG pts** (voyage published vs te-3-large). qwen3-4b = no new vendor.
   Reach: qwen3-4b on OpenRouter (have key); voyage needs new key (200M free). Both require schema dim change (3072 → 1024/2048/2560) + full re-embed.
   A/B: index CoIR cosqa+CodeSearchNet with each model behind a config flag (`embedding.model`/`baseUrl`/`dimensions` already exist in `defaults.ts`); compare nDCG@10. **Single highest-accuracy lever.**

**2. Reranker swap → `cohere/rerank-4-pro` (one slug change in `defaults.ts`).**
   Gain: tops public ELO with zerank-2; 33K ctx (vs our 4,096) fits longer path+text docs.
   Reach: YES — same OpenRouter `/rerank`, `$0.0025/search`. Zero new vendor.
   A/B: flip `rerank.model` to `cohere/rerank-4-pro`, re-run CoIR + own eval. Trivial.

**3. Instruction prefix on the query embedding (free).**
   Gain: instruction-trained code embedders expect a task prefix; vendors report lift. Pairs with Exp 1.
   Reach: YES, 0 cost. A/B: prepend `"Represent this code search query: "` (model-specific) before `embeddings.embed([q])` in `Search.run`; CoIR delta.

**4. Enrich embed text with signature + docstring + symbol chain.**
   Gain: mirrors our proven +20pt Success@1 from path+text on the rerank side, applied to embeds.
   Reach: YES — extend the chunker's context header (already on embed text only). A/B: CoIR + repo eval.

**5. zerank-1 / voyage rerank-2.5 reranker (bigger published delta, new vendor).**
   Gain: zerank-1 **+8.4% nDCG**; voyage-2.5 **+7.94%** over Cohere-v3.5. Reach: new key (or zerank-1-small Apache-2.0 self-host). A/B: only if Exp 2 plateaus.

**6. HyDE on exploratory semantic queries (gated).**
   Gain: **~+27% LLM-judge** on dev-Q&A retrieval. Reach: YES (1 LLM call), but +latency — gate to NL discovery queries only. A/B: CoIR cosqa (NL→code) with/without HyDE; watch p95.

**7. Multi-query → RRF widener (paraphrase arms).**
   Gain: recall lift before rerank (RRR/repo-RAG evidence). Reach: YES. A/B: add 1 templated paraphrase arm to the existing RRF fuse.

**8. Chunking benchmark (repo-level harness) + repo-graph signals.**
   Gain: confirm cAST + add caller/callee. Reach: needs a 2nd harness (SWE-bench-Lite/RepoEval file localization). A/B: separate track; lower priority than embed/rerank.

**9. Late-interaction / ColBERT-for-code.**
   Gain: highest ceiling. Reach: breaks TurboPuffer single-vector; 10x+ storage. **Defer / spike-only.**

---

## Open / blocking unknowns

1. **No public benchmark harness exists** — Exp 0 must land before any ranking claim. (BLOCKING.)
2. **No published voyage-code-3 vs qwen3-embedding-4b head-to-head on identical CoIR splits** — must measure locally (Exp 1) to choose between the max-accuracy (Voyage, new key) and frictionless (Qwen, existing key) path.
3. **TurboPuffer dimension migration cost** — switching off 3072d means re-creating the namespace schema (`vector [N]f32`) and a full re-embed; the namespace version string already supports this (`pisem_v1_<slug>_<hash>`), but confirm cost on a real repo.
4. **CoIR pre-chunked corpus** can't score our chunker — chunking experiments (Exp 8) need a repo-level localization harness, not yet built.
5. **Voyage/ZeroEntropy keys** — not on hand; Exp 1(voyage) and Exp 5 are blocked until a key is added (both have generous free tiers).

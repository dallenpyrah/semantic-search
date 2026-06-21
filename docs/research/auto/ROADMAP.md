# Auto-Research Backlog

North star: be #1 on **CoIR** (nDCG@10, https://archersama.github.io/coir/). Beat **67.41**
(SFR-Embedding-Code-2B) for #1, **64.18** (CodeSage-large-v2) for top-3. Also improve search/index
speed, memory, and tool adoption without regressing them.

The loop (see `docs/AUTO_RESEARCH.md`) picks the highest-ROI `todo` item, runs it on a branch, and
keeps it only if it strictly improves the target metric with no test/latency/adoption regression.
Update `status` and `result` after each attempt. Do not repeat `done`/`rejected` items.

Status: `todo` | `wip` | `done` | `rejected`. Each entry records the measured delta when resolved.

## Tier 0 — harness/anti-overfit infrastructure (do first)

- [ ] **B0.1 Split gold set into tune/held-out** (`eval/gold.ts` → add `holdout: boolean`; `eval/retrieval.ts`
  reports both). Anti-overfit gate. status: todo
- [ ] **B0.2 Machine-readable baseline** — have `eval/retrieval.ts`/`eval/perf.ts`/`eval/benchmark/coir.ts`
  write JSON scorecards under `eval/.cache/baseline/`; the loop diffs against them. status: todo
- [ ] **B0.3 Add CoIR `cosqa` + `codesearchnet-py` to the standing benchmark set** (already have
  codetrans-dl + cosqa registry in `eval/benchmark/coir.ts`; add the CodeSearchNet python slice). status: todo

## Tier 1 — highest expected CoIR lift

- [ ] **B1.1 Code-specialized embedder** (the biggest lever; general text-embedding-3-large is weak on
  code→code — codetrans-dl baseline nDCG@10 18.89). Candidates: `voyage-code-3` (1024d, 32k ctx),
  open `CodeRankEmbed`/`nomic-embed-code`. Reachability is the blocker: Voyage needs a Voyage key;
  open models need local ONNX or a hosted endpoint. Make the embedder a config-swappable provider
  (`embedding.provider`), A/B vs the 3072d baseline on cosqa + codetrans-dl. status: todo
  (REQUIRES a new key or local model — flag to the user before committing cost.)
- [ ] **B1.2 Per-task / per-query-type rerank gating** — CoREB: off-the-shelf rerankers are
  task-asymmetric; Cohere rerank-v3.5 may HURT code→code. Measure rerank on/off per CoIR dataset;
  gate rerank by query shape (NL→code: on; code→code: off). status: todo
- [ ] **B1.3 Embedding instruction prefix / query robustness** — CoREB: short keyword queries collapse
  all models. Prepend a code-search instruction to query (and maybe doc) embed text; measure on short
  queries. status: todo

## Tier 2 — cheap tuning (reuses cached vectors, $0 embed)

- [ ] **B2.1 RRF rank_constant sweep** (`search.rankConstant`, currently 60) on tune+CoIR. status: todo
- [ ] **B2.2 Hybrid arm weighting** — weight ANN vs BM25 vs pathText in fusion (client-side weighted
  RRF) instead of equal. status: todo
- [ ] **B2.3 candidateMultiplier / minCandidates / rerank poolMultiplier sweep**. status: todo
- [ ] **B2.4 Source bonus + per-source quota tuning** (`Search.ts` sourceBonus / SOURCE_QUOTAS) — keep
  code authoritative; verify history/conversation never displace a relevant code hit on plain queries. status: todo

## Tier 3 — TurboPuffer speed/memory (measure recall impact)

- [ ] **B3.1 int8 / f16 vector quantization** for ~2x query speed + lower memory; measure recall delta
  on cosqa. status: todo
- [ ] **B3.2 Matryoshka reduced dims (1536/1024)** — speed + cost; measure recall. (Note: dims are
  baked into the namespace; needs a versioned reindex.) status: todo
- [ ] **B3.3 `hint_cache_warm` timing / consistency=eventual** for hot-path latency. status: todo

## Tier 4 — chunking / representation

- [ ] **B4.1 web-tree-sitter AST chunker** (cAST split-then-merge) behind the existing `Chunker`
  interface; A/B vs the heuristic structural chunker. status: todo
- [ ] **B4.2 Richer embed-text context** — symbol signature / enclosing-class line in the header;
  measure precision@1. status: todo

## Tier 5 — features / quality (from user asks)

- [ ] **B5.1 Git diff summaries in history** (phase 2) — signature-level add/remove + `+N/-M`, capped;
  improves "what changed" retrieval. status: todo
- [ ] **B5.2 Tool-call indexing decision** — measure whether indexing short tool-call summaries adds
  signal vs noise (research said likely noise; verify). status: todo
- [ ] **B5.3 git-blame short-circuit** for "why did this line change" (`{path,startLine}` → `git log -1 -L`)
  before the vector index. status: todo
- [ ] **B5.4 Parallel-search adoption + quality eval** — extend `eval/adoption.ts` with multi-facet
  tasks; confirm `queries[]` lifts recall on multi-hop without over-firing on single-focus. status: todo

## Resolved

(none yet — the loop appends measured outcomes here)

# Parallel / Multi-Search for the Coding Agent — Grounding Brief

Date: 2026-06-20
Scope: How to make `code_search` / `code_grep` better and faster via parallel / multi
query, and the best mechanism to enable it. Decision-oriented. Proposes deltas to the
existing 2-tool system, not a rebuild.

---

## Decision

**Add an optional `queries: string[]` parameter to the two existing tools (mechanism #3),
batched into ONE TurboPuffer multi-query round-trip, fused per-query then merged with RRF,
and grade-budget the output. Pair it with a short system-prompt fan-out rule and one
sentence of `promptGuidelines` per tool. Do NOT add a 3rd tool. Do NOT do internal
paraphrase expansion (RAG-Fusion).**

Combination chosen: **#3 (queries[] param) + (b) system prompt + (a) prompt guidance** —
explicitly rejecting **#2 (new batch tool)** and **#4 (internal query expansion)**.

Core trade-off in one sentence: I trade a slightly richer parameter schema on two existing
tools (more surface on a known tool) for guaranteed single-round-trip parallelism, server-
side dedup/merge, and zero new distractor tools — instead of trading tool-count discipline
(a 3rd tool) or retrieval quality (blind internal expansion) away.

---

## First principles

- True now: the agent fans out by emitting several separate `code_search` tool_use blocks;
  Pi runs them concurrently, but each is its own HTTP request, its own embed call, its own
  rerank pool, and its own result block in context. Fusion across them happens only in the
  model's head.
- Must stay true: only 2 tools (deliberate); tool responses stay high-signal and bounded;
  Effect-first effectful paths; no silent fallbacks.
- Want true: when a task is genuinely multi-faceted ("auth + rate limiting + retry"), the
  agent retrieves all facets in one round-trip, server-side dedup/merge, with a total result
  budget that does not bloat context — and the agent still issues a single query for simple
  asks.

The gap (= the work): the system already accepts `queries: ReadonlyArray<SubQuery>` at the
store layer and already does RRF in `fuse()`. The missing piece is a user-facing way to pass
N *distinct* natural-language facets and merge their ranked lists under one budget.

---

## Evidence

### 1. Parallel tool calls make agentic search faster, accuracy held

- Relace "Fast Agentic Search": parallelizing search with **4–12 simultaneous tool calls per
  turn** dropped turns 20→5 and 10→4, **">4x reduction in end-to-end latency ... while
  maintaining accuracy close to Claude 4.5 Sonnet."** In a full SWE-Bench integration the
  win shrank to **9.3% median latency / 13.6% tokens** because search was only ~12% of tokens
  there vs ~60% in production coding requests — i.e. the win scales with how search-heavy the
  workload is. https://relace.ai/blog/fast-agentic-search
- Anthropic parallel-tool-use docs: "By default, Claude may use multiple tools to answer a
  user query." Claude 4 models "have excellent parallel tool use capabilities by default."
  Independent, read-only operations "are usually safe to run in parallel for lower latency."
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use

### 2. Distinct multi-facet sub-questions improve retrieval; paraphrase expansion does not

- Question Decomposition for RAG (arXiv 2507.00355): decomposing a *multi-hop* query into
  **distinct sub-questions** gave **+16.5% Hits@10 (74.7→87.2), +36.7% MRR@10** on
  MultiHop-RAG and **+11.6% Answer F1** on HotpotQA. Crucial caveat, quoted: *"Question
  decomposition can be counterproductive when the original query is already specific. In such
  cases, subqueries may introduce noise or distract from the original intent."* The method
  also blindly emitted a fixed budget (5 subqueries, 93.3% of the time) uncorrelated with
  actual evidence count — i.e. *forced* fan-out is wasteful.
  https://arxiv.org/html/2507.00355v1
- RAG-Fusion industry deployment (arXiv 2603.02153): internal multi-query *paraphrase*
  expansion + RRF **does not help end-to-end**. *"Retrieval fusion does increase raw recall,
  but these gains are largely neutralized after re-ranking and truncation"*; Hit@10 fell
  **0.51→0.48** in several configs, and fusion "introduces additional latency overhead ...
  without corresponding improvements in downstream effectiveness." This is the direct
  argument against mechanism #4 for THIS system (which already reranks + truncates).
  https://arxiv.org/abs/2603.02153
- RAG-Fusion original (Raudaschl) confirms RRF "consistently outperformed individual
  rankings" at the *retrieval* level — the mechanism is sound; the production lesson is that
  the *source of the extra queries matters* (distinct facets, not paraphrases).
  https://github.com/Raudaschl/rag-fusion

**Synthesis:** fan-out helps exactly when the queries are semantically *different* (separate
facets / different files), and hurts when they are paraphrases of an already-specific query.
So the decision is: let the *model* supply distinct facets (it knows the task), never expand
internally.

### 3. Anthropic tool-design constraints (keep this disciplined)

From "Writing effective tools for AI agents"
(https://www.anthropic.com/engineering/writing-tools-for-agents):
- "More tools don't always lead to better outcomes." "Too many tools or overlapping tools can
  also distract agents from pursuing efficient strategies." → **do not add a 3rd tool.**
- Consolidate operations: prefer one tool that does the compound job (their `schedule_event`
  / `get_customer_context` examples) over many round-trips. → **a queries[] batch is exactly
  this consolidation.**
- "We restrict tool responses to 25,000 tokens by default." Implement "pagination, range
  selection, filtering, and/or truncation with sensible default parameter values." Return
  "only high signal information." A `response_format` concise option used "~⅓ of the tokens."
  → **budget total results across the batch; don't multiply context by N.**
- "Even small refinements to tool descriptions can yield dramatic improvements." → **the
  description/guideline copy is load-bearing.**

From "Effective context engineering"
(https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents):
- "Find the smallest possible set of high-signal tokens that maximize the likelihood of some
  desired outcome." Context windows "will be subject to context pollution." → **one merged,
  budgeted result block beats N separate result blocks for the same coverage.**

### 4. The mechanism is already in the stack — TurboPuffer multi-query

From https://turbopuffer.com/docs/query:
- "You can provide multiple query objects to be executed simultaneously on a namespace."
- "Up to **16 queries** can be sent per request. Each subquery will count against the
  concurrent query limit for the namespace."
- Snapshot isolation across the batch; "better performance than issuing independent queries
  to the same namespace" (consolidated network overhead).
- Server-side RRF available via `rerank_by: ["RRF", { rank_constant: <n> }]`, default
  `rank_constant` 60, `$dist` carries the fused score — but **this system already fuses
  client-side in `fuse()` with its own `rankConstant` + path/token boosts**, so keep client
  fusion (it does more than RRF).

Current code confirms readiness:
- `src/store/Turbopuffer.ts` `query(body: MultiQueryBody)` already posts `{ queries }` as one
  call; hybrid mode already sends 3 sub-queries (vector ANN + text BM25 + pathText BM25).
- `src/search/Search.ts` `run()` already builds `queries: ReadonlyArray<SubQuery>` and calls
  `fuse(lists, sourceNames, ...)` — RRF across lists with source tagging.
- `src/search/fuse.ts` `fuse()` is `1/(rankConstant+rank+1)` summed across lists + prefix/
  token boosts; `diversify()` enforces `perFile` + `limit`.

So extending one user query → N user queries is mechanically: embed N facets (batch),
expand the per-facet sub-queries (semantic: 1 each; hybrid: 3 each), cap at 16 total sub-
queries, one `store.query`, fuse per facet, then merge facets, then rerank once, then
diversify under the global `limit`.

---

## Mechanism comparison (for THIS system)

| # | Mechanism | Parallel? | Round-trips | Dedup/merge | Distractor cost | Verdict |
|---|-----------|-----------|-------------|-------------|-----------------|---------|
| a | Prompt-only fan-out (separate tool calls) | yes (Pi concurrent) | N HTTP, N embed, N rerank pools, N result blocks | none (model's head) | none | keep as fallback, not primary |
| b | System-prompt rule | enables (a) | — | — | none | **adopt as complement** |
| 2 | New batch tool `multi_search(queries[])` | yes | 1 | server-side | **+1 tool = violates "few tools"** | reject |
| 3 | `queries[]` on existing tools | yes | 1 | server-side | none (same 2 tools) | **adopt (primary)** |
| 4 | Internal expansion (RAG-Fusion) | yes | 1 | server-side | none | reject (neutralized by rerank+trunc; can hurt) |

Why #3 over #2: identical engine, identical one-round-trip win, but **zero new tools** —
satisfies Anthropic's "more tools distract" and the system's deliberate 2-tool design. A new
tool would overlap `code_search` semantically (the agent must now choose between `code_search`
and `multi_search`), which is exactly the "overlapping tools distract" failure.

Why not #4: this system reranks (Cohere v3.5) and truncates (`maxOutputBytes`, `limit`).
The industry RAG-Fusion deployment shows recall gains from machine-expanded queries vanish
after exactly those two steps. The model already knows the task's distinct facets; let it
supply them. Internal expansion adds embed/latency cost for a benefit the rerank erases.

---

## Recommended design (deltas, not rebuild)

### Schema change (`src/pi/extension.ts`)

Add a mutually-exclusive `queries` alongside `query`. Keep `query` as the common path.

```ts
const searchParameters = Type.Object({
  query: Type.Optional(Type.String({
    description: "Natural-language description of the code/behavior/concept/symbol/error. " +
      "Use this for a single focus. For a multi-faceted task, prefer queries[] instead."
  })),
  queries: Type.Optional(Type.Array(Type.String(), {
    minItems: 2, maxItems: 5,
    description: "2-5 DISTINCT facets of one task, retrieved together in a single call " +
      "(e.g. ['where auth tokens are validated','how rate limiting works','retry/backoff logic']). " +
      "Use ONLY when the facets are genuinely different concepts. Do NOT pass paraphrases of " +
      "the same question, and do NOT use for a single specific lookup — use query for that."
  })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25,
    description: "TOTAL ranked snippets across all queries (default 8; merged + deduped)" })),
  pathPrefix: Type.Optional(Type.String({ /* unchanged */ })),
  language: Type.Optional(Type.String({ /* unchanged */ }))
})
```

Validation rule (in `runSearch`): require exactly one of `query` / `queries` non-empty;
trim/dedupe `queries`; cap facets so `facets * subPerFacet <= 16` (semantic subPerFacet=1 →
cap 16 facets but UI-cap at 5; hybrid subPerFacet=3 → cap 5 facets). The 16 ceiling is the
TurboPuffer hard limit, the 5 is the "don't over-fire" budget.

### Search-layer change (`src/search/Search.ts`)

Add a `multi(mode, queries, options)` path that:
1. `embeddings.embed(facets)` once (batch — already supported, `embed` takes an array).
2. Build sub-queries: flat-map each facet's sub-queries (semantic 1, hybrid 3), tagging each
   list with `sourceNames` like `f0:semantic`, `f0:text`, `f1:semantic`... Keep total ≤ 16.
3. One `store.query({ queries })`.
4. `fuse()` per facet (so a doc hit by 2 facets compounds — RRF already sums across lists, so
   passing all lists into one `fuse()` call gives cross-facet reinforcement for free).
5. Rerank ONCE against a synthesized query string (join facets with " / ") so the single
   Cohere call has the full intent; pool size scales with `limit * poolMultiplier` (unchanged).
6. `diversify()` under the global `limit` + `perFile`.
7. Format: keep ONE merged ranked block; annotate each hit's `sources` with which facets hit
   it (already a `sources` array). This is the high-signal/budget discipline from Anthropic.

Net new code is small: the sub-query builder and the `sourceNames` tagging; `fuse`,
`diversify`, rerank, format are reused unchanged.

### Why merge (not group) the output

One budgeted, deduped, cross-reinforced ranked list = "smallest set of high-signal tokens"
and avoids N result blocks. A doc relevant to two facets *should* rank higher — grouped
output loses that signal and triples context. Merge wins on both quality and budget.

### Prompt copy

System prompt (mechanism b — add once, app-level, not per tool):
```
For maximum efficiency, when a task spans several distinct concepts, retrieve them together
in one call: pass code_search/code_grep a queries[] array of the distinct facets rather than
issuing separate searches. Use a single query for a single focus. Only group facets that are
genuinely independent concepts; never pass paraphrases of the same question.
```
(This mirrors Anthropic's recommended `<use_parallel_tool_calls>` rule but points the model
at the *batch param* instead of N tool calls — same intent, one round-trip.)

`code_search.promptGuidelines` — append ONE line:
```
For a multi-faceted task (e.g. "auth + rate limiting + retry"), pass queries[] with the 2-5
DISTINCT facets to retrieve and merge them in one call; use a single query for a single focus.
```

`code_grep.promptGuidelines` — append ONE line (same shape, literal-token framing):
```
When you have several distinct symbols/strings to locate at once, pass them as queries[] to
get one merged ranked result instead of several grep calls.
```

`description` — add one clause to each tool's existing description:
`"... Pass queries[] (2-5 distinct facets) to retrieve several concepts in one merged call."`

### Keep prompt-only fan-out (a) as a non-primary fallback

Do not suppress separate parallel tool calls — Pi/Claude 4 already do this well and it's the
right behavior when the agent only realizes mid-task it needs another angle. The system prompt
nudges toward `queries[]` for *known* multi-facet tasks; the model retains the escape hatch.

---

## How to measure it helps

Instrument three metrics (the `details` object in `runSearch` already returns structured
fields — extend it):

1. **Adoption / over-firing.** Log `queries.length` distribution. Healthy = bimodal: mostly 1
   (single focus) with a tail at 2-5. A spike of forced 2-5 on simple asks = over-firing
   (the arXiv 2507.00355 failure mode); tighten the guideline. Anthropic's own metric:
   average tools-per-tool-calling-message should rise toward >1.0 only when warranted, not
   uniformly.
2. **Tool-calls-to-answer.** Count search tool_use blocks per task before vs after. Target:
   fewer round-trips on multi-facet tasks (the Relace turns 20→5 effect), unchanged on simple
   tasks.
3. **Quality.** On a fixed eval set of multi-facet code-search tasks with known gold files,
   measure Recall@k and MRR of the merged result vs (a) single best-facet query and (b) N
   separate queries the model would have issued. Expect a multi-hop-style lift (cf. +16.5%
   Hits@10) ONLY on genuinely multi-facet tasks; expect parity on single-focus tasks. If
   merged < separate on quality, the merge/rerank step is mis-budgeted (revisit pool size).

Tight verification loop available locally: unit-test `fuse()` cross-facet reinforcement
(a doc in 2 facet lists outranks a doc in 1), and an integration test that a 3-facet
`queries[]` produces exactly one `store.query` call with ≤16 sub-queries.

---

## Risks

- **Over-firing on specific queries** (arXiv 2507.00355: decomposition hurts already-specific
  queries). Mitigation: guideline says "single query for a single focus"; param description
  says "ONLY when facets are genuinely different"; `minItems: 2` forces the model to commit to
  real multi-facet intent. Monitor metric #1.
- **Context bloat if output isn't budgeted.** Mitigation: `limit` is the TOTAL across facets,
  merged+deduped, one block, `maxOutputBytes` cap unchanged. This is strictly less context
  than N separate result blocks.
- **Rerank dilution** when many facets share a pool. Mitigation: rerank once against the joined
  intent; if quality drops, rerank per-facet top-N then merge (fallback design, not default).
- **16 sub-query ceiling.** Hybrid (3 sub-queries/facet) caps at 5 facets — already the UI
  budget, so no conflict. Enforce in validation, fail loudly if exceeded (no silent drop).

---

## Sources

- Anthropic, Writing effective tools for AI agents — https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic, Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Claude API, Parallel tool use — https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- Relace, Fast Agentic Search (4x parallel) — https://relace.ai/blog/fast-agentic-search
- Morph, Agentic Search (semantic vs grep, +12.5% Cursor) — https://www.morphllm.com/agentic-search
- Question Decomposition for RAG (distinct sub-questions; +16.5% Hits@10) — https://arxiv.org/html/2507.00355v1
- Scaling RAG with RAG Fusion: industry deployment (paraphrase expansion neutralized) — https://arxiv.org/abs/2603.02153
- RAG-Fusion (RRF + multi-query, original) — https://github.com/Raudaschl/rag-fusion
- TurboPuffer query docs (16-query multi-query, RRF, snapshot) — https://turbopuffer.com/docs/query

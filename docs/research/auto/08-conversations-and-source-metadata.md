# Indexing AI-Agent Conversations + Unified Source-Metadata Design

Research brief for the Pi semantic + hybrid code-search system. Two coupled questions:
**(A)** is it worth indexing Pi/agent conversations as a project-knowledge layer, and exactly what to
index/skip; **(B)** how to unify `code | history | conversation | docs` under one top-level `source`
metadata dimension with source-aware filtering, reranking, and routing.

Grounded against current source (`src/store/schema.ts`, `src/search/Search.ts`, `src/search/fuse.ts`,
`src/domain/types.ts`, `src/config/defaults.ts`, `src/pi/tools.ts`), the **real on-disk Pi session
files** under `~/.pi/agent/sessions/`, the Pi `session-format.md` / `sessions.md` docs, the prior
`git-history-indexing.md` brief, and primary sources cited inline. Date: 2026-06-20.

---

## TL;DR decision

**A — Conversation indexing is worth it, but only for ~2.4% of the bytes.** Empirically, in a real Pi
session, `toolResult` content is **78.9%** of bytes and `toolCall` arguments **18.8%**; user intents +
assistant final text together are **~2.4%** (measured below). That ~2.4% is exactly the high-value
layer — "what we decided / why / what the user asked for" — and the 97.6% is noise that **duplicates the
code index** (file reads, command dumps). So: **index user messages + assistant final text + compaction
& branch summaries; SKIP raw tool results and tool-call arguments** (keep at most a one-line tool-call
verb, optionally). Granularity: **per-turn** (one user message + the assistant text that answers it),
not per-message and not whole-session. Bound to a **token/recency budget** and run incrementally on
new/changed session files.

**B — Hoist `source` to a top-level filterable attribute (`code | history | conversation | docs`) and
keep `kind` as a code-only sub-facet (`code | docs | config | test`).** Store both in the same
TurboPuffer namespace. A plain `code_search` must still return **mostly code**; conversation/history
surface only when the query is **clearly decisional/historical**. Achieve that with **(1) a default
source filter of `code` + `docs`**, **(2) a lightweight query-intent router** that widens the filter to
include `conversation`/`history` on decisional phrasing, and **(3) per-source quotas in `diversify`** so
one source cannot drown the others. The reranker stays source-blind on the document body but receives a
**source-prefix label** (`[conversation 2026-06-15] …`) so it can down-weight chatter relative to a code
match for a "where is X" query.

**Tool surface — reconcile with the prior history decision.** The prior `git-history-indexing.md` brief
chose a **separate `code_history` tool** and `kind:"commit"`. This brief supersedes the *schema* half of
that (history moves from `kind` to `source`), and **keeps** the separate-tool instinct only for
**history**. For **conversation**, do **NOT** add a tool: fold it into `code_search` behind the router,
because a plain `code_search` is exactly where "what did we decide about X" naturally lands, and a third
tool pushes us to 3-4 tools against clear distractor-load evidence (below). Net tool surface:
`code_search` (code+docs+conversation, router-gated) + `code_grep` + `code_history` (history). Three
tools, each with an unambiguous verb.

**Core trade-off:** we accept a small chance of conversation chatter leaking into a code query (mitigated
by default filter + quotas + rerank label) in exchange for *not* adding a fourth tool and *not* forcing
the agent to know which verb to use for "why did we pick X." The `source` filter + source-aware rerank
is the cheaper, composable lever.

---

## Part A — Indexing AI-agent conversations

### A.1 Is it worth it? Evidence from the landscape

Persistent agent memory is now a standard layer, and the consensus is **store decisions/intents, not raw
transcripts**:

- **Letta (formerly MemGPT)** separates a short recent-message buffer from long-term recall memory and
  *summarizes* rather than storing everything; the agent self-edits memory blocks. The lesson: memory is
  curated facts/decisions, not a full log.
  - https://www.letta.com/blog/agent-memory/ · https://arxiv.org/pdf/2310.08560
- **Mem0 / agent-memory comparisons** stress that recall quality "depends entirely on the embedding model
  and the chunking strategy" and that vector memory silently degrades when fed noise.
  - https://sureprompts.com/blog/agent-memory-architectures-compared-2026
- **Claude Code memory** is file-based (`CLAUDE.md` layers) + a memory tool; it persists *curated*
  project facts, not transcripts. Milvus's critique is that exact-keyword memory misses paraphrases
  ("port conflicts" vs "docker-compose mapping") — i.e. semantic retrieval over decisions is the value.
  - https://code.claude.com/docs/en/memory · https://milvus.io/blog/claude-code-memory-memsearch.md
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- **Context-rot** is the counter-pressure: model performance degrades as irrelevant tokens grow, and
  "agents accumulate noise during search/exploration." This is the strongest argument for indexing only
  intents+conclusions and aggressively filtering by source at query time.
  - https://www.trychroma.com/research/context-rot · https://www.morphllm.com/context-rot
  - https://www.elastic.co/search-labs/blog/context-poisoning-llm

**Verdict:** worth it. The unique value a code index *cannot* provide is the *decision record* — "we
chose TurboPuffer over pgvector because of BM25," "we decided to skip raw tool outputs," "the user wants
results stamped with dates." That lives only in conversation. But it is a thin, high-signal layer, and it
must be quarantined behind `source` so it never pollutes a "where is X" code query.

### A.2 The Pi session on-disk format (verified against real files)

**Location** (verified): `~/.pi/agent/sessions/--<cwd-with-slashes-as-dashes>--/<ISO-ts>_<uuid>.jsonl`.
The project a session belongs to is encoded **two ways**, both present in real files:
1. The **directory name** is the cwd with `/` → `-`, wrapped in `--…--`. Example real dir:
   `--Users-dallen.pyrah-projects-steward--`.
2. The **header line** (first JSONL line) carries the literal cwd. Verified header:
   ```json
   {"type":"session","version":3,"id":"019eccc5-8ce8-724c-8545-78441d6251a8",
    "timestamp":"2026-06-15T19:32:39.272Z","cwd":"<example-project>"}
   ```
   **Use the header `cwd`, not the dir name** — the dir-name encoding is lossy (a real repo path with a
   `-` in it is ambiguous), and forked sessions carry a `parentSession` path that can point elsewhere.

**Enumerating a project's sessions:** glob `~/.pi/agent/sessions/--*--/*.jsonl`, read line 1 of each,
keep those whose header `cwd` equals (or is under) the target repo root. Do **not** rely solely on the
dir name. The `SessionManager.list(cwd)` / `listAll()` SDK methods do this canonically if we prefer the
library path (`session-format.md` §SessionManager API).

**Entry/message shapes (verified against real session files):**

- Header (line 1, no `id`/`parentId`): `{type:"session", version:3, id, timestamp, cwd, parentSession?}`.
- Every other entry extends `{type, id /*8-char hex*/, parentId /*null at root*/, timestamp /*ISO*/}`
  and entries form a **tree** (branching via `parentId`), not a flat list.
- **User message** (verified):
  ```json
  {"type":"message","id":"9621cc28","parentId":"b071fb73","timestamp":"2026-06-15T19:32:49.258Z",
   "message":{"role":"user","content":[{"type":"text","text":"Can you please switch to main"}],
   "timestamp":1781551969253}}
  ```
  Note `content` is **string OR `(TextContent|ImageContent)[]`** — handle both.
- **Assistant message** (verified shape): `message.role:"assistant"`, `content` is an array of
  `text` / `thinking` / `toolCall` blocks, plus `model`, `provider`, `stopReason`, `usage`. The
  *final answer* is the `text` blocks; `thinking` and `toolCall` are not the answer. Verified blocks
  for one assistant turn: `["thinking","toolCall"]` (no user-facing text — a pure tool turn, skip it),
  and later turns with `text` like `"Switched to \`main\`. Note: local main is behind origin/main…"`.
- **Tool call** block (verified): `{"type":"toolCall","id":"call_…","name":"bash",
  "arguments":{"command":"git status --short --branch"}}`.
- **Tool result message** (verified): `{role:"toolResult", toolCallId, toolName, content:[{type:"text",
  text:"…"}], isError, timestamp}`. Content can be tiny (24 chars) or large (KBs).
- **Compaction entry** (from format doc; high value): `{type:"compaction", summary, firstKeptEntryId,
  tokensBefore}` — an LLM summary of earlier context.
- **Branch summary** (from format doc): `{type:"branch_summary", fromId, summary}` — captures an
  abandoned exploration path.
- Also present: `model_change`, `thinking_level_change`, `custom`, `custom_message`, `label`,
  `session_info` (display name). Most are state/UI, not knowledge — skip for indexing.

### A.3 The byte economics — measured, not assumed

Measured across one real 163K-char Pi session (`steward`, 4 user / 108 assistant / 102 toolResult):

| Role / block        | chars   | % of content |
|---------------------|---------|--------------|
| toolResult          | 128,660 | **78.9%**    |
| toolCall arguments  | 30,621  | **18.8%**    |
| assistant text      | 3,390   | 2.1%         |
| user text           | 443     | 0.3%         |
| thinking            | 0       | 0.0%         |

**The decision-bearing signal (user + assistant text) is ~2.4% of the bytes.** Indexing tool results
would 40× the corpus size, duplicate the live code index (they *are* file reads and command output),
blow embedding cost, and feed context-rot. This single measurement is the spine of the "skip tool
outputs" recommendation — it is not a guess.

### A.4 What to index, what to skip, granularity

**INDEX (per-turn rows):**
- **User message text** → the *intent* ("why did we change X", "switch to main", "let's use RRF").
- **Assistant final `text` blocks** → the *conclusion/decision/explanation* ("Switched to main, behind
  by 2 commits"; "We'll fuse per-source then merge").
- **Compaction `summary`** and **branch_summary `summary`** → dense, pre-curated decision records;
  highest value-per-byte. Index as their own `source:"conversation"` rows tagged `turnKind:"summary"`.

**SKIP:**
- **toolResult content** — 79% of bytes, duplicates the code index, noisy. Hard skip.
- **toolCall arguments / thinking blocks** — internal reasoning, not a decision; skip. *Optionally*
  keep a **one-line tool-call verb** appended to the turn ("ran: git switch main; edited Search.ts") so
  a turn has a thin action trace — gated behind a config flag, default OFF.
- **Pure tool-only assistant turns** (no `text` block) — skip; they carry no answer.
- **Trivial chatter** — turns whose combined user+assistant text is below a min length (e.g. < 80 chars
  after trimming greetings/acks) — skip via a cheap heuristic.

**Granularity: per-turn.** One row = `{user intent} ⇒ {assistant conclusion}` for a turn. Rationale:
per-message splits the question from its answer (a user "why?" embeds poorly alone; the answer embeds
without the question); whole-session is too coarse to rank and re-embeds on every append. Per-turn is the
natural decision unit and keeps the question+answer in one embedding for retrieval.

**Row text shape (what gets embedded):**
```
User: <user text>
Assistant: <assistant final text>
[optional] Actions: <one-line tool verbs>
```

### A.5 Noise / cost / privacy / incrementality

- **Recency + token budget:** index only the **last N sessions** per project (e.g. N=20) or a token cap
  (e.g. 200K input tokens of conversation), newest first. Decisions decay; ancient sessions rarely help.
- **Dedup:** hash the row text (`chunkHash`, as today); identical re-asked questions collapse.
- **Redaction:** run a secret scrubber over user+assistant text before embedding (API keys, tokens,
  `Bearer …`, `.env` values). Conversations are *more* likely to contain pasted secrets than code is.
- **Incremental:** key off **session file mtime + last-indexed leaf id**. On change, parse the **active
  branch only** (leaf→root walk), diff against indexed turn hashes, upsert new turns. Pi appends, so this
  is cheap; full re-index only on a forced rebuild.
- **Privacy gate:** conversation indexing is **opt-in per project** (a config flag), because sessions can
  hold cross-project or sensitive context. Default OFF until the user enables it.

### A.6 Labeling so the model treats hits as HISTORY, not live code or an instruction

Two layers, mirroring the prior history brief's "stamp it so it can't be mistaken" rule:
1. **`source:"conversation"` attribute** drives filtering + quotas + rerank weighting (Part B).
2. **Result formatting stamp**: prefix each conversation hit with role + session date so the model reads
   it as a *past discussion*, never a current instruction:
   ```
   [conversation 2026-06-15 · user→assistant] We decided to skip raw tool outputs because …
   ```
   This is the single most important anti-confusion lever: a stamped, dated, role-labeled snippet cannot
   be misread as "the user is telling me to do this now" or as live source code.

---

## Part B — Unified source-metadata design

### B.1 Schema: add `source`, keep `kind`

`source` is the **top-level corpus dimension**; `kind` becomes a **code-only sub-facet**. They are
orthogonal: `source` answers "what kind of artifact" (code / git history / conversation / prose docs);
`kind` answers "within live code, is this code/test/config/docs."

```ts
// domain/types.ts
export type Source = "code" | "history" | "conversation" | "docs"
export type ChunkKind = "code" | "docs" | "config" | "test"   // unchanged; meaningful only for source:"code"

// store/schema.ts — buildSchema additions
source:    { type: "string", filterable: true },              // NEW top-level dimension
turnKind:  { type: "string", filterable: true },              // conversation: "turn" | "summary"
sessionId: { type: "string", filterable: true },              // conversation provenance
ts:        { type: "uint",   filterable: true },              // unix-ms; conversation date / commit date — enables recency rank_by & filters
```

Row mapping: `code` rows set `source:"code"` and the existing `kind`; `docs` rows (prose, e.g. README,
ADRs indexed as prose) set `source:"docs"`; conversation rows set `source:"conversation"`, `kind` unset;
history rows set `source:"history"` (reconciling the prior `kind:"commit"` → `source:"history"`).

**Reconciliation with `git-history-indexing.md`:** that brief put history under `kind:"commit"` with a
`committedAt` attribute. This design **moves history to `source:"history"`** and unifies its date into
the shared `ts` attribute. The prior brief's *tool* decision (separate `code_history`) is preserved; only
its *schema slot* changes. Update that brief's schema section when implementing.

### B.2 TurboPuffer storage + filtering

`source` is a plain filterable string attribute — same mechanism as the existing `kind`/`language`
filters in `buildFilters`. Filtering by source is `["source","Eq","code"]`, or a set membership for the
default mix. TurboPuffer supports `In`/`Or` for multi-value; the default code+docs filter is:
```
["source","In",["code","docs"]]     // or ["Or",[["source","Eq","code"],["source","Eq","docs"]]]
```
Combine with existing filters under the same `["And",[…]]` wrapper already in `buildFilters`.

### B.3 Search / rerank / routing

**Should tools take an optional `source` filter?** Yes — add `source?: Source | Source[]` to
`SearchOptions`, same shape as the existing `kind`/`language` options. Explicit beats magic when the
caller knows.

**Should the system infer source intent from the query?** Yes — a **lightweight, deterministic router**,
not an LLM call (latency/cost). It only *widens* the default filter; it never narrows code out:

```
DEFAULT source mix:        ["code","docs"]      (a plain code_search returns mostly code)
DECISIONAL cue → add:      "conversation"       (why did we / what did we decide / we chose / rationale / discussed)
HISTORICAL cue → add:      "history"            (when was / who changed / introduced / regressed / since when)
EXPLICIT options.source    → overrides router entirely
```

Routing rule (pseudocode in B.6). Cues are matched on the lowercased query against small phrase lists;
on a hit, the corresponding source joins the filter set. "Where is X" / "how does X work" never match a
cue, so they stay code+docs — the default reflex is preserved.

**Should the reranker get a source signal?** Yes, but cheaply: **prefix the document passed to Cohere
rerank-v3.5 with the source label** (`[conversation 2026-06-15] …`, `[commit a1b2c3 2026-05-04] …`,
plain `path` for code). The reranker already receives `path\n\ntext`; the label rides in the same slot.
This lets the reranker learn that for a "where is X" query a labeled-conversation passage is a weaker
match than a code passage, *without* a new model input. Additionally, keep a small **post-rerank source
bonus** mirroring today's `kindBonus`: `code:+0.04, docs:0, history:−0.01, conversation:−0.015` by
default, but **flip the sign on a router hit** (when `conversation`/`history` was requested, give it
`+0.03`) so the requested source is allowed to win.

**Avoiding one source drowning the others — per-source quotas in `diversify`.** Today `diversify` caps
per-*file*. Add a per-*source* cap so a flood of conversation turns can't evict all code. Approach:
**RRF/rerank as today across the merged candidate pool, then a quota pass** that admits at most
`sourceCap[source]` hits per source until `limit` is filled, with the **default mix biased to code**:
```
limit=8 default →  code≤6, docs≤2, conversation≤2, history≤2   (caps, not guarantees; code fills first)
router hit (decisional) → raise the requested source's cap (e.g. conversation≤4) and lower code's floor
```
This is a small, composable add to the existing `diversify` (it already iterates candidates with a
`Map` counter — extend the key from `path` to `(source,path)` plus a `source` budget).

### B.4 Tool surface: filter vs new tool (the distractor-load call)

**Decision: do NOT add a conversation tool. Fold conversation into `code_search` behind the router.
Keep the separate `code_history` tool from the prior brief.** Final surface = **3 tools**.

Evidence and reasoning:
- **Distractor load is real and measured.** "How Many Tools Should an LLM Agent See? A Chance-Corrected
  Answer" (arXiv 2605.24660, 2026-06) and "ToolChoiceConfusion" (arXiv 2606.06284, 2026-06) both show
  selection accuracy falls as the tool set grows and that exposing tools that aren't causally useful for
  the current step degrades trajectories (wrong-tool calls, longer paths). MCP "too many tools" write-ups
  echo this in practice.
  - https://arxiv.org/abs/2605.24660 · https://arxiv.org/html/2606.06284
  - https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/
- The system's deliberate **keep-tools-few (2)** principle is correct. Going to 3 (adding `code_history`)
  is justified by an **unambiguous live-vs-history verb boundary** (per the prior brief). Going to 4
  (a separate conversation tool) is **not** justified: "what did we decide about X" is a *search* whose
  natural entry point is `code_search`; a fourth tool just adds a wrong-tool failure mode for a query the
  router already handles.
- History keeps its own tool because **history results are structurally different** (commit/sha/date,
  not file/line) and the agent's reflex on `code_search` is "give me live code" — Sourcegraph similarly
  models commits/diffs as distinct result *types*, not code-with-a-date (per prior brief).
- Conversation, by contrast, is returned in the **same file/line-snippet shape** as code (it's a
  snippet of text with a stamp), so it composes into `code_search`'s existing result format cleanly,
  gated by the router + default filter + quota.

`code_search` description gains one line: *"Also surfaces past decisions and discussion from prior
sessions when you ask why/what-we-decided; those results are stamped `[conversation <date>]`."*

### B.5 Default behavior — the precise rule

- **Plain `code_search("where is the reranker")`** → router finds no decisional/historical cue →
  filter = `["code","docs"]`, quotas `code≤6 docs≤2` → returns **mostly code**. Unchanged UX.
- **`code_search("why did we pick TurboPuffer over pgvector")`** → decisional cue ("why did we") →
  filter widens to include `conversation` → conversation rows get the flipped `+0.03` rerank bonus and a
  raised quota (`conversation≤4`) → the decision record surfaces, code still present.
- **`code_search("when was the rerank pool size changed")`** → historical cue ("when was … changed") →
  widen to `history` → commit rows surface. (Or the agent uses `code_history` directly.)
- **Explicit `options.source`** always wins over the router.

### B.6 Pseudocode

**Conversation indexer** (per project, opt-in):

```ts
// Enumerate this project's sessions by header cwd, newest first, bounded by budget.
function* projectSessions(repoRoot: string): Iterable<SessionFile> {
  for (const file of glob("~/.pi/agent/sessions/--*--/*.jsonl")) {
    const header = JSON.parse(firstLine(file))            // {type:"session", cwd, id, ...}
    if (header.type !== "session") continue
    if (!isUnderRepo(header.cwd, repoRoot)) continue       // header.cwd is source of truth
    yield { path: file, sessionId: header.id, cwd: header.cwd, mtime: statMtime(file) }
  }
}

function indexConversations(repoRoot: string, cfg: ConvCfg): Row[] {
  const sessions = take(byMtimeDesc(projectSessions(repoRoot)), cfg.maxSessions)  // recency bound
  const rows: Row[] = []
  let tokenBudget = cfg.maxTokens
  for (const s of sessions) {
    if (mtimeUnchanged(s) && alreadyIndexed(s)) continue   // incremental: skip stale-unchanged
    const entries = parseJsonl(s.path)
    const path = activeBranch(entries)                     // leaf→root walk (tree-aware)

    // 1) summaries first — densest decisions
    for (const e of path) if (e.type === "compaction" || e.type === "branch_summary") {
      rows.push(makeRow({ source:"conversation", turnKind:"summary",
        sessionId:s.sessionId, ts:isoToMs(e.timestamp), text: redact(e.summary) }))
    }

    // 2) per-turn user-intent ⇒ assistant-conclusion
    for (const turn of turns(path)) {                      // pair each user msg with following assistant text
      const userText = textOf(turn.user)                   // string | TextContent[] → string
      const asstText = assistantFinalText(turn.assistant)  // join `text` blocks; "" if tool-only turn
      if (!asstText && !userText) continue
      const combined = `${userText}\n${asstText}`.trim()
      if (combined.length < cfg.minTurnChars) continue     // skip trivial chatter
      const actions = cfg.includeToolVerbs ? oneLineToolVerbs(turn.assistant) : undefined // default off
      const body = redact(formatTurn(userText, asstText, actions))
      const tok = estimateTokens(body); if (tokenBudget - tok < 0) break
      tokenBudget -= tok
      const hash = sha256(body)
      if (indexedHashes.has(hash)) continue                // dedup
      rows.push(makeRow({ source:"conversation", turnKind:"turn",
        sessionId:s.sessionId, ts:turnTs(turn), text: body }))
    }
    markIndexed(s)
  }
  return rows  // → embed → upsert into the SAME namespace
}

function assistantFinalText(asst: AssistantMessage[]): string {
  return asst.flatMap(m => m.content)
             .filter(c => c.type === "text")               // drop thinking + toolCall
             .map(c => c.text).join("\n").trim()
}
```

**Source-aware retrieval routing** (extends `Search.run` / `buildFilters`):

```ts
const CUES = {
  conversation: ["why did we","what did we decide","we chose","we decided","rationale","discussed","agreed","trade-off","approach we"],
  history:      ["when was","who changed","introduced","since when","regress","what commit","history of","previously"],
}
const DEFAULT_SOURCES = ["code","docs"] as const

function routeSources(query: string, explicit?: Source[]): Source[] {
  if (explicit?.length) return explicit               // caller wins
  const q = query.toLowerCase()
  const set = new Set<Source>(DEFAULT_SOURCES)
  if (CUES.conversation.some(c => q.includes(c))) set.add("conversation")
  if (CUES.history.some(c => q.includes(c)))      set.add("history")
  return [...set]
}

// buildFilters: add  filters.push(["source","In", routeSources(query, options.source)])
// rerank label:  doc = `${sourceStamp(row)}\n\n${row.text}`  // [conversation 2026-06-15] / [commit a1b2c3 2026-05-04] / path
// source bonus:  base = {code:0.04, docs:0, history:-0.01, conversation:-0.015}
//                if (requested.includes(row.source) && row.source !== "code") bonus = +0.03  // flip when asked for
// diversify:     key by (source,path); enforce sourceCap[source]; code fills first; raise requested cap on router hit
```

### B.7 Phased plan

- **Phase 0 — schema + filter (no new corpus).** Add `source` (+`turnKind`,`sessionId`,`ts`) to schema;
  backfill existing rows as `source:"code"`. Add `source` to `SearchOptions`, `buildFilters`, and the
  default `["code","docs"]` filter. Ship the router (`routeSources`) and the per-source quota in
  `diversify`. Reconcile `git-history-indexing.md` to `source:"history"`. **Verifiable now**: code search
  behavior unchanged; `source` filter works; quotas hold.
- **Phase 1 — conversation indexer (summaries + turns), opt-in.** Implement `indexConversations`
  (enumerate by header `cwd`, per-turn rows, redaction, recency/token budget, dedup, incremental on
  mtime). Source-stamp results. Default OFF. **Verify**: a "why did we decide X" query surfaces the
  stamped decision; a "where is X" query still returns mostly code (quota holds).
- **Phase 2 — rerank source signal + bonus flip.** Add the source-prefix label to rerank docs and the
  router-aware bonus flip. **Verify**: decisional queries rank the conversation hit above code; default
  queries unaffected.
- **Phase 3 — tuning.** Tune caps, cue lists, budget N, and the `includeToolVerbs` flag against real
  usage; consider promoting only assistant turns that the user later affirmed.

---

## Sources

- Letta agent memory / MemGPT: https://www.letta.com/blog/agent-memory/ · https://arxiv.org/pdf/2310.08560
- Agent-memory architectures (2026): https://sureprompts.com/blog/agent-memory-architectures-compared-2026
- Claude Code memory: https://code.claude.com/docs/en/memory · https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · https://milvus.io/blog/claude-code-memory-memsearch.md
- Context rot / poisoning: https://www.trychroma.com/research/context-rot · https://www.morphllm.com/context-rot · https://www.elastic.co/search-labs/blog/context-poisoning-llm
- Tool-count / distractor load: https://arxiv.org/abs/2605.24660 · https://arxiv.org/html/2606.06284 · https://demiliani.com/2025/09/04/model-context-protocol-and-the-too-many-tools-problem/
- RRF / hybrid fusion across sources: https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking · https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search
- Pi session format: `~/.pi/.../pi-coding-agent/docs/session-format.md`, `sessions.md`; real files under `~/.pi/agent/sessions/--*--/*.jsonl`
- Prior brief: `docs/research/auto/git-history-indexing.md`

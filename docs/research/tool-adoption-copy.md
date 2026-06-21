# Brief: Making the Coding Agent PREFER `code_search` / `code_grep` Over Plain grep/read

Research date: 2026-06-20. Target harness: Pi coding-agent (`@earendil-works/pi-coding-agent`). All non-obvious claims cited to primary sources (Pi docs, Anthropic/OpenAI engineering guidance, arXiv papers, Pi source). This brief is self-contained: copy the final-draft blocks at the bottom directly into the extension.

---

## TL;DR Decisions

1. **Rename the single `search` tool to two clearly-named tools: `code_search` (semantic intent) and `code_grep` (hybrid semantic+BM25 with exact-token guarantee).** A model picks the tool whose name matches its current intent; one generic `search` collides with built-in `grep`/`bash grep` and loses. (Anthropic: namespace by service/resource; OpenAI: "obvious and intuitive" names, principle of least surprise.)
2. **Strip implementation detail from descriptions.** The current description leaks `Turbopuffer`, `OpenRouter`, `text-embedding-3-large`, `BM25`. The model does not select on infrastructure; it selects on *what the tool does for it now*. Replace with intent + when-to-use + when-NOT + payoff. (Anthropic: "return only high signal information"; "describe your tool to a new hire... make implicit context explicit".)
3. **Lead descriptions verb-first with a concrete trigger list and an explicit token-economy payoff** ("one call instead of many greps + reads"). The payoff is the actual selection lever: the model is trained to conserve context. (Anthropic: agents have limited context, computer memory is cheap; restrict tool responses; CMTF paper: ~90% token reduction is the win.)
4. **Every `promptGuidelines` bullet must name its tool literally** (`Use code_search when…`), never "this tool". Pi appends guideline bullets flat into one shared `Guidelines` section with no tool prefix — "this" is unresolvable. (Pi docs, extensions.md, two explicit warnings.)
5. **Add a default-on routing bullet that demotes the built-ins** ("Prefer `code_search` over `grep`/`read` for discovery; fall back to `grep` only for exact-token/regex sweeps the index hasn't caught"). The built-ins ship their own guideline bullets (`Use read to examine files instead of cat or sed`); we must explicitly claim the discovery slot or the model defaults to grep.
6. **Ship a `code-search` skill** whose frontmatter `description` front-loads trigger phrases ("find where… is implemented", "trace… across the codebase", "search by meaning") so progressive-disclosure selection fires. Skill body teaches the decision tree and shows `code_search` → `read` follow-up.
7. **Keep tool count tiny (2).** Distractor load measurably degrades selection: accuracy drops ~6 pts going 2→5 tools, and up to ~16 pts on medium-difficulty queries (BoR paper). Two well-named tools beats five overlapping ones.
8. **Benchmark adoption with a held-out task set**, primary metric = adoption rate (fraction of discovery tasks whose first retrieval call is `code_search`/`code_grep`), secondary = tool-calls-to-answer and tokens-to-answer. Tune copy against it; do not overfit. (Anthropic eval methodology.)

---

## 1. How the Pi agent actually sees a tool (ground truth)

From `extensions.md` and Pi source (`dist/core/tools/*.js`), three independent strings drive selection, in order of how often the model reads them:

| Slot | Where it appears | Length budget | Drives |
|---|---|---|---|
| `promptSnippet` | One line in the system-prompt **`Available tools`** list (always in context) | ~6–12 words | First-pass *awareness*. If omitted, a custom tool is **left out of `Available tools` entirely** (extensions.md). |
| `promptGuidelines[]` | Flat bullets appended to the shared **`Guidelines`** section (only while the tool is active) | 1 sentence each | *Routing* — when to reach for it vs. alternatives. Must name the tool. |
| `description` | The tool's full description in the tool schema (read when the model is deciding to call) | 2–5 sentences | *Final commit* — confirms inputs/outputs and triggers. |

Built-in competitors and their exact copy (Pi source):

- `grep`: snippet `"Search file contents for patterns (respects .gitignore)"`; description `"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore..."`. No `when-not` guidance — pure capability.
- `read`: snippet `"Read file contents"`; guideline `"Use read to examine files instead of cat or sed."`
- `bash`: snippet `"Execute bash commands (ls, grep, find, etc.)"` — note bash advertises grep/find, a third competitor for discovery.

**Implication:** our two tools must (a) claim a snippet line each so they appear in `Available tools`, (b) win the `Guidelines` routing war against `read`'s and bash's bullets, and (c) carry a description that names concrete triggers grep's does not.

Current extension state (`index.ts:260-276`): a single tool `name:"search"`, `label:"Search"`, description leaking infra, two reasonable but improvable guideline bullets. This is the thing to replace.

---

## 2. Naming patterns that drive selection

Evidence-backed rules:

- **Namespace with a `code_` prefix** to delineate from built-ins and signal domain. Anthropic: "namespacing tools by service (`asana_search`, `jira_search`) and by resource"; "selecting between prefix- and suffix-based namespacing [has] non-trivial effects on our tool-use evaluations." OpenAI: use namespaces to group related tools so the model distinguishes similar ones.
- **Verb/intent-first, least surprise.** OpenAI: names "obvious and intuitive," principle of least surprise. `code_search` reads as "search code by meaning"; `code_grep` reads as "grep but smarter."
- **Two tools, not one, not five.** The single generic `search` is *semantically related but ambiguous* against built-in grep — the BoR paper's distractor effect and the CMTF paper's "semantically related but wrong tool" confuser both predict mis-selection. Two tools each owning a distinct intent removes the ambiguity without adding distractor load (stay well under the 2→5 tool accuracy cliff).
- **Reject these names:** `search` (collides with grep/bash, no domain), `semantic_search` + `hybrid_search` (jargon "hybrid" means nothing to the model's intent; "semantic" is fine because it maps to "by meaning"), `turbopuffer_query`/`vector_search` (leaks infra, Anthropic anti-pattern), `find_code`/`query_index` (vague).

**Decision — final names:**
- `code_search` — semantic, meaning-based discovery. Default discovery tool.
- `code_grep` — hybrid retrieval with an exact-token guarantee (semantic recall + literal/BM25 match). Use when the user gives a literal symbol/string/error and still wants ranked, cross-file results.

(If the team prefers one tool: keep `code_search` and fold the literal path into a `mode: "semantic" | "exact"` enum. Two tools is recommended because the *name* is the strongest selection signal and a name can only advertise one intent.)

---

## 3. Description patterns

Anthropic + OpenAI converge on a description template. Each description must contain, in order:

1. **Verb-first one-liner**: what it does, in intent terms (not infra).
2. **When to use** — 3–5 concrete triggers phrased as the situations the model actually finds itself in ("you don't know which file", "find all callers", "an error string").
3. **When NOT to use** — the explicit boundary that hands the residual to grep/read. OpenAI: "describe when (and when not) to use each function. Generally, tell the model exactly what to do." This is the single most-skipped, highest-leverage line.
4. **Output shape** — "ranked snippets with file path + line range", so the model knows it gets actionable locations and a cheap follow-up `read`.
5. **Payoff** — token/turn economy: "one call replaces many grep+read round-trips." Anthropic's whole framing is context as the scarce resource; CMTF shows the win is ~90% fewer tokens. This is what makes a context-trained model *prefer* it.

Anti-patterns to delete (all present in current copy or common):
- Leaking implementation (`Turbopuffer`, `OpenRouter`, `BM25`, embedding model). Anthropic: high-signal only; the model can't act on infra.
- Pure-capability description with no triggers and no boundary (this is exactly what built-in `grep` has — so a capability-only description ties, and grep wins the tie by being default/cheaper-looking).
- "this tool" anywhere a guideline lands (unresolvable in Pi's flat Guidelines).
- Overlapping descriptions between `code_search` and `code_grep` (creates the "semantically related but wrong tool" confuser, CMTF paper). Make the boundary between them explicit in *both* descriptions.

---

## 4. Final-draft copy (ready to paste)

### Tool A — `code_search`

```ts
pi.registerTool({
  name: "code_search",
  label: "Code Search",
  description:
    "Find code, docs, and symbols by MEANING across the whole project in one call. " +
    "Use when you don't yet know which file holds the logic, when you're tracing a concept, " +
    "feature, behavior, or data flow across files, or when the user describes WHAT something does " +
    "rather than its exact name (e.g. 'where do we validate auth tokens', 'how is retry handled', " +
    "'find the rate limiter'). Returns ranked snippets with file path and line range so you can " +
    "read or edit the right location directly. Prefer this over running several grep + read calls " +
    "to explore: one code_search replaces many round-trips and spends far less context. " +
    "Do NOT use it for an exact literal string or regex you already know verbatim — use code_grep " +
    "(ranked exact + semantic) or the built-in grep for that.",
  promptSnippet:
    "Find code/docs/symbols by meaning in one call (use before grep for discovery)",
  promptGuidelines: [
    "Use code_search first for discovery — locating unknown files, tracing a concept/behavior/feature across the codebase, or any 'where/how is X done' question — instead of multiple grep and read calls.",
    "Prefer code_search over grep and read for exploration; it returns ranked file+line snippets in one call and uses far less context than grep-then-read loops.",
    "Pass pathPrefix or language to code_search when the user names a package, app, directory, or programming language.",
  ],
  parameters: searchParameters,
  // execute(): return ranked snippets; resolve to repo-relative path + line range, no UUIDs.
});
```

### Tool B — `code_grep`

```ts
pi.registerTool({
  name: "code_grep",
  label: "Code Grep",
  description:
    "Find an exact symbol, string, or error message AND its semantically-related code, ranked across " +
    "the whole project in one call. Use when you have a literal token (function name, variable, error " +
    "text, config key) but still want every relevant hit ranked by relevance and grouped with related " +
    "code — not a flat unranked match list. Returns ranked snippets with file path and line range. " +
    "Prefer code_grep over the built-in grep when you want ranked, cross-file results or aren't sure " +
    "the literal spelling is exact. Use the built-in grep only for a raw, exhaustive regex sweep or " +
    "when the project index may be stale.",
  promptSnippet:
    "Ranked exact-token + related-code search across the project (smarter grep)",
  promptGuidelines: [
    "Use code_grep instead of the built-in grep when you have an exact symbol, string, or error but want ranked, cross-file results that also surface related code.",
    "Fall back to the built-in grep only for raw exhaustive regex sweeps or when you suspect the index is stale.",
  ],
  parameters: searchParameters, // + optional mode/exact flag if needed
});
```

Notes:
- Keep each `promptSnippet` ≤ ~12 words; the parenthetical "(use before grep for discovery)" is the routing nudge that lives in the always-on `Available tools` list.
- The descriptions cross-reference each other and the built-ins, so the model can resolve the boundary at decision time (kills the "semantically related but wrong tool" confuser).
- Output contract: resolve to **repo-relative path + line range** (semantic IDs), never UUIDs. Anthropic: resolving UUIDs to semantic identifiers "significantly improves Claude's precision in retrieval tasks."

### Optional: demote built-in grep harder (only if benchmark shows grep still winning)

Pi lets an extension override a built-in by registering a tool with the same name (`extensions.md` → Overriding Built-in Tools). You can re-register `grep` with an added guideline `"Use code_search/code_grep before grep for discovery; use grep only for exhaustive literal sweeps."` Only do this if the routing bullets above underperform in the benchmark — overriding built-ins is a bigger surface area and a heavier hammer.

---

## 5. SKILL.md — progressive-disclosure copy

Pi loads skills by scanning frontmatter `description` into the system prompt (XML), then the model `read`s the full `SKILL.md` on match (skills.md). The `description` is the entire selection signal, max 1024 chars — front-load triggers.

**Frontmatter (final draft):**

```yaml
---
name: code-search
description: >-
  Find code, docs, and symbols by meaning across the whole project. Use when you need to
  locate where something is implemented, trace a feature/behavior/concept across files,
  understand an unfamiliar codebase, find all callers or usages, or search by description
  ("where do we handle retries", "find the auth middleware") rather than an exact name.
  Use the code_search and code_grep tools instead of multiple grep + read calls — they
  return ranked file+line snippets in one call and use far less context.
---
```

**Body structure (teaches when/how):**

```markdown
# Code Search

Use the project's semantic index instead of grep-then-read loops for discovery.

## Decision tree
- Don't know which file? Searching by meaning/behavior?  -> `code_search`
- Have an exact symbol/string/error but want ranked, cross-file hits? -> `code_grep`
- Need a raw exhaustive regex sweep, or index may be stale? -> built-in `grep`
- Already know the exact file and line? -> `read` directly

## Pattern: search, then read
1. `code_search({ query: "where do we validate auth tokens" })`
2. Pick the top-ranked file+line range.
3. `read({ path, offset, limit })` to load just that region.

This replaces "grep for a guess -> read whole file -> grep again" with two calls.

## Scoping
Pass `pathPrefix` (e.g. "packages/api") or `language` (e.g. "typescript") when the user
names a package, directory, or language to tighten results.
```

Keep the body short. The skill's job is to install the decision tree and the search→read pattern, not to re-explain the tools.

---

## 6. Anti-patterns that make models IGNORE a tool (checklist)

1. **No `promptSnippet`** → tool absent from `Available tools` → model never learns it exists (Pi docs).
2. **Generic name colliding with a built-in** (`search` vs `grep`/bash) → "semantically related but wrong tool" confuser → built-in wins by default (CMTF).
3. **Capability-only description, no when-to-use / when-not** → ties with grep's description; grep wins the tie (OpenAI: tell it exactly when and when not).
4. **"this tool" in a guideline** → unresolvable in Pi's flat `Guidelines` → bullet is noise (Pi docs, explicit warning).
5. **Leaking infra** (Turbopuffer/BM25/embedding model) → zero selection signal, wastes the description's scarce words (Anthropic).
6. **No token/turn payoff stated** → removes the one lever a context-trained model optimizes for (Anthropic; CMTF ~90% token win).
7. **Too many overlapping tools** → distractor load, ~6–16 pt accuracy drop (BoR paper); also raises wrong-tool rate (CMTF: 1.25→0.01 only after causal filtering).
8. **Returning UUIDs / low-signal output** → model can't act on results, learns the tool is unhelpful, stops calling it (Anthropic).
9. **Overlapping `code_search`/`code_grep` descriptions** → model can't pick between them → picks neither, falls back to grep.

---

## 7. Benchmark design: measure & tune adoption

Goal: a held-out task set that measures whether the agent *prefers* our tools, then tune copy against it without overfitting (Anthropic eval methodology: realistic tasks, verifiable outcomes, held-out test set, collect tool-call/token/error metrics).

### Task set (~30–50 tasks, two splits: tune / held-out)
Each task = a natural user prompt over a real indexed repo, tagged by intended route:
- **Discovery tasks** (intended: `code_search`): "Where is rate limiting implemented?", "How does the retry logic work?", "Find the code that parses the config file."
- **Exact-token tasks** (intended: `code_grep`): "Find every call to `validateToken`", "Where is the error 'connection refused after retries' raised?"
- **True-grep tasks** (intended: built-in `grep`): "List every TODO comment", "Find all occurrences of the regex `v\d+\.\d+`." (Guards against over-routing to our tools — adoption must be *correct*, not maximal.)

### Metrics (per task, logged via `tool_execution_start`/`tool_call` events)
- **Primary — Adoption rate**: fraction of discovery+exact tasks whose **first retrieval call** is the intended tool (`code_search`/`code_grep`). This is the headline number to drive up.
- **Mis-route rate**: true-grep tasks that wrongly call `code_search`/`code_grep` (over-routing). Keep low.
- **Tool-calls-to-answer** and **tokens-to-answer**: efficiency proof; expect both to fall when our tools are adopted (Anthropic: collect tool-call count + token consumption).
- **Wrong-tool calls/task**: CMTF's metric; should approach 0.
- **Task success**: LLM-as-judge or string match on a ground-truth answer/location (Anthropic verifier).

### Harness
Pi runs in `print`/`json` mode (`ctx.mode`), or use the SDK `createAgentSession`. Subscribe to `tool_execution_start` in a measurement extension to record the ordered tool-call trace per task; classify the first retrieval call; aggregate. Run each task N≥3 times (selection is stochastic) and report mean ± spread.

### Tuning loop
1. Baseline: run the tune split, record adoption rate per route.
2. For tasks that mis-route, read the trace; the model usually verbalizes intent — adjust the offending `promptSnippet`/guideline/description boundary.
3. Re-run tune split only. Iterate.
4. **Only when the tune split is stable, run the held-out split once** to confirm you didn't overfit the copy (Anthropic: held-out set). Report held-out adoption as the real number.

Target: discovery adoption ≥ ~0.9 (matches the BoR "correct-tool-present" ceiling at small K), mis-route ≤ ~0.1.

---

## Citations

- Pi extensions API (Custom Tools, `promptSnippet`, `promptGuidelines`, override built-ins, `setActiveTools`): `~/.pi/agent/git/github.com/dallenpyrah/pi-semantic-search/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
- Pi skills (progressive disclosure, frontmatter `description`, validation): same path `/docs/skills.md`; spec https://agentskills.io/specification, https://agentskills.io/integrate-skills.
- Pi built-in tool copy (grep/read/edit/bash snippets + guidelines): `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/{grep,read,edit}.js` and `dist/.../tools/index`.
- Current extension tool def: `~/.pi/agent/git/github.com/dallenpyrah/pi-semantic-search/index.ts:106-276`.
- Anthropic, "Writing effective tools for AI agents": https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic, "Effective context engineering for AI agents": https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- OpenAI function-calling guide (names, when/when-not, <20 tools, namespaces): https://developers.openai.com/api/docs/guides/function-calling
- CMTF / ToolChoiceConfusion (four confusers; 0.83→0.99 success, 1.25→0.01 wrong-tool, ~90% token cut): https://arxiv.org/html/2606.06284v1
- "How Many Tools Should an LLM Agent See?" / Bits-over-Random (2→5 tools = ~6 pt drop; up to ~16 pt on medium queries): https://arxiv.org/html/2605.24660

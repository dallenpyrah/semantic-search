# Indexing Git History as a Searchable Layer

Research brief for the Pi semantic + hybrid code-search system. Goal: let the agent answer
"why was X changed", "when was Y introduced", "what commit touched Z", "history of this feature"
WITHOUT confusing historical/old code for current live code.

Grounded against current source (`src/store/schema.ts`, `src/search/Search.ts`,
`src/store/Turbopuffer.ts`, `src/index/Indexer.ts`, `src/pi/tools.ts`, `src/pi/extension.ts`)
and primary sources cited inline. Date: 2026-06-20.

---

## TL;DR decision

Add a **git-history layer in the SAME TurboPuffer namespace**, tagged `kind:"commit"`, with a
**numeric `committedAt` timestamp** attribute. Expose it through **ONE new tool `code_history`** —
not a filter flag on `code_search`/`code_grep` — because the agent's default reflex is "search code,
get live code," and a separate verb is the cleanest signal that results are HISTORY, not current
files. Index **commit message + changed-path list + a compact diff summary** per commit, one row per
commit (sub-split only for huge commits). Incremental updates run off `git log <lastSha>..HEAD`.
Phase 1 ships message + changed files (cheap, high-recall for "why/when/history"); Phase 2 adds the
compact diff body. Results are stamped `[commit <sha7> <date> <author>] <subject>` so the model can
never mistake them for live code.

Core trade-off: **one extra tool (distractor load) in exchange for an unambiguous live-vs-history
boundary.** A filter flag is cheaper to build but silently lets historical code leak into the same
result shape the agent already treats as ground truth — the exact failure mode we must prevent.

---

## 1. How production code-RAG systems handle git history

### Sourcegraph (the canonical design)
Sourcegraph treats history as **distinct result TYPES**, not as code with a date attached. Commit
messages are searched with `type:commit`; diffs with `type:diff`. Both accept history-specific
filters: `message:"..."`, `author:`, `before:`/`after:` (commit-date windows, UTC), and
`select:commit.diff.added` to find only where a string was *added* (not removed). Diff search can be
scoped across branches via `repo:...@ref1:ref2` syntax.
- https://docs.sourcegraph.com/code_search/reference/queries
- https://learn.sourcegraph.com/how-to-search-commits-and-diffs-with-sourcegraph
- https://sourcegraph.com/docs/code-search/features

The load-bearing lesson: **commit/diff is a separate retrieval mode with its own verbs and its own
result shape.** It is never blended into the file-content result list. This is the strongest
real-world signal for our "separate tool, not a filter" decision.

### Cody (Sourcegraph's agent)
Cody **moved off embeddings** to a BM25 + native-platform retriever for *code* context, because
embedding all code "required all of your code to be represented in the vector space" and added
operating complexity. Notably Cody's article on code context says **nothing** about embedding commit
history — history retrieval rides the platform's structured commit/diff search, not a vector index.
- https://sourcegraph.com/blog/how-cody-understands-your-codebase

Takeaway: even a top vendor does NOT vector-embed full diff history by default. Message + structured
metadata first; diffs are optional and structured, not bulk-embedded.

### Aider (repo-map)
Aider's repo map ranks **current** symbols via a graph-ranking (PageRank-style) algorithm over the
file dependency graph. It does **not** index commit messages, diffs, or blame for retrieval. History
is out of scope for its context selection.
- https://aider.chat/docs/repomap.html

### GitHub Copilot / Cursor / Windsurf / Augment / Greptile
- Copilot `#codebase`/`@workspace` and Cursor both index **current** code as AST-aware chunks +
  embeddings, with freshness biased toward actively edited files; published material describes
  current-state indexing, not a separate embedded git-history corpus.
  - https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase
  - https://github.com/orgs/community/discussions/174073
- Greptile builds a code **graph** and operates on PR context at review time (full-repo context per
  PR), i.e. history is consumed live from the VCS/PR API at review time rather than pre-embedded as a
  searchable history corpus.
  - https://www.greptile.com/what-is-ai-code-review
- A 2026 survey of code-intelligence tools frames the space as structural understanding
  (dependencies, call chains, symbols) layered on semantic retrieval — history-as-corpus is rare.
  - https://rywalker.com/research/code-intelligence-tools

### Retool/Sequin GitHub embedding pattern (concrete reference)
For PRs/issues/commits they embed **only the high-signal text fields** — for a PR, "just the `title`
and `body`", concatenated newline-separated, one embedding per object. They do NOT embed the raw
diff. One vector per object, granularity = per-commit / per-PR.
- https://retool.com/blog/how-to-build-an-embedding-search-tool-for-github

**Synthesis:** the consensus production shape is (a) history is a **distinct retrieval mode**, (b)
the **commit message + structured metadata** is the primary embedded signal, (c) **raw diffs are
either searched structurally (BM25/regex) or compressed**, never bulk-embedded verbatim, and (d)
**per-commit granularity** is the default unit.

---

## 2. Representation: making the model treat results as HISTORY, not live code

Three reinforcing mechanisms, all cheap:

1. **Distinct `kind`.** Our schema already has a filterable `kind` field (`code`/`docs`/`config`/
   `test`). Add `kind:"commit"`. This is the single source of truth for "is this history."
2. **Result stamping.** Every history hit renders as a header line the model cannot misread:
   `[commit a1b2c3d 2026-05-14 jdoe] Fix token refresh race` followed by changed paths and the diff
   summary. Live-code hits keep their `path:Lstart-Lend` shape. The two are visually disjoint.
3. **Separate tool verb.** A `code_history` tool whose description says "searches PAST commits, not
   current files" frames every result as history before the model even reads it.

### Separate tool vs filter on existing tools — DECISION: separate `code_history` tool

| | Separate `code_history` tool | `history:true` filter on `code_search`/`code_grep` |
|---|---|---|
| Live/history boundary | Unambiguous — different verb, different result shape | Leaky — same tool the agent trusts for live code can now return old code |
| Distractor load | +1 tool (2 -> 3) | 0 new tools |
| Result blending risk | None (history never enters code result list) | High — RRF/rerank could interleave a stale commit snippet with live code |
| Recency semantics | Tool owns "order by recency" + time-window params natively | Has to overload the code-search param surface |
| Matches prod precedent | Yes (Sourcegraph type:commit/type:diff is a distinct mode) | No vendor does this as a mere flag |

The "keep tools few" principle (explicit in `tools.ts`) is real, but it protects against *shallow,
overlapping* tools. `code_history` answers a question the existing two tools structurally cannot
answer well ("when/why/who", time-ordered) and, more importantly, its separateness is the mechanism
that *enforces* the no-confusion requirement. This is a deep tool, not a wrapper — it earns its slot.
Going from 2 to 3 tools is acceptable; the agent already distinguishes `code_search` (semantic) from
`code_grep` (hybrid) by intent, so a third "history" intent fits the existing mental model.

---

## 3. What to embed per commit (keep each unit small)

One row per commit. `embedText` (the vector input) concatenates the high-signal fields; `text` (the
BM25 + display field) holds the human-readable rendering.

```
embedText =
  <subject>
  <body, trimmed to ~1500 chars>
  files: src/auth/token.ts, src/auth/refresh.ts, test/auth.test.ts
  summary: +refreshToken() -rotateKey()   (Phase 2: signature-level diff summary)
```

Field budget and rationale:
- **Subject (`%s`)** — highest signal for "why/what". Always included.
- **Body (`%b`)** — explains rationale ("why X changed"). Trim to a cap (~1500 chars) so the unit
  embeds well; commit bodies are occasionally enormous (squash dumps).
- **Changed-path list** — drives "what commit touched Z" and path-scoped queries; cheap, high recall.
  Cap the list (e.g. first 50 paths + "+N more") for sprawling commits.
- **Compact diff summary (Phase 2)** — NOT the raw diff. Added/removed top-level signatures
  (function/class/exported names) extracted from `+`/`-` lines, plus per-file `+N/-M` line counts
  from `--numstat`. This captures "what structurally changed" at a fraction of the tokens.

### Diff compression rules (Phase 2), grounded in diff-for-LLM practice
- Lockfiles / generated files (`*.lock`, `package-lock.json`, `*.min.*`, `dist/`): record path +
  `+N/-M` only, drop content. ("the LLM doesn't need to see 10,000 lines of dependency updates")
- Binary changes: emit `[binary: path]`, never bytes.
- Deletions: path + first lines only.
- Prefer additions over deletions when truncating; keep hunk headers; cap each commit unit's diff
  summary to a hard token budget.
- https://medium.com/@yehezkieldio/precision-dissection-of-git-diffs-for-llm-consumption-7ce5d2ca5d47

### Huge diffs / merge commits / binary
- **Huge commit** (e.g. > ~200 changed files or summary over budget): keep the message + full path
  list in the primary row; either drop the diff summary or split into N rows
  `id = <sha>#<part>` sharing the same `sha`/`committedAt`, each carrying a slice of files. Keep the
  message-only row as the canonical hit for "why".
- **Merge commits**: index the message (often the PR title/number — valuable for "history of a
  feature") but **skip the combined diff** (merge diffs are noisy/ambiguous). Tag `isMerge:true`.
  Use `--no-merges` for the diff pass, a separate `--merges` pass for messages only.
- **Binary**: counted in path list, excluded from diff summary.

### Schema additions (new TurboPuffer attributes)
Reuse the existing namespace and schema builder; add commit-only fields (all optional for code rows):

```
kind:        "commit"            // existing field, new value
sha:         string  filterable  // full 40-char
shaShort:    string              // display
committedAt: int     filterable  // unix seconds — enables Gte/Lte windows + recency rank
author:      string  filterable
subject:     string              // display
paths:       string  full_text_search  // space-joined changed paths for BM25 path queries
isMerge:     bool    filterable
```
`committedAt` as a filterable numeric is the key new primitive — it unlocks time windows and
recency-weighted ranking (Section 5). TurboPuffer range filters (`Gte`/`Lte`) work on integers and
datetimes. Source: https://turbopuffer.com/docs/query

---

## 4. Incremental indexing strategy

Store the last-indexed HEAD sha in the manifest (alongside the existing file manifest). On each
index pass:

```bash
# 1. Resolve current head
HEAD_SHA=$(git rev-parse HEAD)

# 2. First run: bound cost — last N commits only (e.g. N=2000)
git log -n 2000 --no-merges --reverse \
  --pretty=format:'%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f' \
  --numstat -z

# 3. Incremental run: only commits after the stored sha
git log <lastSha>..HEAD --no-merges --reverse \
  --pretty=format:'%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f' \
  --numstat -z

# 4. Merge messages (no diff), separate pass
git log <lastSha>..HEAD --merges --reverse \
  --pretty=format:'%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b' -z
```

Notes:
- `%x1e` (record sep) starts each commit; `%x1f` (unit sep) separates fields — both rare in commit
  text, safer than newlines. `--numstat -z` gives NUL-terminated `added\tremoved\tpath` lines.
- `%aI` = strict ISO-8601 author date; parse to unix seconds for `committedAt`.
- `--reverse` => oldest first, so a crash mid-pass still advances `lastSha` monotonically.
- `--find-renames` to dedupe rename churn in the path list.
- After a successful pass, persist `lastSha = HEAD_SHA`.
- Source for flags: https://git-scm.com/docs/git-log

**Cost bounding (history is large):**
- Phase 1 embeds only message + path list — short text, one vector per commit. 2000 commits ≈ 2000
  embeddings on first run, then a handful per incremental pass.
- Rewritten history (force-push, rebase): if `<lastSha>` is no longer an ancestor of HEAD
  (`git merge-base --is-ancestor <lastSha> HEAD` fails), fall back to the bounded last-N reindex and
  `delete_by_filter kind=commit` first to avoid orphans.
- The agent already runs a `Watcher`; commit indexing can piggyback on the same lifecycle, triggered
  on index start and (optionally) on detecting a HEAD change.

---

## 5. Retrieval shape for the key use cases

The `code_history` tool runs a hybrid sub-query set (reusing the existing multi-query + RRF +
optional rerank path) but always filtered to `kind:"commit"`:

1. **"why did this change to <region/path>"** — most valuable, maps to git blame.
   - Best answer is the commit that *last touched* that line range. Get it directly:
     `git log -1 -L <start>,<end>:<path>` or `git blame -L <start>,<end> <path>` → resolve to sha →
     fetch that commit row. The vector index is the *fallback / broad* path ("which commits relate
     to auth token refresh"). Blame is exact; the index is fuzzy. Offer both: tool can take an
     optional `{path, startLine, endLine}` and short-circuit to blame.
2. **"history of a feature / when was Y introduced"** — semantic + BM25 over message+paths, ordered
   by `committedAt`. `select:commit.diff.added`-style "first introduced" = the *earliest* matching
   commit (sort `committedAt asc`, take first).
3. **"what changed recently"** — filter `committedAt >= now-30d`, `rank_by:["committedAt","desc"]`.
4. **"what commit touched Z (a path)"** — BM25 on `paths` + `path Glob` filter, ordered by recency.

### Recency weighting (TurboPuffer-native, no reindex needed)
TurboPuffer can blend BM25 relevance with a recency boost in a single `rank_by` using
`Sum`/`Product`/`Decay` — tunable via a weight + midpoint without reindexing:

```json
{ "rank_by": ["Sum", [
    ["text", "BM25", "auth token refresh"],
    ["Product", 1.5, ["Decay",
      ["Dist", ["Attribute", "committedAt"], <now-epoch>],
      { "midpoint": "30d" }]]
]]}
```
This makes "recent commits about X" rank above ancient ones without losing old-but-relevant hits.
- https://turbopuffer.com/blog/rank-by-attribute
- Pure recency sort: `{ "rank_by": ["committedAt", "desc"] }` — https://turbopuffer.com/docs/query

---

## 6. Phased plan

**Phase 1 — messages + changed files (ship first).**
- New `kind:"commit"` rows: `sha`, `shaShort`, `committedAt`, `author`, `subject`, body (trimmed),
  `paths`, `isMerge`. `embedText` = subject + body + path list.
- Incremental `git log <lastSha>..HEAD` indexer; store `lastSha` in manifest; bounded last-N first
  run; merge-base ancestry check for rewrites.
- New `code_history` tool: hybrid sub-queries filtered `kind=commit`; params `query`, optional
  `pathPrefix`, `author`, `since`/`until` (time window), `recencyBoost` default on; result stamped
  `[commit <sha7> <date> <author>] <subject>` + path list.
- Blame short-circuit: optional `{path, startLine, endLine}` → `git blame` → exact commit row.

**Phase 2 — compact diff summary.**
- Add `--numstat` parse + signature-level add/remove extraction with the compression rules in §3.
- Append summary to `embedText`/`text`. Split huge commits into `<sha>#<part>` rows.
- Optional `code_history` mode `diff:true` to surface the structural diff summary in output.

**Out of scope (for now):** full raw-diff embedding (cost/noise; Cody and Retool both avoid it),
per-line blame index (compute live via git), cross-repo history.

---

## 7. Commit-indexer pseudocode

```
indexCommits():
  head     = git rev-parse HEAD
  lastSha  = manifest.get("commits.lastSha")

  if lastSha and not gitAncestor(lastSha, head):   # rebase/force-push
    store.deleteByFilter(kind == "commit")
    lastSha = null

  range = lastSha ? `${lastSha}..HEAD` : `-n ${FIRST_RUN_LIMIT}`

  # main pass: non-merge commits with file stats
  for commit in parseGitLog(range, "--no-merges", "--numstat", "--reverse"):
    rows = buildCommitRows(commit)        # 1 row, or N for huge commits
    embed = embeddings.embed(rows.map(r => r.embedText))
    store.upsert(rows.zip(embed).map(toCommitRow))

  # merge pass: messages only, no diff
  for merge in parseGitLog(range, "--merges", "--reverse"):
    row = buildCommitRows(merge, { diff: false, isMerge: true })
    store.upsert([toCommitRow(row, embeddings.embed(row.embedText))])

  manifest.set("commits.lastSha", head)
  manifest.save()

buildCommitRows(commit):
  subject = commit.subject
  body    = truncate(commit.body, 1500)
  paths   = commit.files.map(f => f.path)
  pathStr = capList(paths, 50)                       # "a, b, ... +N more"
  summary = PHASE2 ? diffSummary(commit.files) : ""  # signatures + +N/-M, compressed
  embedText = [subject, body, "files: "+pathStr, summary].filter(Boolean).join("\n")
  if isHuge(commit): return splitIntoParts(commit, embedText)   # <sha>#0, <sha>#1 ...
  return [{ id: commit.sha, embedText,
            text: render(commit), sha: commit.sha, shaShort: commit.sha[0..7],
            committedAt: toEpoch(commit.date), author: commit.author,
            subject, paths: pathStr, isMerge: commit.isMerge }]

diffSummary(files):                                  # Phase 2
  for f in files:
    if isGenerated(f.path) or isLockfile(f.path): emit `${f.path} +${f.add}/-${f.del}`; continue
    if f.binary: emit `[binary: ${f.path}]`; continue
    adds = signatures(f.addedLines)                  # new fn/class/export names
    dels = signatures(f.removedLines)
    emit `${f.path} +${f.add}/-${f.del}  +{${adds}} -{${dels}}`
  return capTokens(joined, DIFF_BUDGET)
```

---

## 8. Key citations
- Sourcegraph commit/diff search (distinct types, message:/author:/before:/after:/select):
  https://docs.sourcegraph.com/code_search/reference/queries ·
  https://learn.sourcegraph.com/how-to-search-commits-and-diffs-with-sourcegraph
- Cody moved off embeddings; no diff-history embedding:
  https://sourcegraph.com/blog/how-cody-understands-your-codebase
- Aider repo-map = current-code graph ranking, no history:
  https://aider.chat/docs/repomap.html
- Cursor AST-aware current-code indexing:
  https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase
- Greptile PR-time graph/context:
  https://www.greptile.com/what-is-ai-code-review
- Retool/Sequin: embed message/title+body only, one vector per object, no raw diff:
  https://retool.com/blog/how-to-build-an-embedding-search-tool-for-github
- Diff compression for LLMs (lockfile/binary/deletion truncation, additions-first, hunk headers):
  https://medium.com/@yehezkieldio/precision-dissection-of-git-diffs-for-llm-consumption-7ce5d2ca5d47
- TurboPuffer numeric/timestamp filters + recency rank (Decay/Sum/Product):
  https://turbopuffer.com/docs/query · https://turbopuffer.com/blog/rank-by-attribute
- git log machine-readable enumeration (format placeholders, --numstat -z, --reverse, merges):
  https://git-scm.com/docs/git-log

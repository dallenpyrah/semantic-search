---
name: searching-code
description: >-
  Searches code, docs, symbols, git history, and implementation concepts by meaning with the
  semantic_search tool. Use when locating where behavior is implemented, tracing a feature across files,
  finding callers/usages by description, or asking why/when code changed.
---

<!-- semantic-search amp installer managed -->

# Searching Code

Use the `semantic_search` tool for discovery before falling back to grep/read loops. It returns ranked
file-and-line snippets and can search live code, docs, git history, and conversation context.

## When to use it

- Unknown file, behavior, concept, or feature location → `semantic_search({ query })`
- Exact symbol/string but ranked cross-file hits are useful → `semantic_search({ query, mode: "hybrid" })`
- Several distinct facets at once → `semantic_search({ queries: ["auth", "rate limiting", "retry"] })`
- File history or old diffs → `semantic_search({ file: "src/foo.ts", lines: "40-80" })`
- Why/when/decision history → `semantic_search({ query })` or force `source: ["history"]`

Use built-in grep for raw exhaustive regex sweeps or when the user explicitly asks for literal text
enumeration. Read files directly only after the relevant file or line range is already known.

## Search, then read

1. Search by meaning with `semantic_search`.
2. Pick the top-ranked file and line range.
3. Read only that region before editing or explaining live behavior.

Live code is authoritative. Results tagged `[history]` or `[conversation]` are context, not the current
state of the code.

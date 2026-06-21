---
name: code-search
description: >-
  Find code, docs, and symbols by meaning across the whole project. Use when you need to locate where
  something is implemented, trace a feature, behavior, or concept across files, understand an unfamiliar
  codebase, find all callers or usages, search by description ("where do we handle retries", "find the
  auth middleware"), or ask why/when something changed. Use the single semantic_search tool instead of
  multiple grep and read calls — it returns ranked file-and-line snippets in one call and uses far less
  context.
---

# Semantic Search

One tool — `semantic_search` — covers discovery. Drive it with config options instead of running
grep-then-read loops. The index is built and kept fresh automatically while the session is open
(including across git pull / branch switch / commit).

## When to use it (and how)

- Don't know which file? Searching by meaning, behavior, or concept? → `semantic_search({ query })`
- Have an exact symbol/string but want ranked, cross-file hits? → `semantic_search({ query, mode: "hybrid" })` (hybrid is the default)
- Several distinct things to find at once? → `semantic_search({ queries: ["auth", "rate limiting", "retry"] })` (one parallel, merged call)
- "Why did this file change / show the old diff"? → `semantic_search({ file: "src/foo.ts", lines: "40-80" })`
- "Why/when did we change X" (decisional/historical)? → `semantic_search({ query })` — it auto-surfaces git history / past conversations as tagged context; or force it with `source: ["history"]`.
- Need a raw exhaustive regex sweep, or the index may be stale? → built-in `grep`
- Already know the exact file and line? → `read` it directly

## Pattern: search, then read

1. `semantic_search({ query: "where do we validate auth tokens" })`
2. Pick the top-ranked file and line range.
3. `read({ path, offset, limit })` to load just that region.

## Important

Live code is the source of truth. Results tagged `[history]` or `[conversation]` are context about why
or when something changed — use them to understand intent, then confirm present behavior on the live
file. Pass `pathPrefix` or `language` to scope when the request names a package, directory, or language.

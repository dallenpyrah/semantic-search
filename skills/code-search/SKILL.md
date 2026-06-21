---
name: code-search
description: >-
  Find code, docs, and symbols by meaning across the whole project. Use when you need to locate
  where something is implemented, trace a feature, behavior, or concept across files, understand an
  unfamiliar codebase, find all callers or usages, or search by description ("where do we handle
  retries", "find the auth middleware", "how does indexing work") rather than an exact name. Use the
  code_search and code_grep tools instead of multiple grep and read calls — they return ranked
  file-and-line snippets in one call and use far less context.
---

# Code Search

Use the project's semantic index instead of grep-then-read loops for discovery. The index is built
and kept fresh automatically while the session is open.

## Decision tree

- Don't know which file holds it? Searching by meaning, behavior, or concept? → `code_search`
- Have an exact symbol, string, or error but want ranked, cross-file hits with related code? → `code_grep`
- Need a raw exhaustive regex sweep, or the index may be stale? → built-in `grep`
- Already know the exact file and line? → `read` it directly

## Pattern: search, then read

1. `code_search({ query: "where do we validate auth tokens" })`
2. Pick the top-ranked file and line range from the result.
3. `read({ path, offset, limit })` to load just that region.

This replaces "grep for a guess → read the whole file → grep again" with two calls and a fraction of
the context.

## Scoping

Pass `pathPrefix` (e.g. `packages/api`) or `language` (e.g. `typescript`) when the request names a
package, directory, or language, to tighten results.

## Examples

- "How is rate limiting implemented?" → `code_search({ query: "rate limiting implementation" })`
- "Find every place that calls validateToken" → `code_grep({ query: "validateToken" })`
- "Where is the database connection pool created?" → `code_search({ query: "create database connection pool" })`

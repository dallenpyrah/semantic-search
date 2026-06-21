export const codeSearchTool = {
  name: "code_search",
  label: "Code Search",
  description:
    "Find code, docs, and symbols by MEANING across the whole project in one call. " +
    "Use when you don't yet know which file holds the logic, when you're tracing a concept, " +
    "feature, behavior, or data flow across files, or when the request describes WHAT something does " +
    "rather than its exact name (e.g. 'where do we validate auth tokens', 'how is retry handled', " +
    "'find the rate limiter'). Returns ranked snippets with repository-relative file path and line " +
    "range so you can read or edit the right location directly. Prefer this over running several grep " +
    "and read calls to explore: one code_search replaces many round-trips and spends far less context. " +
    "Do NOT use it for an exact literal string or regex you already know verbatim — use code_grep for " +
    "ranked exact + related matches, or the built-in grep for a raw regex sweep.",
  promptSnippet: "Find code/docs/symbols by meaning in one call (use before grep for discovery)",
  promptGuidelines: [
    "Use code_search first for discovery — locating unknown files, tracing a concept, behavior, or feature across the codebase, or any 'where is X' or 'how does X work' question — instead of multiple grep and read calls.",
    "Prefer code_search over grep and read for exploration; it returns ranked file and line snippets in one call and uses far less context than grep-then-read loops.",
    "Pass pathPrefix or language to code_search when the request names a package, app, directory, or programming language."
  ]
}

export const codeGrepTool = {
  name: "code_grep",
  label: "Code Grep",
  description:
    "Find an exact symbol, string, or error message AND its semantically related code, ranked across " +
    "the whole project in one call. Use when you have a literal token (function name, variable, error " +
    "text, config key) but still want every relevant hit ranked by relevance and grouped with related " +
    "code, not a flat unranked match list. Returns ranked snippets with repository-relative file path " +
    "and line range. Prefer code_grep over the built-in grep when you want ranked, cross-file results " +
    "or aren't certain the literal spelling is exact. Use the built-in grep only for a raw exhaustive " +
    "regex sweep or when the project index may be stale.",
  promptSnippet: "Ranked exact-token plus related-code search across the project (smarter grep)",
  promptGuidelines: [
    "Use code_grep instead of the built-in grep when you have an exact symbol, string, or error but want ranked, cross-file results that also surface related code.",
    "Fall back to the built-in grep only for raw exhaustive regex sweeps or when you suspect the index is stale."
  ]
}

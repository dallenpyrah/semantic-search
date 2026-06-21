export const semanticSearchTool = {
  name: "semantic_search",
  label: "Semantic Search",
  description:
    "Search the project by MEANING in one call — the primary way to find code, trace a concept, " +
    "behavior, feature, or data flow across files, and answer 'where is X' or 'how does X work' without " +
    "running many grep and read calls. Returns ranked snippets with repository-relative file path and " +
    "line range, so you can read or edit the right location directly. Prefer it over grep/read for " +
    "discovery: one call replaces many round-trips and spends far less context.\n\n" +
    "Config options (all optional):\n" +
    "- query: a single natural-language or symbol query.\n" +
    "- queries: 2-5 DISTINCT facets to retrieve and MERGE in one parallel call (use for multi-faceted " +
    "tasks instead of several searches; never pass paraphrases).\n" +
    "- mode: 'hybrid' (default — semantic + exact-token matching, best for an exact symbol/string) or " +
    "'semantic' (meaning only, fastest).\n" +
    "- pathPrefix / language: scope to a directory prefix or language.\n" +
    "- limit: max snippets to return (default 8).\n" +
    "- source: force ['history'] (git commits) or ['conversation'] (past sessions). By default results " +
    "are live code; for clearly historical 'why/when did this change' questions it also surfaces " +
    "lower-weighted git-history and conversation context, tagged [history]/[conversation] — treat those " +
    "as context, NOT the current state of the code, which is always authoritative.\n" +
    "- file (+ optional lines like 40-80): return the ACTUAL commit messages and diffs that changed that " +
    "file or region — for 'why did this file change from X to Y, show the old diff'.\n\n" +
    "Use the built-in grep only for a raw exhaustive regex sweep, or read when you already know the exact file.",
  promptSnippet: "Search code by meaning in one call (options: queries[], mode, source, file) — use before grep",
  promptGuidelines: [
    "Use semantic_search first for discovery — locating unknown files, tracing a concept, behavior, or feature across the codebase, or any 'where is X' or 'how does X work' question — instead of multiple grep and read calls.",
    "Pass semantic_search a queries[] array of 2-5 distinct facets to retrieve and merge several concepts in one parallel call; use a single query for a single focus.",
    "For 'why did this change' or a file's history, pass semantic_search a file (and optional lines) to get the real past diffs and messages; treat any history or conversation results as context, while the live code it returns is the source of truth.",
    "Pass pathPrefix or language to semantic_search when the request names a package, directory, or programming language.",
    "Fall back to the built-in grep only for raw exhaustive regex sweeps or when you suspect the index is stale."
  ]
}

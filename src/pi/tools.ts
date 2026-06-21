export const codeSearchTool = {
  name: "code_search",
  label: "Code Search",
  description:
    "Find code, docs, and symbols by MEANING across the whole project in one call. " +
    "Use when you don't yet know which file holds the logic, when you're tracing a concept, " +
    "feature, behavior, or data flow across files, or when the request describes WHAT something does " +
    "rather than its exact name (e.g. 'where do we validate auth tokens', 'how is retry handled'). " +
    "Returns ranked snippets with repository-relative file path and line range. For a multi-faceted " +
    "task, pass queries[] with 2-5 DISTINCT facets to retrieve and merge them in one parallel call " +
    "instead of several searches; use a single query for a single focus. Live code is the source of " +
    "truth; when the request is clearly about WHY or WHEN something changed, results may also include " +
    "lower-weighted git-history or past-conversation context, clearly tagged — treat those as context, " +
    "not as the current state of the code. Prefer this over running several grep and read calls. " +
    "Do NOT use it for an exact literal string you already know verbatim — use code_grep for that.",
  promptSnippet: "Find code/docs by meaning in one call; pass queries[] to search several facets in parallel",
  promptGuidelines: [
    "Use code_search first for discovery — locating unknown files, tracing a concept, behavior, or feature across the codebase, or any 'where is X' or 'how does X work' question — instead of multiple grep and read calls.",
    "For a multi-faceted task (e.g. 'auth + rate limiting + retry'), pass code_search a queries[] array of the 2-5 distinct facets to retrieve and merge in one call; use a single query for a single focus and never pass paraphrases.",
    "Treat any git-history or conversation results from code_search as supplementary context for why/when questions; the live code it returns is authoritative.",
    "Pass pathPrefix or language to code_search when the request names a package, app, directory, or programming language."
  ]
}

export const codeGrepTool = {
  name: "code_grep",
  label: "Code Grep",
  description:
    "Find an exact symbol, string, or error message AND its semantically related code, ranked across " +
    "the whole project in one call. Use when you have a literal token (function name, variable, error " +
    "text, config key) but still want every relevant hit ranked and grouped with related code. Returns " +
    "ranked snippets with repository-relative file path and line range. Pass queries[] with 2-5 distinct " +
    "symbols/strings to locate several at once in one merged ranked call. Prefer code_grep over the " +
    "built-in grep when you want ranked, cross-file results or aren't certain the literal spelling is " +
    "exact. Use the built-in grep only for a raw exhaustive regex sweep or when the index may be stale.",
  promptSnippet: "Ranked exact-token + related-code search; pass queries[] for several symbols at once",
  promptGuidelines: [
    "Use code_grep instead of the built-in grep when you have an exact symbol, string, or error but want ranked, cross-file results that also surface related code.",
    "When you have several distinct symbols or strings to locate at once, pass code_grep a queries[] array for one merged ranked result instead of several grep calls.",
    "Fall back to the built-in grep only for raw exhaustive regex sweeps or when you suspect the index is stale."
  ]
}

export const codeHistoryTool = {
  name: "code_history",
  label: "Code History",
  description:
    "Search the project's GIT HISTORY to answer WHY something changed, WHEN a feature or behavior was " +
    "introduced, what a recent change did, or how a file evolved. Two modes: (1) pass a query to rank " +
    "commits by message; (2) pass a file (repo-relative path, optionally with a lines range like 40-80) " +
    "to get the ACTUAL commits, messages, and diffs that changed that file or region — exactly for 'why " +
    "did this file change from X to Y, show the old diff'. Results are stamped with short sha, date, and " +
    "author. This is historical context, NOT the current state of the code: use it to understand intent " +
    "and evolution, then confirm present behavior with code_search or read on the live file. Use " +
    "code_search (not this) to find where something IS implemented now.",
  promptSnippet: "Git history: why/when code changed, or a file's commits + diffs — context, not live code",
  promptGuidelines: [
    "Use code_history for 'why did this change', 'when was X introduced', or 'what changed recently'; pass a file (and optional lines) to see the actual past diffs and messages that changed it. The live code (via code_search/read) remains the source of truth."
  ]
}

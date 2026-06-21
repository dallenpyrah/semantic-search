import type { ChunkKind } from "../domain/types.ts"

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".clj": "clojure",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".lua": "lua",
  ".dart": "dart",
  ".r": "r",
  ".jl": "julia",
  ".tf": "terraform",
  ".dockerfile": "dockerfile"
}

export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  if (dot <= 0) {
    return name.toLowerCase() === "dockerfile" ? ".dockerfile" : ""
  }
  return name.slice(dot).toLowerCase()
}

export const languageForPath = (path: string): string => {
  const ext = extensionOf(path)
  return LANGUAGE_BY_EXTENSION[ext] ?? (ext === "" ? "plain" : ext.slice(1))
}

export const kindForPath = (path: string): ChunkKind => {
  const lower = path.toLowerCase()
  const ext = extensionOf(lower)
  if (/(^|\/|[._-])(test|tests|spec|specs|__tests__)([._/-]|$)/.test(lower)) return "test"
  if (ext === ".md" || ext === ".mdx") return "docs"
  if (ext === ".json" || ext === ".jsonc" || ext === ".yaml" || ext === ".yml" || ext === ".toml") return "config"
  return "code"
}

export const isMarkdown = (path: string): boolean => {
  const ext = extensionOf(path)
  return ext === ".md" || ext === ".mdx"
}

export const DEFAULT_INCLUDE_EXTENSIONS: ReadonlyArray<string> = Object.keys(LANGUAGE_BY_EXTENSION)

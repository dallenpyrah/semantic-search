import type { IndexingConfig } from "../config/defaults.ts"
import { extensionOf } from "../chunk/language.ts"

export interface IgnoreRules {
  readonly maxFileBytes: number
  readonly includeExtensions: ReadonlySet<string>
  readonly excludeDirs: ReadonlySet<string>
  readonly excludeFiles: ReadonlySet<string>
  readonly excludePatterns: ReadonlyArray<RegExp>
}

const globToRegExp = (pattern: string): RegExp => {
  let source = "^"
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    const next = pattern[i + 1]
    if (char === "*" && next === "*") {
      source += ".*"
      i += 1
      if (pattern[i + 1] === "/") i += 1
    } else if (char === "*") {
      source += "[^/]*"
    } else if (char === "?") {
      source += "[^/]"
    } else {
      source += char!.replace(/[\\^$+?.()|[\]{}]/g, "\\$&")
    }
  }
  return new RegExp(`${source}$`)
}

export const compileRules = (indexing: IndexingConfig): IgnoreRules => ({
  maxFileBytes: indexing.maxFileBytes,
  includeExtensions: new Set(indexing.includeExtensions.map((e) => e.toLowerCase())),
  excludeDirs: new Set(indexing.excludeDirs.map((d) => d.toLowerCase())),
  excludeFiles: new Set(indexing.excludeFiles.map((f) => f.toLowerCase())),
  excludePatterns: indexing.excludePathPatterns.map((p) => globToRegExp(p.toLowerCase()))
})

export const shouldEnterDir = (name: string, rules: IgnoreRules): boolean => {
  const lower = name.toLowerCase()
  if (rules.excludeDirs.has(lower)) return false
  if (name.startsWith(".")) return false
  return true
}

const matchesPattern = (relPath: string, rules: IgnoreRules): boolean => {
  const lower = relPath.toLowerCase()
  for (const pattern of rules.excludePatterns) {
    if (pattern.test(lower)) return true
  }
  return false
}

export const isWatchRelevant = (relPath: string, rules: IgnoreRules): boolean => {
  const lower = relPath.toLowerCase()
  const segments = lower.split("/")
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!
    if (segment.length === 0) continue
    if (segment.startsWith(".") || rules.excludeDirs.has(segment)) return false
  }
  return !matchesPattern(lower, rules)
}

export const shouldIndexFile = (
  relPath: string,
  size: number,
  rules: IgnoreRules
): boolean => {
  if (size <= 0 || size > rules.maxFileBytes) return false
  const name = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase()
  if (name.startsWith(".env")) return false
  if (rules.excludeFiles.has(name)) return false
  if (matchesPattern(relPath, rules)) return false
  return rules.includeExtensions.has(extensionOf(relPath))
}

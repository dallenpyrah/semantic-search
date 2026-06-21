import { describe, expect, test } from "bun:test"
import { compileRules, isWatchRelevant, shouldEnterDir, shouldIndexFile } from "../src/index/ignore.ts"
import { defaultSettings } from "../src/config/defaults.ts"

const rules = compileRules(defaultSettings.indexing)

describe("ignore rules", () => {
  test("excludes node_modules and hidden directories", () => {
    expect(shouldEnterDir("node_modules", rules)).toBe(false)
    expect(shouldEnterDir(".git", rules)).toBe(false)
    expect(shouldEnterDir(".next", rules)).toBe(false)
    expect(shouldEnterDir("src", rules)).toBe(true)
    expect(shouldEnterDir("packages", rules)).toBe(true)
  })

  test("indexes supported source files within size limits", () => {
    expect(shouldIndexFile("src/app.ts", 1200, rules)).toBe(true)
    expect(shouldIndexFile("README.md", 500, rules)).toBe(true)
    expect(shouldIndexFile("src/app.ts", 0, rules)).toBe(false)
    expect(shouldIndexFile("src/app.ts", 5_000_000, rules)).toBe(false)
  })

  test("rejects lockfiles, env files, minified and unsupported files", () => {
    expect(shouldIndexFile("package-lock.json", 100, rules)).toBe(false)
    expect(shouldIndexFile(".env", 50, rules)).toBe(false)
    expect(shouldIndexFile(".env.local", 50, rules)).toBe(false)
    expect(shouldIndexFile("dist/app.min.js", 100, rules)).toBe(false)
    expect(shouldIndexFile("image.png", 100, rules)).toBe(false)
    expect(shouldIndexFile("bun.lock", 100, rules)).toBe(false)
  })

  test("watch relevance drops excluded and hidden path segments", () => {
    expect(isWatchRelevant("src/app.ts", rules)).toBe(true)
    expect(isWatchRelevant("node_modules/pkg/index.js", rules)).toBe(false)
    expect(isWatchRelevant(".git/HEAD", rules)).toBe(false)
    expect(isWatchRelevant("packages/api/src/route.ts", rules)).toBe(true)
    expect(isWatchRelevant("src/app.min.js", rules)).toBe(false)
  })
})

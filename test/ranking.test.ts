import { describe, expect, test } from "bun:test"
import type { SearchOptions } from "../src/domain/types.ts"
import { buildFilters, kindNudge, resolveSources, sourceBonus } from "../src/search/ranking.ts"

const opts = (extra: Partial<SearchOptions> = {}): SearchOptions => ({ limit: 8, ...extra })

describe("resolveSources", () => {
  test("defaults to code + docs", () => {
    expect(resolveSources("where is the auth middleware", opts())).toEqual(["code", "docs"])
  })
  test("explicit source overrides routing", () => {
    expect(resolveSources("anything", opts({ source: ["history"] }))).toEqual(["history"])
  })
  test("historical cue widens to history", () => {
    expect(resolveSources("when was this introduced", opts())).toContain("history")
  })
  test("decision cue widens to conversation", () => {
    expect(resolveSources("what did we decide about caching", opts())).toContain("conversation")
  })
  test("causal cue widens to both history and conversation", () => {
    const sources = resolveSources("why did we change the cache eviction", opts())
    expect(sources).toContain("history")
    expect(sources).toContain("conversation")
  })
})

describe("sourceBonus", () => {
  const requested = new Set(["history"])
  test("code is preferred", () => {
    expect(sourceBonus("code", requested)).toBeGreaterThan(0)
  })
  test("unrequested history is penalized, requested is rewarded", () => {
    expect(sourceBonus("history", requested)).toBeGreaterThan(0)
    expect(sourceBonus("conversation", requested)).toBeLessThan(0)
  })
  test("code outranks requested history (authoritative)", () => {
    expect(sourceBonus("code", requested)).toBeGreaterThan(sourceBonus("history", requested))
  })
})

describe("kindNudge", () => {
  test("tests are nudged down, code is neutral", () => {
    expect(kindNudge("test")).toBeLessThan(0)
    expect(kindNudge("code")).toBe(0)
  })
})

describe("buildFilters", () => {
  test("single source filter without options", () => {
    expect(buildFilters(["code", "docs"], opts())).toEqual(["source", "In", ["code", "docs"]])
  })
  test("ANDs language when provided", () => {
    const filter = buildFilters(["code"], opts({ language: "TypeScript" })) as Array<unknown>
    expect(filter[0]).toBe("And")
    expect(JSON.stringify(filter)).toContain("typescript")
  })
})

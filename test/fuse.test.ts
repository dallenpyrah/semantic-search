import { describe, expect, test } from "bun:test"
import { diversify, formatHits, fuse, normalizePrefix, toHit, tokenize } from "../src/search/fuse.ts"
import type { TpufRow } from "../src/store/schema.ts"

const row = (id: string, path: string, text = ""): TpufRow => ({ id, path, text })

describe("tokenize / normalizePrefix", () => {
  test("tokenize keeps code-ish tokens and drops noise", () => {
    expect(tokenize("verify the JWT token!!")).toEqual(["verify", "the", "jwt", "token"])
  })
  test("normalizePrefix trims and lowercases", () => {
    expect(normalizePrefix("./Packages/API/")).toBe("packages/api")
    expect(normalizePrefix("  ")).toBeUndefined()
  })
})

describe("fuse", () => {
  test("rewards items appearing in multiple arms via reciprocal rank", () => {
    const semantic = [row("a", "src/a.ts"), row("b", "src/b.ts")]
    const text = [row("b", "src/b.ts"), row("c", "src/c.ts")]
    const fused = fuse([semantic, text], ["semantic", "text"], "x", 60, undefined)
    expect(fused[0]!.id).toBe("b")
    expect([...fused.find((c) => c.id === "b")!.sources].sort()).toEqual(["semantic", "text"])
  })

  test("path-prefix and token boosts nudge ranking", () => {
    const list = [row("a", "other/file.ts", "nothing"), row("b", "src/auth/login.ts", "auth login here")]
    const fused = fuse([list], ["semantic"], "auth login", 60, "src/auth")
    expect(fused[0]!.id).toBe("b")
  })
})

describe("diversify", () => {
  test("caps results per file and respects limit", () => {
    const cands = [
      { id: "1", row: row("1", "src/a.ts"), score: 9, sources: [] },
      { id: "2", row: row("2", "src/a.ts"), score: 8, sources: [] },
      { id: "3", row: row("3", "src/a.ts"), score: 7, sources: [] },
      { id: "4", row: row("4", "src/b.ts"), score: 6, sources: [] }
    ]
    const out = diversify(cands, 10, 2, undefined)
    expect(out.map((c) => c.id)).toEqual(["1", "2", "4"])
  })
})

describe("toHit / formatHits", () => {
  test("toHit builds a path:line snippet hit", () => {
    const hit = toHit(
      { id: "1", row: { id: "1", path: "src/a.ts", text: "alpha beta", startLine: 3, endLine: 9 }, score: 0.5, sources: ["semantic"] },
      "alpha",
      100
    )
    expect(hit.path).toBe("src/a.ts")
    expect(hit.startLine).toBe(3)
    expect(hit.snippet).toContain("alpha")
  })

  test("formatHits returns a not-found message for empty results", () => {
    expect(formatHits("q", [], 1000)).toContain("No indexed results")
  })
})

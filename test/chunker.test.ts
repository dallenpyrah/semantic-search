import { describe, expect, test } from "bun:test"
import { chunkSource, type ChunkBudget } from "../src/chunk/structural.ts"
import { sha256 } from "../src/domain/hash.ts"

const budget: ChunkBudget = { targetChars: 1200, maxChars: 1600, embedCharCap: 32000 }

const fileHash = (source: string) => sha256(source)

describe("chunkSource", () => {
  test("empty and whitespace-only sources produce no chunks", () => {
    expect(chunkSource("a.ts", "", fileHash(""), budget).length).toBe(0)
    expect(chunkSource("a.ts", "   \n\n\t\n", fileHash("x"), budget).length).toBe(0)
  })

  test("a small file becomes a single chunk", () => {
    const src = "export const a = 1\nexport const b = 2\n"
    const chunks = chunkSource("src/a.ts", src, fileHash(src), budget)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.path).toBe("src/a.ts")
    expect(chunks[0]!.language).toBe("typescript")
    expect(chunks[0]!.startLine).toBe(1)
  })

  test("many small top-level declarations merge under the budget", () => {
    const decls = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}`).join("\n")
    const chunks = chunkSource("src/many.ts", decls, fileHash(decls), budget)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.length).toBeLessThan(40)
    for (const c of chunks) {
      expect(c.rawText.replace(/\s/g, "").length).toBeLessThanOrEqual(budget.maxChars)
    }
  })

  test("a single oversized declaration is hard-split into budget-sized pieces", () => {
    const body = Array.from({ length: 400 }, (_, i) => `  doThing(${i})`).join("\n")
    const fn = `function huge() {\n${body}\n}`
    const chunks = chunkSource("src/huge.ts", fn, fileHash(fn), budget)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.rawText.replace(/\s/g, "").length).toBeLessThanOrEqual(budget.maxChars + 200)
    }
  })

  test("chunk ids are content-addressed and stable when unrelated regions change", () => {
    const bodyA = Array.from({ length: 120 }, (_, i) => `  stepA(${i})`).join("\n")
    const bodyB = Array.from({ length: 120 }, (_, i) => `  stepB(${i})`).join("\n")
    const fnA = `function alpha() {\n${bodyA}\n}\n`
    const fnB = `function beta() {\n${bodyB}\n}\n`
    const before = `${fnA}\n${fnB}`
    const after = `${fnA}\nfunction beta() {\n${bodyB}\n  stepB(999)\n}\n`
    const a = chunkSource("src/s.ts", before, fileHash(before), budget)
    const b = chunkSource("src/s.ts", after, fileHash(after), budget)
    const alphaA = a.find((c) => c.symbol === "alpha")
    const alphaB = b.find((c) => c.symbol === "alpha")
    expect(alphaA?.id).toBeDefined()
    expect(alphaA?.id).toBe(alphaB?.id)
    expect(a.find((c) => c.symbol === "beta")?.id).not.toBe(b.find((c) => c.symbol === "beta")?.id)
  })

  test("markdown splits on headings", () => {
    const md = "# Title\nintro\n\n## Auth\nwe validate tokens\n\n## Storage\nwe persist rows\n"
    const chunks = chunkSource("docs/readme.md", md, fileHash(md), budget)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.every((c) => c.kind === "docs")).toBe(true)
  })

  test("embed text carries a path/symbol context header, raw text does not", () => {
    const src = "export function authenticate(token: string) {\n  return verify(token)\n}\n"
    const chunks = chunkSource("src/auth/login.ts", src, fileHash(src), budget)
    const c = chunks[0]!
    expect(c.embedText).toContain("// src/auth/login.ts")
    expect(c.embedText).toContain("authenticate")
    expect(c.rawText.startsWith("// src/auth/login.ts")).toBe(false)
    expect(c.symbol).toBe("authenticate")
  })

  test("kind detection flags tests and config", () => {
    const t = chunkSource("src/foo.test.ts", "test('x', () => {})\n", fileHash("t"), budget)
    expect(t[0]?.kind).toBe("test")
    const cfg = chunkSource("tsconfig.json", '{\n  "compilerOptions": {}\n}\n', fileHash("c"), budget)
    expect(cfg[0]?.kind).toBe("config")
  })

  test("output is deterministic", () => {
    const src = "function a() { return 1 }\nfunction b() { return 2 }\n"
    const first = chunkSource("src/d.ts", src, fileHash(src), budget)
    const second = chunkSource("src/d.ts", src, fileHash(src), budget)
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id))
  })
})

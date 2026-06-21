import type { Chunk, ChunkKind } from "../domain/types.ts"
import { chunkId, sha256 } from "../domain/hash.ts"
import { isMarkdown, kindForPath, languageForPath } from "./language.ts"

export interface ChunkBudget {
  readonly targetChars: number
  readonly maxChars: number
  readonly embedCharCap: number
}

interface Span {
  readonly startLine: number
  readonly endLine: number
  readonly start: number
  readonly end: number
  readonly text: string
}

const nonWhitespace = (text: string): number => {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 11) {
      count += 1
    }
  }
  return count
}

const lineOffsets = (source: string): ReadonlyArray<number> => {
  const offsets: Array<number> = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) offsets.push(i + 1)
  }
  return offsets
}

const isTopLevelStart = (line: string): boolean => {
  if (line.length === 0) return false
  const first = line.charCodeAt(0)
  if (first === 32 || first === 9) return false
  if (first === 125 || first === 93 || first === 41) return false
  return true
}

const detectCodeSpans = (source: string, offsets: ReadonlyArray<number>): Array<Span> => {
  const lines = source.split("\n")
  const spans: Array<Span> = []
  let blockStart = 0
  let sawContent = false
  const flush = (endLineExclusive: number) => {
    if (!sawContent) {
      blockStart = endLineExclusive
      return
    }
    const startLine = blockStart
    const endLine = endLineExclusive - 1
    const start = offsets[startLine] ?? 0
    const end = startLine >= endLineExclusive ? start : (offsets[endLine + 1] ?? source.length)
    const text = source.slice(start, end)
    if (text.trim().length > 0) {
      spans.push({ startLine: startLine + 1, endLine: endLine + 1, start, end, text })
    }
    blockStart = endLineExclusive
    sawContent = false
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (i > blockStart && isTopLevelStart(line)) flush(i)
    if (line.trim().length > 0) sawContent = true
  }
  flush(lines.length)
  return spans
}

const detectMarkdownSpans = (source: string, offsets: ReadonlyArray<number>): Array<Span> => {
  const lines = source.split("\n")
  const spans: Array<Span> = []
  let blockStart = 0
  let started = false
  const flush = (endLineExclusive: number) => {
    const startLine = blockStart
    const endLine = endLineExclusive - 1
    const start = offsets[startLine] ?? 0
    const end = offsets[endLine + 1] ?? source.length
    const text = source.slice(start, end)
    if (text.trim().length > 0) {
      spans.push({ startLine: startLine + 1, endLine: endLine + 1, start, end, text })
    }
    blockStart = endLineExclusive
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    if (/^#{1,6}\s/.test(line) && i > blockStart && started) flush(i)
    if (line.trim().length > 0) started = true
  }
  flush(lines.length)
  return spans
}

const hardSplit = (span: Span, source: string, offsets: ReadonlyArray<number>, max: number): Array<Span> => {
  const result: Array<Span> = []
  let startLine = span.startLine
  let acc = 0
  for (let line = span.startLine; line <= span.endLine; line += 1) {
    const lineStart = offsets[line - 1] ?? span.start
    const lineEnd = offsets[line] ?? span.end
    const size = nonWhitespace(source.slice(lineStart, lineEnd))
    if (acc > 0 && acc + size > max) {
      const start = offsets[startLine - 1] ?? span.start
      const end = offsets[line - 1] ?? span.end
      result.push({ startLine, endLine: line - 1, start, end, text: source.slice(start, end) })
      startLine = line
      acc = 0
    }
    acc += size
  }
  const start = offsets[startLine - 1] ?? span.start
  result.push({ startLine, endLine: span.endLine, start, end: span.end, text: source.slice(start, span.end) })
  return result.filter((s) => s.text.trim().length > 0)
}

const splitOversized = (
  spans: ReadonlyArray<Span>,
  source: string,
  offsets: ReadonlyArray<number>,
  max: number
): Array<Span> => {
  const result: Array<Span> = []
  for (const span of spans) {
    if (nonWhitespace(span.text) > max) {
      for (const piece of hardSplit(span, source, offsets, max)) result.push(piece)
    } else {
      result.push(span)
    }
  }
  return result
}

const greedyMerge = (
  spans: ReadonlyArray<Span>,
  source: string,
  offsets: ReadonlyArray<number>,
  budget: ChunkBudget
): Array<Span> => {
  const result: Array<Span> = []
  let current: Span | undefined
  let currentSize = 0
  const flush = () => {
    if (current) result.push(current)
    current = undefined
    currentSize = 0
  }
  for (const span of spans) {
    const size = nonWhitespace(span.text)
    if (size > budget.maxChars) {
      flush()
      for (const piece of hardSplit(span, source, offsets, budget.maxChars)) result.push(piece)
      continue
    }
    if (current && currentSize + size > budget.maxChars) flush()
    if (!current) {
      current = span
      currentSize = size
    } else {
      current = {
        startLine: current.startLine,
        endLine: span.endLine,
        start: current.start,
        end: span.end,
        text: source.slice(current.start, span.end)
      }
      currentSize += size
    }
    if (currentSize >= budget.targetChars) flush()
  }
  flush()
  return result
}

const IMPORT_LINE = /^\s*(import\s|from\s|use\s|using\s|#include|require\(|package\s|require\s)/

const fileContextHeader = (source: string): string => {
  const lines = source.split("\n")
  const collected: Array<string> = []
  for (let i = 0; i < lines.length && collected.length < 8; i += 1) {
    const line = lines[i] ?? ""
    if (line.trim().length === 0) continue
    if (IMPORT_LINE.test(line)) {
      collected.push(line.trim())
      continue
    }
    if (collected.length > 0) break
    if (i > 24) break
  }
  return collected.join("\n")
}

const SYMBOL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /\bdef\s+([A-Za-z_][\w]*)/,
  /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  /\b(?:public|private|protected|static|\s)*(?:[A-Za-z_<>[\]]+\s+)([A-Za-z_][\w]*)\s*\(/,
  /^#{1,6}\s+(.+?)\s*$/m
]

const symbolOf = (text: string): string => {
  const head = text.split("\n").slice(0, 4).join("\n")
  for (const pattern of SYMBOL_PATTERNS) {
    const match = pattern.exec(head)
    if (match && match[1]) return match[1].trim().slice(0, 80)
  }
  return ""
}

const clampChars = (text: string, cap: number): string =>
  text.length <= cap ? text : text.slice(0, cap)

const buildChunk = (
  path: string,
  language: string,
  kind: ChunkKind,
  fileHash: string,
  header: string,
  span: Span,
  budget: ChunkBudget
): Chunk => {
  const raw = span.text.replace(/\s+$/g, "")
  const symbol = symbolOf(raw)
  const prefix =
    `// ${path}\n` +
    (symbol ? `// ${kind} ${symbol}\n` : "") +
    (header ? `${header}\n` : "")
  const embedText = clampChars(`${prefix}${raw}`, budget.embedCharCap)
  return {
    id: chunkId(path, symbol, raw),
    path,
    language,
    kind,
    symbol,
    startLine: span.startLine,
    endLine: span.endLine,
    startByte: span.start,
    endByte: span.end,
    rawText: raw,
    embedText,
    contentHash: sha256(raw),
    fileHash
  }
}

export const chunkSource = (
  path: string,
  source: string,
  fileHash: string,
  budget: ChunkBudget
): ReadonlyArray<Chunk> => {
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (normalized.trim().length === 0) return []
  const language = languageForPath(path)
  const kind = kindForPath(path)
  const offsets = lineOffsets(normalized)
  const markdown = isMarkdown(path)
  const header = markdown ? "" : fileContextHeader(normalized)
  const merged = markdown
    ? splitOversized(detectMarkdownSpans(normalized, offsets), normalized, offsets, budget.maxChars)
    : greedyMerge(detectCodeSpans(normalized, offsets), normalized, offsets, budget)
  const seen = new Set<string>()
  const chunks: Array<Chunk> = []
  for (const span of merged) {
    const chunk = buildChunk(path, language, kind, fileHash, header, span, budget)
    if (seen.has(chunk.id)) continue
    seen.add(chunk.id)
    chunks.push(chunk)
  }
  return chunks
}

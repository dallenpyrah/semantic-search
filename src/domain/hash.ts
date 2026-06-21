import { createHash } from "node:crypto"

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

export const shortHash = (value: string, length = 16): string => sha256(value).slice(0, length)

export const chunkId = (path: string, symbol: string, rawText: string): string =>
  shortHash(`${path}\n${symbol}\n${rawText}`, 40)

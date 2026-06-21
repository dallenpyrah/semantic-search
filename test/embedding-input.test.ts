import { describe, expect, test } from "bun:test"
import {
  OPENAI_EMBEDDING_MAX_INPUT_TOKENS,
  OPENAI_EMBEDDING_MAX_REQUEST_INPUTS,
  classifyEmbeddingHttpStatus,
  countEmbeddingTokens,
  embeddingInputTokenLimit,
  prepareEmbeddingInput,
  providerErrorStatus,
  splitEmbeddingRequests
} from "../src/embedding/EmbeddingInput.ts"

describe("embedding input preparation", () => {
  test("truncates by cl100k tokens and treats literal special-token strings as text", () => {
    const text = `<|endoftext|>\n${Array.from({ length: 9000 }, (_, i) => `identifier_${i}`).join(" ")}`
    const prepared = prepareEmbeddingInput(text, 512)

    expect(prepared.truncated).toBe(true)
    expect(prepared.tokens).toBeLessThanOrEqual(512)
    expect(countEmbeddingTokens(prepared.text)).toBe(prepared.tokens)
  })

  test("caps configured per-input token limits at the OpenAI embedding model limit", () => {
    expect(embeddingInputTokenLimit(999_999)).toBe(OPENAI_EMBEDDING_MAX_INPUT_TOKENS)
    expect(embeddingInputTokenLimit(0)).toBe(1)
  })

  test("splits batches by input count and aggregate token budget", () => {
    const inputs = Array.from({ length: 5 }, () => prepareEmbeddingInput("token ".repeat(100), 1_000))
    const byCount = splitEmbeddingRequests(inputs, {
      maxInputsPerRequest: 2,
      maxTokensPerRequest: 1_000
    })
    const byTokens = splitEmbeddingRequests(inputs, {
      maxInputsPerRequest: OPENAI_EMBEDDING_MAX_REQUEST_INPUTS,
      maxTokensPerRequest: 250
    })

    expect(byCount.map((batch) => batch.length)).toEqual([2, 2, 1])
    expect(byTokens.every((batch) => batch.reduce((sum, input) => sum + input.tokens, 0) <= 250)).toBe(true)
    expect(byTokens.flat()).toHaveLength(inputs.length)
  })

  test("classifies provider 400s as permanent and rate/server failures as retryable", () => {
    expect(classifyEmbeddingHttpStatus(400).retryable).toBe(false)
    expect(classifyEmbeddingHttpStatus(429).retryable).toBe(true)
    expect(classifyEmbeddingHttpStatus(500).retryable).toBe(true)
    expect(providerErrorStatus({ error: { message: "HTTP 400: invalid input", code: 400 } })).toBe(400)
  })
})

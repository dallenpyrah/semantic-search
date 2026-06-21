import { Tiktoken } from "js-tiktoken/lite"
import cl100kBase from "js-tiktoken/ranks/cl100k_base"

export const OPENAI_EMBEDDING_MAX_INPUT_TOKENS = 8192

export const OPENAI_EMBEDDING_MAX_REQUEST_INPUTS = 2048

export const OPENAI_EMBEDDING_MAX_REQUEST_TOKENS = 300_000

export const DEFAULT_EMBEDDING_REQUEST_TOKEN_BUDGET = 250_000

export interface PreparedEmbeddingInput {
  readonly text: string
  readonly tokens: number
  readonly truncated: boolean
}

export interface EmbeddingRequestLimits {
  readonly maxInputsPerRequest: number
  readonly maxTokensPerRequest: number
}

export interface EmbeddingHttpClassification {
  readonly status: number
  readonly retryable: boolean
}

const encoder = new Tiktoken(cl100kBase)

const positiveInteger = (value: number): number => Math.max(1, Math.floor(value))

const encodeText = (text: string): ReadonlyArray<number> => encoder.encode(text, [], [])

export const countEmbeddingTokens = (text: string): number => encodeText(text).length

export const embeddingInputTokenLimit = (configuredLimit: number): number =>
  Math.min(OPENAI_EMBEDDING_MAX_INPUT_TOKENS, positiveInteger(configuredLimit))

export const embeddingRequestInputLimit = (configuredLimit: number): number =>
  Math.min(OPENAI_EMBEDDING_MAX_REQUEST_INPUTS, positiveInteger(configuredLimit))

export const embeddingRequestTokenBudget = (configuredBudget = DEFAULT_EMBEDDING_REQUEST_TOKEN_BUDGET): number =>
  Math.min(OPENAI_EMBEDDING_MAX_REQUEST_TOKENS, positiveInteger(configuredBudget))

export const prepareEmbeddingInput = (text: string, configuredTokenLimit: number): PreparedEmbeddingInput => {
  const limit = embeddingInputTokenLimit(configuredTokenLimit)
  const tokens = encodeText(text)
  if (tokens.length <= limit) return { text, tokens: tokens.length, truncated: false }

  const truncatedTokens = tokens.slice(0, limit)
  return {
    text: encoder.decode(truncatedTokens),
    tokens: truncatedTokens.length,
    truncated: true
  }
}

export const splitEmbeddingRequests = (
  inputs: ReadonlyArray<PreparedEmbeddingInput>,
  limits: EmbeddingRequestLimits
): ReadonlyArray<ReadonlyArray<PreparedEmbeddingInput>> => {
  const maxInputs = embeddingRequestInputLimit(limits.maxInputsPerRequest)
  const maxTokens = embeddingRequestTokenBudget(limits.maxTokensPerRequest)
  const batches: Array<Array<PreparedEmbeddingInput>> = []
  let current: Array<PreparedEmbeddingInput> = []
  let currentTokens = 0

  const flush = () => {
    if (current.length === 0) return
    batches.push(current)
    current = []
    currentTokens = 0
  }

  for (const input of inputs) {
    if (current.length > 0 && (current.length >= maxInputs || currentTokens + input.tokens > maxTokens)) {
      flush()
    }
    current.push(input)
    currentTokens += input.tokens
  }
  flush()

  return batches
}

export const classifyEmbeddingHttpStatus = (status: number): EmbeddingHttpClassification => ({
  status,
  retryable: status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
})

const statusFromUnknown = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value !== "string") return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

export const providerErrorStatus = (json: unknown): number | undefined => {
  if (json === null || typeof json !== "object") return undefined
  const error = (json as { error?: unknown }).error
  if (error === null || typeof error !== "object") return undefined
  const codeStatus = statusFromUnknown((error as { code?: unknown }).code)
  if (codeStatus !== undefined) return codeStatus

  const message = (error as { message?: unknown }).message
  if (typeof message !== "string") return undefined
  const match = /\bHTTP\s+(\d{3})\b/.exec(message)
  return match?.[1] ? Number(match[1]) : undefined
}

export const providerErrorMessage = (json: unknown): string | undefined => {
  if (json === null || typeof json !== "object") return undefined
  const error = (json as { error?: unknown }).error
  if (error === null || typeof error !== "object") return undefined
  const message = (error as { message?: unknown }).message
  return typeof message === "string" ? message : undefined
}

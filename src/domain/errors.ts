import { Schema } from "effect"

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export class EmbedError extends Schema.TaggedErrorClass<EmbedError>()("EmbedError", {
  message: Schema.String,
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect())
}) {}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("StoreError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  namespaceMissing: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect())
}) {}

export class RerankError extends Schema.TaggedErrorClass<RerankError>()("RerankError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export class ChunkError extends Schema.TaggedErrorClass<ChunkError>()("ChunkError", {
  message: Schema.String,
  path: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export class IndexError extends Schema.TaggedErrorClass<IndexError>()("IndexError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export type SemanticSearchError =
  | ConfigError
  | EmbedError
  | StoreError
  | RerankError
  | ChunkError
  | IndexError

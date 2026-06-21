import { Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { AppConfig } from "../config/AppConfig.ts"
import { Chunker } from "../chunk/Chunker.ts"
import { CommitIndexer } from "../index/CommitIndexer.ts"
import { ConversationIndexer } from "../index/ConversationIndexer.ts"
import { Embeddings } from "../embedding/Embeddings.ts"
import { GitHistory } from "../index/GitHistory.ts"
import { Indexer } from "../index/Indexer.ts"
import { Manifest } from "../index/Manifest.ts"
import { Reranker } from "../rerank/Reranker.ts"
import { Search } from "../search/Search.ts"
import { Turbopuffer } from "../store/Turbopuffer.ts"
import { Watcher } from "../watch/Watcher.ts"

export interface RuntimeInput {
  readonly root: string
  readonly trusted: boolean
  readonly namespaceOverride?: string
}

const leaves = Layer.mergeAll(
  Chunker.layer,
  Embeddings.layer,
  Turbopuffer.layer,
  Reranker.layer,
  Manifest.layer,
  GitHistory.layer
)

const withIndexer = Indexer.layer.pipe(Layer.provideMerge(leaves))
const withCommit = CommitIndexer.layer.pipe(Layer.provideMerge(withIndexer))
const withConversation = ConversationIndexer.layer.pipe(Layer.provideMerge(withCommit))
const withWatcher = Watcher.layer.pipe(Layer.provideMerge(withConversation))
const services = Search.layer.pipe(Layer.provideMerge(withWatcher))

export const configLayer = (input: RuntimeInput) =>
  AppConfig.layer(input).pipe(Layer.provide(NodeServices.layer))

export const appLayer = (input: RuntimeInput) =>
  services.pipe(
    Layer.provideMerge(AppConfig.layer(input)),
    Layer.provide(NodeServices.layer)
  )

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>
export type AppError = Layer.Error<ReturnType<typeof appLayer>>

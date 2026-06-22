import type { Plugin } from "@opencode-ai/plugin"
import semanticSearch from "./semantic_search.ts"
import { runtimeFor, stopRuntime } from "./runtime.ts"

const SemanticSearchPlugin = (async ({ client, directory, worktree }) => {
  const root = worktree || directory
  void runtimeFor(root).then((state) =>
    client.app.log({
      body: {
        service: "semantic-search",
        level: state.enabled ? "info" : "warn",
        message: state.enabled ? "indexer started" : state.disabledReason,
        extra: { root: state.root, namespace: state.namespace }
      }
    })
  )

  return {
    tool: {
      semantic_search: semanticSearch
    },
    dispose: async () => {
      await stopRuntime(root)
    }
  }
}) satisfies Plugin

export default SemanticSearchPlugin

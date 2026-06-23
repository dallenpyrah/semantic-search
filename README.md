<div align="center">

# semantic-search

**Effect-native semantic + hybrid code search — Amp/OpenCode custom tools, a Pi coding-agent extension, and a standalone CLI.**

</div>

Backed by [TurboPuffer](https://turbopuffer.com) (vector + BM25), `text-embedding-3-large`
embeddings and a Cohere `rerank-v3.5` reranker — both via [OpenRouter](https://openrouter.ai) (one key).
Built entirely in [Effect v4](https://effect.website).

It gives a coding agent **one** tool — `semantic_search` — driven by config options (`query`,
`queries[]` for parallel facets, `mode`, `source`, `file`/`lines` for git diffs, `pathPrefix`,
`language`). It answers "where / how is X" in one call instead of many grep-then-read round-trips, and
can also surface lower-weighted git-history and past-conversation context for "why / when did this
change" questions. The index is built and kept fresh automatically while an agent integration is
running — including across `git pull`, branch switches, and commits.

## Why

- **Fewer tool calls, less context.** One ranked call with file path + line range replaces a loop of
  guessing greps and whole-file reads.
- **Better answers.** Hybrid retrieval (semantic ANN + BM25) fused and cross-encoder reranked.
  Success@10 97%, nDCG@10 0.90 on the project's own eval (`docs/BENCHMARKS.md`).
- **The agent actually uses it.** Tool descriptions + a skill tuned until adoption hit 4/4 with zero
  grep fallback (`docs/BENCHMARKS.md`).
- **Safe to run for hours.** Incremental indexing (only changed chunks re-embed), a bounded watcher
  queue, scoped resources, and a leak test that asserts no watcher/timer growth.

## Install (as an Amp plugin)

This repo ships a trusted Amp adapter in `src/amp/`:

- `src/amp/plugin.ts` registers the `semantic_search` tool and starts the indexer/watcher on
  `session.start`.
- `src/amp/skills/searching-code/SKILL.md` teaches Amp when to prefer `semantic_search` over grep/read
  loops.
- `src/amp/install.ts` installs both into your Amp agent config.

From this checkout:

```bash
bun install
bun run amp:install
```

By default this writes a user-wide plugin loader to `~/.config/amp/plugins/semantic-search.ts` and a
user-wide skill to `~/.config/agents/skills/searching-code`. For a project-local install instead, run:

```bash
bun run amp:install -- --workspace --workspace-root /path/to/repo
```

Reload plugins from the Amp command palette (`plugins: reload`) or restart Amp. Use the
`Semantic Search Status`, `Semantic Search Stop`, and `Semantic Search Restart` commands to inspect or
control the long-lived indexer/watcher. Amp currently exposes a start event but not a session shutdown
event, so the watcher is scoped to the Amp plugin process after first start.
The installed plugin resolves the target root from `SEMANTIC_SEARCH_ROOT` when set, otherwise from the
Amp launch directory (`PWD`) and its git root.

Credentials are the same as the Pi/OpenCode integrations:

- `OPENROUTER_API_KEY` (required — embeddings + reranker by default)
- `TURBOPUFFER_API_KEY` + `TURBOPUFFER_REGION` (required — storage)
- `OPENAI_API_KEY` (only if `embedding.provider` is set to `openai`)

Integration choice: for trusted local use, a plugin plus skill is the shortest correct path. It reuses
the in-process TypeScript/Effect runtime directly and avoids an extra MCP server dependency or process.
For non-Amp clients, the next layer should be a small MCP stdio server using the same
`semantic_search` surface.

## Install (as an OpenCode plugin)

Add the package plugin to `~/.config/opencode/opencode.jsonc`:

```json
{
  "plugin": ["git+https://github.com/dallenpyrah/semantic-search.git"]
}
```

The plugin registers the `semantic_search` tool, starts the indexer/watcher when OpenCode starts, and stops it on shutdown.

## Install (as a Pi extension)

```bash
pi install git:https://github.com/dallenpyrah/semantic-search.git
```

The extension auto-starts on `session_start`: it indexes the project, warms the namespace, and
watches for file changes. It stops on `session_shutdown`. The skill lives in `skills/code-search`.
2. Provide credentials via environment or `~/.pi/agent/semantic-search.env`:
   - `OPENROUTER_API_KEY` (required — embeddings + reranker, one key)
   - `TURBOPUFFER_API_KEY` + `TURBOPUFFER_REGION` (required — storage)
   - `OPENAI_API_KEY` (only if you set `embedding.provider` to `openai` to call OpenAI directly)

If a required key is missing the extension disables itself cleanly and tells you which key to set.

## Standalone CLI

```bash
bun src/cli/main.ts index .                 # embed + index a codebase
bun src/cli/main.ts search "where do we validate auth tokens" --root .
bun src/cli/main.ts search "validateToken" --mode hybrid --root .
bun src/cli/main.ts watch .                 # index, then keep fresh on file changes
bun src/cli/main.ts status .
bun src/cli/main.ts clear . --force
bun src/cli/main.ts config .                # print resolved configuration
```

`--json` emits machine-readable output; `--limit`, `--path`, `--language` scope results.

## Configuration

Resolution order (later overrides earlier): built-in defaults → global
`~/.pi/agent/semantic-search.json` → project `.pi/semantic-search.json` (trusted projects only).

Control which folders are indexed globally — e.g. `~/.pi/agent/semantic-search.json`:

```json
{
  "indexing": {
    "excludeDirs": ["fixtures", "generated"],
    "excludePathPatterns": ["**/*.pb.go"]
  }
}
```

`excludeDirs` / `excludeFiles` / `excludePathPatterns` merge additively over a sensible base
(`node_modules`, `.git`, `dist`, lockfiles, minified files, …). See `src/config/defaults.ts`.

## Architecture

See `docs/ARCHITECTURE.md`. Deep modules behind narrow `Effect` services: `Embeddings`,
`Turbopuffer`, `Reranker`, `Chunker`, `Manifest`, `Indexer`, `Watcher`, `Search` — composed into one
layer, run as a `ManagedRuntime` inside OpenCode tools and Pi, and via `effect/unstable/cli` standalone.

## Develop

```bash
bun install
bun run typecheck
bun test                # unit + leak tests; *.live.test.ts hit the real APIs when keys are set
bun eval/retrieval.ts   # retrieval quality scorecard
```

## License

Apache-2.0.

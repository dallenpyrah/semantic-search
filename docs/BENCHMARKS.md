# Benchmarks

Reproducible scorecards. Re-run with `bun eval/retrieval.ts` and `bun eval/adoption.ts <repo>`.

## Retrieval quality

Corpus: this repository's `src/` + real docs (excludes `eval/` and `docs/research/`, which are
test-gold and research artifacts). 30 curated queries (20 semantic NL, 10 exact-token), gold =
the file that implements the queried thing. Embeddings `text-embedding-3-large` @ 3072d, TurboPuffer
hybrid + Cohere `rerank-v3.5`.

| Metric | Score |
|---|---|
| Success@1 | 80% |
| Success@3 | 93% |
| Success@5 | 97% |
| Success@10 | 97% |
| MRR | 0.875 |
| nDCG@10 | 0.899 |
| Search latency p50 / p95 | ~720ms / ~1300ms (includes rerank) |
| Index (97 chunks) | ~7s cold, ~2.5s incremental |

Tuning that moved the numbers (each verified by re-running the eval):

1. Rerank semantic queries too (not just hybrid): Success@10 87% → 100%.
2. Feed the reranker the file path plus chunk text (not text alone): Success@1 27% → 47%.
3. Mild kind preference (code > test > docs) as a near-tie breaker: Success@1 47% → 80%,
   nDCG@10 0.74 → 0.90.

## Tool adoption (real Pi, `pi -p --mode json`)

4 tasks over a pre-indexed sample repo, only this extension + skill loaded.

| Task type | Prompt | First retrieval call | grep used | Tool calls |
|---|---|---|---|---|
| discovery | "Where is rate limiting implemented?" | `code_search` | no | 3 |
| discovery | "How does the billing retry logic work?" | `code_search` | no | 3 |
| discovery | "Where do we issue and validate access tokens?" | `code_search` | no | 3 |
| exact | "Find every place that references validateAccessToken" | `code_grep` | no | 3 |

**Adoption: 4/4 routed to `code_search`/`code_grep` first. Mis-route: 0. Grep fallback: 0. Avg 3.0
tool calls.** The flow is `read(SKILL.md)` → `code_search` → `read(target file)`: the agent loads
the skill once, then uses the semantic tools for the rest of the session.

## Why this beats grep-then-read for discovery

For "where is rate limiting implemented", a grep approach is: grep a guessed term → read several
candidate files → grep again → read. That is typically 5–10+ calls and loads whole files into
context. `code_search` returns the ranked file path plus the exact line range in one call, so the
agent reads exactly one region. Fewer tool calls, far less context, one round-trip of latency.

## Memory / leaks

`test/watcher-leak.test.ts` opens and closes the watcher 20 times and asserts no growth in
`FSWatcher` / timer counts via `process.getActiveResourcesInfo()`. The watcher uses a bounded
sliding queue and scoped finalizers, so teardown is total.

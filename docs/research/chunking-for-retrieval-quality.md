# Code Chunking for Retrieval Quality — Research Brief

Project: Effect v4 semantic code-search CLI + Pi coding-agent extension.
Date: 2026-06-20. Author: grounding subagent.
Scope: how to split source files into retrieval units that maximize semantic + hybrid (vector+BM25) search quality, at low memory, across many languages, with stable boundaries for incremental reindexing.

---

## TL;DR Decision

**Ship a strong AST/structure-aware chunker from day one, built on `web-tree-sitter` (WASM), using the cAST split-then-merge algorithm. Budget chunks by non-whitespace characters with a target of ~1200 and a hard max of ~1600 non-whitespace chars (~400–500 tokens), no overlap, and prepend a compact context header (file path + enclosing symbol chain + imports) to every chunk's *embedding text* while storing the raw span separately. Fall back to a brace/blank-line/indent heuristic splitter when no grammar is loaded or parsing errors out.**

Do NOT ship a pure fixed-size line chunker as the primary path. The evidence is unambiguous that structure-aware chunking wins, and `web-tree-sitter` is cheap enough (single 4.5 MB core wasm + ~small per-language wasm, lazy-loaded) that there is no reason to defer it. The heuristic splitter is the *fallback*, not the *MVP*.

---

## 1. Evidence: AST/structure-aware chunking beats fixed-size chunking

Primary source: **cAST — "Chunking via Abstract Syntax Trees" (Zhang et al., CMU + Augment Code, EMNLP Findings 2025).**
- arXiv HTML: https://arxiv.org/html/2506.15655v1
- ACL Anthology: https://aclanthology.org/2025.findings-emnlp.430
- CMU PDF: https://www.cs.cmu.edu/~sherryw/assets/pubs/2025-cast.pdf

cAST replaces fixed-size line-based chunking with a recursive *split-then-merge* over the tree-sitter AST, and measures gains on three benchmarks (RepoEval, CrossCodeEval, SWE-bench Lite) across multiple retrievers (BGE, GIST, CodeSage) and generators (StarCoder2, CodeLlama, Claude, Gemini). Quoted results from the paper:

- **Recall@5 +4.3 points on RepoEval retrieval** (code-to-code). (abstract, §3.2)
- **Pass@1 +2.67 points on SWE-bench generation.** (abstract)
- Retrieval, RepoEval (code→code): all retrievers gain **1.2–3.3 points Precision, 1.8–4.3 points Recall**. (§3.2 "Retrieval")
- Retrieval, SWE-bench (NL→code, harder): **0.5–1.4 Precision, 0.7–1.1 Recall**. (§3.2)
- Generation: StarCoder2-7B averages **+5.5 points on RepoEval**. (§1, advantage 1)
- Cross-language: **up to +4.3 points on CrossCodeEval** (language-invariant algorithm generalizes). (§1, advantage 2)
- Multilingual EM (Table 5, Codesage-small-v2 + StarCoder2-7B): **+2.9 EM on code, +3.0 on identifier, largest gains on TypeScript** ("the noisiest language"). (§ line 1289)

**Why it works (the mechanism, not just the numbers):** Figure 1 of the paper shows fixed-size chunking slicing a method across a chunk boundary, so the model loses the method's return value and generates code on a false assumption. AST chunks keep "complete syntactic units" intact, so the retrieved evidence is self-contained. Critically, the paper finds **precision (not recall/nDCG) correlates most with downstream generation quality** — "ensuring the top-k context is highly relevant reduces noise" (§3.2 "Correlation"). This matters for us: a reranker plus structure-aware chunks both push toward precision.

cAST's four stated design goals (§ line 99), which we adopt verbatim as our chunker contract:
1. **Syntactic integrity** — boundaries align with complete syntactic units whenever possible.
2. **High information density** — each chunk packed up to but not beyond a fixed budget.
3. **Language invariance** — no language-specific heuristics; works unchanged across grammars.
4. **Plug-and-play / lossless** — concatenating chunks reproduces the original file verbatim.

Corroborating (secondary) sources, all agreeing structure-aware > fixed-size for code RAG:
- KnowledgeSDK, "AST-Aware Code Chunking for RAG: Why Text Splitting Fails on Code" (2026-03-20): https://knowledgesdk.com/blog/ast-aware-chunking-code-rag
- dasroot.net, "Using AST Parsing to Improve Code Retrieval" (2026-04-10): https://dasroot.net/posts/2026/04/using-ast-parsing-improve-code-retrieval
- The classic prior-art convention is Sweep.dev's tree-sitter "CST chunker" and LlamaIndex's `CodeSplitter`, both of which split on tree-sitter spans with a char budget. cAST is the rigorous benchmarked version of that idea.

**Conclusion:** structure-aware chunking is worth roughly **+2 to +4 retrieval points and +2.5 to +5.5 generation points** over fixed-size, consistently, across languages and retrievers. This is a large, free, one-time quality win. Take it.

---

## 2. The cAST algorithm (the thing to implement)

From the paper, Algorithm 1 (Appendix A.3), reproduced exactly (paper line 799+):

```
MAX_SIZE ← maximum chunk size            # measured in NON-WHITESPACE characters

function ChunkCode(code):
    tree ← ParseAST(code)
    if GetSize(code) ≤ MAX_SIZE:
        return [tree]                    # whole file fits → one chunk
    else:
        return ChunkNodes(tree.children) # recurse into top-level nodes

function ChunkNodes(nodes):
    chunks ← [], chunk ← [], size ← 0
    for node in nodes:
        s ← GetSize(node)
        if (chunk = [] and s > MAX_SIZE) or (size + s > MAX_SIZE):
            if chunk ≠ []:
                chunks.append(chunk)
                chunk, size ← [], 0
            if s > MAX_SIZE:                       # node too big alone → split it
                subchunks ← ChunkNodes(node.children)
                chunks.extend(subchunks)
                continue
        else:
            chunk.append(node); size ← size + s    # greedily merge sibling into current chunk
    if chunk ≠ []:
        chunks.append(chunk)
    return chunks
```

Two key properties:
1. **Greedy merge of adjacent siblings** packs many small declarations (imports, tiny functions, consts) into one dense chunk instead of one-chunk-per-line. This is exactly what the reference Rust chunker's `merge_small_spans` does (see §6).
2. **Recursive split** only descends into a node when it alone exceeds `MAX_SIZE` (e.g. a giant class/impl body), splitting it by its children (methods). Same as the Rust reference's `is_container_node` recursion.

**Chunk-size metric — this is a deliberate, non-obvious choice (paper §line 117):**
> "we measure chunk size by the number of **non-whitespace characters** rather than by lines. This keeps chunks text-dense and comparable across diverse files, languages, and coding styles, ensuring that our budget reflects actual content rather than incidental formatting."

So `GetSize(node) = count of non-whitespace chars in node.text`. Use this, not line count, not raw char count. (The Rust reference uses line count — that's the one place we deviate from it and follow the paper instead.)

---

## 3. Practical Node/TS implementation: web-tree-sitter (WASM) vs native vs heuristic

### Option A — `web-tree-sitter` (WASM) — RECOMMENDED

- npm `web-tree-sitter@0.26.9` (verified via `npm view`, 2026-06-20). Core package: **4.56 MB unpacked, 19 files** — one `web-tree-sitter.wasm` core + JS bindings (ESM, CJS via `.cjs` for Electron, and a `/debug` build).
- API (verified from the official README at https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md):

```ts
import { Parser, Language } from "web-tree-sitter"

await Parser.init()                                       // one-time WASM core init
const TS = await Language.load("/path/to/tree-sitter-typescript.wasm") // per-language wasm, LAZY
const parser = new Parser()
parser.setLanguage(TS)

const tree = parser.parse(sourceCode)                     // string | callback
const root = tree.rootNode
// node API: node.type, node.startIndex, node.endIndex,
//           node.startPosition {row,column}, node.endPosition,
//           node.isNamed(), node.namedChildren, node.childForFieldName("name"),
//           node.walk() → TreeCursor (gotoFirstChild / gotoNextSibling / gotoParent)
tree.delete()                                             // MANUAL free — WASM heap is not GC'd
```

- **Languages are individual `.wasm` files, loaded on demand.** You install `tree-sitter-typescript`, `tree-sitter-python`, etc. and grab the `.wasm` from `node_modules/<grammar>/`. Each grammar wasm is small (tens to low-hundreds of KB). You only load the grammars actually present in a repo, lazily, and can unload by dropping the `Language` reference.
- **Memory:** one shared 4.5 MB core wasm heap + one parser + the per-file `Tree`. Trees must be `.delete()`d (manual free). Steady-state footprint for an incremental indexer parsing one file at a time is single-digit MB plus loaded grammars. This is the low-memory profile a Pi extension needs.
- **Incremental parsing supported** (`tree.edit(...)` + `parser.parse(newSrc, oldTree)`), faster than first parse — directly useful for the live-file-watch reindex path.
- **No native build step, no node-gyp, no per-platform binaries.** Works the same on macOS/Linux/Windows, in the main process or a worker, and survives Node version bumps. This is the single biggest operational reason to pick it for a distributed CLI/extension.

Gotchas (grounded):
- You must `await Parser.init()` once before anything; it's async (WASM instantiation).
- You must `.delete()` every `Tree` (and `Query`/`TreeCursor` if used) — leaking them grows the WASM heap. Wrap parse+walk in an Effect `acquireRelease` so the finalizer always frees.
- WASM parsing is ~3–5× slower than native tree-sitter for large files, but for chunking-on-save (one file at a time) this is irrelevant; parsing a typical source file is sub-millisecond to low-ms.
- The `.wasm` grammar files must be shipped/resolvable at runtime. Resolve them from the installed grammar packages (`require.resolve("tree-sitter-typescript/.../*.wasm")`) or bundle them — do not assume a hardcoded path.

### Option B — native `tree-sitter` (node bindings) — NOT recommended for this project

- npm `tree-sitter@0.25.0` is a native addon (node-gyp). Each grammar is a **separate native package that compiles at install** — `tree-sitter-typescript@0.23.2` unpacks to **38.8 MB** (verified via `npm view`) because it ships C sources + build artifacts.
- 2–5× faster parsing, but: requires a C/C++ toolchain at install, produces platform-specific binaries, breaks across Node ABI versions (must rebuild on Node upgrade), and bloats install size dramatically per language. For a *distributed* CLI / agent extension that users install with `npm i`, this is a deployment and support liability. The speed advantage is moot for one-file-at-a-time chunking.
- Reserve native only if we ever batch-index millions of files where parse throughput dominates — not the case here.

### Option C — pure heuristic structural splitting (brace depth / blank-line / top-level decl) — KEEP AS FALLBACK ONLY

- Split on: top-level brace-depth-0 boundaries, blank-line groups, and indentation drops (Python-style). Merge small adjacent groups up to the char budget; hard-split anything over budget at line boundaries.
- Pros: zero deps, zero wasm, trivially low memory, language-agnostic, always available.
- Cons: brace heuristics break on strings/comments/regex/JSX; indentation heuristics are language-specific; produces worse boundaries than AST (the entire point of cAST's +2–4 points). It is *good enough* as a safety net, not as the product.
- **Role:** fallback when (a) no grammar is loaded for the file's language, or (b) `parser.parse` returns a tree with errors / the language isn't in our grammar set. The Rust reference does exactly this (`chunk_fallback` on parse failure — see its test `chunk_file_with_parse_error_falls_back`).

### Recommendation matrix

| Path | Quality | Deps | Memory | Install/Deploy | Verdict |
|---|---|---|---|---|---|
| web-tree-sitter (WASM) | High (AST) | core wasm + lazy grammars | low (manual free) | trivial, portable | **Primary** |
| native tree-sitter | High (AST) | node-gyp + 38 MB/grammar | low | fragile, per-platform | Avoid |
| heuristic structural | Medium | none | lowest | trivial | **Fallback** |

**Decision: ship web-tree-sitter now; heuristic splitter as the fallback. Do not defer tree-sitter to "phase 2."** The WASM path removes every reason people usually defer tree-sitter (native build pain, install size, ABI breakage). The quality delta is real and benchmarked. Deferring it ships a worse product for no saved complexity beyond a lazy `Language.load`.

---

## 4. Chunk sizing, overlap, context prefixing, embeddings, huge files, docs

### Embedding model constraints (verified)
- **OpenAI `text-embedding-3-large`**: max input **8191 tokens**; default **3072 dimensions**, Matryoshka-truncatable to 1024 or 256 via the `dimensions` param. Sources: https://zilliz.com/ai-models/text-embedding-3-large and OpenAI dev forum. So a single chunk can technically be huge — but bigger chunks dilute the embedding (one vector summarizing too much) and hurt *precision*, which the cAST paper shows is what actually drives downstream quality.

### Recommended sizes
- **Target chunk budget: ~1200 non-whitespace chars. Hard max: ~1600 non-whitespace chars.** That's roughly 300–500 tokens of code — small enough for sharp, precise embeddings, large enough to hold a whole typical function plus its signature/context header. This sits in the well-supported "small chunk, high precision" regime that the paper's precision-correlation finding favors.
- **Minimum useful chunk: ~80 non-whitespace chars.** Below that, the greedy-merge step should have already absorbed it into a neighbor; a lone tiny chunk (e.g. a one-line export) is fine to merge forward.
- **No overlap.** cAST uses none and is lossless (chunks concatenate to the original). Overlap is a fixed-size-chunking patch for the boundary-cutting problem; AST boundaries already fall on syntactic seams, so overlap just adds duplicate vectors, inflates the index, and muddies BM25. Skip it. (If recall ever proves weak in eval, revisit with *sibling context* — including the parent declaration line — not raw line overlap.)
- **Hard ceiling vs embedding limit:** since 1600 non-ws chars << 8191 tokens, no chunk will ever exceed the embedding limit. The only file that can blow the limit is a single token-dense node bigger than budget that *also* can't be split (a node with no named children, e.g. a giant string literal or minified line). For that pathological case, hard-truncate the embedding text at a safe token margin (e.g. 8000 tokens) but keep the full raw span for display/BM25. The Rust reference does exactly this with `MAX_SNIPPET_CHARS = 8192` + UTF-8-boundary-safe truncation.

### Context prefixing (prepend file path + symbol chain) — DO THIS

Prepend a compact context header to the **text you embed and BM25-index**, while storing the raw span unmodified for display and line-accurate jumps. The cAST paper explicitly flags "metadata retention" (file/class/function level) as advantage #3 (up to +2.7 on SWE-bench) and notes that multi-level/hierarchical context "can improve retrieval" (§ Limitations, line 336). The Rust reference already does this: `build_chunk` prepends `// File: {path}\n`, and `extract_file_context` prepends imports, and `extract_parent_context` prepends `// Context: {class/impl Name}`.

Recommended header format (kept tiny so it doesn't dominate the embedding):

```
// <relative/path/to/file.ts>
// <kind> <SymbolChain>           e.g. "class UserService > method authenticate"
<original chunk text>
```

Rationale:
- The path tokens ground "where" (helps NL→code queries that mention a module/feature).
- The enclosing symbol chain restores the context a leaf method loses when chunked out of its class — this is the precise failure cAST's Figure 1 highlights.
- Keep it to 1–3 lines. Do not dump the whole class body; that defeats density.
- **Embed-text ≠ stored-text.** Header goes into the vector + BM25 doc; `startLine/endLine` still point at the raw span. Keep these two strings separate in the chunk record.

### Huge files
- A 50k-line generated/vendored file should mostly be *excluded* at the ignore layer (respect `.gitignore`, skip `*.min.js`, lockfiles, `dist/`, vendored dirs). For huge-but-legit files, the cAST recursion already splits them into budget-sized chunks; just cap total chunks per file (e.g. 2000) and emit a warning rather than indexing a megabyte of one file.
- If parse time on a giant file is a problem, size-gate: files over ~1 MB go straight to the heuristic line splitter (skip AST). The Rust reference effectively does this via its fallback path.

### Markdown / docs
- Markdown has a tree-sitter grammar (`tree-sitter-md`), and the Rust reference treats `atx_heading`/`setext_heading`/`section`/`fenced_code_block`/`list` as semantic nodes. Chunk markdown by **heading section**: each `##`/`###` section (heading + body until next same-or-higher heading) becomes a chunk, splitting oversized sections by paragraph/list. Keep fenced code blocks intact within their section. This gives doc chunks that map to a queryable concept.
- For other structured text (JSON/YAML/TOML), AST chunking by top-level key/section is supported by the same grammars but is low-value for code search — index them with the heuristic splitter or skip unless the project wants config search.

---

## 5. Metadata + stable boundaries for incremental reindexing

### Metadata to attach per chunk (store alongside the vector in TurboPuffer)

| Field | Source | Use |
|---|---|---|
| `path` | file path (repo-relative) | filter, display, header |
| `language` | extension → grammar | filter, BM25 analyzer choice |
| `startLine` / `endLine` | `node.startPosition.row+1` / `node.endPosition.row+1` | editor jump, display |
| `startByte` / `endByte` | `node.startIndex` / `node.endIndex` | exact span re-extraction |
| `kind` | AST node type → label (function/class/method/...) | filter, reranker signal, display |
| `symbol` | enclosing decl name chain | header, filter, display |
| `contentHash` | hash of the raw span text (blake3/sha) | change detection, dedup, idempotent upsert |
| `fileHash` + `mtime` | whole-file hash + mtime | skip-unchanged-file fast path |

The Rust reference's `CodeChunk` struct is the template: `{ id, path, language, start_line, end_line, text, hash, modified_at }`. Mirror it; add `kind`, `symbol`, `start_byte/end_byte`.

### Stable boundaries (the incremental-reindex problem)

The hard requirement for live file watching: **editing line 10 of a 500-line file must not re-embed (and re-pay OpenAI for) all 40 chunks** — only the chunk(s) that actually changed.

Mechanism:
1. **Content-addressed chunk IDs.** Make each chunk's identity = `hash(path + symbolPath + rawSpanText)`, NOT a random UUID and NOT the line range. Line ranges shift when you add a line above; symbol+content does not. (The Rust reference uses `Uuid::new_v4()` per chunk — that's wrong for incremental dedup; we deviate and use a content-derived ID.)
2. **AST boundaries are inherently stable.** Because chunks align to whole declarations, inserting a blank line or editing one function leaves every *other* function's chunk text byte-identical → same content hash → no-op upsert. This stability is a property of structure-aware chunking that fixed-size line chunking does not have (line chunks shift en masse when a line is inserted near the top). This is a second, underappreciated reason to choose AST chunking for a *live-watch* indexer.
3. **Reindex diff:** on file change, re-chunk the whole file (cheap), compute the new set of `(chunkId, contentHash)`, diff against the stored set for that path:
   - new IDs → embed + upsert,
   - missing IDs → delete from index,
   - unchanged IDs → skip (no embed call).
4. **File-level gate first:** if `fileHash` is unchanged, skip entirely. If changed, run the chunk diff. This keeps the steady-state cost proportional to *what changed*, not file size.

Caveat: if two distinct functions have byte-identical bodies and the same symbol path (rare; e.g. duplicated stubs), content-hash IDs collide — dedup is actually desirable there (one vector, both locations stored in metadata). If you need both locations, salt the ID with `startByte`, accepting that pure line shifts above won't change `startByte` only if nothing before them changed (they will if text is inserted). Prefer `hash(path+symbolPath+rawText)` and treat collisions as dedup.

---

## 6. What to take from the Rust reference (`<reference-chunker>`)

Read for ideas only (Rust; do not port). What it gets right and we should mirror in TS:
- **Parse → semantic-span collection → merge-small → fallback** pipeline (`mod.rs` `chunk_file`, `treesitter.rs` `chunk_with_tree`). This is cAST's split-then-merge in practice.
- **`is_semantic_node` / `is_container_node` / `is_context_provider`** (`treesitter.rs` lines 244–351): a kind allow-list that works across grammars by both exact match AND substring (`kind.contains("function")`, `"class"`, `"method"`, `"heading"`). This is how it stays language-invariant without per-language config — copy this pattern.
- **`merge_small_spans`** (lines 81–144): TARGET=120, MAX=200 lines; merges adjacent non-container spans up to MAX, never merges across container (class/impl) boundaries. This is the greedy-merge half of cAST. Its tests `merges_small_adjacent_functions_into_single_chunk`, `does_not_merge_across_class_boundaries`, `splits_large_impl_block_by_methods` are exactly the behaviors to replicate in our test suite.
- **Context headers**: `extract_file_context` (imports/use/package, capped at `MAX_CONTEXT_LINES=10`) + `extract_parent_context` (`// Context: class Foo`) + `// File:` prefix. Adopt, but put them in *embed-text only*.
- **UTF-8-safe truncation** at `MAX_SNIPPET_CHARS=8192` with char-boundary checks (`build_chunk`, and tests with emoji/Chinese). Replicate — JS `String.slice` is UTF-16, so guard against splitting a surrogate pair / count tokens not chars when truncating for the embedder.
- **Deterministic output** (test `chunk_file_deterministic_with_pooling`): same input → same chunks → same hashes. Required for our content-addressed incremental reindex.

What to change (deviate from the reference, follow cAST instead):
- **Size metric: non-whitespace characters, not lines** (cAST §line 117). The reference uses line counts (120/200); the paper argues chars are better. Use chars.
- **Chunk ID: content-addressed hash, not `Uuid::new_v4()`** (incremental dedup requirement, §5).
- **Use `web-tree-sitter` (WASM)**, not native `tree-sitter` Rust crates.

---

## 7. Recommended chunker — pseudocode (Effect-shaped)

```ts
// Contract: deterministic, lossless-spans, char-budgeted, AST-first with heuristic fallback.
// Effect services: Grammars (lazy Language.load cache), Chunker.

const TARGET = 1200   // non-whitespace chars, greedy-merge target
const MAX    = 1600   // non-whitespace chars, hard split threshold
const MIN     = 80    // below this, always merge forward
const EMBED_TOKEN_CAP = 8000  // safety margin under 8191

// size = non-whitespace char count
const sizeOf = (text: string) => text.replace(/\s/g, "").length

// Effect.fn that owns the Tree's lifecycle with acquireRelease so it's always freed.
chunkFile = Effect.fn("chunkFile")(function* (path, source) {
  if (source.trim() === "") return []
  const lang = detectLanguage(path)                 // ext → grammar id | null

  // No grammar OR parse error → heuristic fallback (never throws away the file)
  const tree = lang
    ? yield* Grammars.parse(lang, source)           // acquireRelease: parse → finally tree.delete()
    : null
  if (!tree || tree.rootNode.hasError /* and is mostly error */) {
    return heuristicChunks(path, source, lang)       // brace/blank-line/indent splitter
  }

  const fileHeader = extractFileContext(tree.rootNode, source)  // imports/package, <=10 lines
  const spans: Span[] = []
  collectSemanticSpans(tree.rootNode, source, /*parentSymbol*/ "", spans)  // recurse, cAST-style
  const merged = greedyMerge(spans)                  // Algorithm 1 ChunkNodes, budget by sizeOf

  return merged.map((s) => {
    const raw = source.slice(s.startByte, s.endByte) // lossless span (STORED text)
    const header =
      `// ${rel(path)}\n` +
      (s.symbolChain ? `// ${s.kind} ${s.symbolChain}\n` : "") +
      (fileHeader ? fileHeader + "\n" : "")
    const embedText = clampTokens(header + raw, EMBED_TOKEN_CAP) // EMBEDDED text
    return {
      id: hash(`${rel(path)}|${s.symbolChain}|${raw}`),  // content-addressed → stable
      path: rel(path), language: lang ?? "plain",
      startLine: s.startLine, endLine: s.endLine,
      startByte: s.startByte, endByte: s.endByte,
      kind: s.kind, symbol: s.symbolChain,
      rawText: raw, embedText,
      contentHash: hash(raw),
    }
  })
})

// collectSemanticSpans: for each named child,
//   if isSemanticNode(kind): record span {startByte,endByte,kind,symbol}; if isContainer, recurse INTO it
//   else recurse THROUGH it (descend without recording) — same shape as the Rust reference.

// greedyMerge (cAST Algorithm 1): walk sibling spans in order;
//   accumulate into current chunk while sizeOf(current)+sizeOf(span) <= MAX;
//   if a single span alone > MAX and has children → recurse split by its children;
//   never merge across a container boundary; flush on overflow.
```

Incremental reindex driver (live watch):

```ts
onFileChange = Effect.fn("reindex")(function* (path) {
  const source = yield* readFile(path)
  const fh = hash(source)
  if (fh === yield* Index.fileHash(path)) return        // file-level skip
  const next = yield* chunkFile(path, source)
  const prev = yield* Index.chunksFor(path)             // [{id, contentHash}]
  const prevIds = new Set(prev.map(c => c.id))
  const nextIds = new Set(next.map(c => c.id))
  const toUpsert = next.filter(c => !prevIds.has(c.id)) // new/changed chunks only → embed
  const toDelete = prev.filter(c => !nextIds.has(c.id))
  yield* Embeddings.embedAndUpsert(toUpsert)            // only these hit OpenAI
  yield* Index.delete(toDelete.map(c => c.id))
  yield* Index.setFileHash(path, fh)
})
```

---

## 8. Final decisions (locked)

1. **Structure-aware (AST) chunking is the primary strategy.** Evidence: cAST +1.8–4.3 Recall / +1.2–3.3 Precision retrieval, +2.5–5.5 generation, consistently. Fixed-size is a fallback, never the product.
2. **Implement cAST's split-then-merge (Algorithm 1) exactly**, budgeting by **non-whitespace characters**.
3. **Sizes:** target ~1200, hard max ~1600 non-ws chars; min ~80 (merge forward); **no overlap**; embed-text token cap ~8000 (under the 8191 limit).
4. **Use `web-tree-sitter` (WASM) now**, with lazy per-language `.wasm` loading and `acquireRelease` for `Tree.delete()`. Do NOT use native `tree-sitter` (38 MB/grammar, node-gyp, ABI fragility). Do NOT defer tree-sitter to a later phase.
5. **Heuristic brace/blank-line/indent splitter is the fallback** for unknown languages and parse failures (mirror the Rust reference's `chunk_fallback`).
6. **Prepend a compact context header** (`// path` + `// kind SymbolChain` + imports, ≤3 lines) to **embed/BM25 text only**; keep the raw span for display and line jumps.
7. **Content-addressed chunk IDs** = `hash(path + symbolChain + rawText)`, not UUIDs and not line ranges → stable boundaries → cheap incremental reindex (embed only changed chunks). AST boundaries are inherently shift-stable, reinforcing this.
8. **Metadata per chunk:** path, language, startLine/endLine, startByte/endByte, kind, symbol, contentHash, fileHash. Mirror the Rust `CodeChunk` struct + bytes + kind/symbol.
9. **Markdown/docs:** chunk by heading section via `tree-sitter-md`; keep fenced code blocks intact.
10. **Huge files:** exclude at ignore layer; size-gate >1 MB to heuristic splitter; cap chunks/file (~2000).

---

## Sources

- cAST paper (primary): https://arxiv.org/html/2506.15655v1 · https://aclanthology.org/2025.findings-emnlp.430 · https://www.cs.cmu.edu/~sherryw/assets/pubs/2025-cast.pdf
- web-tree-sitter README (API): https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md ; npm `web-tree-sitter@0.26.9` (4.56 MB unpacked, verified `npm view`)
- native tree-sitter sizing: `npm view tree-sitter@0.25.0`, `tree-sitter-typescript@0.23.2` (38.8 MB unpacked, verified)
- OpenAI text-embedding-3-large limits (8191 tokens, 3072 dims, Matryoshka 256/1024): https://zilliz.com/ai-models/text-embedding-3-large ; OpenAI dev forum threads
- Corroborating: https://knowledgesdk.com/blog/ast-aware-chunking-code-rag · https://dasroot.net/posts/2026/04/using-ast-parsing-improve-code-retrieval
- Reference Rust impl (read-only): <reference-chunker>/{mod.rs,treesitter.rs,language.rs,parser_pool.rs}

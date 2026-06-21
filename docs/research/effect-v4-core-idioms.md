# Effect v4 (smol) — Core Idioms Cheatsheet

Grounding brief for the semantic-search CLI + Pi agent extension. Every API below
is verified against vendored source and primary docs. v4 ("smol") differs
materially from v3; every v3→v4 delta is flagged inline.

## Sources

- Vendored source: `<effect-source>`
  - `LLMS.md`, `ai-docs/src/01_effect/**`, `ai-docs/src/02_stream/**`, `ai-docs/src/06_schedule/**`
  - `packages/effect/src/{Context,Config,Layer,Effect,Schema,Stream,Schedule,Ref,SynchronizedRef,Queue,FileSystem,Path,Data}.ts`
  - `packages/platform-node/src/{NodeServices,NodeFileSystem,NodePath,NodeStream,NodeRuntime}.ts`
- Vendored `package.json` version: **`4.0.0-beta.66`** (HEAD dated 2026-05-29).
- Migration primary source: `https://raw.githubusercontent.com/Effect-TS/effect-smol/main/MIGRATION.md` and `migration/{services,error-handling,forking,scope,v3-to-v4}.md`.
- Naming-timeline note: `https://effect.website/blog/this-week-in-effect/2026/04/10/` and `https://effect.website/blog/effect-v4beta-launch-to-may-recap/`.

## CRITICAL version / naming note (resolve before building)

The project targets **beta.85**; the vendored repo is **beta.66**. During the beta the
service module was renamed `Context` → `ServiceMap` → **renamed back to `Context`**
(blog "This Week in Effect 2026-04-10": *"ServiceMap renamed back to Context, realigning
with v3 naming conventions"*; confirmed in the Feb–May recap). The vendored beta.66 source
already uses the **final** name `Context`, which is what beta.85 ships. **Decision: use
`Context.Service` / `Context.Reference` / `Context.Key`. Do NOT use `ServiceMap.*`** — that
name existed only transiently. If a `ServiceMap` symbol appears in beta.85, it is an alias;
prefer `Context`. Verify with one `grep -r "export const Service" node_modules/effect/dist/dts/Context.d.ts` at project setup.

A v3-trained model will reach for `Context.Tag`, `Context.GenericTag`, `Effect.Tag`,
`Effect.Service`, `Either`, `Layer.scoped`, `Effect.catchAll`, `Effect.fork`. **All of these
are wrong in v4.** See the delta table at the end.

---

## 1. Effect bodies: `Effect.gen` and `Effect.fn`

Rule (from `LLMS.md`): write effectful code with `Effect.gen`; for any **function that
returns an Effect**, use `Effect.fn("name")` — do **not** write `(x) => Effect.gen(...)`.
`Effect.fn` improves stack traces and attaches a tracing span (`Effect.withSpan`).
Additional combinators are passed as **trailing arguments** to `Effect.fn`, NOT via `.pipe`.

```ts
import { Effect } from "effect"

// gen block
const program = Effect.gen(function*() {
  yield* Effect.log("start")
  return 42
})

// function returning Effect — note trailing combinators, no .pipe
export const enrich = Effect.fn("enrich")(
  function*(id: string): Effect.fn.Return<string, MyError> {
    yield* Effect.sleep("5 millis")
    return id.toUpperCase()
  },
  Effect.catch((e) => Effect.logError(`failed: ${e}`)),
  Effect.annotateLogs({ method: "enrich" })
)

// untraced variant (no span) when you do not want a span per call
export const fast = Effect.fnUntraced(function*(n: number) { return n + 1 })
```

- `Effect.fn.Return<A, E, R>` annotates the generator return type.
- Always `return yield* new SomeError({...})` when raising, so TS narrows control flow.
- v3→v4: `Effect.fn` semantics unchanged; `Effect.fnUntraced` is available.

---

## 2. Services: `Context.Service` (NOT `Context.Tag` / `Effect.Service`)

Verified `packages/effect/src/Context.ts:128` (`export const Service`), `:69` (`interface Service`),
`:44` (`interface Key`), `:1022` (`Reference`).

Class form (the default — use this for all services):

```ts
// file: src/index/Indexer.ts
import { Context, Effect, Layer, Schema } from "effect"

export class Indexer extends Context.Service<Indexer, {
  // method returning Effect — declare the full Effect signature
  index(path: string): Effect.Effect<void, IndexError>
  readonly count: Effect.Effect<number>
}>()(
  // identifier string: include package + path. Note argument order:
  //   v4: Context.Service<Self, Shape>()(id)   <-- types first, then ()(id)
  //   v3: Context.Tag(id)<Self, Shape>()       <-- id first (DO NOT USE)
  "semantic-search/index/Indexer"
) {
  static readonly layer = Layer.effect(
    Indexer,
    Effect.gen(function*() {
      const index = Effect.fn("Indexer.index")(function*(path: string) {
        yield* Effect.log(`indexing ${path}`)
      })
      // Build the instance with Indexer.of (preserves the exact Shape type)
      return Indexer.of({ index, count: Effect.succeed(0) })
    })
  )
}

export class IndexError extends Schema.TaggedErrorClass<IndexError>()("IndexError", {
  cause: Schema.Defect
}) {}

// Access the Shape type if needed:  type S = Indexer["Service"]
```

Key facts (from source):
- `Context.Service<Self, Shape>()(id, options?)` returns a `ServiceClass`. The class **is**
  the tag: `yield* Indexer` yields the `Shape` (it `extends Effect<Shape, never, Identifier>`).
- `Indexer.of(impl)` — identity helper that pins the impl to `Shape`.
- `Indexer.use(f)` / `Indexer.useSync(f)` — run a callback against the resolved service without
  a separate `yield*` (replaces v3 `Effect.Tag` accessors, which are removed).
- Function form for a bare tag (no class): `const Db = Context.Service<DbShape>("Db")`.
- **`make` option**: `Context.Service<Self, Shape>()(id, { make: <Effect|fn> })` attaches a
  `.make` builder used by tooling; you still typically expose a hand-written `static layer`.

### Reference (config/default-valued service) — replaces v3 `FiberRef`

`packages/effect/src/Context.ts:1022`. Use for feature flags / defaults that need no layer.

```ts
import { Context } from "effect"
export const ConcurrencyLimit = Context.Reference<number>(
  "semantic-search/ConcurrencyLimit",
  { defaultValue: () => 8 }
)
// read with: const n = yield* ConcurrencyLimit
// override with: Effect.provideService(ConcurrencyLimit, 16) — no Layer required
```

---

## 3. Layer construction & composition

Verified `packages/effect/src/Layer.ts`: `effect:788`, `sync:719`, `succeed:633`,
`effectDiscard:865`, `unwrap:920`, `mergeAll:975`, `merge:1014`, `provide:1133`,
`provideMerge:1237`, `launch:1819`.

- **`Layer.effect(Tag, effect)`** — primary constructor. The effect runs in the layer's scope,
  so a `Scope` requirement is **stripped** (`Exclude<R, Scope>`). **This is v4's `Layer.scoped`.**
  Source comment at `Layer.ts:766`: *"This API replaces ... `Layer.scoped`"*. **There is no
  separate `Layer.scoped` export in v4** — `Layer.effect` handles scoped acquisition (e.g.
  `Effect.acquireRelease` inside it works and is cleaned up on layer teardown).
- **`Layer.sync(Tag, () => impl)`** / **`Layer.succeed(Tag, impl)`** — pure construction.
- **`Layer.effectDiscard(effect)`** — run a background/startup effect, provide no service
  (`Layer<never, E, Exclude<R, Scope>>`). Use with `Effect.forkScoped` for daemons.
- **`Layer.provide(self, dep)`** — satisfy `self`'s requirements with `dep`; `dep`'s output is
  **hidden** (not re-exported).
- **`Layer.provideMerge(self, dep)`** — same, but `dep`'s output **is** re-exported alongside `self`.
- **`Layer.mergeAll(a, b, c, ...)`** — combine independent layers, union their outputs.
- **`Layer.unwrap(effectReturningLayer)`** — build a layer dynamically from an Effect/Config
  (e.g. choose in-memory vs remote based on `Config.boolean`). Replaces v3 `Layer.unwrapEffect`.
- **`Layer.launch(layer)`** — turn a layer into a never-ending `Effect` for the app entrypoint.

```ts
import { Config, Effect, Layer } from "effect"

class Embedder extends Context.Service<Embedder, {
  embed(texts: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError>
}>()("semantic-search/Embedder") {
  static readonly layerNoDeps = Layer.effect(Embedder, Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient            // a dependency
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    // ... build instance
    return Embedder.of({ embed: /* ... */ })
  }))
  // hide HttpClient, expose only Embedder
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer))
}

// App composition root:
const AppLayer = Layer.mergeAll(Embedder.layer, Indexer.layer, NodeServices.layer)
```

---

## 4. Config — env vars, redacted secrets, defaults

Verified `packages/effect/src/Config.ts`. In v4, primitive readers are **functions** (not
`export const`), each a thin shortcut over `Config.schema(<Schema>, name)`:

- `Config.string(name)` `:879` · `Config.nonEmptyString(name)` `:894`
- `Config.number(name)` `:909` · `Config.int(name)` `:939` · `Config.finite(name)` `:924`
- `Config.boolean(name)` `:1017` (accepts `true/yes/on/1/y` and `false/no/off/0/n`)
- `Config.duration(name)` `:1055` (parses `"10 seconds"`) · `Config.port(name)` `:1089`
- `Config.url(name)` `:1209` · `Config.date(name)` `:1235` · `Config.logLevel(name)` `:1126`
- `Config.literal(l, name)` `:959` · `Config.literals([...], name)` `:979`
- **`Config.redacted(name)`** `:1161` → `Config<Redacted<string>>`. Read the secret with
  `Redacted.value(secret)` only at the point of use; it is hidden in logs/`toString`.
- `Config.schema(codec, path?)` `:675` — read any value via a `Schema.Codec` (use for typed
  enums, custom shapes, `Schema.Record(...)` maps).

Combinators: `Config.withDefault(self, value)` `:425`, `Config.option(self)` `:466`
(→ `Config<Option<A>>`), `Config.map`/`mapOrFail`, `Config.orElse`, `Config.all({...})` `:347`
(group into a record/tuple), `Config.nested(self, prefix)` `:1290`, `Config.unwrap(wrapped)` `:527`.

```ts
import { Config, Effect, Redacted } from "effect"

const Settings = Effect.gen(function*() {
  const apiKey   = yield* Config.redacted("OPENAI_API_KEY")          // Redacted<string>
  const tpUrl    = yield* Config.url("TURBOPUFFER_URL")
  const tpKey    = yield* Config.redacted("TURBOPUFFER_API_KEY")
  const batch    = yield* Config.int("EMBED_BATCH").pipe(Config.withDefault(96))
  const model    = yield* Config.string("EMBED_MODEL").pipe(
    Config.withDefault("text-embedding-3-large")
  )
  return { apiKey, tpUrl, tpKey, batch, model } as const
})

// use the secret:  Redacted.value(apiKey)
```

v3→v4 deltas: `Config.array`/`Config.hashMap`/`Config.set` are replaced by `Config.schema`
with `Schema.Array`/`Config.Record`. `Config.secret` → `Config.redacted`. The error type is
`Config.ConfigError`. `ConfigProvider.fromEnv({ env })` is used for tests.

---

## 5. Scope, acquireRelease, addFinalizer

Verified `packages/effect/src/Effect.ts`: `acquireRelease:6182`, `acquireUseRelease:6300`,
`addFinalizer:6347`, `scoped:6083`.

```ts
export const acquireRelease: <A, E, R, R2>(
  acquire: Effect<A, E, R>,
  release: (a: A, exit: Exit.Exit<unknown, unknown>) => Effect<unknown, never, R2>,
  options?: { readonly interruptible?: boolean }
) => Effect<A, E, R | R2 | Scope>

export const addFinalizer: <R>(
  finalizer: (exit: Exit.Exit<unknown, unknown>) => Effect<void, never, R>
) => Effect<void, never, R | Scope>
```

- `Effect.acquireRelease(acquire, release)` adds a `Scope` requirement; the release runs with
  the resource **and** the `Exit`. Put it inside `Layer.effect` and teardown is automatic when
  the layer closes (e.g. a TurboPuffer HTTP pool, an fs watcher, a Queue).
- `Effect.addFinalizer((exit) => ...)` — register a finalizer without an acquired value.
- `Effect.scoped(effect)` discharges the `Scope` locally (opens, runs, closes immediately).
- `Effect.acquireUseRelease(acquire, use, release)` — bracket form, no `Scope` in the type.
- v4 also supports JS disposables: `Effect.scoped` honors `Symbol.dispose`/`Symbol.asyncDispose`.

```ts
import { Context, Effect, Layer } from "effect"

class Watcher extends Context.Service<Watcher, {
  readonly changes: Stream.Stream<string>
}>()("semantic-search/Watcher") {
  static readonly layer = Layer.effect(Watcher, Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    // resource cleaned up on layer teardown:
    const handle = yield* Effect.acquireRelease(
      Effect.sync(() => openNativeWatcher()),
      (h) => Effect.sync(() => h.close())
    )
    return Watcher.of({ changes: fs.watch("./") .pipe(Stream.map((e) => e.path)) })
  }))
}
```

v3→v4: `Scope.extend` → **`Scope.provide`** (`migration/scope.md`). `Scope.make()` unchanged.

---

## 6. Errors: tagged errors + Schema-decoded boundaries

Two ways to define tagged errors. **Prefer `Schema.TaggedErrorClass` for v4** (per `LLMS.md`),
because the error is also a `Schema` (decode/encode across process/IPC boundaries) and is
yieldable.

Verified `packages/effect/src/Schema.ts`: `TaggedErrorClass:10842`, `ErrorClass:10788`,
`TaggedClass:10730`, `Class:10675`. And `packages/effect/src/Data.ts`: `TaggedError:763`.

```ts
import { Schema } from "effect"

// Schema-backed tagged error (preferred). Adds a `_tag: "EmbedError"` literal field.
export class EmbedError extends Schema.TaggedErrorClass<EmbedError>()("EmbedError", {
  status: Schema.Number,
  message: Schema.String,
  retryable: Schema.Boolean
}) {}

// raise:  return yield* new EmbedError({ status: 503, message: "...", retryable: true })
```

Plain (non-schema) tagged error via `Data` — lighter, no codec, fine for purely internal errors:

```ts
import { Data } from "effect"
class ParseError extends Data.TaggedError("ParseError")<{ readonly input: string }> {}
```

Handling (note v4 catch renames):

```ts
import { Effect } from "effect"

eff.pipe(
  Effect.catchTag("EmbedError", (e) => Effect.succeed(/* fallback */)),
  Effect.catchTags({ ParseError: (_) => Effect.succeed(...) }),
  Effect.catch((_e) => Effect.succeed(...))   // v3 Effect.catchAll -> v4 Effect.catch
)
```

Schema-decoded boundary (decode untyped external JSON into a typed value; failure → `SchemaError`):

Verified `Schema.ts`: `decodeUnknownEffect:1144`, `decodeEffect:1160`, `Struct:2485`,
`Class:10675`.

```ts
import { Effect, Schema } from "effect"

const SearchHit = Schema.Struct({
  id: Schema.String,
  score: Schema.Number,
  text: Schema.String
})
// or a class:  class SearchHit extends Schema.Class<SearchHit>("SearchHit")({ ... }) {}

const decodeHits = Schema.decodeUnknownEffect(Schema.Array(SearchHit))
//  (input: unknown, opts?) => Effect<ReadonlyArray<SearchHit>, SchemaError, never>

export const parseResponse = Effect.fn("parseResponse")(function*(raw: unknown) {
  const hits = yield* decodeHits(raw)   // fails with SchemaError on bad shape
  return hits
})
```

- `Schema.decodeUnknownEffect(schema)(input)` → `Effect<Type, SchemaError, DecodingServices>`.
  Use this for `unknown` (e.g. `JSON.parse` output / HTTP body).
- `Schema.decodeEffect(schema)(input)` when `input` is already typed as `Encoded`.
- Sync variants: `Schema.decodeUnknownSync`, `Schema.decodeUnknownExit`.
- `Schema.encodeEffect(schema)(value)` for the reverse direction.
- The error channel is `Schema.SchemaError` (wraps the underlying issue).

v3→v4 error deltas: `Effect.catchAll`→`Effect.catch`, `catchAllCause`→`catchCause`,
`catchAllDefect`→`catchDefect`, `catchSome`→`catchFilter` (uses `Filter` module, not `Option`),
`catchSomeCause`→`catchCauseFilter`. `catchTag`/`catchTags`/`catchIf` unchanged.

### Reason errors (optional, nice for one error with many causes)

`Effect.catchReason("ParentTag", "ReasonTag", handler, catchAll?)`,
`Effect.catchReasons("ParentTag", { ReasonTag: handler, ... })`,
`Effect.unwrapReason("ParentTag")` to lift `reason` into the error channel. Define with a
`reason: Schema.Union([...])` field. See `ai-docs/src/01_effect/03_errors/20_reason-errors.ts`.

---

## 7. Stream — walking files, batching, concurrency

Verified `packages/effect/src/Stream.ts`: `mapEffect:1943`, `flatMap:2346`, `chunks:6566`,
`rechunk:6597`, `grouped:7686`, `groupedWithin:7717`, `buffer:4553`, `throttle:7626`,
run-ops from `ai-docs/src/02_stream/20_consuming-streams.ts`.

Constructors (from `ai-docs/src/02_stream/10_creating-streams.ts`):
`Stream.fromIterable`, `Stream.make(...)`, `Stream.range(lo, hi)`, `Stream.fromEffectSchedule`,
`Stream.paginate(seed, fn)`, `Stream.fromAsyncIterable(it, onError)`, `Stream.callback(fn)`,
`Stream.fromEventListener`, `NodeStream.fromReadable({ evaluate, onError, closeOnDone })`.

Key signatures:

```ts
// effectful per-element map with bounded concurrency
export const mapEffect: <A, E, R, A2, E2, R2>(
  self: Stream<A, E, R>,
  f: (a: A, i: number) => Effect.Effect<A2, E2, R2>,
  options?: { readonly concurrency?: number | "unbounded"; readonly unordered?: boolean }
) => Stream<A2, E | E2, R | R2>

// batch into fixed-size NonEmpty arrays
export const grouped: <A,E,R>(self: Stream<A,E,R>, n: number) => Stream<NonEmptyReadonlyArray<A>, E, R>

// batch by size OR time window (whichever first) — ideal for embedding batches
export const groupedWithin: <A,E,R>(
  self: Stream<A,E,R>, chunkSize: number, duration: Duration.Input
) => Stream<Array<A>, E, R>
```

Embedding/indexing pipeline (the core shape for this project):

```ts
import { Effect, Stream } from "effect"

const indexAll = (paths: ReadonlyArray<string>) =>
  Stream.fromIterable(paths).pipe(
    // read + AST-chunk each file, concurrently, ordered output not required
    Stream.mapEffect(readAndChunk, { concurrency: 8, unordered: true }),
    Stream.flatMap((chunks) => Stream.fromIterable(chunks)), // flatten chunks
    // batch chunks for the embedding API: 96 chunks OR every 2s
    Stream.groupedWithin(96, "2 seconds"),
    // call OpenAI per batch, up to 4 batches in flight
    Stream.mapEffect((batch) => embedAndUpsert(batch), { concurrency: 4 }),
    Stream.runDrain                                          // execute for effects
  )
```

Run operators: `Stream.runDrain`, `Stream.runCollect`, `Stream.runForEach`, `Stream.runFold`,
`Stream.runHead`/`runLast`, `Stream.run(sink)`. Backpressure helpers: `Stream.buffer({capacity})`,
`Stream.throttle`. `Stream.groupBy(classifier)` → keyed substreams.

v3→v4: import is `effect/Stream` (top-level barrel `effect`). `NodeStream` is from
`@effect/platform-node`. Semantics largely match v3; `mapEffect` gains `unordered`.

---

## 8. Schedule — retry/backoff

Verified `packages/effect/src/Schedule.ts`: `exponential:1962`, `spaced:2607`, `recurs:2404`,
`fixed:2116`, `jittered:2301`, `addDelay:638`, `both:882`, `either:1678`, `while`,
`setInputType:3244`, `tapInput:2736`, `tapOutput:2840`, `forever:3183`.
Patterns from `ai-docs/src/06_schedule/10_schedules.ts`.

```ts
import { Schedule } from "effect"

export const exponential = (base: Duration.Input, factor?: number) => Schedule<Duration>
export const spaced = (duration: Duration.Input) => Schedule<number>
export const recurs = (times: number) => Schedule<number>
```

Production retry: capped exponential + jitter + attempt cap + retry-only-when-retryable:

```ts
import { Effect, Schedule } from "effect"

const retry = Schedule.exponential("250 millis").pipe(
  Schedule.either(Schedule.spaced("10 seconds")),    // cap delay at 10s
  Schedule.jittered,                                  // add jitter
  Schedule.setInputType<EmbedError>(),                // declare the error fed in
  Schedule.while(({ input }) => input.retryable)      // stop on non-retryable
)

const embedWithRetry = callEmbedApi(batch).pipe(Effect.retry(retry), Effect.orDie)

// inline builder form that infers the error/input type:
callEmbedApi(batch).pipe(
  Effect.retry(($) => $(Schedule.exponential("250 millis")).pipe(
    Schedule.while(({ input }) => input.retryable)
  ))
)
```

Combinators: `Schedule.both(a,b)` (AND — continue while both continue, good for "backoff AND
attempt cap"), `Schedule.either(a,b)` (OR), `Schedule.while`/`Schedule.recurUntil`,
`Schedule.addDelay`, `Schedule.tapInput`/`tapOutput` (logging/metrics per attempt). Use with
`Effect.retry(schedule)` and `Effect.repeat(schedule)`.

v3→v4: API shape stable. `Schedule.setInputType<E>()` is the v4 way to fix the input type so
`Schedule.while` can inspect the error. `Schedule.jittered` unchanged.

---

## 9. State & backpressure — Ref / SynchronizedRef / Queue

Verified `Ref.ts` (`make:174`, `get:193`, `set:221`, `update:530`, `modify:426`,
`updateAndGet:561`), `SynchronizedRef.ts` (`make:49`, `get:61`, `modify:147`,
`modifyEffect:160`, `update:256`, `updateEffect:269`, `set:230`), `Queue.ts`
(`make:336`, `bounded:383`, `unbounded:483`, `sliding:415`, `dropping:448`, `offer:513`,
`offerAll:611`, `take:1197`, `takeAll:1028`, `takeBetween:1150`, `shutdown:938`).

```ts
import { Effect, Queue, Ref, SynchronizedRef } from "effect"

// plain mutable cell (sync updates)
const r = yield* Ref.make(0)
yield* Ref.update(r, (n) => n + 1)
const v = yield* Ref.get(r)

// SynchronizedRef: serialize *effectful* updates (e.g. refresh a TurboPuffer schema)
const sref = yield* SynchronizedRef.make(initialState)
yield* SynchronizedRef.updateEffect(sref, (s) => refreshEffect(s))
//   modifyEffect: f: (a) => Effect<readonly [B, A], E, R>  → Effect<B, E, R>

// Queue for backpressure between the watcher (producer) and indexer (consumer)
const q = yield* Queue.bounded<string>(1024)   // bounded = producer blocks when full
yield* Queue.offer(q, path)                     // Effect<boolean>
const next = yield* Queue.take(q)               // Effect<A, E>  (blocks until available)
const batch = yield* Queue.takeBetween(q, 1, 96) // drain 1..96 for batched embedding
```

- `Queue.bounded(n)` gives backpressure (producers suspend when full). `Queue.sliding`/`dropping`
  drop instead of blocking. `Queue.unbounded` never blocks (watch for memory).
- `Queue.takeBetween(q, min, max)` / `Queue.takeAll(q)` are the batching primitives if you
  drive batching off a Queue instead of `Stream.groupedWithin`.
- Unsafe (sync, no Effect) variants exist: `Queue.offerUnsafe` (used inside `Stream.callback`).
- v3→v4: `Ref`/`Queue` shapes match v3. Transactional refs renamed: `TRef`→`TxRef`, `TQueue`→
  `TxQueue`, etc. (`migration/v3-to-v4.md`). Use `SubscriptionRef`/`TxSubscriptionRef` for
  observable state.

---

## 10. Platform: FileSystem & Path (now in core `effect`, not `@effect/platform`)

Verified: `effect/FileSystem` `FileSystem.ts:714` (`Context.Service("effect/platform/FileSystem")`),
`effect/Path` `Path.ts:194` (`Context.Service("effect/Path")`), node layers
`platform-node/src/NodeFileSystem.ts:12`, `NodePath.ts:12`, combined `NodeServices.ts:26`.

**v3→v4 import change:** `@effect/platform/FileSystem` → **`effect/FileSystem`**;
`@effect/platform/Path` → **`effect/Path`**; `@effect/platform/Error` → **`effect/PlatformError`**
(`migration/v3-to-v4.md`). The service *values* are named `FileSystem.FileSystem` and `Path.Path`.

```ts
import { FileSystem, Path } from "effect"          // <-- core barrel now
import { Effect, Stream } from "effect"

const walk = Effect.fn("walk")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(root)     // Effect<ReadonlyArray<string>, PlatformError>
  for (const name of entries) {
    const full = path.join(root, name)              // sync string
    const stat = yield* fs.stat(full)
    if (stat.type === "Directory") { /* recurse */ }
    else { const text = yield* fs.readFileString(full) }
  }
})

// live file watching → Stream
const watchChanges = Effect.fn("watchChanges")(function*(dir: string) {
  const fs = yield* FileSystem.FileSystem
  return fs.watch(dir)   // Stream.Stream<WatchEvent, PlatformError>  (Path.ts/FileSystem.ts:344)
})
```

FileSystem methods (from `FileSystem.ts`): `exists`, `makeDirectory({recursive})`,
`readDirectory`, `readFile`→`Uint8Array`, `readFileString`, `writeFile`, `writeFileString`,
`stat`→`{type,size,...}`, **`watch(path) → Stream<WatchEvent, PlatformError>`**.
Path methods: `join`, `dirname`, `basename(p, suffix?)`, `extname`, `relative`, `resolve` (all
sync, return `string`).

**Provide platform services once at the root:**

```ts
import { NodeServices, NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"

const Main = AppLayer.pipe(Layer.provide(NodeServices.layer))  // FileSystem+Path+Stdio+Terminal+ChildProcessSpawner
NodeRuntime.runMain(Layer.launch(Main))
// Or provide just what you need: Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
```

---

## 11. Entry point — `NodeRuntime.runMain` / `Layer.launch`

From `ai-docs/src/01_effect/05_running/10_run-main.ts`:

```ts
import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"

const program = Layer.launch(AppLayer)   // long-running app
NodeRuntime.runMain(program, { disableErrorReporting: true })
// installs SIGINT/SIGTERM handlers, interrupts fibers for graceful shutdown.
// Bun: BunRuntime.runMain(program) from @effect/platform-bun
```

For a CLI, use `effect/unstable/cli` (`Command`, `Flag`, `Argument`, `Prompt`) and run via
`NodeRuntime.runMain` (see `ai-docs/src/70_cli/10_basics.ts`).

---

## 12. Adjacent modules you'll need (verified paths)

- HTTP client (for OpenAI / TurboPuffer / reranker): `effect/unstable/http/HttpClient`
  (`HttpClient`, `HttpClientRequest`, `HttpClientResponse`), node impl `FetchHttpClient.layer`
  (`effect/unstable/http/FetchHttpClient`) or `@effect/platform-node` `NodeHttpClient`.
- Telemetry: `effect/unstable/observability/{Otlp,OtlpTracer,OtlpLogger,OtlpMetrics}`.
- `Either` is **removed/renamed to `Result`** (`effect/Result`). A v3 model will reach for
  `Either` — use `Result`.
- Node stream interop: `@effect/platform-node` `NodeStream.fromReadable({ evaluate, onError, closeOnDone })`.

---

## v3 → v4 delta table (flag these — a v3-trained model gets them wrong)

| Concern | v3 (WRONG in v4) | v4 (correct) |
| --- | --- | --- |
| Service definition | `Context.Tag(id)<Self,Shape>()`, `Context.GenericTag`, `Effect.Tag`, `Effect.Service` | `Context.Service<Self,Shape>()(id)` (only) |
| Service module name | (transient `ServiceMap` mid-beta) | `Context` (renamed back; final) |
| Service accessors | `Service.method(...)` proxy | removed → `Service.use(f)` / `yield* Service` |
| FiberRef | `FiberRef` | `Context.Reference` |
| Scoped layer | `Layer.scoped(tag, eff)` | `Layer.effect(tag, eff)` (strips `Scope`) |
| Dynamic layer | `Layer.unwrapEffect` | `Layer.unwrap` |
| Scope extend | `Scope.extend` | `Scope.provide` |
| Catch all | `Effect.catchAll` | `Effect.catch` |
| Catch all cause | `Effect.catchAllCause` | `Effect.catchCause` |
| Catch all defect | `Effect.catchAllDefect` | `Effect.catchDefect` |
| Catch partial | `Effect.catchSome` (Option) | `Effect.catchFilter` (Filter module) |
| Fork | `Effect.fork` | `Effect.forkChild` |
| Fork daemon | `Effect.forkDaemon` | `Effect.forkDetach` |
| Either | `effect/Either` (`Either`) | `effect/Result` (`Result`) |
| FileSystem import | `@effect/platform/FileSystem` | `effect/FileSystem` (core barrel) |
| Path import | `@effect/platform/Path` | `effect/Path` (core barrel) |
| Platform error | `@effect/platform/Error` | `effect/PlatformError` |
| Config secret | `Config.secret` | `Config.redacted` |
| Config array/map | `Config.array`/`Config.hashMap` | `Config.schema(Schema.Array/Record...)` |
| Tx data structures | `TRef`/`TQueue`/`TMap`/`TSet`... | `TxRef`/`TxQueue`/`TxHashMap`/`TxHashSet`... |
| Tagged error | `Data.TaggedError` only | prefer `Schema.TaggedErrorClass` (still have `Data.TaggedError`) |
| Function-returning-Effect | `(x) => Effect.gen(...)` | `Effect.fn("name")(function*(x){...}, ...combinators)` |
| Unstable modules | `@effect/{cli,rpc,sql,http,ai,cluster}` | `effect/unstable/{cli,rpc,sql,http,ai,cluster}` |
| Versioning | independent `@effect/*` versions | single shared version (`4.0.0-beta.N`) across all packages |

## Gotchas

1. **`Layer.effect` strips `Scope`** — put `acquireRelease` inside it; do NOT look for `Layer.scoped`.
2. **`Context.Service` argument order is reversed from v3** (`<Self,Shape>()(id)`); the most
   common porting mistake.
3. **`Config.redacted` returns `Redacted<string>`** — call `Redacted.value()` only at point of
   use; never log the secret directly.
4. **`Effect.fn` combinators go as trailing args, not `.pipe`** (per `LLMS.md`). `.pipe` is for
   `Effect.gen`/values.
5. **Single shared package version** — `effect@4.0.0-beta.85` must pair with
   `@effect/platform-node@4.0.0-beta.85` etc. Mismatched betas break type identity.
6. **`Schema.decodeUnknownEffect` fails with `SchemaError`**, not your tagged error — map it
   (`Effect.mapError`) at the boundary if you want a domain error.
7. **`Stream.groupedWithin(size, duration)`** is the right batching primitive for embedding
   (size OR time), vs `grouped(n)` which only flushes on size (bad for the tail of a stream).
8. **beta.66 vs beta.85**: signatures here are from beta.66 (final naming). Re-verify
   `Context`/`Layer.effect`/`Config.redacted` against installed `node_modules/effect` at setup
   in case beta.67–85 moved anything; the rename-back to `Context` is the only large naming
   event and it already matches this brief.

# Effect v4 CLI Module (`effect/unstable/cli`) — Grounding Brief

Status: grounded against vendored Effect v4 ("smol") source at
`/Users/dallen.pyrah/projects/rika-labs/effect-desktop/repos/effect-smol`.
All signatures and snippets below are quoted/derived from real source, not memory.

## TL;DR decisions

1. Import everything from the single barrel `effect/unstable/cli`:
   `import { Argument, Command, Flag } from "effect/unstable/cli"`. Platform glue
   (`NodeRuntime`, `NodeServices`) comes from `@effect/platform-node`.
2. Build the CLI as a tree of `Command.make(...)` nodes, compose with
   `Command.withSubcommands([...])`, attach cross-cutting flags with
   `Command.withSharedFlags({...})`, and run the root with
   `Command.run(root, { version })` (reads argv from the `Stdio` service) →
   `Effect.provide(NodeServices.layer)` → `NodeRuntime.runMain`.
3. A subcommand handler is just an `Effect`; it reads its own parsed config from
   the handler argument, reads parent shared flags by `yield* parentCommand`
   (a `Command` is itself an `Effect` yielding its `ContextInput`), and reads
   app services via normal `yield* Service`.
4. Provide app services per-command with `Command.provide(layerOrFn, { local? })`
   (and `provideEffect` / `provideSync` variants), or globally by
   `Effect.provide(appLayer)` on the run pipeline alongside `NodeServices.layer`.
5. `--help`, `--version`, `--log-level`, and `--completions` are built-in global
   flags; you never define them. Help/version printing and exit codes are
   handled by the runner via `CliError` classes carrying `Runtime.errorExitCode`.
6. JSON vs human output is your concern: read a `--json` boolean flag and branch
   on `Console.log(JSON.stringify(payload, null, 2))` vs human text. There is no
   built-in formatter for handler output.

---

## 1. Module layout & import path

`effect/unstable/cli` is the barrel (`packages/effect/src/unstable/cli/index.ts`).
Public submodules: `Argument`, `Command`, `Flag`, `GlobalFlag`, `CliError`,
`CliOutput`, `Completions`, `HelpDoc`, `Prompt`. `Param` and `Primitive` are
internal/advanced (Param is the shared polymorphic impl behind Argument & Flag).

```ts
import { Argument, Command, Flag } from "effect/unstable/cli"
// optional: GlobalFlag, CliError, HelpDoc, Prompt — same path
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
```

---

## 2. Defining commands — `Command.make`

Source: `packages/effect/src/unstable/cli/Command.ts:451`.

```ts
export const make: {
  <Name extends string>(name: Name): Command<Name, {}, {}, never, never>
  <Name extends string, const Config extends Command.Config>(
    name: Name,
    config: Config
  ): Command<Name, Command.Config.Infer<Config>, {}, never, never>
  <Name extends string, const Config extends Command.Config, R, E>(
    name: Name,
    config: Config,
    handler: (config: Command.Config.Infer<Config>) => Effect.Effect<void, E, R>
  ): Command<Name, Command.Config.Infer<Config>, {}, E, Exclude<R, GlobalFlag.BuiltInSettingContext>>
}
```

- `config` is a record (`Command.Config`) whose values are `Flag`/`Argument` (or
  nested records of them — see `deploy.database` in the fixture). The handler
  receives the inferred typed object.
- Handler return must be `Effect<void, E, R>`. Errors `E` and requirements `R`
  flow into the `Command` type and must be discharged before `run`.
- A command with **no handler** prints help when invoked with no subcommand
  (fixture `mycli` root has no handler on purpose).

The `Command` type is itself an `Effect`:
`Command.ts:79`
```ts
export interface Command<in out Name extends string, in Input, out ContextInput = {}, out E = never, out R = never>
  extends Effect.Effect<ContextInput, never, CommandContext<Name>> { ... }
```
This is why `const root = yield* parentCommand` inside a child handler returns the
parent's shared-flag values (`ContextInput`).

### Combinators (all `dual`, pipe-friendly)

| Combinator | Purpose | Source |
|---|---|---|
| `Command.withHandler(fn)` | attach/replace handler | `:505` |
| `Command.withSubcommands([...])` | compose children | `:610` |
| `Command.withSharedFlags({...})` | flags inherited by all subcommands AND readable via `yield* parent` | `:726` |
| `Command.withGlobalFlags([...])` | attach custom `GlobalFlag` action/setting flags | `:822` |
| `Command.withDescription(str)` | long help text | `:894` |
| `Command.withShortDescription(str)` | one-liner in subcommand list | `:917` |
| `Command.withAlias(str)` | short command name (e.g. `ls`) | `:939` |
| `Command.withExamples([{command, description}])` | usage examples | `:1024` |
| `Command.provide(layer \| (input)=>layer, {local?})` | provide services to handler | `:1086` |
| `Command.provideSync(key, impl \| (input)=>impl)` | provide a sync service | `:1119` |
| `Command.provideEffect(key, eff \| (input)=>eff)` | provide effectfully | `:1150` |
| `Command.provideEffectDiscard(eff)` | run effect before handler | `:1180` |
| `Command.annotate(key, value)` | metadata | `:958` |

`withSubcommands` signature (`:610`): merges child errors/context, and **excludes
`CommandContext<Name>` from R** — i.e. the parent-yield dependency is auto-satisfied
by the runner.

`withSharedFlags` signature (`:726`): adds the shared flags to BOTH `Input`
(this command's handler) and `ContextInput` (what children get when they yield the
parent). This is the canonical "global options visible to subcommands" mechanism.

---

## 3. Flags — `Flag.*`

Source: `packages/effect/src/unstable/cli/Flag.ts`. Constructors:

```ts
Flag.string(name): Flag<string>                       // :45
Flag.boolean(name): Flag<boolean>                      // :61  (presence => true)
Flag.integer(name): Flag<number>                       // :77
Flag.float(name): Flag<number>                         // :93
Flag.date(name): Flag<Date>                            // :109
Flag.choice(name, choices): Flag<Choices[number]>      // :144  literal-typed
Flag.choiceWithValue(name, [[label, value], ...])      // :133  map label -> value
Flag.path(name, { pathType?, mustExist?, typeName? })  // :175
Flag.file(name, options?): Flag<string>                // :200
Flag.directory(name, options?)                         // :223
Flag.redacted(name): Flag<Redacted<string>>            // :250
Flag.fileText(name): Flag<string>                      // :266  read file contents
Flag.fileParse(name) / Flag.fileSchema(name, schema)   // :289/:314
Flag.keyValuePair(name): Flag<Record<string,string>>   // :338
```

`Flag.choice` exact signature (`Flag.ts:144`):
```ts
export const choice = <const Choices extends ReadonlyArray<string>>(
  name: string,
  choices: Choices
): Flag<Choices[number]> => Param.choice(Param.flagKind, name, choices)
```

### Flag combinators

```ts
Flag.withAlias(short)                  // :383  e.g. "v" -> -v
Flag.withDescription(str)              // :407
Flag.withMetavar(str)                  // :441
Flag.optional(self): Flag<Option<A>>   // :472
Flag.withDefault(self, default | Effect)  // :495
Flag.withFallbackConfig(self, Config.Config<B>)  // :516  <-- ENV FALLBACK
Flag.withFallbackPrompt(self, Prompt)  // :536
Flag.map / mapEffect / mapTryCatch / filter / filterMap / orElse / withSchema
Flag.atLeast / atMost / between        // repeated flags -> arrays
```

`withDefault` (`Flag.ts:495`):
```ts
export const withDefault: {
  <const B>(defaultValue: B | Effect.Effect<B, CliError.CliError, Param.Environment>): <A>(self: Flag<A>) => Flag<A | B>
  <A, const B>(self: Flag<A>, defaultValue: B | Effect.Effect<B, CliError.CliError, Param.Environment>): Flag<A | B>
}
```

### ENV fallback (the key answer)

There is no `Flag.fromEnv`. Env fallback = `withFallbackConfig` + an Effect
`Config` that reads the environment. When the flag is absent on the CLI, the
config is loaded (from `process.env` via the default ConfigProvider).

`Flag.ts:516`:
```ts
export const withFallbackConfig: {
  <B>(config: Config.Config<B>): <A>(self: Flag<A>) => Flag<A | B>
  <A, B>(self: Flag<A>, config: Config.Config<B>): Flag<A | B>
}
```
Doc example (verbatim from source):
```ts
import { Config } from "effect"
import { Flag } from "effect/unstable/cli"
const verbose = Flag.boolean("verbose").pipe(
  Flag.withFallbackConfig(Config.boolean("VERBOSE"))
)
```
Pattern for "flag, else env, else default":
```ts
const apiKey = Flag.redacted("api-key").pipe(
  Flag.withFallbackConfig(Config.redacted("OPENAI_API_KEY"))
)
const limit = Flag.integer("limit").pipe(
  Flag.withFallbackConfig(Config.integer("SEARCH_LIMIT")),
  Flag.withDefault(10)
)
```
Note: `withFallbackConfig` introduces a `Config` load that can fail with
`CliError`; precedence is CLI value > fallback config > `withDefault`.

---

## 4. Positional arguments — `Argument.*`

Source: `packages/effect/src/unstable/cli/Argument.ts`. Same constructor names as
Flag (string/integer/float/date/choice/path/file/directory/redacted/fileText/...).

```ts
Argument.string(name): Argument<string>                // :49
Argument.integer(name): Argument<number>               // :64
Argument.file(name, { mustExist? }): Argument<string>  // :80
Argument.directory(name, options?)                     // :97
Argument.choice(name, choices)                         // :144
Argument.optional(self): Argument<Option<A>>           // :273
Argument.withDescription(str)                          // :290
Argument.withDefault(self, default | Effect)           // :308
Argument.withFallbackConfig(self, Config)              // :334  env fallback
Argument.variadic(options?)                            // :383
Argument.atLeast(n) / atMost(n) / between(min,max)     // :492/:510/:528
```

`Argument.variadic` (`:383`):
```ts
export const variadic: {
  (options?: Param.VariadicParamOptions | undefined): <A>(self: Argument<A>) => Argument<ReadonlyArray<A>>
  <A>(self: Argument<A>, options?: Param.VariadicParamOptions | undefined): Argument<ReadonlyArray<A>>
}
```
`VariadicParamOptions` = `{ min?, max? }`. From the fixture:
```ts
Argument.string("files").pipe(Argument.variadic({ min: 1 }))      // 1..N
Argument.string("paths").pipe(Argument.variadic({ min: 2 }))      // >=2
Argument.string("key=value").pipe(Argument.variadic({ min: 1 }))
```
Optional positional: `Argument.string("email").pipe(Argument.optional)` → `Option<string>`.

---

## 5. Running the CLI & entrypoint wiring

### `Command.run` (reads argv from Stdio) — `Command.ts:1276`
```ts
export const run: {
  (config: { readonly version: string }):
    <Name, Input, E, R, ContextInput>(command: Command<Name, Input, ContextInput, E, R>)
      => Effect.Effect<void, E | CliError.CliError, R | Environment>
  <Name, Input, E, R, ContextInput>(
    command: Command<Name, Input, ContextInput, E, R>,
    config: { readonly version: string }
  ): Effect.Effect<void, E | CliError.CliError, R | Environment>
}
```
Internally: `Stdio.Stdio.use(({ args }) => ... runWith(command, config)(args))`.
So `run` pulls argv from the `Stdio` service (no manual `process.argv` slicing).

### `Command.runWith` (explicit args, for tests) — `Command.ts:1340`
```ts
export const runWith = <const Name extends string, Input, E, R, ContextInput>(
  command: Command<Name, Input, ContextInput, E, R>,
  config: { readonly version: string }
): (input: ReadonlyArray<string>)
  => Effect.Effect<void, Exclude<E, Terminal.QuitError> | CliError.CliError, R | Environment>
```
Use in tests: `Command.runWith(cmd, { version: "1.0.0" })(["search", "foo", "--json"])`.

### `Command.Environment` — what the runner needs (`Command.ts:312`)
```ts
export type Environment =
  FileSystem.FileSystem | Path.Path | Terminal.Terminal | ChildProcessSpawner | Stdio.Stdio
```
`NodeServices.layer` provides exactly this set (`platform-node/src/NodeServices.ts`):
```ts
export type NodeServices = ChildProcessSpawner | FileSystem | Path | Stdio | Terminal
export const layer: Layer.Layer<NodeServices> = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeStdio.layer, NodeTerminal.layer)
)
```

### Entrypoint (verbatim shape from `ai-docs/src/70_cli/10_basics.ts`)
```ts
root.pipe(
  Command.withSubcommands([create, list]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),  // satisfies Command.Environment
  NodeRuntime.runMain                  // runs + sets exit code + reports errors
)
```
`NodeRuntime.runMain` (`platform-node/src/NodeRuntime.ts:34`) accepts
`{ disableErrorReporting?, teardown? }` and handles `process.exit`.

### Exit codes & help/version output
- `--help`/`-h`, `--version`, `--completions`, `--log-level` are **built-in global
  flags** (`GlobalFlag.ts`): you never define them. They are "Action" flags that
  run a side effect (print) and exit. `Command.withGlobalFlags([...])` adds custom
  ones.
- Help/version are printed via `CliOutput.Formatter` to `Console.log`. The runner
  catches `CliError.ShowHelp`, prints the help doc, then fails so the exit code is set.
- Exit codes come from `CliError` classes carrying `Runtime.errorExitCode`
  (`CliError.ts:482`): `ShowHelp` → `1` if it carries parse errors, else `0`
  (plain `--help` exits 0; a missing-required-flag error exits 1).
- Handler failures: a handler can `Effect.fail(new CliError.UserError({ cause }))`
  (`CliError.ts:425`) to signal a domain failure → non-zero exit. Other `E` from
  your handler propagate to `runMain`, which reports and exits non-zero.
- Ctrl-C: `Terminal.QuitError` is caught and converted to `Effect.interrupt`
  (`Command.ts:1431`), so it is excluded from the `runWith` error channel.

---

## 6. Providing app services to handlers

Two equivalent strategies:

**A. Global (simplest for a single app layer).** Merge your app layer into the run
pipeline:
```ts
root.pipe(
  Command.run({ version }),
  Effect.provide(Layer.mergeAll(NodeServices.layer, AppLayer)),
  NodeRuntime.runMain
)
```
Here `R` from every handler (e.g. `EmbeddingService | TurboPufferService`) is
discharged by `AppLayer` before `runMain`.

**B. Per-command (`Command.provide`)** — `Command.ts:1086`:
```ts
export const provide: {
  <Input, LR, LE, LA>(
    layer: Layer.Layer<LA, LE, LR> | ((input: Input) => Layer.Layer<LA, LE, LR>),
    options?: { readonly local?: boolean | undefined }
  ): <Name, E, R, ContextInput>(self: Command<Name, Input, ContextInput, E, R>)
      => Command<Name, Input, ContextInput, E | LE, Exclude<R, LA> | LR>
  ...
}
```
The layer may be a function of the parsed `input`, so you can build a service from
flags (e.g. open a TurboPuffer client using `--namespace`). `provideEffect`/
`provideSync` provide a single service key; `provideEffectDiscard` runs a setup
effect before the handler.

Inside a handler, read services the normal way:
```ts
const handler = Effect.fn("search")(function*(cfg: { query: string; limit: number; json: boolean }) {
  const search = yield* SearchService            // your service
  const results = yield* search.hybrid(cfg.query, cfg.limit)
  ...
})
```

---

## 7. JSON vs human output, reading `--json`/`--limit`/`--path`

No built-in output mode. Pattern (verbatim shape from `ai-docs` `list` handler):
```ts
const list = Command.make("list", {
  status: Flag.choice("status", ["open", "done", "all"]).pipe(Flag.withDefault("open")),
  json: Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable output"))
}, Effect.fn(function*({ status, json }) {
  const items = [...]
  if (json) {
    yield* Console.log(JSON.stringify({ status, items }, null, 2))
    return
  }
  for (const item of items) yield* Console.log(`- ${item.title}`)
}))
```
`--limit`: `Flag.integer("limit").pipe(Flag.withAlias("n"), Flag.withDefault(10))`.
`--path`: `Flag.directory("path").pipe(Flag.withDefault("."))` or
`Flag.path("path", { pathType: "directory", mustExist: true })`.
For a global `--json`/`--quiet` visible to all subcommands, put them in
`Command.withSharedFlags({...})` on the root and read via `const root = yield* cli`.

---

## 8. Concrete minimal multi-subcommand CLI (semantic-search shape)

Compile-minded; uses only verified APIs. `index/search/watch/status/clear/config`.

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, Layer } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"

// ---- shared/global flags, visible to every subcommand via `yield* root` ----
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit machine-readable JSON")
)
const namespaceFlag = Flag.string("namespace").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("TurboPuffer namespace"),
  Flag.withFallbackConfig(Config.string("SEMSEARCH_NAMESPACE")), // env fallback
  Flag.withDefault("default")
)

// ---- root: no handler => prints help when run bare ----
const root = Command.make("semsearch").pipe(
  Command.withDescription("Semantic + hybrid code search"),
  Command.withSharedFlags({ json: jsonFlag, namespace: namespaceFlag })
)

// ---- index ----
const index = Command.make("index", {
  path: Argument.directory("path", { mustExist: true }).pipe(
    Argument.withDescription("Directory to index"),
    Argument.withDefault(".")
  ),
  include: Flag.string("include").pipe(
    Flag.withDescription("Glob to include"),
    Flag.optional
  )
}, Effect.fn("index")(function*(cfg) {
  const r = yield* root // { json, namespace }
  // const indexer = yield* Indexer
  // yield* indexer.run(cfg.path, r.namespace)
  yield* Console.log(`Indexing ${cfg.path} into ${r.namespace}`)
})).pipe(Command.withDescription("Embed and index a codebase"))

// ---- search ----
const search = Command.make("search", {
  query: Argument.string("query").pipe(Argument.withDescription("Search query")),
  limit: Flag.integer("limit").pipe(
    Flag.withAlias("l"),
    Flag.withFallbackConfig(Config.integer("SEMSEARCH_LIMIT")),
    Flag.withDefault(10)
  ),
  mode: Flag.choice("mode", ["semantic", "hybrid", "bm25"]).pipe(
    Flag.withDefault("hybrid")
  )
}, Effect.fn("search")(function*(cfg) {
  const r = yield* root
  // const svc = yield* SearchService
  // const hits = yield* svc.query(cfg.query, { limit: cfg.limit, mode: cfg.mode, namespace: r.namespace })
  const hits = [{ path: "src/a.ts", score: 0.92 }]
  if (r.json) {
    yield* Console.log(JSON.stringify({ query: cfg.query, mode: cfg.mode, hits }, null, 2))
    return
  }
  for (const h of hits) yield* Console.log(`${h.score.toFixed(2)}  ${h.path}`)
})).pipe(Command.withDescription("Search the index"))

// ---- watch ----
const watch = Command.make("watch", {
  path: Argument.directory("path", { mustExist: true }).pipe(Argument.withDefault("."))
}, Effect.fn("watch")(function*(cfg) {
  const r = yield* root
  yield* Console.log(`Watching ${cfg.path} -> ${r.namespace}`)
  // yield* watcher.run(cfg.path, r.namespace)  // long-running fiber
})).pipe(Command.withDescription("Watch files and re-index on change"))

// ---- status ----
const status = Command.make("status", {}, Effect.fn("status")(function*() {
  const r = yield* root
  const stats = { namespace: r.namespace, vectors: 1234 }
  yield* (r.json
    ? Console.log(JSON.stringify(stats, null, 2))
    : Console.log(`namespace=${stats.namespace} vectors=${stats.vectors}`))
})).pipe(Command.withDescription("Show index status"))

// ---- clear ----
const clear = Command.make("clear", {
  force: Flag.boolean("force").pipe(Flag.withAlias("f"))
}, Effect.fn("clear")(function*(cfg) {
  const r = yield* root
  if (!cfg.force) {
    yield* Console.log("Refusing to clear without --force")
    return
  }
  yield* Console.log(`Cleared ${r.namespace}`)
})).pipe(Command.withDescription("Delete all vectors in the namespace"))

// ---- config ----
const config = Command.make("config", {
  key: Argument.string("key").pipe(Argument.optional)
}, Effect.fn("config")(function*(cfg) {
  yield* Console.log(`config ${cfg.key._tag === "Some" ? cfg.key.value : "(all)"}`)
})).pipe(Command.withDescription("Read/write configuration"))

// ---- compose + entrypoint ----
root.pipe(
  Command.withSubcommands([index, search, watch, status, clear, config]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),     // satisfies Command.Environment
  // Effect.provide(AppLayer),             // discharge handler service deps (R)
  NodeRuntime.runMain
)
```

Notes:
- `cfg.key` is `Option<string>` because of `Argument.optional`; pattern-match it.
- For handlers that need services, add `Effect.provide(AppLayer)` (or per-command
  `Command.provide`) so `R` is empty before `runMain`.
- `Effect.fn("name")(function*...)` is the v4-preferred handler style (LLMS.md).

---

## 9. Gotchas

- **Import path is `effect/unstable/cli`** (unstable namespace). It can move/break
  between betas — pin the version. Quoted: index barrel exists at
  `packages/effect/src/unstable/cli/index.ts`.
- **Shared flags ≠ global flags.** `withSharedFlags` adds typed flags to the
  command and its subtree (read via `yield* parent`). `withGlobalFlags` adds
  `GlobalFlag` action/setting flags (like custom `--verbose` that short-circuits).
  Built-in `--help/--version/--log-level/--completions` are always present.
- **`run` needs the `Stdio` service**; tests use `runWith(args)` to bypass argv.
- **Env fallback is `withFallbackConfig(Config.*)`**, not a dedicated env option.
  Precedence: CLI flag > fallback config (env) > `withDefault`. `withFallbackConfig`
  adds a `CliError` to the flag's failure channel.
- **Root command with no handler prints help** when run bare or with `--help`
  (exit 0); parse errors print help + exit 1. Don't add a no-op handler if you want
  the help-on-bare behavior.
- **Exit codes are driven by `CliError` + `Runtime.errorExitCode`**, not manual
  `process.exit`. To force non-zero from a handler, fail with `CliError.UserError`
  or any error; `NodeRuntime.runMain` reports and sets the code.
- **Variadic min/max** is `{ min, max }` via `Argument.variadic`; repeated *flags*
  use `Flag.atLeast/atMost/between` instead.
- **Nested config records** are allowed in `Command.make` config (e.g.
  `database: { host: Flag..., port: Flag... }`) and infer as nested objects.

## Citations (file:line, vendored source)

- `ai-docs/src/70_cli/10_basics.ts` — canonical end-to-end example.
- `packages/effect/test/unstable/cli/fixtures/ComprehensiveCli.ts` — all flag/arg/subcommand patterns.
- `Command.ts`: make `:451`, withHandler `:505`, withSubcommands `:610`,
  withSharedFlags `:726`, withGlobalFlags `:822`, provide `:1086`,
  provideSync `:1119`, provideEffect `:1150`, run `:1276`, runWith `:1340`,
  Environment `:312`, Command interface (extends Effect) `:79`.
- `Flag.ts`: string `:45`, boolean `:61`, integer `:77`, choice `:144`,
  file `:200`, optional `:472`, withDefault `:495`, withFallbackConfig `:516`.
- `Argument.ts`: string `:49`, file `:80`, optional `:273`, withDefault `:308`,
  withFallbackConfig `:334`, variadic `:383`.
- `GlobalFlag.ts`: Help `:137`, Version `:157`, Completions `:175`, LogLevel `:199`.
- `CliError.ts`: UserError `:425`, ShowHelp `:475`, errorExitCode `:482`.
- `packages/platform-node/src/NodeServices.ts` — `layer` provides Command.Environment.
- `packages/platform-node/src/NodeRuntime.ts:34` — `runMain`.

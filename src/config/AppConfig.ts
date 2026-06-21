import { Context, Effect, FileSystem, Layer, Option, Path, Redacted } from "effect"
import { homedir } from "node:os"
import { ConfigError } from "../domain/errors.ts"
import {
  defaultSettings,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type Settings,
  type SettingsOverride
} from "./defaults.ts"
import { shortHash } from "../domain/hash.ts"

export interface ResolvedKeys {
  readonly openai: Option.Option<Redacted.Redacted<string>>
  readonly turbopuffer: Option.Option<Redacted.Redacted<string>>
  readonly openrouter: Option.Option<Redacted.Redacted<string>>
}

export interface RuntimeConfig {
  readonly root: string
  readonly trusted: boolean
  readonly agentDir: string
  readonly cacheDir: string
  readonly namespace: string
  readonly settings: Settings
  readonly keys: ResolvedKeys
  readonly missingRequired: ReadonlyArray<string>
}

export interface AppConfigInput {
  readonly root: string
  readonly trusted: boolean
  readonly namespaceOverride?: string
}

export class AppConfig extends Context.Service<AppConfig, RuntimeConfig>()(
  "semantic-search/AppConfig"
) {
  static layer = (input: AppConfigInput) => Layer.effect(AppConfig, build(input))
}

export const requireKey = (
  key: Option.Option<Redacted.Redacted<string>>,
  name: string
): Effect.Effect<Redacted.Redacted<string>, ConfigError> =>
  Option.match(key, {
    onNone: () => Effect.fail(new ConfigError({ message: `${name} is required but not set` })),
    onSome: (value) => Effect.succeed(value)
  })

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? `${homedir()}/.pi/agent`

const build = (input: AppConfigInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.resolve(input.root)
    const dir = agentDir()

    const fileEnv = yield* readEnvFile(fs, path.join(dir, "semantic-search.env"))
    const envValue = (key: string): string | undefined => {
      const fromFile = fileEnv[key]
      if (fromFile !== undefined && fromFile.length > 0) return fromFile
      const fromProc = process.env[key]
      return fromProc !== undefined && fromProc.length > 0 ? fromProc : undefined
    }
    const redactedOption = (key: string): Option.Option<Redacted.Redacted<string>> => {
      const value = envValue(key)
      return value === undefined ? Option.none() : Option.some(Redacted.make(value))
    }

    const keys: ResolvedKeys = {
      openai: redactedOption("OPENAI_API_KEY"),
      turbopuffer: redactedOption("TURBOPUFFER_API_KEY"),
      openrouter: redactedOption("OPENROUTER_API_KEY")
    }

    const globalOverride = yield* readJsonConfig(fs, path.join(dir, "semantic-search.json"))
    const projectOverride = input.trusted
      ? yield* readJsonConfig(fs, path.join(root, ".pi", "semantic-search.json"))
      : Option.none<SettingsOverride>()

    const settings = applyEnvOverrides(
      mergeSettings(mergeSettings(defaultSettings, globalOverride), projectOverride),
      envValue
    )

    const missingRequired: Array<string> = []
    const embedKey = settings.embedding.provider === "openai" ? keys.openai : keys.openrouter
    const embedKeyName = settings.embedding.provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY"
    if (Option.isNone(embedKey)) missingRequired.push(embedKeyName)
    if (Option.isNone(keys.turbopuffer)) missingRequired.push("TURBOPUFFER_API_KEY")

    return AppConfig.of({
      root,
      trusted: input.trusted,
      agentDir: dir,
      cacheDir: path.join(dir, "semantic-search", shortHash(input.namespaceOverride ?? root, 16)),
      namespace: input.namespaceOverride ?? namespaceFor(settings, root),
      settings,
      keys,
      missingRequired
    })
  })

const namespaceFor = (settings: Settings, root: string): string => {
  const slug =
    root
      .slice(root.lastIndexOf("/") + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  const signature = shortHash(`${root}\n${settingsSignature(settings)}`, 12)
  return `${settings.store.namespacePrefix}_${SCHEMA_VERSION}_${slug}_${signature}`.slice(0, 128)
}

const settingsSignature = (settings: Settings): string =>
  JSON.stringify({
    model: settings.embedding.model,
    dims: settings.embedding.dimensions,
    prompt: PROMPT_VERSION,
    target: settings.indexing.chunkTargetChars,
    max: settings.indexing.chunkMaxChars,
    extensions: settings.indexing.includeExtensions,
    excludeDirs: settings.indexing.excludeDirs,
    excludeFiles: settings.indexing.excludeFiles,
    excludePatterns: settings.indexing.excludePathPatterns
  })

const applyEnvOverrides = (
  settings: Settings,
  envValue: (key: string) => string | undefined
): Settings => {
  const region = envValue("TURBOPUFFER_REGION") ?? settings.store.region
  const baseUrl = envValue("TURBOPUFFER_BASE_URL") ?? settings.store.baseUrl
  return { ...settings, store: { ...settings.store, region, baseUrl } }
}

const uniqueLower = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)))

const mergeSettings = (base: Settings, override: Option.Option<SettingsOverride>): Settings => {
  if (Option.isNone(override)) return base
  const o = override.value
  const indexing = { ...base.indexing, ...o.indexing }
  if (o.indexing?.excludeDirs) {
    indexing.excludeDirs = uniqueLower([...base.indexing.excludeDirs, ...o.indexing.excludeDirs])
  }
  if (o.indexing?.excludeFiles) {
    indexing.excludeFiles = uniqueLower([...base.indexing.excludeFiles, ...o.indexing.excludeFiles])
  }
  if (o.indexing?.excludePathPatterns) {
    indexing.excludePathPatterns = uniqueLower([
      ...base.indexing.excludePathPatterns,
      ...o.indexing.excludePathPatterns
    ])
  }
  if (o.indexing?.includeDirs) {
    indexing.includeDirs = uniqueLower([...base.indexing.includeDirs, ...o.indexing.includeDirs])
  }
  return {
    embedding: { ...base.embedding, ...o.embedding },
    store: { ...base.store, ...o.store },
    rerank: { ...base.rerank, ...o.rerank },
    indexing,
    search: { ...base.search, ...o.search }
  }
}

const readJsonConfig = (
  fs: FileSystem.FileSystem,
  file: string
): Effect.Effect<Option.Option<SettingsOverride>> =>
  fs.readFileString(file).pipe(
    Effect.map((text) => Option.some(JSON.parse(text) as SettingsOverride)),
    Effect.catch(() => Effect.succeed(Option.none<SettingsOverride>()))
  )

const readEnvFile = (fs: FileSystem.FileSystem, file: string): Effect.Effect<Record<string, string>> =>
  fs.readFileString(file).pipe(
    Effect.map((text) => {
      const out: Record<string, string> = {}
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const equals = trimmed.indexOf("=")
        if (equals <= 0) continue
        const key = trimmed.slice(0, equals).trim()
        if (!/^[A-Z0-9_]+$/.test(key)) continue
        out[key] = unquote(trimmed.slice(equals + 1).trim())
      }
      return out
    }),
    Effect.catch(() => Effect.succeed({} as Record<string, string>))
  )

const unquote = (value: string): string =>
  (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))
    ? value.slice(1, -1)
    : value

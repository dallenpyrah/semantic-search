#!/usr/bin/env bun
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const managedMarker = "semantic-search amp installer managed"
const defaultPluginUrl =
  "https://raw.githubusercontent.com/dallenpyrah/semantic-search/main/dist/amp/semantic-search.ts"
const execFileAsync = promisify(execFile)

type InstallScope = "system" | "workspace"

interface InstallOptions {
  readonly scope: InstallScope
  readonly force: boolean
  readonly pluginUrl: string
  readonly workspaceRoot: string
}

const usage = `Install the semantic-search Amp plugin and skill.

Usage:
  bun run amp:install [-- --system|--workspace] [--workspace-root <path>] [--plugin-url <url>] [--force]

Options:
  --system          Install user-wide into ~/.config/amp/plugins and ~/.config/agents/skills (default).
  --workspace       Install into <workspace>/.amp/plugins and <workspace>/.agents/skills.
  --workspace-root  Workspace path for --workspace installs (default: current directory).
  --plugin-url      URL passed to \`amp plugins add\` when it points at Amp's hosted registry.
                    Other URLs are recorded in the bundled plugin's update directive.
                    Default: ${defaultPluginUrl}.
  --force           Overwrite an existing non-semantic-search plugin or skill with the same name.
  --help            Show this help.
`

const isErrno = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error

const isExecError = (error: unknown): error is NodeJS.ErrnoException & { stderr?: unknown; stdout?: unknown } =>
  isErrno(error)

const parseArgs = (args: ReadonlyArray<string>): InstallOptions => {
  let scope: InstallScope = "system"
  let force = false
  let pluginUrl = process.env.SEMANTIC_SEARCH_AMP_PLUGIN_URL?.trim() || defaultPluginUrl
  let workspaceRoot = process.cwd()

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--system" || arg === "--global") {
      scope = "system"
      continue
    }
    if (arg === "--workspace") {
      scope = "workspace"
      continue
    }
    if (arg === "--workspace-root") {
      const next = args[index + 1]
      if (!next) throw new Error("--workspace-root requires a path")
      workspaceRoot = resolve(next)
      index += 1
      continue
    }
    if (arg === "--plugin-url") {
      const next = args[index + 1]
      if (!next) throw new Error("--plugin-url requires a URL")
      pluginUrl = next
      index += 1
      continue
    }
    if (arg === "--force") {
      force = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage)
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage}`)
  }

  return { scope, force, pluginUrl, workspaceRoot: resolve(workspaceRoot) }
}

const readIfExists = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

const assertManagedOrMissing = async (file: string, force: boolean, label: string) => {
  const existing = await readIfExists(file)
  if (existing === undefined || existing.includes(managedMarker) || force) return
  throw new Error(`${label} already exists and was not created by semantic-search: ${file}\nUse --force to overwrite it.`)
}

const sourceRoot = (): string => resolve(fileURLToPath(new URL("../../", import.meta.url)))

const installHostedPlugin = async (options: InstallOptions) => {
  const target = options.scope === "system" ? "system" : "workspace"
  const args = ["plugins", "add", "--target", target, "--auto-update", options.pluginUrl]
  try {
    await execFileAsync("amp", args, { cwd: options.workspaceRoot })
  } catch (error) {
    if (!isExecError(error)) throw error
    const stderr = typeof error.stderr === "string" ? error.stderr : ""
    const stdout = typeof error.stdout === "string" ? error.stdout : ""
    throw new Error([`amp ${args.join(" ")} failed.`, stdout, stderr].filter(Boolean).join("\n"))
  }
}

const installBundledPlugin = async (options: InstallOptions, root: string) => {
  const sourcePlugin = resolve(root, "dist/amp/semantic-search.ts")
  await stat(sourcePlugin)

  const pluginDir =
    options.scope === "system"
      ? resolve(homedir(), ".config/amp/plugins")
      : resolve(options.workspaceRoot, ".amp/plugins")
  const pluginFile = resolve(pluginDir, "semantic-search.ts")

  await assertManagedOrMissing(pluginFile, options.force, "Amp plugin")
  await mkdir(pluginDir, { recursive: true })

  const contents = await readFile(sourcePlugin, "utf8")
  await writeFile(
    pluginFile,
    [`// ${managedMarker}`, "// Bundled semantic-search Amp plugin. No local checkout imports.", contents].join("\n")
  )
}

const installPlugin = async (options: InstallOptions, root: string) => {
  if (options.pluginUrl.startsWith("https://ampcode.com/@amp/plugins/")) {
    await installHostedPlugin(options)
    return
  }

  await installBundledPlugin(options, root)
}

const install = async (options: InstallOptions) => {
  const root = sourceRoot()
  const sourceSkill = resolve(root, "src/amp/skills/searching-code")
  await stat(sourceSkill)

  const skillRoot =
    options.scope === "system"
      ? resolve(homedir(), ".config/agents/skills")
      : resolve(options.workspaceRoot, ".agents/skills")
  const skillDir = resolve(skillRoot, "searching-code")
  const skillFile = resolve(skillDir, "SKILL.md")

  await assertManagedOrMissing(skillFile, options.force, "Amp skill")
  await installPlugin(options, root)
  await mkdir(skillRoot, { recursive: true })

  await rm(skillDir, { recursive: true, force: true })
  await cp(sourceSkill, skillDir, { recursive: true })

  console.log(`Installed semantic-search Amp integration (${options.scope}):`)
  console.log(
    options.pluginUrl.startsWith("https://ampcode.com/@amp/plugins/")
      ? `- plugin: ${options.pluginUrl}`
      : "- plugin: bundled dist/amp/semantic-search.ts"
  )
  console.log(`- skill:  ${skillDir}`)
  console.log("Restart Amp or run `plugins: reload` from the command palette.")
}

install(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

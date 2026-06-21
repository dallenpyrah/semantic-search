import { Effect } from "effect"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const execFileAsync = promisify(execFile)

export const git = (root: string, args: ReadonlyArray<string>): Effect.Effect<{ out: string; ok: boolean }> =>
  Effect.promise(async () => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 96 * 1024 * 1024 })
      return { out: String(stdout), ok: true }
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout
      return { out: typeof stdout === "string" ? stdout : "", ok: false }
    }
  })

export const gitPath = async (root: string, rel: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--git-path", rel])
    const path = resolve(root, String(stdout).trim())
    return existsSync(path) ? path : undefined
  } catch {
    return undefined
  }
}

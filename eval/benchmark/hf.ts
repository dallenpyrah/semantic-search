import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const CACHE = join(import.meta.dirname, ".cache")
const ROWS = "https://datasets-server.huggingface.co/rows"

export interface HfRow {
  readonly [key: string]: unknown
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fetchRows = async (
  dataset: string,
  config: string,
  split: string,
  offset: number,
  length: number
): Promise<{ rows: ReadonlyArray<HfRow>; total: number }> => {
  const url = `${ROWS}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url)
    if (response.ok) {
      const json = (await response.json()) as {
        rows: Array<{ row: HfRow }>
        num_rows_total: number
      }
      return { rows: json.rows.map((entry) => entry.row), total: json.num_rows_total }
    }
    if (response.status === 429 || response.status >= 500) {
      await sleep(1000 * (attempt + 1))
      continue
    }
    throw new Error(`HF rows ${response.status} for ${dataset}/${config}/${split}: ${await response.text()}`)
  }
  throw new Error(`HF rows failed after retries for ${dataset}/${config}/${split}`)
}

export const loadSplit = async (
  dataset: string,
  config: string,
  split: string,
  limit?: number
): Promise<ReadonlyArray<HfRow>> => {
  mkdirSync(CACHE, { recursive: true })
  const safe = dataset.replace(/[^a-zA-Z0-9]+/g, "_")
  const cacheFile = join(CACHE, `${safe}__${config}__${split}${limit ? `__${limit}` : ""}.json`)
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, "utf8")) as ReadonlyArray<HfRow>
  }
  const out: Array<HfRow> = []
  const first = await fetchRows(dataset, config, split, 0, 100)
  const total = limit ? Math.min(limit, first.total) : first.total
  for (const row of first.rows) out.push(row)
  let offset = 100
  while (out.length < total) {
    const page = await fetchRows(dataset, config, split, offset, 100)
    for (const row of page.rows) out.push(row)
    offset += 100
    if (page.rows.length === 0) break
  }
  const result = out.slice(0, total)
  writeFileSync(cacheFile, JSON.stringify(result))
  return result
}

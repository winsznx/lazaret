import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import pLimit from "p-limit"
import { fetchPackument } from "./packument"
import type { Packument } from "./packument"
import type { PackageRecord } from "./records"

export interface CrawlOptions {
  seeds: string[]
  outDir: string
  maxPackages: number
  concurrency: number
  maxVersionsPerPackage: number
  includeDev: boolean
  expandDepth: number
}

export interface CrawlReport {
  packages: number
  versions: number
  edges: number
  failures: number
  elapsedMs: number
}

function loadEtags(path: string): Map<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>
    return new Map(Object.entries(parsed))
  } catch {
    return new Map()
  }
}

function dedupeUnvisited(names: string[], visited: Set<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    if (visited.has(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

export async function crawl(options: CrawlOptions): Promise<CrawlReport> {
  const started = performance.now()
  mkdirSync(options.outDir, { recursive: true })
  const path = (file: string): string => resolve(options.outDir, file)
  const completedPath = path("completed.txt")
  const resuming = existsSync(completedPath)

  const visited = new Set<string>()
  if (resuming) {
    for (const line of readFileSync(completedPath, "utf8").split("\n")) {
      const name = line.trim()
      if (name.length > 0) visited.add(name)
    }
  } else {
    for (const file of ["packages.jsonl", "versions.jsonl", "edges.jsonl", "completed.txt"]) {
      writeFileSync(path(file), "")
    }
  }

  const etags = loadEtags(path("etags.json"))
  const limit = pLimit(options.concurrency)

  let packages = 0
  let versions = 0
  let edges = 0
  let failures = 0

  const writeRecords = (packument: Packument): void => {
    const pkg: PackageRecord = { name: packument.name }
    appendFileSync(path("packages.jsonl"), `${JSON.stringify(pkg)}\n`)
    if (packument.versions.length > 0) {
      appendFileSync(
        path("versions.jsonl"),
        packument.versions.map((v) => JSON.stringify(v)).join("\n") + "\n",
      )
    }
    if (packument.edges.length > 0) {
      appendFileSync(
        path("edges.jsonl"),
        packument.edges.map((e) => JSON.stringify(e)).join("\n") + "\n",
      )
    }
  }

  let frontier = dedupeUnvisited(options.seeds, visited)

  for (let depth = 0; depth <= options.expandDepth; depth += 1) {
    if (frontier.length === 0 || visited.size >= options.maxPackages) break
    const batch = frontier.slice(0, options.maxPackages - visited.size)
    for (const name of batch) visited.add(name)

    const discovered = new Set<string>()
    await Promise.all(
      batch.map((name) =>
        limit(async () => {
          try {
            const result = await fetchPackument(name, {
              maxVersions: options.maxVersionsPerPackage,
              includeDev: options.includeDev,
              etag: etags.get(name),
            })
            if (result.status === 200 && result.packument !== undefined) {
              writeRecords(result.packument)
              packages += 1
              versions += result.packument.versions.length
              edges += result.packument.edges.length
              if (result.etag !== undefined) etags.set(name, result.etag)
              for (const dep of result.packument.dependencyNames) discovered.add(dep)
              appendFileSync(completedPath, `${name}\n`)
            } else if (result.status === 304) {
              packages += 1
              appendFileSync(completedPath, `${name}\n`)
            } else {
              failures += 1
            }
          } catch {
            failures += 1
          }
        }),
      ),
    )

    frontier = depth < options.expandDepth ? dedupeUnvisited([...discovered], visited) : []
  }

  writeFileSync(path("etags.json"), JSON.stringify(Object.fromEntries(etags)))
  const report: CrawlReport = {
    packages,
    versions,
    edges,
    failures,
    elapsedMs: performance.now() - started,
  }
  writeFileSync(path("report.json"), JSON.stringify(report, null, 2))
  return report
}

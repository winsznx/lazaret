import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { configFromEnv, GraphClient } from "@lazaret/graph-client"
import { crawl } from "./crawler"
import { loadDotenv, REPO_ROOT } from "./env"
import { loadSlice } from "./loader"
import type { EdgeRecord, NormalizedSlice, PackageRecord, VersionRecord } from "./records"
import { seedNames } from "./seed"

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as T
}

function readJsonl<T>(absolutePath: string): T[] {
  const out: T[] = []
  for (const line of readFileSync(absolutePath, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) out.push(JSON.parse(trimmed) as T)
  }
  return out
}

function argValue(flag: string, fallback: string): string {
  const prefix = `--${flag}=`
  const match = process.argv.find((arg) => arg.startsWith(prefix))
  return match === undefined ? fallback : match.slice(prefix.length)
}

async function countLabel(client: GraphClient, label: string): Promise<number> {
  const row = await client.queryOne(`MATCH (n:${label}) RETURN count(*) AS c`)
  const value = row?.["c"]
  return typeof value === "number" ? value : 0
}

async function countEdges(client: GraphClient, relType: string): Promise<number> {
  const row = await client.queryOne(`MATCH ()-[r:${relType}]->() RETURN count(*) AS c`)
  const value = row?.["c"]
  return typeof value === "number" ? value : 0
}

async function seedFixture(client: GraphClient): Promise<void> {
  const slice = readJson<NormalizedSlice>("fixtures/micro/slice.json")
  const report = await loadSlice(client, slice)
  console.log(
    `loaded micro-slice: ${report.packages} packages, ${report.versions} versions ` +
      `(${report.reconstructed} reconstructed), ${report.dependsOn} DEPENDS_ON, ` +
      `${report.hasVersion} HAS_VERSION in ${Math.round(report.ms)}ms`,
  )
}

async function stats(client: GraphClient): Promise<void> {
  const [packages, versions, advisories, dependsOn] = await Promise.all([
    countLabel(client, "Package"),
    countLabel(client, "Version"),
    countLabel(client, "Advisory"),
    countEdges(client, "DEPENDS_ON"),
  ])
  console.log(
    `packages=${packages} versions=${versions} advisories=${advisories} depends_on=${dependsOn}`,
  )
}

async function runCrawl(): Promise<void> {
  const maxPackages = Number(argValue("max", "2500"))
  const concurrency = Number(argValue("concurrency", "40"))
  const maxVersions = Number(argValue("versions", "12"))
  const expandDepth = Number(argValue("depth", "1"))
  const outDir = resolve(REPO_ROOT, argValue("out", "data/slice"))
  const seeds = seedNames([], maxPackages)
  console.log(
    `crawling up to ${maxPackages} packages (concurrency ${concurrency}, ` +
      `${maxVersions} versions each, expand depth ${expandDepth}) into ${outDir}`,
  )
  const report = await crawl({
    seeds,
    outDir,
    maxPackages,
    concurrency,
    maxVersionsPerPackage: maxVersions,
    includeDev: false,
    expandDepth,
  })
  console.log(
    `crawl done: ${report.packages} packages, ${report.versions} versions, ` +
      `${report.edges} edges, ${report.failures} failures in ${Math.round(report.elapsedMs / 1000)}s`,
  )
}

async function loadDir(client: GraphClient): Promise<void> {
  const dir = resolve(REPO_ROOT, argValue("dir", "data/slice"))
  const slice: NormalizedSlice = {
    packages: readJsonl<PackageRecord>(resolve(dir, "packages.jsonl")),
    versions: readJsonl<VersionRecord>(resolve(dir, "versions.jsonl")),
    edges: readJsonl<EdgeRecord>(resolve(dir, "edges.jsonl")),
  }
  console.log(
    `loading slice from ${dir}: ${slice.packages.length} packages, ` +
      `${slice.versions.length} versions, ${slice.edges.length} edges`,
  )
  const report = await loadSlice(client, slice)
  console.log(
    `loaded: ${report.packages} packages, ${report.versions} versions ` +
      `(${report.reconstructed} reconstructed), ${report.dependsOn} DEPENDS_ON in ` +
      `${Math.round(report.ms / 1000)}s`,
  )
}

async function main(): Promise<void> {
  loadDotenv()
  const command = process.argv[2] ?? "help"
  const client = new GraphClient(configFromEnv())
  try {
    switch (command) {
      case "seed-fixture":
        await seedFixture(client)
        break
      case "stats":
        await stats(client)
        break
      case "crawl":
        await runCrawl()
        break
      case "load-dir":
        await loadDir(client)
        break
      default:
        console.log("usage: cli <seed-fixture|stats|crawl|load-dir>")
    }
  } finally {
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

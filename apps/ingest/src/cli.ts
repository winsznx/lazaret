import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { configFromEnv, GraphClient } from "@lazaret/graph-client"
import { computeClosure } from "@lazaret/refmodel"
import { compileIncident } from "./compiler"
import { crawl } from "./crawler"
import { loadDotenv, REPO_ROOT } from "./env"
import { loadIncident } from "./incident"
import { loadSlice } from "./loader"
import { compareParity, incidentToAdvisory, readExposed, sliceToSnapshot } from "./parity"
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

async function runCompile(client: GraphClient): Promise<void> {
  const incident = loadIncident(argValue("incident", "fixtures/incidents/tanstack-micro.json"))
  const result = await compileIncident(client, incident)
  const histogram = Array.from(
    { length: result.depthHistogram.length },
    (_unused, depth) => `${depth}:${result.depthHistogram[depth] ?? 0}`,
  ).join(" ")
  console.log(
    `compiled ${incident.id}: ${result.members} members, depths [${histogram}], ` +
      `capHit=${result.capHit}, ${result.reverseReads} reverse reads in ${Math.round(result.ms)}ms`,
  )
}

async function verifyFixture(client: GraphClient): Promise<void> {
  const slice = readJson<NormalizedSlice>("fixtures/micro/slice.json")
  await loadSlice(client, slice)
  const incident = loadIncident("fixtures/incidents/tanstack-micro.json")
  const result = await compileIncident(client, incident)
  const compiled = await readExposed(client, result.advisoryId)
  const closure = computeClosure(sliceToSnapshot(slice), incidentToAdvisory(incident))
  const parity = compareParity(closure.members, compiled)
  console.log(
    `refmodel closure ${closure.members.size}, compiled EXPOSES ${compiled.size} in ${Math.round(result.ms)}ms`,
  )
  if (parity.ok) {
    console.log("PARITY OK: compiled EXPOSES equals the reference-model closure, depths match")
  } else {
    console.error("PARITY FAILED:", JSON.stringify(parity))
    process.exitCode = 1
  }
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
      case "compile":
        await runCompile(client)
        break
      case "verify":
        await verifyFixture(client)
        break
      default:
        console.log("usage: cli <seed-fixture|stats|crawl|load-dir|compile|verify>")
    }
  } finally {
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

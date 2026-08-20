import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { arch, platform } from "node:os"
import { resolve } from "node:path"
import { configFromEnv, GraphClient, nodeId } from "@lazaret/graph-client"
import { computeClosure } from "@lazaret/refmodel"
import { compileIncident } from "./compiler"
import { crawl } from "./crawler"
import { enrichIncident } from "./enrich"
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
  const [packages, versions, advisories] = await Promise.all([
    countLabel(client, "Package"),
    countLabel(client, "Version"),
    countLabel(client, "Advisory"),
  ])
  console.log(`packages=${packages} versions=${versions} advisories=${advisories}`)
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
  writeFileSync(resolve(dir, "load-report.json"), JSON.stringify(report, null, 2))
  console.log(
    `loaded: ${report.packages} packages, ${report.versions} versions ` +
      `(${report.reconstructed} reconstructed), ${report.dependsOn} DEPENDS_ON in ` +
      `${Math.round(report.ms / 1000)}s`,
  )
}

async function runCompile(client: GraphClient): Promise<void> {
  const incident = loadIncident(argValue("incident", "fixtures/incidents/tanstack-micro.json"))
  const result = await compileIncident(client, incident)
  const reportDir = resolve(REPO_ROOT, "data")
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(resolve(reportDir, `compile-${incident.id}.json`), JSON.stringify(result, null, 2))
  const histogram = Array.from(
    { length: result.depthHistogram.length },
    (_unused, depth) => `${depth}:${result.depthHistogram[depth] ?? 0}`,
  ).join(" ")
  console.log(
    `compiled ${incident.id}: ${result.members} members, depths [${histogram}], ` +
      `capHit=${result.capHit}, ${result.reverseReads} reverse reads in ${Math.round(result.ms)}ms`,
  )
}

async function runEnrich(client: GraphClient): Promise<void> {
  const incident = loadIncident(argValue("incident", "fixtures/incidents/chalk-debug-2025-09.json"))
  const result = await enrichIncident(client, incident)
  const reportDir = resolve(REPO_ROOT, "data")
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(resolve(reportDir, `enrich-${incident.id}.json`), JSON.stringify(result, null, 2))
  const totalReach = result.maintainers.reduce((sum, entry) => sum + entry.total, 0)
  console.log(
    `enriched ${incident.id}: ${result.maintainers.length} maintainer account(s) controlling ` +
      `${totalReach} packages total, ${result.similar.length} similar-name candidate(s)`,
  )
}

function evidenceMetadata(): Record<string, string> {
  const read = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd: REPO_ROOT }).toString().trim()
    } catch {
      return "unknown"
    }
  }
  let hydraImage = "unknown"
  try {
    const compose = readFileSync(resolve(REPO_ROOT, "docker-compose.yml"), "utf8")
    hydraImage = compose.match(/image:\s*(ghcr\.io\/hydra-db\/hydradb@sha256:[a-f0-9]+)/)?.[1] ?? "unknown"
  } catch {
    hydraImage = "unknown"
  }
  return {
    gitSha: read("git rev-parse --short HEAD"),
    hydraImage,
    generatedAt: new Date().toISOString(),
    os: platform(),
    arch: arch(),
    node: process.version,
  }
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

  // Emit the committed evidence artifact behind the fixture.parity claim. This
  // is the live verification run itself producing the number, not a hand copy.
  const evidenceDir = resolve(REPO_ROOT, "evidence")
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(
    resolve(evidenceDir, "parity-fixture.json"),
    JSON.stringify(
      {
        metadata: evidenceMetadata(),
        fixture: "tanstack-micro",
        refmodelClosure: closure.members.size,
        compiledExposes: compiled.size,
        ok: parity.ok,
      },
      null,
      2,
    ),
  )

  if (parity.ok) {
    console.log("PARITY OK: compiled EXPOSES equals the reference-model closure, depths match")
  } else {
    console.error("PARITY FAILED:", JSON.stringify(parity))
    process.exitCode = 1
  }
}

async function dependents(client: GraphClient): Promise<void> {
  for (const pkg of argValue("pkg", "debug").split(",")) {
    const row = await client.queryOne(
      "MATCH (p:Package {id: $pid})<-[e:DEPENDS_ON]-(v:Version) RETURN count(*) AS c",
      { pid: nodeId("pkg", pkg) },
    )
    const count = row?.["c"]
    console.log(`${pkg}: ${typeof count === "number" ? count : 0} dependent versions`)
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
      case "enrich":
        await runEnrich(client)
        break
      case "verify":
        await verifyFixture(client)
        break
      case "dependents":
        await dependents(client)
        break
      default:
        console.log(
          "usage: cli <seed-fixture|stats|crawl|load-dir|compile|enrich|verify|dependents>",
        )
    }
  } finally {
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

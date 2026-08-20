import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { arch, platform } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { computeClosure, verdict } from "../packages/refmodel/src/index"
import type { Advisory, GraphSnapshot, ServiceVerdict } from "../packages/refmodel/src/index"
import type { Lockfile as RefLockfile } from "../packages/refmodel/src/index"
import { sliceToSnapshot } from "../apps/ingest/src/parity"
import type { EdgeRecord, NormalizedSlice, PackageRecord, VersionRecord } from "../apps/ingest/src/records"
import { parseLockfile } from "../apps/api/src/lockfile"

// The evidence campaign. For a deterministic cohort of real public lockfiles it
// runs two independent engines over the same input: production (the live API,
// reading the compiled graph from HydraDB) and the reference model (recomputing
// the closure in memory from the original crawled slice records, never touching
// the compiled graph). It publishes every service result, the agreement rate,
// and every disagreement. It then audits that sampled evidence paths reach a
// real advisory target, and measures replay latency across 100 timestamps.
// Nothing is hidden: OUT_OF_SLICE and any mismatch are reported, not filtered.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const CAMPAIGN_DIR = resolve(REPO_ROOT, "fixtures/campaign")
const LOCKFILE_DIR = resolve(CAMPAIGN_DIR, "lockfiles")
const EVIDENCE_DIR = resolve(REPO_ROOT, "evidence")
const API = process.env.LAZARET_API ?? "http://127.0.0.1:8080"
const INCIDENT = "chalk-debug-2025-09"

function metadata(): Record<string, string> {
  const read = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd: REPO_ROOT }).toString().trim()
    } catch {
      return "unknown"
    }
  }
  return {
    gitSha: read("git rev-parse --short HEAD"),
    generatedAt: new Date().toISOString(),
    os: platform(),
    arch: arch(),
    node: process.version,
    apiBase: API,
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round((sorted[index] ?? 0) * 10) / 10
}

interface Incident {
  id: string
  targets: { pkg: string; version: string }[]
  windowStart: number
  windowEnd: number
}

interface ManifestEntry {
  repo: string
  ref: string
  path: string
}

function slug(repo: string): string {
  return repo.replace(/\//g, "__")
}

function readJsonl<T>(path: string): T[] {
  const out: T[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) out.push(JSON.parse(trimmed) as T)
  }
  return out
}

// The oracle snapshot is rebuilt from the original crawled slice records, an
// independent source from the compiled graph the production API reads.
function loadSliceRecords(): { snapshot: GraphSnapshot; sliceNames: Set<string> } {
  const dir = resolve(REPO_ROOT, "data/slice")
  const slice: NormalizedSlice = {
    packages: readJsonl<PackageRecord>(resolve(dir, "packages.jsonl")),
    versions: readJsonl<VersionRecord>(resolve(dir, "versions.jsonl")),
    edges: readJsonl<EdgeRecord>(resolve(dir, "edges.jsonl")),
  }
  return {
    snapshot: sliceToSnapshot(slice),
    sliceNames: new Set(slice.packages.map((entry) => entry.name)),
  }
}

async function productionVerdict(
  incidentId: string,
  service: string,
  lockfileDoc: unknown,
): Promise<ServiceVerdict> {
  const response = await fetch(`${API}/v1/verdict?fresh=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incident: incidentId, lockfiles: [{ service, lockfile: lockfileDoc }] }),
  })
  if (!response.ok) throw new Error(`verdict ${response.status}: ${(await response.text()).slice(0, 160)}`)
  const body = (await response.json()) as { verdicts: ServiceVerdict[] }
  return body.verdicts[0]!
}

function classMap(result: ServiceVerdict): Map<string, string> {
  return new Map(result.packages.map((entry) => [entry.name, entry.class]))
}

async function runParity(incident: Incident): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(resolve(CAMPAIGN_DIR, "manifest.json"), "utf8")) as {
    entries: ManifestEntry[]
  }
  const advisory: Advisory = {
    id: incident.id,
    targets: incident.targets,
    windowStart: incident.windowStart,
    windowEnd: incident.windowEnd,
  }
  console.log("building reference snapshot from crawled slice records ...")
  const { snapshot, sliceNames } = loadSliceRecords()
  const closure = computeClosure(snapshot, advisory)
  console.log(`snapshot ${snapshot.versions.length} versions, oracle closure ${closure.members.size}`)

  const services: Record<string, unknown>[] = []
  const disagreements: Record<string, unknown>[] = []
  const serviceClasses: Record<string, number> = {}
  let serviceMatched = 0
  let pkgMatched = 0
  let pkgTotal = 0
  let outOfSlicePackages = 0
  let servicesWithOos = 0

  for (const entry of manifest.entries) {
    const doc = JSON.parse(readFileSync(resolve(LOCKFILE_DIR, `${slug(entry.repo)}.json`), "utf8"))
    const parsed = parseLockfile(entry.repo, doc) as unknown as RefLockfile
    const oracle = verdict(parsed, advisory, closure, snapshot, sliceNames)
    const production = await productionVerdict(incident.id, entry.repo, doc)

    const oracleMap = classMap(oracle)
    const productionMap = classMap(production)
    const names = new Set([...oracleMap.keys(), ...productionMap.keys()])
    let localMatched = 0
    for (const name of names) {
      pkgTotal += 1
      const o = oracleMap.get(name)
      const p = productionMap.get(name)
      if (o === p) {
        pkgMatched += 1
        localMatched += 1
      } else {
        disagreements.push({ service: entry.repo, package: name, production: p, oracle: o })
      }
    }
    const serviceMatch = oracle.class === production.class
    if (serviceMatch) serviceMatched += 1
    serviceClasses[production.class] = (serviceClasses[production.class] ?? 0) + 1
    if (production.outOfSlice.length > 0) servicesWithOos += 1
    outOfSlicePackages += production.outOfSlice.length

    services.push({
      service: entry.repo,
      ref: entry.ref,
      productionClass: production.class,
      oracleClass: oracle.class,
      classMatch: serviceMatch,
      packages: names.size,
      packagesMatched: localMatched,
      exposedPackages: production.packages.filter((entry2) =>
        entry2.class.startsWith("EXPOSED"),
      ).length,
      outOfSlice: production.outOfSlice.length,
    })
    console.log(
      `${serviceMatch ? "==" : "!!"} ${entry.repo}: prod=${production.class} oracle=${oracle.class} (${localMatched}/${names.size} packages agree)`,
    )
  }

  return {
    cohortSize: manifest.entries.length,
    serviceClassCounts: serviceClasses,
    serviceAgreement: {
      matched: serviceMatched,
      total: manifest.entries.length,
      rate: manifest.entries.length === 0 ? 0 : serviceMatched / manifest.entries.length,
    },
    packageAgreement: {
      matched: pkgMatched,
      total: pkgTotal,
      rate: pkgTotal === 0 ? 0 : Math.round((pkgMatched / pkgTotal) * 10000) / 10000,
    },
    outOfSlice: { packages: outOfSlicePackages, servicesWithAny: servicesWithOos },
    disagreements,
    services,
  }
}

async function runPathAudit(incident: Incident, sampleSize: number): Promise<Record<string, unknown>> {
  const blast = (await (await fetch(`${API}/v1/blast/${incident.id}?t=9999999999`)).json()) as {
    members: { pkg: string; semver: string; depth: number }[]
  }
  const targets = new Set(incident.targets.map((t) => `${t.pkg}@${t.version}`))
  const targetPkgs = new Set(incident.targets.map((t) => t.pkg))
  // Deterministic spread across depths: take an evenly-strided sample.
  const members = blast.members.filter((m) => m.depth > 0)
  const stride = Math.max(1, Math.floor(members.length / sampleSize))
  const sample = members.filter((_m, index) => index % stride === 0).slice(0, sampleSize)
  let reachTarget = 0
  const failures: Record<string, unknown>[] = []
  for (const member of sample) {
    const url = `${API}/v1/path/${incident.id}?pkg=${encodeURIComponent(member.pkg)}&version=${encodeURIComponent(member.semver)}`
    const path = (await (await fetch(url)).json()) as { chain: { pkg: string; version: string }[] }
    const root = path.chain[0]
    if (root !== undefined && (targets.has(`${root.pkg}@${root.version}`) || targetPkgs.has(root.pkg))) {
      reachTarget += 1
    } else {
      failures.push({ member: `${member.pkg}@${member.semver}`, root })
    }
  }
  return {
    sampled: sample.length,
    reachTarget,
    passRate: sample.length === 0 ? 0 : Math.round((reachTarget / sample.length) * 10000) / 10000,
    failures,
  }
}

async function runReplay(incident: Incident, points: number): Promise<Record<string, unknown>> {
  const span = incident.windowEnd - incident.windowStart
  const observations: number[] = []
  let cold = 0
  for (let i = 0; i < points; i += 1) {
    const t = incident.windowStart + Math.round((span * i) / (points - 1))
    const response = (await (await fetch(`${API}/v1/blast/${incident.id}?t=${t}`)).json()) as {
      latencyMs: number
    }
    if (i === 0) cold = response.latencyMs
    else observations.push(response.latencyMs)
  }
  const sorted = [...observations].sort((a, b) => a - b)
  return {
    points,
    coldMs: Math.round(cold * 10) / 10,
    warmP50Ms: percentile(sorted, 50),
    warmP95Ms: percentile(sorted, 95),
    warmMinMs: sorted[0] ?? 0,
    warmMaxMs: sorted[sorted.length - 1] ?? 0,
  }
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const meta = metadata()
  const incidentDoc = JSON.parse(
    readFileSync(resolve(REPO_ROOT, `fixtures/incidents/${INCIDENT}.json`), "utf8"),
  ) as Incident

  const parity = await runParity(incidentDoc)
  writeFileSync(
    resolve(EVIDENCE_DIR, "campaign-report.json"),
    JSON.stringify({ metadata: meta, incident: INCIDENT, ...parity }, null, 2),
  )
  const pathAudit = await runPathAudit(incidentDoc, 100)
  writeFileSync(
    resolve(EVIDENCE_DIR, "path-audit.json"),
    JSON.stringify({ metadata: meta, incident: INCIDENT, ...pathAudit }, null, 2),
  )
  const replay = await runReplay(incidentDoc, 100)
  writeFileSync(
    resolve(EVIDENCE_DIR, "replay-latency.json"),
    JSON.stringify({ metadata: meta, incident: INCIDENT, ...replay }, null, 2),
  )

  console.log("\n=== campaign summary ===")
  console.log(
    `services ${(parity as { cohortSize: number }).cohortSize}, service-class agreement ${JSON.stringify((parity as { serviceAgreement: unknown }).serviceAgreement)}`,
  )
  console.log(`package agreement ${JSON.stringify((parity as { packageAgreement: unknown }).packageAgreement)}`)
  console.log(`path audit ${JSON.stringify(pathAudit)}`)
  console.log(`replay ${JSON.stringify(replay)}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

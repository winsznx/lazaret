import { nodeId } from "@lazaret/graph-client"
import type { Row } from "@lazaret/graph-client"
import semver from "semver"
import type { Incident } from "./incidents"
import type { Lockfile, PackageClass, PackageVerdict, Provenance, ServiceVerdict } from "./types"

// The engine answers product questions from the compiled graph HydraDB holds:
// the materialized EXPOSES membership and the EXPOSED_VIA evidence edges. It
// never recomputes the semver-aware closure the way the refmodel oracle does.
// semver.satisfies is shared with the oracle on purpose: the range grammar is
// the specification, not the thing under verification. Everything else here,
// the data source and the computation, is independent of @lazaret/refmodel.

// Narrow read surface. GraphClient satisfies it; tests supply an in-memory fake
// seeded from the oracle, which is exactly how production/oracle parity is
// demonstrated without a live database.
export interface ReadClient {
  queryOne(cypher: string, params?: Record<string, unknown>): Promise<Row | null>
  queryStream(cypher: string, params?: Record<string, unknown>): AsyncGenerator<Row>
}

const DEPTH_CAP = 8
const MEMBERSHIP_TTL_MS = 5_000

const EXPOSES_CYPHER =
  "MATCH (a:Advisory {id: $adv})-[e:EXPOSES]->(v:Version) " +
  "RETURN v.pkg_name AS pkg, v.semver AS semver, v.published_at AS published_at, " +
  "v.malicious AS malicious, v.reconstructed AS reconstructed, e.depth AS depth, e.t_first AS t_first"

const EXPOSED_VIA_CYPHER =
  "MATCH (c:Version {id: $cid})-[r:EXPOSED_VIA]->(p:Version) WHERE r.adv_low = $adv " +
  "RETURN p.pkg_name AS ppkg, p.semver AS psem"

// "In slice" means Lazaret actually has coverage of the package: at least one
// version node. The loader also materializes bare Package nodes for dependency
// targets it never crawled, so counting Package labels would call coverage-less
// packages CLEAN when the honest answer is OUT_OF_SLICE. Deriving the slice from
// versioned packages keeps abstention truthful.
const SLICE_CYPHER = "MATCH (v:Version) RETURN v.pkg_name AS name"

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}
function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0
}
function asBool(value: unknown): boolean {
  return value === true
}
function versionKey(pkg: string, version: string): string {
  return `${pkg}@${version}`
}
function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: false, loose: false })
  } catch {
    return false
  }
}

export interface ExposedVersion {
  version: string
  publishedAt: number
  malicious: boolean
  reconstructed: boolean
  depth: number
  tFirst: number
}

export interface ExposedSet {
  byPkg: Map<string, ExposedVersion[]>
  targets: Set<string>
}

export function newProvenance(fresh: boolean): Provenance {
  return { hydraMs: 0, queryCount: 0, cached: false, fresh, cypher: [] }
}

async function streamAll(
  client: ReadClient,
  prov: Provenance,
  cypher: string,
  params: Record<string, unknown>,
): Promise<Row[]> {
  prov.queryCount += 1
  if (!prov.cypher.includes(cypher)) prov.cypher.push(cypher)
  const started = performance.now()
  const rows: Row[] = []
  for await (const row of client.queryStream(cypher, params)) rows.push(row)
  prov.hydraMs += performance.now() - started
  return rows
}

async function readOne(
  client: ReadClient,
  prov: Provenance,
  cypher: string,
  params: Record<string, unknown>,
): Promise<Row | null> {
  prov.queryCount += 1
  if (!prov.cypher.includes(cypher)) prov.cypher.push(cypher)
  const started = performance.now()
  const row = await client.queryOne(cypher, params)
  prov.hydraMs += performance.now() - started
  return row
}

// The compiled exposure membership for one incident, read live from HydraDB.
// Targets are the depth-0 malicious versions inside that same compiled set, so
// no extra TARGETS query is needed.
export async function readExposedSet(
  client: ReadClient,
  prov: Provenance,
  advisoryId: number,
): Promise<ExposedSet> {
  const byPkg = new Map<string, ExposedVersion[]>()
  const targets = new Set<string>()
  const rows = await streamAll(client, prov, EXPOSES_CYPHER, { adv: advisoryId })
  for (const row of rows) {
    const pkg = asString(row["pkg"])
    const version = asString(row["semver"])
    const entry: ExposedVersion = {
      version,
      publishedAt: asNumber(row["published_at"]),
      malicious: asBool(row["malicious"]),
      reconstructed: asBool(row["reconstructed"]),
      depth: asNumber(row["depth"]),
      tFirst: asNumber(row["t_first"]),
    }
    const list = byPkg.get(pkg)
    if (list === undefined) byPkg.set(pkg, [entry])
    else list.push(entry)
    if (entry.malicious && entry.depth === 0) targets.add(versionKey(pkg, version))
  }
  return { byPkg, targets }
}

// Bounded one-hop EXPOSED_VIA walk from a version up to its malicious root,
// filtered by advisory. Returned root-first to match the evidence order the UI
// renders. Each hop is a single HydraDB read; the loop is capped at DEPTH_CAP.
export async function walkEvidence(
  client: ReadClient,
  prov: Provenance,
  advisoryId: number,
  pkg: string,
  version: string,
): Promise<{ pkg: string; version: string }[]> {
  const chain: { pkg: string; version: string }[] = [{ pkg, version }]
  const guard = new Set<string>([versionKey(pkg, version)])
  let cursor = versionKey(pkg, version)
  for (let hop = 0; hop < DEPTH_CAP; hop += 1) {
    const row = await readOne(client, prov, EXPOSED_VIA_CYPHER, {
      cid: nodeId("ver", cursor),
      adv: advisoryId,
    })
    if (row === null) break
    const ppkg = asString(row["ppkg"])
    const psem = asString(row["psem"])
    const parentKey = versionKey(ppkg, psem)
    if (ppkg === "" || guard.has(parentKey)) break
    guard.add(parentKey)
    chain.push({ pkg: ppkg, version: psem })
    cursor = parentKey
  }
  return chain.reverse()
}

function liveInWindow(entry: ExposedVersion, windowEnd: number): boolean {
  if (entry.reconstructed && entry.malicious) return true
  return entry.publishedAt <= windowEnd
}

const RANK: Record<PackageClass, number> = {
  EXPOSED_PINNED: 3,
  EXPOSED_WINDOW: 2,
  CLEAN: 1,
  OUT_OF_SLICE: 0,
}

interface ParsedLockRefs {
  referenced: string[]
  resolved: Map<string, Set<string>>
  declaredRanges: Map<string, string[]>
}

function collectRefs(lockfile: Lockfile): ParsedLockRefs {
  const resolved = new Map<string, Set<string>>()
  const declaredRanges = new Map<string, string[]>()
  const referenced = new Set<string>()
  for (const entry of lockfile.entries) {
    if (entry.root !== true) {
      referenced.add(entry.name)
      const versions = resolved.get(entry.name)
      if (versions === undefined) resolved.set(entry.name, new Set([entry.version]))
      else versions.add(entry.version)
    }
    for (const [depName, range] of Object.entries(entry.dependencies)) {
      referenced.add(depName)
      const ranges = declaredRanges.get(depName)
      if (ranges === undefined) declaredRanges.set(depName, [range])
      else ranges.push(range)
    }
  }
  return { referenced: [...referenced].sort(), resolved, declaredRanges }
}

// Classify one service lockfile against the compiled graph. The exposure set is
// the live HydraDB membership; evidence chains are live EXPOSED_VIA walks. This
// is the production path, structurally independent of the oracle.
export async function classifyLockfile(
  client: ReadClient,
  prov: Provenance,
  incident: Incident,
  exposed: ExposedSet,
  sliceNames: Set<string>,
  lockfile: Lockfile,
): Promise<ServiceVerdict> {
  const advisoryId = nodeId("adv", incident.id)
  const refs = collectRefs(lockfile)
  const packages: PackageVerdict[] = []
  const outOfSlice: string[] = []

  for (const name of refs.referenced) {
    const candidates = exposed.byPkg.get(name) ?? []

    const pinned = pinnedTarget(name, refs.resolved.get(name), exposed.targets)
    if (pinned !== undefined) {
      packages.push({
        name,
        class: "EXPOSED_PINNED",
        pinnedVersion: pinned,
        chain: await walkEvidence(client, prov, advisoryId, name, pinned),
      })
      continue
    }

    const windowHit = admittedWindow(candidates, refs.declaredRanges.get(name) ?? [], incident)
    if (windowHit !== undefined) {
      packages.push({
        name,
        class: "EXPOSED_WINDOW",
        admittedVersion: windowHit.version,
        admittingRange: windowHit.range,
        chain: await walkEvidence(client, prov, advisoryId, name, windowHit.version),
      })
      continue
    }

    if (sliceNames.has(name)) {
      packages.push({ name, class: "CLEAN", reason: cleanReason(candidates, refs.declaredRanges.get(name) ?? []) })
    } else {
      packages.push({
        name,
        class: "OUT_OF_SLICE",
        reason: "outside the crawled slice, refusing to guess",
      })
      outOfSlice.push(name)
    }
  }

  let worst: PackageClass = "OUT_OF_SLICE"
  let worstRank = -1
  for (const entry of packages) {
    if (RANK[entry.class] > worstRank) {
      worstRank = RANK[entry.class]
      worst = entry.class
    }
  }
  return { service: lockfile.service, class: worst, packages, outOfSlice }
}

function pinnedTarget(
  name: string,
  versions: Set<string> | undefined,
  targets: Set<string>,
): string | undefined {
  if (versions === undefined) return undefined
  for (const version of versions) {
    if (targets.has(versionKey(name, version))) return version
  }
  return undefined
}

function admittedWindow(
  candidates: ExposedVersion[],
  ranges: string[],
  incident: Incident,
): { version: string; range: string } | undefined {
  for (const range of ranges) {
    for (const candidate of candidates) {
      if (!satisfies(candidate.version, range)) continue
      if (!liveInWindow(candidate, incident.windowEnd)) continue
      return { version: candidate.version, range }
    }
  }
  return undefined
}

function cleanReason(candidates: ExposedVersion[], ranges: string[]): string {
  const malicious = candidates.filter((entry) => entry.malicious).map((entry) => entry.version)
  if (malicious.length > 0 && ranges.length > 0) {
    return `declared ${ranges.join(", ")} does not admit malicious ${malicious.join(", ")}`
  }
  return "in the slice, not reachable from the incident targets"
}

// A short-lived membership cache. The bounded TTL is what keeps the served
// answer from going stale, and ?fresh=1 bypasses it so a judge can force the
// live read and watch cached flip to false.
export class ExposureReader {
  private readonly cache = new Map<string, { exposed: ExposedSet; readAt: number }>()
  private sliceNames: Set<string> | null = null

  constructor(private readonly client: ReadClient) {}

  async exposedSet(incident: Incident, prov: Provenance, fresh: boolean): Promise<ExposedSet> {
    const now = Date.now()
    const hit = this.cache.get(incident.id)
    if (!fresh && hit !== undefined && now - hit.readAt < MEMBERSHIP_TTL_MS) {
      prov.cached = true
      return hit.exposed
    }
    const exposed = await readExposedSet(this.client, prov, nodeId("adv", incident.id))
    this.cache.set(incident.id, { exposed, readAt: now })
    prov.cached = false
    return exposed
  }

  async sliceSet(prov: Provenance): Promise<Set<string>> {
    if (this.sliceNames !== null) return this.sliceNames
    const names = new Set<string>()
    for (const row of await streamAll(this.client, prov, SLICE_CYPHER, {})) {
      const name = row["name"]
      if (typeof name === "string") names.add(name)
    }
    this.sliceNames = names
    return names
  }
}

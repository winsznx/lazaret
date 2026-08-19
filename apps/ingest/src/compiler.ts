import type {
  AdvisoryInput,
  ExposedViaInput,
  ExposesInput,
  HasVersionInput,
  PackageInput,
  Row,
  TargetsInput,
  VersionInput,
} from "@lazaret/graph-client"
import { edgeId, nodeId } from "@lazaret/graph-client"
import semver from "semver"
import { asBool, asNumber, asString } from "./coerce"
import type { Incident, IncidentTarget } from "./incident"

// The compiler reads and writes the graph through this narrow surface, so the
// frontier BFS can be exercised in tests with an in-memory fake and against a
// live HydraDB in verify, both structurally satisfied by GraphClient.
export interface CompilerClient {
  queryOne(cypher: string, params?: Record<string, unknown>): Promise<Row | null>
  queryStream(cypher: string, params?: Record<string, unknown>): AsyncGenerator<Row>
  upsertPackages(rows: PackageInput[]): Promise<void>
  upsertVersions(rows: VersionInput[]): Promise<void>
  upsertHasVersion(rows: HasVersionInput[]): Promise<void>
  upsertAdvisories(rows: AdvisoryInput[]): Promise<void>
  upsertTargets(rows: TargetsInput[]): Promise<void>
  upsertExposes(rows: ExposesInput[]): Promise<void>
  upsertExposedVia(rows: ExposedViaInput[]): Promise<void>
}

export interface CompileConfig {
  countedKinds: Set<string>
  depthCap: number
}

export const DEFAULT_COMPILE_CONFIG: CompileConfig = {
  countedKinds: new Set(["prod", "peer", "optional"]),
  depthCap: 8,
}

export interface CompileResult {
  incidentId: string
  advisoryId: number
  members: number
  depthHistogram: number[]
  capHit: boolean
  reverseReads: number
  ms: number
}

interface Frontier {
  id: number
  pkgName: string
  semver: string
  publishedAt: number
  malicious: boolean
  reconstructed: boolean
  depth: number
  tFirst: number
  parentId: number | null
}

interface DependentRow {
  id: number
  pkg: string
  semver: string
  publishedAt: number
  range: string
  kind: string
}

function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: false, loose: false })
  } catch {
    return false
  }
}

function live(node: Frontier, incident: Incident): boolean {
  if (node.reconstructed && node.malicious) return true
  return node.publishedAt <= incident.windowEnd
}

async function ensureTarget(
  client: CompilerClient,
  incident: Incident,
  target: IncidentTarget,
): Promise<Frontier> {
  const key = `${target.pkg}@${target.version}`
  const verId = nodeId("ver", key)
  const row = await client.queryOne(
    "MATCH (v:Version {id: $id}) RETURN v.pkg_name AS pkg, v.semver AS semver, v.published_at AS published_at, v.malicious AS malicious, v.reconstructed AS reconstructed",
    { id: verId },
  )

  if (row === null) {
    const pkgId = nodeId("pkg", target.pkg)
    const publishedAt = target.publishedAt ?? incident.windowStart
    await client.upsertPackages([{ id: pkgId, name: target.pkg }])
    await client.upsertVersions([
      {
        id: verId,
        pkgName: target.pkg,
        semver: target.version,
        publishedAt,
        malicious: true,
        reconstructed: true,
      },
    ])
    await client.upsertHasVersion([{ pkgId, verId, rid: edgeId("HAS_VERSION", key) }])
    return {
      id: verId,
      pkgName: target.pkg,
      semver: target.version,
      publishedAt,
      malicious: true,
      reconstructed: true,
      depth: 0,
      tFirst: publishedAt,
      parentId: null,
    }
  }

  const publishedAt = asNumber(row["published_at"])
  return {
    id: verId,
    pkgName: asString(row["pkg"]),
    semver: asString(row["semver"]),
    publishedAt,
    malicious: asBool(row["malicious"]),
    reconstructed: asBool(row["reconstructed"]),
    depth: 0,
    tFirst: publishedAt,
    parentId: null,
  }
}

async function readDependents(client: CompilerClient, pkgName: string): Promise<DependentRow[]> {
  const pid = nodeId("pkg", pkgName)
  const rows: DependentRow[] = []
  const stream = client.queryStream(
    "MATCH (p:Package {id: $pid})<-[e:DEPENDS_ON]-(v:Version) RETURN v.id AS id, v.pkg_name AS pkg, v.semver AS semver, v.published_at AS published_at, e.range AS range, e.kind AS kind",
    { pid },
  )
  for await (const row of stream) {
    rows.push({
      id: asNumber(row["id"]),
      pkg: asString(row["pkg"]),
      semver: asString(row["semver"]),
      publishedAt: asNumber(row["published_at"]),
      range: asString(row["range"]),
      kind: asString(row["kind"]),
    })
  }
  return rows
}

export async function compileIncident(
  client: CompilerClient,
  incident: Incident,
  config: CompileConfig = DEFAULT_COMPILE_CONFIG,
): Promise<CompileResult> {
  const started = performance.now()
  const advisoryId = nodeId("adv", incident.id)

  const targets: Frontier[] = []
  for (const target of incident.targets) {
    targets.push(await ensureTarget(client, incident, target))
  }

  await client.upsertAdvisories([
    {
      id: advisoryId,
      sourceId: incident.sourceId,
      publishedAt: incident.windowStart,
      windowStart: incident.windowStart,
      windowEnd: incident.windowEnd,
      windowEndEstimated: incident.windowEndEstimated,
    },
  ])
  await client.upsertTargets(
    targets.map((t) => ({
      advId: advisoryId,
      verId: t.id,
      rid: edgeId("TARGETS", `${advisoryId}->${t.id}`),
    })),
  )

  const members = new Map<number, Frontier>()
  const queue: Frontier[] = []
  for (const target of targets) {
    if (!members.has(target.id)) {
      members.set(target.id, target)
      queue.push(target)
    }
  }

  const reverseCache = new Map<string, DependentRow[]>()
  let reverseReads = 0
  let capHit = false
  let head = 0
  while (head < queue.length) {
    const frontier = queue[head]
    head += 1
    if (frontier === undefined || !live(frontier, incident)) continue

    let dependents = reverseCache.get(frontier.pkgName)
    if (dependents === undefined) {
      dependents = await readDependents(client, frontier.pkgName)
      reverseCache.set(frontier.pkgName, dependents)
      reverseReads += 1
    }

    for (const dependent of dependents) {
      if (!config.countedKinds.has(dependent.kind)) continue
      if (!satisfies(frontier.semver, dependent.range)) continue
      if (members.has(dependent.id)) continue
      const depth = frontier.depth + 1
      if (depth > config.depthCap) {
        capHit = true
        continue
      }
      const member: Frontier = {
        id: dependent.id,
        pkgName: dependent.pkg,
        semver: dependent.semver,
        publishedAt: dependent.publishedAt,
        malicious: false,
        reconstructed: false,
        depth,
        tFirst: Math.max(frontier.tFirst, dependent.publishedAt),
        parentId: frontier.id,
      }
      members.set(dependent.id, member)
      queue.push(member)
    }
  }

  const exposes: ExposesInput[] = []
  const exposedVia: ExposedViaInput[] = []
  const depthHistogram: number[] = []
  for (const member of members.values()) {
    exposes.push({
      advId: advisoryId,
      verId: member.id,
      rid: edgeId("EXPOSES", `${advisoryId}->${member.id}`),
      depth: member.depth,
      tFirst: member.tFirst,
    })
    if (member.parentId !== null) {
      exposedVia.push({
        childId: member.id,
        parentId: member.parentId,
        rid: edgeId("EXPOSED_VIA", `${member.id}->${member.parentId}:${advisoryId}`),
        advLow: advisoryId,
        advHigh: 0,
      })
    }
    depthHistogram[member.depth] = (depthHistogram[member.depth] ?? 0) + 1
  }
  await client.upsertExposes(exposes)
  await client.upsertExposedVia(exposedVia)

  return {
    incidentId: incident.id,
    advisoryId,
    members: members.size,
    depthHistogram,
    capHit,
    reverseReads,
    ms: performance.now() - started,
  }
}

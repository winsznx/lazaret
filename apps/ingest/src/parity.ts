import type { Advisory, Dependency, GraphSnapshot, VersionNode } from "@lazaret/refmodel"
import { asNumber, asString } from "./coerce"
import type { CompilerClient } from "./compiler"
import type { Incident } from "./incident"
import type { NormalizedSlice } from "./records"

export function sliceToSnapshot(slice: NormalizedSlice): GraphSnapshot {
  const depsByVersion = new Map<string, Dependency[]>()
  for (const edge of slice.edges) {
    const key = `${edge.fromPkg}@${edge.fromVersion}`
    const dependency: Dependency = { pkg: edge.toPackage, range: edge.range, kind: edge.kind }
    const list = depsByVersion.get(key)
    if (list === undefined) depsByVersion.set(key, [dependency])
    else list.push(dependency)
  }
  const versions: VersionNode[] = slice.versions.map((version) => ({
    pkg: version.pkg,
    version: version.version,
    publishedAt: version.publishedAt,
    malicious: version.malicious ?? false,
    reconstructed: version.reconstructed ?? false,
    dependencies: depsByVersion.get(`${version.pkg}@${version.version}`) ?? [],
  }))
  return { versions }
}

export function incidentToAdvisory(incident: Incident): Advisory {
  return {
    id: incident.id,
    targets: incident.targets.map((target) => ({ pkg: target.pkg, version: target.version })),
    windowStart: incident.windowStart,
    windowEnd: incident.windowEnd,
  }
}

export async function readExposed(
  client: CompilerClient,
  advisoryId: number,
): Promise<Map<string, number>> {
  const exposed = new Map<string, number>()
  const stream = client.queryStream(
    "MATCH (a:Advisory {id: $adv})-[e:EXPOSES]->(v:Version) RETURN v.pkg_name AS pkg, v.semver AS semver, e.depth AS depth",
    { adv: advisoryId },
  )
  for await (const row of stream) {
    exposed.set(`${asString(row["pkg"])}@${asString(row["semver"])}`, asNumber(row["depth"]))
  }
  return exposed
}

export interface ParityResult {
  ok: boolean
  missing: string[]
  extra: string[]
  depthMismatches: string[]
}

export function compareParity(
  refMembers: Map<string, { depth: number }>,
  compiled: Map<string, number>,
): ParityResult {
  const missing: string[] = []
  const extra: string[] = []
  const depthMismatches: string[] = []
  for (const [key, member] of refMembers) {
    if (!compiled.has(key)) missing.push(key)
    else if (compiled.get(key) !== member.depth) depthMismatches.push(key)
  }
  for (const key of compiled.keys()) {
    if (!refMembers.has(key)) extra.push(key)
  }
  return {
    ok: missing.length === 0 && extra.length === 0 && depthMismatches.length === 0,
    missing,
    extra,
    depthMismatches,
  }
}

import { GraphClient, nodeId } from "@lazaret/graph-client"
import type {
  Advisory,
  Closure,
  ClosureMember,
  GraphSnapshot,
  VersionNode,
} from "@lazaret/refmodel"
import { versionKey } from "@lazaret/refmodel"
import type { Incident } from "./incidents"

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}
function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0
}
function asBool(value: unknown): boolean {
  return value === true
}

export interface IncidentContext {
  advisory: Advisory
  closure: Closure
  snapshot: GraphSnapshot
}

// The verdict needs the compiled closure and the referenced versions' publish
// times. Both are read straight from HydraDB, so the API never holds the graph.
export async function buildIncidentContext(
  client: GraphClient,
  incident: Incident,
): Promise<IncidentContext> {
  const advisoryId = nodeId("adv", incident.id)
  const members = new Map<string, ClosureMember>()
  const versions: VersionNode[] = []

  const exposesStream = client.queryStream(
    "MATCH (a:Advisory {id: $adv})-[e:EXPOSES]->(v:Version) RETURN v.pkg_name AS pkg, v.semver AS semver, v.published_at AS published_at, v.malicious AS malicious, v.reconstructed AS reconstructed, e.depth AS depth, e.t_first AS t_first",
    { adv: advisoryId },
  )
  for await (const row of exposesStream) {
    const pkg = asString(row["pkg"])
    const version = asString(row["semver"])
    members.set(versionKey(pkg, version), {
      pkg,
      version,
      depth: asNumber(row["depth"]),
      tFirst: asNumber(row["t_first"]),
      parent: null,
      viaRange: null,
      viaOptional: false,
    })
    versions.push({
      pkg,
      version,
      publishedAt: asNumber(row["published_at"]),
      malicious: asBool(row["malicious"]),
      reconstructed: asBool(row["reconstructed"]),
      dependencies: [],
    })
  }

  const viaStream = client.queryStream(
    "MATCH (c:Version)-[r:EXPOSED_VIA]->(p:Version) WHERE r.adv_low = $adv RETURN c.pkg_name AS cpkg, c.semver AS csem, p.pkg_name AS ppkg, p.semver AS psem",
    { adv: advisoryId },
  )
  for await (const row of viaStream) {
    const member = members.get(versionKey(asString(row["cpkg"]), asString(row["csem"])))
    if (member !== undefined) {
      member.parent = { pkg: asString(row["ppkg"]), version: asString(row["psem"]) }
    }
  }

  const advisory: Advisory = {
    id: incident.id,
    targets: incident.targets.map((t) => ({ pkg: t.pkg, version: t.version })),
    windowStart: incident.windowStart,
    windowEnd: incident.windowEnd,
  }
  const closure: Closure = { advisoryId: incident.id, members, depthCap: 8, capHit: false }
  return { advisory, closure, snapshot: { versions } }
}

export async function readSliceNames(client: GraphClient): Promise<Set<string>> {
  const names = new Set<string>()
  for await (const row of client.queryStream("MATCH (n:Package) RETURN n.name AS name")) {
    const name = row["name"]
    if (typeof name === "string") names.add(name)
  }
  return names
}

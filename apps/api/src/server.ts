import cors from "@fastify/cors"
import { GraphClient, nodeId } from "@lazaret/graph-client"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { ExposureReader, classifyLockfile, newProvenance, walkEvidence } from "./engine"
import type { Incident } from "./incidents"
import { parseLockfile } from "./lockfile"
import type { Provenance, ServiceVerdict } from "./types"

const MAX_BODY_BYTES = 10 * 1024 * 1024

interface VerdictBody {
  incident?: string
  lockfiles?: { service?: string; lockfile?: unknown }[]
}

interface IncidentSummary {
  id: string
  sourceId: string
  windowStart: number
  windowEnd: number
  windowEndEstimated: boolean
  targets: number
  exposed: number
  compiled: boolean
}

function provenanceView(prov: Provenance): {
  hydraMs: number
  queryCount: number
  cached: boolean
  fresh: boolean
  cypher: string
} {
  return {
    hydraMs: Math.round(prov.hydraMs * 10) / 10,
    queryCount: prov.queryCount,
    cached: prov.cached,
    fresh: prov.fresh,
    cypher: prov.cypher.join("\n\n"),
  }
}

function isFresh(value: string | undefined): boolean {
  return value === "1" || value === "true"
}

export async function createServer(
  client: GraphClient,
  incidents: Incident[],
): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, logger: false })
  await app.register(cors, { origin: true })

  const byId = new Map(incidents.map((incident) => [incident.id, incident]))
  const reader = new ExposureReader(client)

  const countLabel = async (label: string): Promise<number> => {
    const row = await client.queryOne(`MATCH (n:${label}) RETURN count(*) AS c`)
    const value = row?.["c"]
    return typeof value === "number" ? value : 0
  }

  // Health is only meaningful if the graph that powers the product answers. A
  // cheap count proves the Bolt/HTTP path to HydraDB is live, not just that the
  // API process is up.
  app.get("/healthz", async (_request, reply) => {
    const started = performance.now()
    try {
      const row = await client.queryOne("MATCH (a:Advisory) RETURN count(*) AS c")
      const advisories = typeof row?.["c"] === "number" ? (row["c"] as number) : 0
      return {
        ok: true,
        hydra: "up",
        advisories,
        hydraMs: Math.round((performance.now() - started) * 10) / 10,
      }
    } catch (error) {
      reply.code(503)
      return {
        ok: false,
        hydra: "down",
        error: error instanceof Error ? error.message : "hydradb unreachable",
      }
    }
  })

  app.get("/v1/incidents", async () => {
    const summaries: IncidentSummary[] = []
    for (const incident of incidents) {
      const row = await client.queryOne(
        "MATCH (a:Advisory {id: $id})-[e:EXPOSES]->() RETURN count(*) AS c",
        { id: nodeId("adv", incident.id) },
      )
      const value = row?.["c"]
      const exposed = typeof value === "number" ? value : 0
      summaries.push({
        id: incident.id,
        sourceId: incident.sourceId,
        windowStart: incident.windowStart,
        windowEnd: incident.windowEnd,
        windowEndEstimated: incident.windowEndEstimated,
        targets: incident.targets.length,
        exposed,
        compiled: exposed > 0,
      })
    }
    return { incidents: summaries }
  })

  app.get<{ Params: { incident: string }; Querystring: { t?: string } }>(
    "/v1/blast/:incident",
    async (request, reply) => {
      const incident = byId.get(request.params.incident)
      if (incident === undefined) {
        reply.code(404)
        return { error: "unknown incident" }
      }
      const t = request.query.t !== undefined ? Number(request.query.t) : incident.windowEnd
      const cypher =
        "MATCH (a:Advisory {id: $adv})-[e:EXPOSES]->(v:Version) WHERE e.t_first <= $t RETURN v.pkg_name AS pkg, v.semver AS semver, e.depth AS depth, e.t_first AS t_first"
      const started = performance.now()
      const members = await client.queryAll(cypher, { adv: nodeId("adv", incident.id), t })
      const latencyMs = Math.round((performance.now() - started) * 10) / 10
      return {
        incident: incident.id,
        t,
        count: members.length,
        latencyMs,
        hydraMs: latencyMs,
        queryCount: 1,
        cached: false,
        fresh: true,
        consistency: "causal",
        cypher,
        members,
      }
    },
  )

  app.get<{
    Params: { incident: string }
    Querystring: { pkg?: string; version?: string; fresh?: string }
  }>("/v1/path/:incident", async (request, reply) => {
    const incident = byId.get(request.params.incident)
    if (incident === undefined) {
      reply.code(404)
      return { error: "unknown incident" }
    }
    const pkg = request.query.pkg ?? ""
    const version = request.query.version ?? ""
    const prov = newProvenance(true)
    const chain = await walkEvidence(client, prov, nodeId("adv", incident.id), pkg, version)
    return { incident: incident.id, pkg, version, chain, provenance: provenanceView(prov) }
  })

  app.post<{ Body: VerdictBody; Querystring: { fresh?: string } }>(
    "/v1/verdict",
    async (request, reply) => {
      const body = request.body
      const incident = typeof body.incident === "string" ? byId.get(body.incident) : undefined
      if (incident === undefined) {
        reply.code(400)
        return { error: "unknown or missing incident" }
      }
      if (!Array.isArray(body.lockfiles) || body.lockfiles.length === 0) {
        reply.code(400)
        return { error: "provide at least one lockfile" }
      }
      const fresh = isFresh(request.query.fresh)
      const prov = newProvenance(fresh)
      const exposed = await reader.exposedSet(incident, prov, fresh)
      const sliceNames = await reader.sliceSet(prov)
      const verdicts: ServiceVerdict[] = []
      for (const item of body.lockfiles) {
        const service = typeof item.service === "string" ? item.service : "service"
        let parsed
        try {
          parsed = parseLockfile(service, item.lockfile)
        } catch (error) {
          reply.code(422)
          return { error: error instanceof Error ? error.message : "lockfile parse error" }
        }
        verdicts.push(await classifyLockfile(client, prov, incident, exposed, sliceNames, parsed))
      }
      return { incident: incident.id, verdicts, provenance: provenanceView(prov) }
    },
  )

  app.get("/v1/stats", async () => {
    const [packages, versions, advisories] = await Promise.all([
      countLabel("Package"),
      countLabel("Version"),
      countLabel("Advisory"),
    ])
    return { packages, versions, advisories, incidents: incidents.length }
  })

  // The maintainer accounts behind the compromised packages, and each account's
  // reach. Read live from the MAINTAINS edges: this is the blast radius of the
  // account, not just the package.
  app.get<{ Params: { incident: string } }>("/v1/maintainers/:incident", async (request, reply) => {
    const incident = byId.get(request.params.incident)
    if (incident === undefined) {
      reply.code(404)
      return { error: "unknown incident" }
    }
    const accounts = new Map<string, { login: string; mid: number; packagesTotal: number }>()
    for (const pkg of new Set(incident.targets.map((t) => t.pkg))) {
      const rows = await client.queryAll(
        "MATCH (m:Maintainer)-[e:MAINTAINS]->(p:Package {id: $pid}) RETURN m.login AS login, m.id AS mid, m.packages_total AS total",
        { pid: nodeId("pkg", pkg) },
      )
      for (const row of rows) {
        const login = typeof row["login"] === "string" ? row["login"] : ""
        const mid = typeof row["mid"] === "number" ? row["mid"] : 0
        const total = typeof row["total"] === "number" ? row["total"] : 0
        if (login.length > 0) accounts.set(login, { login, mid, packagesTotal: total })
      }
    }
    const maintainers = []
    for (const account of accounts.values()) {
      const owned = await client.queryAll(
        "MATCH (m:Maintainer {id: $mid})-[e:MAINTAINS]->(p:Package) RETURN p.name AS name",
        { mid: account.mid },
      )
      const inSlice = owned
        .map((row) => (typeof row["name"] === "string" ? row["name"] : ""))
        .filter((name) => name.length > 0)
        .sort()
      maintainers.push({
        login: account.login,
        packagesTotal: account.packagesTotal,
        inSliceCount: inSlice.length,
        inSlice,
      })
    }
    maintainers.sort((a, b) => b.packagesTotal - a.packagesTotal)
    return { incident: incident.id, maintainers }
  })

  // Packages whose names sit within a small edit distance of a compromised
  // package. Surfaced as confusion candidates, never asserted typosquats.
  app.get<{ Params: { incident: string } }>("/v1/similar/:incident", async (request, reply) => {
    const incident = byId.get(request.params.incident)
    if (incident === undefined) {
      reply.code(404)
      return { error: "unknown incident" }
    }
    const candidates: { target: string; candidate: string; distance: number; reason: string }[] = []
    for (const pkg of new Set(incident.targets.map((t) => t.pkg))) {
      const rows = await client.queryAll(
        "MATCH (t:Package {id: $pid})-[r:SIMILAR_NAME]->(c:Package) RETURN c.name AS name, r.distance AS distance, r.reason AS reason",
        { pid: nodeId("pkg", pkg) },
      )
      for (const row of rows) {
        const candidate = typeof row["name"] === "string" ? row["name"] : ""
        const distance = typeof row["distance"] === "number" ? row["distance"] : 0
        const reason = typeof row["reason"] === "string" ? row["reason"] : ""
        if (candidate.length > 0) candidates.push({ target: pkg, candidate, distance, reason })
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    return { incident: incident.id, candidates }
  })

  return app
}

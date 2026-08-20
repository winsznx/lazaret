import cors from "@fastify/cors"
import { GraphClient, nodeId } from "@lazaret/graph-client"
import { closureChain, verdict } from "@lazaret/refmodel"
import type { ServiceVerdict } from "@lazaret/refmodel"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import { buildIncidentContext, readSliceNames } from "./context"
import type { IncidentContext } from "./context"
import type { Incident } from "./incidents"
import { parseLockfile } from "./lockfile"

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

export async function createServer(
  client: GraphClient,
  incidents: Incident[],
): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: MAX_BODY_BYTES, logger: false })
  await app.register(cors, { origin: true })

  const byId = new Map(incidents.map((incident) => [incident.id, incident]))
  const contextCache = new Map<string, IncidentContext>()
  let sliceNamesCache: Set<string> | null = null

  const getSliceNames = async (): Promise<Set<string>> => {
    if (sliceNamesCache === null) sliceNamesCache = await readSliceNames(client)
    return sliceNamesCache
  }
  const getContext = async (incident: Incident): Promise<IncidentContext> => {
    const cached = contextCache.get(incident.id)
    if (cached !== undefined) return cached
    const built = await buildIncidentContext(client, incident)
    contextCache.set(incident.id, built)
    return built
  }
  const countLabel = async (label: string): Promise<number> => {
    const row = await client.queryOne(`MATCH (n:${label}) RETURN count(*) AS c`)
    const value = row?.["c"]
    return typeof value === "number" ? value : 0
  }

  app.get("/healthz", () => ({ ok: true }))

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
      const started = performance.now()
      const members = await client.queryAll(
        "MATCH (a:Advisory {id: $adv})-[e:EXPOSES]->(v:Version) WHERE e.t_first <= $t RETURN v.pkg_name AS pkg, v.semver AS semver, e.depth AS depth, e.t_first AS t_first",
        { adv: nodeId("adv", incident.id), t },
      )
      const latencyMs = Math.round((performance.now() - started) * 10) / 10
      return { incident: incident.id, t, count: members.length, latencyMs, members }
    },
  )

  app.get<{ Params: { incident: string }; Querystring: { pkg?: string; version?: string } }>(
    "/v1/path/:incident",
    async (request, reply) => {
      const incident = byId.get(request.params.incident)
      if (incident === undefined) {
        reply.code(404)
        return { error: "unknown incident" }
      }
      const pkg = request.query.pkg ?? ""
      const version = request.query.version ?? ""
      const ctx = await getContext(incident)
      const chain = closureChain(ctx.closure, pkg, version).map((member) => ({
        pkg: member.pkg,
        version: member.version,
        depth: member.depth,
        tFirst: member.tFirst,
      }))
      return { incident: incident.id, pkg, version, chain }
    },
  )

  app.post<{ Body: VerdictBody }>("/v1/verdict", async (request, reply) => {
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
    const ctx = await getContext(incident)
    const sliceNames = await getSliceNames()
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
      verdicts.push(verdict(parsed, ctx.advisory, ctx.closure, ctx.snapshot, sliceNames))
    }
    return { incident: incident.id, verdicts }
  })

  app.get("/v1/stats", async () => {
    const [packages, versions, advisories] = await Promise.all([
      countLabel("Package"),
      countLabel("Version"),
      countLabel("Advisory"),
    ])
    return { packages, versions, advisories, incidents: incidents.length }
  })

  return app
}

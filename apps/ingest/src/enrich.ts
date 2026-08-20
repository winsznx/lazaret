import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { edgeId, nodeId } from "@lazaret/graph-client"
import type { GraphClient } from "@lazaret/graph-client"
import pLimit from "p-limit"
import { REPO_ROOT } from "./env"
import type { Incident } from "./incident"
import type { PackageRecord } from "./records"

const REGISTRY = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org"

// Enrichment adds two graph-native surfaces around an incident:
//  1. Maintainer + MAINTAINS: the accounts behind the compromised packages and
//     the blast radius of the account, not just the package. This is the
//     "who else could this account have pushed to" question.
//  2. SIMILAR_NAME: packages in the slice whose names are within a small edit
//     distance of a compromised package, surfaced as confusion candidates, not
//     asserted typosquats.

interface RawMaintainer {
  name?: string
}
interface RawPackument {
  maintainers?: (RawMaintainer | string)[]
}
interface SearchResponse {
  total?: number
  objects?: { package?: { name?: string } }[]
}

export interface MaintainerReach {
  login: string
  total: number
  inSlice: string[]
}
export interface SimilarCandidate {
  target: string
  candidate: string
  distance: number
}
export interface EnrichResult {
  incidentId: string
  maintainers: MaintainerReach[]
  similar: SimilarCandidate[]
}

function encodeName(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2F") : encodeURIComponent(name)
}

function maintainerLogin(entry: RawMaintainer | string): string | null {
  if (typeof entry === "string") return entry.split("<")[0]?.trim() ?? null
  return typeof entry.name === "string" ? entry.name : null
}

async function targetMaintainers(pkg: string): Promise<string[]> {
  const response = await fetch(`${REGISTRY}/${encodeName(pkg)}`, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    await response.body?.cancel()
    return []
  }
  const raw = (await response.json()) as RawPackument
  const logins = new Set<string>()
  for (const entry of raw.maintainers ?? []) {
    const login = maintainerLogin(entry)
    if (login !== null && login.length > 0) logins.add(login)
  }
  return [...logins]
}

async function maintainerPackages(login: string): Promise<{ total: number; names: string[] }> {
  const url = `${REGISTRY}/-/v1/search?text=maintainer:${encodeURIComponent(login)}&size=250`
  const response = await fetch(url, { headers: { Accept: "application/json" } })
  if (!response.ok) {
    await response.body?.cancel()
    return { total: 0, names: [] }
  }
  const raw = (await response.json()) as SearchResponse
  const names = (raw.objects ?? [])
    .map((entry) => entry.package?.name)
    .filter((name): name is string => typeof name === "string")
  return { total: typeof raw.total === "number" ? raw.total : names.length, names }
}

// Bounded Levenshtein: returns the true distance, or max + 1 once it is clear
// the distance exceeds max. Length gap alone can rule a pair out cheaply.
function editDistanceAtMost(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) prev[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    let rowMin = curr[0] as number
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      )
      rowMin = Math.min(rowMin, curr[j] as number)
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] as number
  }
  return prev[b.length] as number
}

function sliceNames(): string[] {
  const dir = resolve(REPO_ROOT, "data/slice")
  const out: string[] = []
  for (const line of readFileSync(resolve(dir, "packages.jsonl"), "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length > 0) out.push((JSON.parse(trimmed) as PackageRecord).name)
  }
  return out
}

export async function enrichIncident(
  client: GraphClient,
  incident: Incident,
  maxDistance = 2,
): Promise<EnrichResult> {
  const targetPkgs = [...new Set(incident.targets.map((t) => t.pkg))]
  const names = sliceNames()
  const inSlice = new Set(names)

  // Maintainers of the compromised packages, and each account's reach.
  const limit = pLimit(8)
  const logins = new Set<string>()
  await Promise.all(
    targetPkgs.map((pkg) =>
      limit(async () => {
        for (const login of await targetMaintainers(pkg)) logins.add(login)
      }),
    ),
  )
  const maintainers: MaintainerReach[] = []
  await Promise.all(
    [...logins].map((login) =>
      limit(async () => {
        const { total, names: owned } = await maintainerPackages(login)
        maintainers.push({ login, total, inSlice: owned.filter((name) => inSlice.has(name)).sort() })
      }),
    ),
  )
  maintainers.sort((a, b) => b.total - a.total)

  // Similar names within a small edit distance of a compromised package.
  const similar: SimilarCandidate[] = []
  for (const target of targetPkgs) {
    for (const candidate of names) {
      if (candidate === target) continue
      const distance = editDistanceAtMost(target, candidate, maxDistance)
      if (distance <= maxDistance) similar.push({ target, candidate, distance })
    }
  }
  similar.sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))

  await loadEnrichment(client, { incidentId: incident.id, maintainers, similar })
  return { incidentId: incident.id, maintainers, similar }
}

async function loadEnrichment(client: GraphClient, result: EnrichResult): Promise<void> {
  const maintainerRows = result.maintainers.map((m) => ({
    id: nodeId("usr", m.login),
    login: m.login,
    total: m.total,
  }))
  if (maintainerRows.length > 0) await client.upsertMaintainers(maintainerRows)

  const maintainsRows = result.maintainers.flatMap((m) =>
    m.inSlice.map((pkg) => ({
      maintainerId: nodeId("usr", m.login),
      pkgId: nodeId("pkg", pkg),
      rid: edgeId("MAINTAINS", `${m.login}->${pkg}`),
    })),
  )
  if (maintainsRows.length > 0) await client.upsertMaintains(maintainsRows)

  const similarRows = result.similar.map((s) => ({
    fromPkgId: nodeId("pkg", s.target),
    toPkgId: nodeId("pkg", s.candidate),
    rid: edgeId("SIMILAR_NAME", `${s.target}->${s.candidate}`),
    distance: s.distance,
    reason: `edit distance ${s.distance} from compromised package ${s.target}`,
  }))
  if (similarRows.length > 0) await client.upsertSimilarNames(similarRows)
}

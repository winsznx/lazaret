const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8080"

export interface IncidentSummary {
  id: string
  sourceId: string
  windowStart: number
  windowEnd: number
  windowEndEstimated: boolean
  targets: number
  exposed: number
  compiled: boolean
}

export interface BlastMember {
  pkg: string
  semver: string
  depth: number
  t_first: number
}

export interface Provenance {
  hydraMs: number
  queryCount: number
  cached: boolean
  fresh: boolean
  cypher: string
}

export interface BlastResponse {
  incident: string
  t: number
  count: number
  latencyMs: number
  hydraMs?: number
  queryCount?: number
  cached?: boolean
  fresh?: boolean
  consistency?: string
  cypher?: string
  members: BlastMember[]
}

export interface PathMember {
  pkg: string
  version: string
  depth: number
  tFirst: number
}

export interface PathResponse {
  incident: string
  pkg: string
  version: string
  chain: PathMember[]
  provenance?: Provenance
}

export type PackageClass = "EXPOSED_PINNED" | "EXPOSED_WINDOW" | "CLEAN" | "OUT_OF_SLICE"

export interface PackageVerdict {
  name: string
  class: PackageClass
  pinnedVersion?: string
  admittedVersion?: string
  admittingRange?: string
  reason?: string
  chain?: { pkg: string; version: string }[]
}

export interface ServiceVerdict {
  service: string
  class: PackageClass
  packages: PackageVerdict[]
  outOfSlice: string[]
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`)
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
  return (await response.json()) as T
}

export function apiBase(): string {
  return API_BASE
}

export async function getIncidents(): Promise<IncidentSummary[]> {
  const data = await getJson<{ incidents: IncidentSummary[] }>("/v1/incidents")
  return data.incidents
}

export async function getStats(): Promise<{
  packages: number
  versions: number
  advisories: number
  incidents: number
}> {
  return getJson("/v1/stats")
}

export async function getBlast(incident: string, t: number): Promise<BlastResponse> {
  return getJson(`/v1/blast/${encodeURIComponent(incident)}?t=${t}`)
}

export async function getPath(
  incident: string,
  pkg: string,
  version: string,
): Promise<PathResponse> {
  return getJson<PathResponse>(
    `/v1/path/${encodeURIComponent(incident)}?pkg=${encodeURIComponent(pkg)}&version=${encodeURIComponent(version)}`,
  )
}

export async function postVerdict(
  incident: string,
  lockfiles: { service: string; lockfile: unknown }[],
  fresh = false,
): Promise<{ incident: string; verdicts: ServiceVerdict[]; provenance?: Provenance }> {
  const suffix = fresh ? "?fresh=1" : ""
  const response = await fetch(`${API_BASE}/v1/verdict${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incident, lockfiles }),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`verdict failed: ${response.status} ${detail.slice(0, 200)}`)
  }
  return (await response.json()) as {
    incident: string
    verdicts: ServiceVerdict[]
    provenance?: Provenance
  }
}

import type { EdgeRecord, VersionRecord } from "./records"

const REGISTRY = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org"

export interface Packument {
  name: string
  versions: VersionRecord[]
  edges: EdgeRecord[]
  dependencyNames: string[]
}

export interface FetchResult {
  status: number
  etag?: string
  packument?: Packument
}

export interface FetchOptions {
  maxVersions: number
  includeDev: boolean
  etag?: string
}

interface RawVersion {
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface RawPackument {
  name?: string
  time?: Record<string, string>
  versions?: Record<string, RawVersion>
}

function encodeName(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2F") : encodeURIComponent(name)
}

function parseEpochSeconds(iso: string | undefined): number {
  if (iso === undefined) return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

function addEdges(
  edges: EdgeRecord[],
  names: Set<string>,
  pkg: string,
  version: string,
  deps: Record<string, string> | undefined,
  kind: EdgeRecord["kind"],
): void {
  if (deps === undefined) return
  for (const [toPackage, range] of Object.entries(deps)) {
    names.add(toPackage)
    edges.push({ fromPkg: pkg, fromVersion: version, toPackage, range, kind })
  }
}

function normalize(name: string, raw: RawPackument, options: FetchOptions): Packument {
  const time = raw.time ?? {}
  const rawVersions = raw.versions ?? {}
  const entries = Object.entries(rawVersions).map(([version, meta]) => ({
    version,
    meta,
    publishedAt: parseEpochSeconds(time[version]),
  }))
  // Keep the newest versions to bound the slice; older tails add edges without
  // changing the recent resolution surface a lockfile hits.
  entries.sort((a, b) => b.publishedAt - a.publishedAt)
  const kept = entries.slice(0, options.maxVersions)

  const versions: VersionRecord[] = []
  const edges: EdgeRecord[] = []
  const dependencyNames = new Set<string>()
  for (const entry of kept) {
    versions.push({ pkg: name, version: entry.version, publishedAt: entry.publishedAt })
    addEdges(edges, dependencyNames, name, entry.version, entry.meta.dependencies, "prod")
    addEdges(edges, dependencyNames, name, entry.version, entry.meta.peerDependencies, "peer")
    addEdges(
      edges,
      dependencyNames,
      name,
      entry.version,
      entry.meta.optionalDependencies,
      "optional",
    )
    if (options.includeDev) {
      addEdges(edges, dependencyNames, name, entry.version, entry.meta.devDependencies, "dev")
    }
  }
  return { name, versions, edges, dependencyNames: [...dependencyNames] }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  maxRetries = 5,
): Promise<Response> {
  let attempt = 0
  for (;;) {
    const response = await fetch(url, { headers })
    if (response.status !== 429 && response.status < 500) return response
    attempt += 1
    if (attempt > maxRetries) return response
    await response.body?.cancel()
    const backoff = Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250)
    await sleep(backoff)
  }
}

export async function fetchPackument(name: string, options: FetchOptions): Promise<FetchResult> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (options.etag !== undefined) headers["If-None-Match"] = options.etag

  const response = await fetchWithRetry(`${REGISTRY}/${encodeName(name)}`, headers)
  if (response.status === 304) {
    await response.body?.cancel()
    return { status: 304, etag: options.etag }
  }
  if (!response.ok) {
    await response.body?.cancel()
    return { status: response.status }
  }
  const etag = response.headers.get("etag") ?? undefined
  const raw = (await response.json()) as RawPackument
  return { status: 200, etag, packument: normalize(name, raw, options) }
}

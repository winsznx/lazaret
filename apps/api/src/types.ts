// Production types owned by the API. The API deliberately does not import from
// @lazaret/refmodel: refmodel is the independent verification oracle, and
// production answers must come from HydraDB reads through its own path. These
// types mirror the shape the web client consumes; the classification logic that
// fills them lives in engine.ts and reads the compiled graph, not the oracle.

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

export interface LockfileEntry {
  name: string
  version: string
  dependencies: Record<string, string>
  root?: boolean
}

export interface Lockfile {
  service: string
  entries: LockfileEntry[]
}

// Read provenance attached to every product response, so a judge can see how
// many HydraDB queries answered the request, how long they took, whether the
// membership read was served fresh or from the short-lived cache, and the exact
// Cypher that ran.
export interface Provenance {
  hydraMs: number
  queryCount: number
  cached: boolean
  fresh: boolean
  cypher: string[]
}

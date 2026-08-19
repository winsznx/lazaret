export type DependencyKind = "prod" | "peer" | "optional" | "dev"

export interface Dependency {
  pkg: string
  range: string
  kind: DependencyKind
}

export interface VersionNode {
  pkg: string
  version: string
  publishedAt: number
  malicious: boolean
  reconstructed: boolean
  dependencies: Dependency[]
}

export interface GraphSnapshot {
  versions: VersionNode[]
}

export interface AdvisoryTarget {
  pkg: string
  version: string
}

export interface Advisory {
  id: string
  targets: AdvisoryTarget[]
  windowStart: number
  windowEnd: number
}

export interface ClosureConfig {
  countedKinds: DependencyKind[]
  depthCap: number
}

export interface ClosureMember {
  pkg: string
  version: string
  depth: number
  tFirst: number
  parent: AdvisoryTarget | null
  viaRange: string | null
  viaOptional: boolean
}

export interface Closure {
  advisoryId: string
  members: Map<string, ClosureMember>
  depthCap: number
  capHit: boolean
}

export function versionKey(pkg: string, version: string): string {
  return `${pkg}@${version}`
}

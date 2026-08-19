export type DependencyKind = "prod" | "peer" | "optional" | "dev"

export interface PackageRecord {
  name: string
}

export interface VersionRecord {
  pkg: string
  version: string
  publishedAt: number
  malicious?: boolean
  reconstructed?: boolean
}

export interface EdgeRecord {
  fromPkg: string
  fromVersion: string
  toPackage: string
  range: string
  kind: DependencyKind
}

export interface NormalizedSlice {
  packages: PackageRecord[]
  versions: VersionRecord[]
  edges: EdgeRecord[]
}

export interface PackageInput {
  id: number
  name: string
}

export interface VersionInput {
  id: number
  pkgName: string
  semver: string
  publishedAt: number
  malicious: boolean
  reconstructed: boolean
}

export interface DependsOnInput {
  srcId: number
  dstId: number
  rid: number
  range: string
  kind: string
}

export interface HasVersionInput {
  pkgId: number
  verId: number
  rid: number
}

export interface AdvisoryInput {
  id: number
  sourceId: string
  publishedAt: number
  windowStart: number
  windowEnd: number
  windowEndEstimated: boolean
}

export interface TargetsInput {
  advId: number
  verId: number
  rid: number
}

export interface ExposesInput {
  advId: number
  verId: number
  rid: number
  depth: number
  tFirst: number
}

export interface ExposedViaInput {
  childId: number
  parentId: number
  rid: number
  advLow: number
  advHigh: number
}

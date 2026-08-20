import { closureChain } from "./closure"
import { satisfies } from "./semver"
import type { Advisory, Closure, ClosureMember, GraphSnapshot, VersionNode } from "./types"
import { versionKey } from "./types"

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

export type PackageClass = "EXPOSED_PINNED" | "EXPOSED_WINDOW" | "CLEAN" | "OUT_OF_SLICE"

export interface PackageVerdict {
  name: string
  class: PackageClass
  pinnedVersion?: string
  admittedVersion?: string
  admittingRange?: string
  chain?: { pkg: string; version: string }[]
}

export interface ServiceVerdict {
  service: string
  class: PackageClass
  packages: PackageVerdict[]
  outOfSlice: string[]
}

const RANK: Record<PackageClass, number> = {
  EXPOSED_PINNED: 3,
  EXPOSED_WINDOW: 2,
  CLEAN: 1,
  OUT_OF_SLICE: 0,
}

function liveInWindow(node: VersionNode | undefined, advisory: Advisory): boolean {
  if (node === undefined) return true
  if (node.reconstructed && node.malicious) return true
  return node.publishedAt <= advisory.windowEnd
}

export function verdict(
  lockfile: Lockfile,
  advisory: Advisory,
  closure: Closure,
  snapshot: GraphSnapshot,
  sliceNames?: Set<string>,
): ServiceVerdict {
  const byKey = new Map<string, VersionNode>()
  const derivedSlice = new Set<string>()
  for (const node of snapshot.versions) {
    byKey.set(versionKey(node.pkg, node.version), node)
    derivedSlice.add(node.pkg)
  }
  const slice = sliceNames ?? derivedSlice
  const targetSet = new Set(advisory.targets.map((t) => versionKey(t.pkg, t.version)))

  const closureByPkg = new Map<string, ClosureMember[]>()
  for (const member of closure.members.values()) {
    const list = closureByPkg.get(member.pkg)
    if (list === undefined) closureByPkg.set(member.pkg, [member])
    else list.push(member)
  }

  const resolved = new Map<string, Set<string>>()
  const declaredRanges = new Map<string, string[]>()
  const referenced = new Set<string>()
  for (const entry of lockfile.entries) {
    if (entry.root !== true) {
      referenced.add(entry.name)
      const versions = resolved.get(entry.name)
      if (versions === undefined) resolved.set(entry.name, new Set([entry.version]))
      else versions.add(entry.version)
    }
    for (const [depName, range] of Object.entries(entry.dependencies)) {
      referenced.add(depName)
      const ranges = declaredRanges.get(depName)
      if (ranges === undefined) declaredRanges.set(depName, [range])
      else ranges.push(range)
    }
  }

  const packages: PackageVerdict[] = []
  const outOfSlice: string[] = []

  for (const name of [...referenced].sort()) {
    const pinnedVersion = findPinned(name, resolved.get(name), targetSet)
    if (pinnedVersion !== undefined) {
      packages.push({
        name,
        class: "EXPOSED_PINNED",
        pinnedVersion,
        chain: chainOf(closure, name, pinnedVersion),
      })
      continue
    }

    const windowHit = findWindow(
      closureByPkg.get(name) ?? [],
      declaredRanges.get(name) ?? [],
      name,
      byKey,
      advisory,
    )
    if (windowHit !== undefined) {
      packages.push({
        name,
        class: "EXPOSED_WINDOW",
        admittedVersion: windowHit.member.version,
        admittingRange: windowHit.range,
        chain: chainOf(closure, name, windowHit.member.version),
      })
      continue
    }

    if (slice.has(name)) {
      packages.push({ name, class: "CLEAN" })
    } else {
      packages.push({ name, class: "OUT_OF_SLICE" })
      outOfSlice.push(name)
    }
  }

  let worst: PackageClass = "OUT_OF_SLICE"
  let worstRank = -1
  for (const entry of packages) {
    if (RANK[entry.class] > worstRank) {
      worstRank = RANK[entry.class]
      worst = entry.class
    }
  }

  return { service: lockfile.service, class: worst, packages, outOfSlice }
}

function findPinned(
  name: string,
  versions: Set<string> | undefined,
  targetSet: Set<string>,
): string | undefined {
  if (versions === undefined) return undefined
  for (const version of versions) {
    if (targetSet.has(versionKey(name, version))) return version
  }
  return undefined
}

function findWindow(
  members: ClosureMember[],
  ranges: string[],
  name: string,
  byKey: Map<string, VersionNode>,
  advisory: Advisory,
): { member: ClosureMember; range: string } | undefined {
  for (const range of ranges) {
    for (const member of members) {
      if (!satisfies(member.version, range)) continue
      if (!liveInWindow(byKey.get(versionKey(name, member.version)), advisory)) continue
      return { member, range }
    }
  }
  return undefined
}

function chainOf(
  closure: Closure,
  pkg: string,
  version: string,
): { pkg: string; version: string }[] {
  return closureChain(closure, pkg, version).map((member) => ({
    pkg: member.pkg,
    version: member.version,
  }))
}

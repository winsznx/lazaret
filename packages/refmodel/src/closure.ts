import { satisfies } from "./semver"
import type {
  Advisory,
  Closure,
  ClosureConfig,
  ClosureMember,
  GraphSnapshot,
  VersionNode,
} from "./types"
import { versionKey } from "./types"

const DEFAULT_CONFIG: ClosureConfig = {
  countedKinds: ["prod", "peer", "optional"],
  depthCap: 8,
}

interface ReverseEdge {
  dependent: VersionNode
  range: string
  optional: boolean
}

// A version w is live for propagation when it existed during the incident
// window. Reconstructed malicious nodes are live in the window by definition;
// everything else must have been published on or before the window closed.
function live(node: VersionNode | undefined, advisory: Advisory): boolean {
  if (node === undefined) return true
  if (node.reconstructed && node.malicious) return true
  return node.publishedAt <= advisory.windowEnd
}

export function computeClosure(
  snapshot: GraphSnapshot,
  advisory: Advisory,
  config: Partial<ClosureConfig> = {},
): Closure {
  const cfg: ClosureConfig = { ...DEFAULT_CONFIG, ...config }
  const counted = new Set(cfg.countedKinds)

  const byKey = new Map<string, VersionNode>()
  for (const node of snapshot.versions) {
    byKey.set(versionKey(node.pkg, node.version), node)
  }

  const reverse = new Map<string, ReverseEdge[]>()
  for (const node of snapshot.versions) {
    for (const dep of node.dependencies) {
      if (!counted.has(dep.kind)) continue
      const list = reverse.get(dep.pkg)
      const edge: ReverseEdge = {
        dependent: node,
        range: dep.range,
        optional: dep.kind === "optional",
      }
      if (list === undefined) reverse.set(dep.pkg, [edge])
      else list.push(edge)
    }
  }

  const members = new Map<string, ClosureMember>()
  const queue: string[] = []
  let capHit = false

  for (const target of advisory.targets) {
    const key = versionKey(target.pkg, target.version)
    if (members.has(key)) continue
    const node = byKey.get(key)
    members.set(key, {
      pkg: target.pkg,
      version: target.version,
      depth: 0,
      tFirst: node ? node.publishedAt : advisory.windowStart,
      parent: null,
      viaRange: null,
      viaOptional: false,
    })
    queue.push(key)
  }

  let head = 0
  while (head < queue.length) {
    const key = queue[head]
    head += 1
    if (key === undefined) continue
    const w = members.get(key)
    if (w === undefined) continue
    if (!live(byKey.get(key), advisory)) continue

    const dependents = reverse.get(w.pkg)
    if (dependents === undefined) continue

    for (const edge of dependents) {
      if (!satisfies(w.version, edge.range)) continue
      const childKey = versionKey(edge.dependent.pkg, edge.dependent.version)
      if (members.has(childKey)) continue
      const depth = w.depth + 1
      if (depth > cfg.depthCap) {
        capHit = true
        continue
      }
      members.set(childKey, {
        pkg: edge.dependent.pkg,
        version: edge.dependent.version,
        depth,
        tFirst: Math.max(w.tFirst, edge.dependent.publishedAt),
        parent: { pkg: w.pkg, version: w.version },
        viaRange: edge.range,
        viaOptional: edge.optional || w.viaOptional,
      })
      queue.push(childKey)
    }
  }

  return { advisoryId: advisory.id, members, depthCap: cfg.depthCap, capHit }
}

export function closureChain(closure: Closure, pkg: string, version: string): ClosureMember[] {
  const chain: ClosureMember[] = []
  let current = closure.members.get(versionKey(pkg, version))
  const guard = new Set<string>()
  while (current !== undefined) {
    const key = versionKey(current.pkg, current.version)
    if (guard.has(key)) break
    guard.add(key)
    chain.push(current)
    if (current.parent === null) break
    current = closure.members.get(versionKey(current.parent.pkg, current.parent.version))
  }
  return chain.reverse()
}

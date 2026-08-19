import { nodeId } from "@lazaret/graph-client"
import type {
  AdvisoryInput,
  DependsOnInput,
  ExposedViaInput,
  ExposesInput,
  HasVersionInput,
  PackageInput,
  Row,
  TargetsInput,
  VersionInput,
} from "@lazaret/graph-client"
import { computeClosure } from "@lazaret/refmodel"
import type { Dependency, DependencyKind, GraphSnapshot, VersionNode } from "@lazaret/refmodel"
import { describe, expect, it } from "vitest"
import type { CompilerClient } from "../src/compiler"
import { compileIncident } from "../src/compiler"
import type { Incident } from "../src/incident"
import { compareParity, incidentToAdvisory } from "../src/parity"

interface ReverseEntry {
  version: VersionNode
  range: string
  kind: string
}

class FakeClient implements CompilerClient {
  readonly exposes: ExposesInput[] = []
  private readonly nodeByVerId = new Map<number, VersionNode>()
  private readonly pkgByPid = new Map<number, string>()
  private readonly dependentsByPkg = new Map<string, ReverseEntry[]>()

  constructor(snapshot: GraphSnapshot) {
    for (const version of snapshot.versions) {
      this.nodeByVerId.set(nodeId("ver", `${version.pkg}@${version.version}`), version)
      this.pkgByPid.set(nodeId("pkg", version.pkg), version.pkg)
      for (const dep of version.dependencies) {
        this.pkgByPid.set(nodeId("pkg", dep.pkg), dep.pkg)
        const entry: ReverseEntry = { version, range: dep.range, kind: dep.kind }
        const list = this.dependentsByPkg.get(dep.pkg)
        if (list === undefined) this.dependentsByPkg.set(dep.pkg, [entry])
        else list.push(entry)
      }
    }
  }

  keyOf(verId: number): string {
    const node = this.nodeByVerId.get(verId)
    return node === undefined ? `unknown@${verId}` : `${node.pkg}@${node.version}`
  }

  queryOne(_cypher: string, params: Record<string, unknown> = {}): Promise<Row | null> {
    const node = this.nodeByVerId.get(Number(params["id"]))
    if (node === undefined) return Promise.resolve(null)
    return Promise.resolve({
      pkg: node.pkg,
      semver: node.version,
      published_at: node.publishedAt,
      malicious: node.malicious,
      reconstructed: node.reconstructed,
    })
  }

  async *queryStream(_cypher: string, params: Record<string, unknown> = {}): AsyncGenerator<Row> {
    const pkgName = this.pkgByPid.get(Number(params["pid"]))
    if (pkgName === undefined) return
    for (const entry of this.dependentsByPkg.get(pkgName) ?? []) {
      yield {
        id: nodeId("ver", `${entry.version.pkg}@${entry.version.version}`),
        pkg: entry.version.pkg,
        semver: entry.version.version,
        published_at: entry.version.publishedAt,
        range: entry.range,
        kind: entry.kind,
      }
    }
  }

  upsertExposes(rows: ExposesInput[]): Promise<void> {
    this.exposes.push(...rows)
    return Promise.resolve()
  }

  upsertPackages(_rows: PackageInput[]): Promise<void> {
    return Promise.resolve()
  }
  upsertVersions(_rows: VersionInput[]): Promise<void> {
    return Promise.resolve()
  }
  upsertHasVersion(_rows: HasVersionInput[]): Promise<void> {
    return Promise.resolve()
  }
  upsertAdvisories(_rows: AdvisoryInput[]): Promise<void> {
    return Promise.resolve()
  }
  upsertTargets(_rows: TargetsInput[]): Promise<void> {
    return Promise.resolve()
  }
  upsertExposedVia(_rows: ExposedViaInput[]): Promise<void> {
    return Promise.resolve()
  }
  upsertDependsOn(_rows: DependsOnInput[]): Promise<void> {
    return Promise.resolve()
  }
}

function ver(
  pkg: string,
  version: string,
  publishedAt: number,
  deps: Dependency[] = [],
  flags: { malicious?: boolean; reconstructed?: boolean } = {},
): VersionNode {
  return {
    pkg,
    version,
    publishedAt,
    malicious: flags.malicious ?? false,
    reconstructed: flags.reconstructed ?? false,
    dependencies: deps,
  }
}

function dep(pkg: string, range: string, kind: DependencyKind = "prod"): Dependency {
  return { pkg, range, kind }
}

async function assertParity(snapshot: GraphSnapshot, incident: Incident): Promise<void> {
  const fake = new FakeClient(snapshot)
  await compileIncident(fake, incident)
  const compiled = new Map<string, number>()
  for (const exposes of fake.exposes) compiled.set(fake.keyOf(exposes.verId), exposes.depth)
  const closure = computeClosure(snapshot, incidentToAdvisory(incident))
  const parity = compareParity(closure.members, compiled)
  expect(parity).toEqual({ ok: true, missing: [], extra: [], depthMismatches: [] })
}

const WINDOW = { windowStart: 0, windowEnd: 1000, windowEndEstimated: true, sourceId: "src" }

describe("compileIncident parity with the reference model", () => {
  it("matches on a transitive TanStack-style chain", async () => {
    const snapshot: GraphSnapshot = {
      versions: [
        ver("@tanstack/react-router", "1.169.5", 500, [], { malicious: true, reconstructed: true }),
        ver("router-app", "1.0.0", 400, [dep("@tanstack/react-router", "^1.169.0")]),
        ver("meta-lib", "2.0.0", 450, [dep("router-app", "^1.0.0")]),
        ver("safe-app", "1.0.0", 400, [dep("@tanstack/react-router", "1.169.4")]),
      ],
    }
    const incident: Incident = {
      id: "tanstack",
      targets: [{ pkg: "@tanstack/react-router", version: "1.169.5" }],
      ...WINDOW,
    }
    await assertParity(snapshot, incident)
  })

  it("matches on the keyv negative case where a caret range blocks the dependent", async () => {
    const snapshot: GraphSnapshot = {
      versions: [
        ver("cacheable-request", "10.1.0", 500, [], { malicious: true, reconstructed: true }),
        ver("keyv", "4.5.4", 400, [dep("cacheable-request", "^9.0.0")]),
        ver("got", "13.0.0", 400, [dep("cacheable-request", "^10.0.0")]),
      ],
    }
    const incident: Incident = {
      id: "keyv",
      targets: [{ pkg: "cacheable-request", version: "10.1.0" }],
      ...WINDOW,
    }
    await assertParity(snapshot, incident)
  })

  it("matches when a dependent published after the window cannot propagate", async () => {
    const snapshot: GraphSnapshot = {
      versions: [
        ver("evil", "1.0.0", 50, [], { malicious: true, reconstructed: true }),
        ver("mid", "1.0.0", 5000, [dep("evil", "^1.0.0")]),
        ver("leaf", "1.0.0", 60, [dep("mid", "^1.0.0")]),
      ],
    }
    const incident: Incident = {
      id: "window",
      targets: [{ pkg: "evil", version: "1.0.0" }],
      windowStart: 0,
      windowEnd: 100,
      windowEndEstimated: false,
      sourceId: "src",
    }
    await assertParity(snapshot, incident)
  })
})

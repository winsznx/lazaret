import { nodeId } from "@lazaret/graph-client"
import type { Row } from "@lazaret/graph-client"
import { computeClosure, versionKey } from "@lazaret/refmodel"
import type { Advisory, Dependency, GraphSnapshot, VersionNode } from "@lazaret/refmodel"
import { describe, expect, it } from "vitest"
import { ExposureReader, classifyLockfile, newProvenance, walkEvidence } from "../src/engine"
import type { ReadClient } from "../src/engine"
import type { Incident } from "../src/incidents"
import { parseLockfile } from "../src/lockfile"
import type { ServiceVerdict } from "../src/types"

// These tests drive the production engine against an in-memory HydraDB fake that
// is seeded from the refmodel oracle's compiled closure. The engine never sees
// the oracle: it only reads the materialized EXPOSES / EXPOSED_VIA rows, exactly
// as it would from a live database. Agreement here is production/oracle parity.

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

const snapshot: GraphSnapshot = {
  versions: [
    ver("debug", "4.4.2", 500, [{ pkg: "ms", range: "^2.1.3", kind: "prod" }], {
      malicious: true,
      reconstructed: true,
    }),
    ver("debug", "4.3.7", 100, [{ pkg: "ms", range: "^2.1.3", kind: "prod" }]),
    ver("ms", "2.1.3", 50, []),
    ver("nodemon", "3.1.7", 200, [{ pkg: "debug", range: "^4.0.0", kind: "prod" }]),
    ver("typescript", "5.6.0", 60, []),
  ],
}
const advisory: Advisory = {
  id: "chalk-debug",
  targets: [{ pkg: "debug", version: "4.4.2" }],
  windowStart: 0,
  windowEnd: 1000,
}
const incident: Incident = {
  id: "chalk-debug",
  sourceId: "npm-qix",
  targets: [{ pkg: "debug", version: "4.4.2" }],
  windowStart: 0,
  windowEnd: 1000,
  windowEndEstimated: false,
}
const sliceNames = new Set(["debug", "ms", "nodemon", "typescript"])

// Compile once with the oracle, then serve those rows as if HydraDB held them.
function seededClient(): ReadClient {
  const closure = computeClosure(snapshot, advisory)
  const byKey = new Map(snapshot.versions.map((node) => [versionKey(node.pkg, node.version), node]))
  const exposesRows: Row[] = [...closure.members.values()].map((member) => {
    const node = byKey.get(versionKey(member.pkg, member.version))
    return {
      pkg: member.pkg,
      semver: member.version,
      published_at: node ? node.publishedAt : advisory.windowStart,
      malicious: node ? node.malicious : false,
      reconstructed: node ? node.reconstructed : false,
      depth: member.depth,
      t_first: member.tFirst,
    } as Row
  })
  const parentById = new Map<number, { ppkg: string; psem: string }>()
  for (const member of closure.members.values()) {
    if (member.parent !== null) {
      parentById.set(nodeId("ver", versionKey(member.pkg, member.version)), {
        ppkg: member.parent.pkg,
        psem: member.parent.version,
      })
    }
  }
  return {
    async queryOne(cypher: string, params: Record<string, unknown> = {}): Promise<Row | null> {
      if (cypher.includes("EXPOSED_VIA")) {
        const parent = parentById.get(params["cid"] as number)
        return parent === undefined ? null : ({ ppkg: parent.ppkg, psem: parent.psem } as Row)
      }
      return null
    },
    async *queryStream(cypher: string): AsyncGenerator<Row> {
      if (cypher.includes("]->(v:Version)") && cypher.includes("EXPOSES")) {
        for (const row of exposesRows) yield row
      } else if (cypher.includes(":Package")) {
        for (const name of sliceNames) yield { name } as Row
      }
    },
  }
}

interface LockPackages {
  [path: string]: { name?: string; version?: string; dependencies?: Record<string, string> }
}

async function run(service: string, packages: LockPackages): Promise<ServiceVerdict> {
  const client = seededClient()
  const reader = new ExposureReader(client)
  const prov = newProvenance(true)
  const exposed = await reader.exposedSet(incident, prov, true)
  const slice = await reader.sliceSet(prov)
  const doc = { name: service, lockfileVersion: 3, packages }
  return classifyLockfile(client, prov, incident, exposed, slice, parseLockfile(service, doc))
}

describe("production verdict over the compiled HydraDB graph", () => {
  it("EXPOSED_PINNED when the tree pins the malicious version directly", async () => {
    const result = await run("pinned", {
      "": { name: "pinned", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.4.2" },
    })
    expect(result.class).toBe("EXPOSED_PINNED")
  })

  it("EXPOSED_PINNED when the malicious version is only a transitive resolution", async () => {
    const result = await run("transitive", {
      "": { name: "transitive", dependencies: { nodemon: "^3.0.0" } },
      "node_modules/nodemon": { version: "3.1.7", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.4.2" },
    })
    expect(result.class).toBe("EXPOSED_PINNED")
  })

  it("EXPOSED_WINDOW when a range admits the malicious version but the tree pinned a safe one", async () => {
    const result = await run("window", {
      "": { name: "window", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.3.7" },
    })
    expect(result.class).toBe("EXPOSED_WINDOW")
    expect(result.packages.find((p) => p.name === "debug")?.admittedVersion).toBe("4.4.2")
  })

  it("CLEAN with a stated reason when the range cannot reach the malicious version", async () => {
    const result = await run("safe-range", {
      "": { name: "safe-range", dependencies: { debug: "~4.3.0" } },
      "node_modules/debug": { version: "4.3.7" },
    })
    expect(result.class).toBe("CLEAN")
    const debug = result.packages.find((p) => p.name === "debug")
    expect(debug?.reason).toContain("does not admit malicious 4.4.2")
  })

  it("CLEAN for an in-slice package unrelated to the incident, with a reason", async () => {
    const result = await run("clean", {
      "": { name: "clean", dependencies: { typescript: "^5.0.0" } },
      "node_modules/typescript": { version: "5.6.0" },
    })
    expect(result.class).toBe("CLEAN")
    expect(result.packages.find((p) => p.name === "typescript")?.reason).toContain(
      "not reachable from the incident targets",
    )
  })

  it("OUT_OF_SLICE for a package missing from the slice, never called clean", async () => {
    const result = await run("unknown", {
      "": { name: "unknown", dependencies: { "not-in-slice-xyz": "^1.0.0" } },
    })
    expect(result.class).toBe("OUT_OF_SLICE")
    expect(result.outOfSlice).toContain("not-in-slice-xyz")
    expect(result.packages.find((p) => p.name === "not-in-slice-xyz")?.reason).toContain(
      "refusing to guess",
    )
  })

  it("takes the worst class and tracks abstentions on a mixed tree", async () => {
    const result = await run("mixed", {
      "": {
        name: "mixed",
        dependencies: { debug: "^4.0.0", typescript: "^5.0.0", "not-in-slice-xyz": "^1.0.0" },
      },
      "node_modules/debug": { version: "4.3.7" },
      "node_modules/typescript": { version: "5.6.0" },
    })
    expect(result.class).toBe("EXPOSED_WINDOW")
    expect(result.packages.find((p) => p.name === "typescript")?.class).toBe("CLEAN")
    expect(result.packages.find((p) => p.name === "debug")?.class).toBe("EXPOSED_WINDOW")
    expect(result.outOfSlice).toContain("not-in-slice-xyz")
  })

  it("attaches a root-first evidence chain walked from EXPOSED_VIA", async () => {
    const result = await run("window", {
      "": { name: "window", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.3.7" },
    })
    const debug = result.packages.find((p) => p.name === "debug")
    expect(debug?.chain?.[0]).toEqual({ pkg: "debug", version: "4.4.2" })
  })
})

describe("evidence walk and read provenance", () => {
  it("walks EXPOSED_VIA to the malicious root and orders the chain root-first", async () => {
    const client = seededClient()
    const prov = newProvenance(true)
    const chain = await walkEvidence(client, prov, nodeId("adv", incident.id), "nodemon", "3.1.7")
    expect(chain).toEqual([
      { pkg: "debug", version: "4.4.2" },
      { pkg: "nodemon", version: "3.1.7" },
    ])
    expect(prov.queryCount).toBeGreaterThan(0)
    expect(prov.cypher.join("\n")).toContain("EXPOSED_VIA")
  })

  it("records how many HydraDB reads answered a verdict", async () => {
    const client = seededClient()
    const reader = new ExposureReader(client)
    const prov = newProvenance(true)
    const exposed = await reader.exposedSet(incident, prov, true)
    const slice = await reader.sliceSet(prov)
    await classifyLockfile(
      client,
      prov,
      incident,
      exposed,
      slice,
      parseLockfile("p", {
        name: "p",
        lockfileVersion: 3,
        packages: {
          "": { name: "p", dependencies: { debug: "^4.0.0" } },
          "node_modules/debug": { version: "4.4.2" },
        },
      }),
    )
    expect(prov.queryCount).toBeGreaterThanOrEqual(2)
    expect(prov.hydraMs).toBeGreaterThanOrEqual(0)
    expect(prov.cypher.join("\n")).toContain("EXPOSES")
  })

  it("serves the membership from cache until fresh is forced", async () => {
    const client = seededClient()
    const reader = new ExposureReader(client)
    const first = newProvenance(false)
    await reader.exposedSet(incident, first, false)
    expect(first.cached).toBe(false)

    const second = newProvenance(false)
    await reader.exposedSet(incident, second, false)
    expect(second.cached).toBe(true)

    const forced = newProvenance(true)
    await reader.exposedSet(incident, forced, true)
    expect(forced.cached).toBe(false)
  })
})

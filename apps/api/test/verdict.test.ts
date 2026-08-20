import { computeClosure, verdict } from "@lazaret/refmodel"
import type {
  Advisory,
  Dependency,
  GraphSnapshot,
  ServiceVerdict,
  VersionNode,
} from "@lazaret/refmodel"
import { describe, expect, it } from "vitest"
import { parseLockfile } from "../src/lockfile"

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
const closure = computeClosure(snapshot, advisory)
const sliceNames = new Set(["debug", "ms", "nodemon", "typescript"])

interface LockPackages {
  [path: string]: { name?: string; version?: string; dependencies?: Record<string, string> }
}

function run(service: string, packages: LockPackages): ServiceVerdict {
  const doc = { name: service, lockfileVersion: 3, packages }
  return verdict(parseLockfile(service, doc), advisory, closure, snapshot, sliceNames)
}

describe("verdict over parsed lockfiles", () => {
  it("EXPOSED_PINNED when the tree pins the malicious version directly", () => {
    const result = run("pinned", {
      "": { name: "pinned", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.4.2" },
    })
    expect(result.class).toBe("EXPOSED_PINNED")
  })

  it("EXPOSED_PINNED when the malicious version is only a transitive resolution", () => {
    const result = run("transitive", {
      "": { name: "transitive", dependencies: { nodemon: "^3.0.0" } },
      "node_modules/nodemon": { version: "3.1.7", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.4.2" },
    })
    expect(result.class).toBe("EXPOSED_PINNED")
  })

  it("EXPOSED_WINDOW when a range admits the malicious version but the tree pinned a safe one", () => {
    const result = run("window", {
      "": { name: "window", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.3.7" },
    })
    expect(result.class).toBe("EXPOSED_WINDOW")
    expect(result.packages.find((p) => p.name === "debug")?.admittedVersion).toBe("4.4.2")
  })

  it("CLEAN when the range cannot reach the malicious version", () => {
    const result = run("safe-range", {
      "": { name: "safe-range", dependencies: { debug: "~4.3.0" } },
      "node_modules/debug": { version: "4.3.7" },
    })
    expect(result.class).toBe("CLEAN")
  })

  it("CLEAN for an in-slice package unrelated to the incident", () => {
    const result = run("clean", {
      "": { name: "clean", dependencies: { typescript: "^5.0.0" } },
      "node_modules/typescript": { version: "5.6.0" },
    })
    expect(result.class).toBe("CLEAN")
  })

  it("OUT_OF_SLICE for a package missing from the slice, never called clean", () => {
    const result = run("unknown", {
      "": { name: "unknown", dependencies: { "not-in-slice-xyz": "^1.0.0" } },
    })
    expect(result.class).toBe("OUT_OF_SLICE")
    expect(result.outOfSlice).toContain("not-in-slice-xyz")
  })

  it("takes the worst class and tracks abstentions on a mixed tree", () => {
    const result = run("mixed", {
      "": {
        name: "mixed",
        dependencies: { debug: "^4.0.0", typescript: "^5.0.0", "not-in-slice-xyz": "^1.0.0" },
      },
      "node_modules/debug": { version: "4.3.7" },
      "node_modules/typescript": { version: "5.6.0" },
    })
    // #then window beats clean, and the unknown dep is abstained separately
    expect(result.class).toBe("EXPOSED_WINDOW")
    expect(result.packages.find((p) => p.name === "typescript")?.class).toBe("CLEAN")
    expect(result.packages.find((p) => p.name === "debug")?.class).toBe("EXPOSED_WINDOW")
    expect(result.outOfSlice).toContain("not-in-slice-xyz")
  })

  it("attaches an evidence chain to a windowed verdict", () => {
    const result = run("window", {
      "": { name: "window", dependencies: { debug: "^4.0.0" } },
      "node_modules/debug": { version: "4.3.7" },
    })
    const debug = result.packages.find((p) => p.name === "debug")
    expect(debug?.chain?.[0]).toEqual({ pkg: "debug", version: "4.4.2" })
  })
})

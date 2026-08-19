import { describe, expect, it } from "vitest"
import { computeClosure } from "../src/closure"
import type { Advisory } from "../src/types"
import type { Lockfile } from "../src/verdict"
import { verdict } from "../src/verdict"
import { dep, snapshot, ver } from "./builders"

const graph = snapshot(
  ver("evil", "1.0.0", 10, [], { malicious: true, reconstructed: true }),
  ver("lib", "1.0.0", 20, [dep("evil", "^1.0.0")]),
  ver("lib", "0.9.0", 5, []),
  ver("safepkg", "1.0.0", 5, []),
)
const advisory: Advisory = {
  id: "adv",
  targets: [{ pkg: "evil", version: "1.0.0" }],
  windowStart: 0,
  windowEnd: 1000,
}
const closure = computeClosure(graph, advisory)

function app(dependencies: Record<string, string>): {
  name: string
  version: string
  dependencies: Record<string, string>
  root: true
} {
  return { name: "app", version: "0.0.0", dependencies, root: true }
}

describe("verdict", () => {
  it("flags EXPOSED_PINNED when the resolved tree contains the malicious version", () => {
    // #given a lockfile whose tree pins evil@1.0.0
    const lockfile: Lockfile = {
      service: "app",
      entries: [
        app({ lib: "^1.0.0" }),
        { name: "lib", version: "1.0.0", dependencies: { evil: "^1.0.0" } },
        { name: "evil", version: "1.0.0", dependencies: {} },
      ],
    }

    // #when the verdict is computed
    const result = verdict(lockfile, advisory, closure, graph)

    // #then the service is EXPOSED_PINNED and evil is the pinned package
    expect(result.class).toBe("EXPOSED_PINNED")
    expect(result.packages.find((p) => p.name === "evil")?.class).toBe("EXPOSED_PINNED")
  })

  it("flags EXPOSED_WINDOW when a range admits a live closure member the tree did not pin", () => {
    // #given the tree pins the safe lib@0.9.0 but the root range is ^1.0.0
    const lockfile: Lockfile = {
      service: "app",
      entries: [app({ lib: "^1.0.0" }), { name: "lib", version: "0.9.0", dependencies: {} }],
    }

    // #when the verdict is computed
    const result = verdict(lockfile, advisory, closure, graph)

    // #then lib is EXPOSED_WINDOW against the admitted 1.0.0
    expect(result.class).toBe("EXPOSED_WINDOW")
    const lib = result.packages.find((p) => p.name === "lib")
    expect(lib?.class).toBe("EXPOSED_WINDOW")
    expect(lib?.admittedVersion).toBe("1.0.0")
  })

  it("reports CLEAN when the range cannot reach a closure member", () => {
    // #given a range that excludes the malicious major
    const lockfile: Lockfile = {
      service: "app",
      entries: [app({ lib: "^0.9.0" }), { name: "lib", version: "0.9.0", dependencies: {} }],
    }

    // #when the verdict is computed
    const result = verdict(lockfile, advisory, closure, graph)

    // #then the service is CLEAN
    expect(result.class).toBe("CLEAN")
  })

  it("abstains with OUT_OF_SLICE for packages missing from the snapshot", () => {
    // #given a dependency on a package that is not in the slice
    const lockfile: Lockfile = {
      service: "app",
      entries: [app({ ghostpkg: "^1.0.0" })],
    }

    // #when the verdict is computed
    const result = verdict(lockfile, advisory, closure, graph)

    // #then the missing package is abstained, never called clean
    expect(result.outOfSlice).toContain("ghostpkg")
    expect(result.class).toBe("OUT_OF_SLICE")
  })

  it("takes the worst class per service and lists abstentions separately", () => {
    // #given one window-exposed dep, one clean dep, and one out-of-slice dep
    const lockfile: Lockfile = {
      service: "app",
      entries: [
        app({ lib: "^1.0.0", safepkg: "^1.0.0", ghostpkg: "^1.0.0" }),
        { name: "lib", version: "0.9.0", dependencies: {} },
        { name: "safepkg", version: "1.0.0", dependencies: {} },
      ],
    }

    // #when the verdict is computed
    const result = verdict(lockfile, advisory, closure, graph)

    // #then the service is EXPOSED_WINDOW with the unknown dep tracked apart
    expect(result.class).toBe("EXPOSED_WINDOW")
    expect(result.outOfSlice).toContain("ghostpkg")
    expect(result.packages.find((p) => p.name === "safepkg")?.class).toBe("CLEAN")
  })

  it("handles a hostile __proto__ package name without polluting prototypes", () => {
    // #given a dependency literally named __proto__
    const lockfile: Lockfile = {
      service: "app",
      entries: [app(JSON.parse('{"__proto__":"^1.0.0"}') as Record<string, string>)],
    }

    // #when the verdict is computed
    const result = verdict(lockfile, advisory, closure, graph)

    // #then it is abstained and Object.prototype is untouched
    expect(result.outOfSlice).toContain("__proto__")
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined()
  })
})

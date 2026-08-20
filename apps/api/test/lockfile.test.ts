import { describe, expect, it } from "vitest"
import { parseLockfile } from "../src/lockfile"

describe("parseLockfile", () => {
  it("parses a package-lock v3 packages map into entries", () => {
    // #given a small v3 lockfile
    const doc = {
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", dependencies: { debug: "^4.0.0" } },
        "node_modules/debug": { version: "4.4.2", dependencies: { ms: "^2.1.3" } },
      },
    }

    // #when parsed
    const lockfile = parseLockfile("app", doc)

    // #then the root and the resolved package are captured
    const root = lockfile.entries.find((e) => e.root === true)
    const debug = lockfile.entries.find((e) => e.name === "debug")
    expect(root?.dependencies).toEqual({ debug: "^4.0.0" })
    expect(debug?.version).toBe("4.4.2")
  })

  it("derives scoped and nested names from the path", () => {
    // #given scoped and nested node_modules paths
    const doc = {
      packages: {
        "": { name: "app" },
        "node_modules/@scope/pkg": { version: "1.0.0" },
        "node_modules/a/node_modules/b": { version: "2.0.0" },
      },
    }

    // #when parsed
    const names = parseLockfile("app", doc).entries.map((e) => e.name)

    // #then both names resolve correctly
    expect(names).toContain("@scope/pkg")
    expect(names).toContain("b")
  })

  it("drops a hostile __proto__ dependency name without polluting prototypes", () => {
    // #given a lockfile whose dependency map carries a __proto__ key
    const doc = JSON.parse(
      '{"packages":{"":{"name":"app","dependencies":{"__proto__":"^1.0.0","debug":"^4.0.0"}}}}',
    ) as unknown

    // #when parsed
    const root = parseLockfile("app", doc).entries[0]

    // #then only the valid name survives and the map has a null prototype
    expect(Object.keys(root?.dependencies ?? {})).toEqual(["debug"])
    expect(Object.getPrototypeOf(root?.dependencies)).toBeNull()
  })

  it("rejects a v1 lockfile with no packages map", () => {
    // #given a legacy v1 lockfile
    const doc = { lockfileVersion: 1, dependencies: { debug: { version: "4.4.2" } } }

    // #then parsing throws a clear error
    expect(() => parseLockfile("app", doc)).toThrow(/package-lock v2 or v3/)
  })

  it("rejects a non-object document", () => {
    // #then a string body is refused
    expect(() => parseLockfile("app", "not json")).toThrow(/JSON object/)
  })
})

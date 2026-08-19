import { describe, expect, it } from "vitest"
import { edgeId, hashId, nodeId } from "../src/ids"

describe("nodeId", () => {
  it("is deterministic for the same kind and key", () => {
    // #given the same package key
    // #when hashed twice
    // #then the id is stable
    expect(nodeId("pkg", "react")).toBe(nodeId("pkg", "react"))
  })

  it("stays inside the JavaScript safe-integer range", () => {
    // #given a set of keys
    const ids = ["react", "@tanstack/react-router", "lodash", "left-pad"].map((k) =>
      nodeId("pkg", k),
    )

    // #then every id is a non-negative safe integer
    for (const id of ids) {
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThanOrEqual(0)
    }
  })

  it("separates ids by kind", () => {
    // #given the same key under different kinds
    // #then the ids differ
    expect(nodeId("pkg", "x")).not.toBe(nodeId("ver", "x"))
  })

  it("edge ids and node ids draw from disjoint prefixes", () => {
    // #given the same key
    // #then an edge id differs from a node id
    expect(edgeId("DEPENDS_ON", "x")).not.toBe(nodeId("pkg", "x"))
    expect(Number.isSafeInteger(hashId("anything"))).toBe(true)
  })
})

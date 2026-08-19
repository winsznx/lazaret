import { describe, expect, it } from "vitest"
import { closureChain, computeClosure } from "../src/closure"
import type { Advisory } from "../src/types"
import { versionKey } from "../src/types"
import { dep, snapshot, ver } from "./builders"

function keys(closureMembers: Map<string, unknown>): string[] {
  return [...closureMembers.keys()].sort()
}

const WINDOW: Pick<Advisory, "windowStart" | "windowEnd"> = { windowStart: 0, windowEnd: 1000 }

describe("computeClosure", () => {
  it("follows a transitive chain and assigns BFS depths", () => {
    // #given a target A that B depends on, and C depends on B
    const graph = snapshot(
      ver("a", "1.0.0", 10, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 20, [dep("a", "^1.0.0")]),
      ver("c", "1.0.0", 30, [dep("b", "^1.0.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "a", version: "1.0.0" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then all three are members at increasing depth
    expect(keys(closure.members)).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"])
    expect(closure.members.get("c@1.0.0")?.depth).toBe(2)
  })

  it("carries t_first as the max publish time along the chain", () => {
    // #given a chain where the middle version is published latest
    const graph = snapshot(
      ver("a", "1.0.0", 10, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 50, [dep("a", "^1.0.0")]),
      ver("c", "1.0.0", 30, [dep("b", "^1.0.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "a", version: "1.0.0" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then t_first is the latest publish across the whole chain, not c's own time
    expect(closure.members.get("c@1.0.0")?.tFirst).toBe(50)
  })

  it("excludes a dependent whose caret range does not admit the malicious major", () => {
    // #given the malicious version is 2.0.0 but the dependent pins ^1.0.0
    const graph = snapshot(
      ver("a", "2.0.0", 10, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 20, [dep("a", "^1.0.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "a", version: "2.0.0" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then the caret range saves the dependent
    expect(closure.members.has("b@1.0.0")).toBe(false)
  })

  it("respects tilde range bounds", () => {
    // #given a tilde dependent that admits 1.2.9 but not 1.3.0
    const graph = snapshot(
      ver("a", "1.3.0", 10, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 20, [dep("a", "~1.2.3")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "a", version: "1.3.0" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then the tilde bound excludes the 1.3.0 malicious version
    expect(closure.members.has("b@1.0.0")).toBe(false)
  })

  it("does not admit a prerelease target into a plain caret range", () => {
    // #given a prerelease malicious version and a plain caret dependent
    const graph = snapshot(
      ver("a", "1.0.0-rc.1", 10, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 20, [dep("a", "^1.0.0")]),
    )
    const advisory: Advisory = {
      id: "adv",
      targets: [{ pkg: "a", version: "1.0.0-rc.1" }],
      ...WINDOW,
    }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then npm prerelease semantics keep the dependent clean
    expect(closure.members.has("b@1.0.0")).toBe(false)
  })

  it("admits a prerelease target when the range opts into the same prerelease", () => {
    // #given a dependent range that explicitly names the prerelease line
    const graph = snapshot(
      ver("a", "1.0.0-rc.2", 10, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 20, [dep("a", "^1.0.0-rc.1")]),
    )
    const advisory: Advisory = {
      id: "adv",
      targets: [{ pkg: "a", version: "1.0.0-rc.2" }],
      ...WINDOW,
    }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then the prerelease opt-in exposes the dependent
    expect(closure.members.has("b@1.0.0")).toBe(true)
  })

  it("handles 0.x caret semantics", () => {
    // #given ^0.2.3 admits 0.2.5 but not 0.3.0
    const graph = snapshot(
      ver("a", "0.2.5", 10, [], { malicious: true, reconstructed: true }),
      ver("admits", "1.0.0", 20, [dep("a", "^0.2.3")]),
      ver("blocks", "1.0.0", 20, [dep("a", "^0.3.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "a", version: "0.2.5" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then only the range that covers 0.2.5 is exposed
    expect(closure.members.has("admits@1.0.0")).toBe(true)
    expect(closure.members.has("blocks@1.0.0")).toBe(false)
  })

  it("keyv caret case: a caret range blocks the most-reported package", () => {
    // #given cacheable-request is compromised at 10.1.0 but keyv pins ^9.0.0
    const graph = snapshot(
      ver("cacheable-request", "10.1.0", 10, [], { malicious: true, reconstructed: true }),
      ver("keyv", "4.5.4", 5, [dep("cacheable-request", "^9.0.0")]),
      ver("got", "13.0.0", 5, [dep("cacheable-request", "^10.0.0")]),
    )
    const advisory: Advisory = {
      id: "adv",
      targets: [{ pkg: "cacheable-request", version: "10.1.0" }],
      ...WINDOW,
    }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then keyv is saved by its range while got is exposed
    expect(closure.members.has("keyv@4.5.4")).toBe(false)
    expect(closure.members.has("got@13.0.0")).toBe(true)
  })

  it("terminates on dependency cycles", () => {
    // #given a and b depend on each other, both depend on the target t
    const graph = snapshot(
      ver("t", "1.0.0", 5, [], { malicious: true, reconstructed: true }),
      ver("a", "1.0.0", 10, [dep("t", "^1.0.0"), dep("b", "^1.0.0")]),
      ver("b", "1.0.0", 10, [dep("t", "^1.0.0"), dep("a", "^1.0.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "t", version: "1.0.0" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then both cycle members are included exactly once
    expect(keys(closure.members)).toEqual(["a@1.0.0", "b@1.0.0", "t@1.0.0"])
  })

  it("assigns the minimal depth on a diamond", () => {
    // #given d reachable both directly from the target and via a longer arm
    const graph = snapshot(
      ver("t", "1.0.0", 5, [], { malicious: true, reconstructed: true }),
      ver("mid", "1.0.0", 10, [dep("t", "^1.0.0")]),
      ver("d", "1.0.0", 10, [dep("t", "^1.0.0"), dep("mid", "^1.0.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "t", version: "1.0.0" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then d takes the shorter path depth
    expect(closure.members.get("d@1.0.0")?.depth).toBe(1)
  })

  it("excludes dev dependencies by default and counts peer and optional", () => {
    // #given three dependents on the target across dev, peer, and optional kinds
    const graph = snapshot(
      ver("t", "1.0.0", 5, [], { malicious: true, reconstructed: true }),
      ver("viadev", "1.0.0", 10, [dep("t", "^1.0.0", "dev")]),
      ver("viapeer", "1.0.0", 10, [dep("t", "^1.0.0", "peer")]),
      ver("viaopt", "1.0.0", 10, [dep("t", "^1.0.0", "optional")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "t", version: "1.0.0" }], ...WINDOW }

    // #when the closure is computed with defaults
    const closure = computeClosure(graph, advisory)

    // #then dev is excluded, peer and optional are included, optional is annotated
    expect(closure.members.has("viadev@1.0.0")).toBe(false)
    expect(closure.members.has("viapeer@1.0.0")).toBe(true)
    expect(closure.members.get("viaopt@1.0.0")?.viaOptional).toBe(true)
  })

  it("does not propagate through a version published after the window closed", () => {
    // #given b depends on the target but was published after window_end
    const graph = snapshot(
      ver("t", "1.0.0", 5, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 500, [dep("t", "^1.0.0")]),
      ver("c", "1.0.0", 20, [dep("b", "^1.0.0")]),
    )
    const advisory: Advisory = {
      id: "adv",
      targets: [{ pkg: "t", version: "1.0.0" }],
      windowStart: 0,
      windowEnd: 100,
    }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then b joins the closure but cannot propagate to c
    expect(closure.members.has("b@1.0.0")).toBe(true)
    expect(closure.members.has("c@1.0.0")).toBe(false)
  })

  it("reports a depth-cap hit and drops nodes past the cap", () => {
    // #given a chain longer than the configured cap
    const graph = snapshot(
      ver("t", "1.0.0", 5, [], { malicious: true, reconstructed: true }),
      ver("l1", "1.0.0", 10, [dep("t", "^1.0.0")]),
      ver("l2", "1.0.0", 10, [dep("l1", "^1.0.0")]),
      ver("l3", "1.0.0", 10, [dep("l2", "^1.0.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "t", version: "1.0.0" }], ...WINDOW }

    // #when the closure is computed with depthCap 2
    const closure = computeClosure(graph, advisory, { depthCap: 2 })

    // #then the cap is reported and the too-deep node is dropped
    expect(closure.capHit).toBe(true)
    expect(closure.members.has("l2@1.0.0")).toBe(true)
    expect(closure.members.has("l3@1.0.0")).toBe(false)
  })

  it("returns only the target when nothing depends on it", () => {
    // #given a target with no dependents
    const graph = snapshot(ver("t", "1.0.0", 5, [], { malicious: true, reconstructed: true }))
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "t", version: "1.0.0" }], ...WINDOW }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then the closure is exactly the target
    expect(keys(closure.members)).toEqual(["t@1.0.0"])
  })

  it("propagates from a target that is absent from the slice", () => {
    // #given the advisory targets a version not present in the snapshot
    const graph = snapshot(ver("b", "1.0.0", 20, [dep("ghost", "^1.0.0")]))
    const advisory: Advisory = {
      id: "adv",
      targets: [{ pkg: "ghost", version: "1.0.0" }],
      windowStart: 7,
      windowEnd: 1000,
    }

    // #when the closure is computed
    const closure = computeClosure(graph, advisory)

    // #then the absent target uses window_start for t_first and still exposes its dependent
    expect(closure.members.get("ghost@1.0.0")?.tFirst).toBe(7)
    expect(closure.members.has("b@1.0.0")).toBe(true)
  })

  it("builds an evidence chain from root to member", () => {
    // #given a two-hop chain
    const graph = snapshot(
      ver("a", "1.0.0", 10, [], { malicious: true, reconstructed: true }),
      ver("b", "1.0.0", 20, [dep("a", "^1.0.0")]),
      ver("c", "1.0.0", 30, [dep("b", "^1.0.0")]),
    )
    const advisory: Advisory = { id: "adv", targets: [{ pkg: "a", version: "1.0.0" }], ...WINDOW }

    // #when the chain to c is requested
    const closure = computeClosure(graph, advisory)
    const chain = closureChain(closure, "c", "1.0.0").map((m) => versionKey(m.pkg, m.version))

    // #then the chain runs from the root target down to c
    expect(chain).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"])
  })
})

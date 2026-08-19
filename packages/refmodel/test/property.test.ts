import fc from "fast-check"
import { describe, it } from "vitest"
import { computeClosure } from "../src/closure"
import type { Advisory, GraphSnapshot, VersionNode } from "../src/types"

interface RandomGraph {
  n: number
  published: number[]
  edges: [number, number][]
  target: number
  windowEnd: number
}

const graphArb: fc.Arbitrary<RandomGraph> = fc.integer({ min: 1, max: 12 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    published: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: n, maxLength: n }),
    edges: fc.array(
      fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })),
      {
        maxLength: n * 3,
      },
    ),
    target: fc.integer({ min: 0, max: n - 1 }),
    windowEnd: fc.integer({ min: 0, max: 100 }),
  }),
)

function build(g: RandomGraph, windowEnd: number): { snapshot: GraphSnapshot; advisory: Advisory } {
  const versions: VersionNode[] = []
  for (let i = 0; i < g.n; i += 1) {
    const deps = g.edges
      .filter(([from]) => from === i)
      .map(([, to]) => ({ pkg: `p${to}`, range: "^1.0.0", kind: "prod" as const }))
    versions.push({
      pkg: `p${i}`,
      version: "1.0.0",
      publishedAt: g.published[i] ?? 0,
      malicious: i === g.target,
      reconstructed: i === g.target,
      dependencies: deps,
    })
  }
  const advisory: Advisory = {
    id: "adv",
    targets: [{ pkg: `p${g.target}`, version: "1.0.0" }],
    windowStart: 0,
    windowEnd,
  }
  return { snapshot: { versions }, advisory }
}

function memberSet(g: RandomGraph, windowEnd: number, reversed = false): Set<string> {
  const { snapshot, advisory } = build(g, windowEnd)
  if (reversed) snapshot.versions.reverse()
  return new Set(computeClosure(snapshot, advisory).members.keys())
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

describe("computeClosure properties", () => {
  it("is stable across repeated runs", () => {
    // #given any random graph
    fc.assert(
      fc.property(graphArb, (g) => {
        // #when the closure is computed twice
        // #then the member sets are identical
        return sameSet(memberSet(g, g.windowEnd), memberSet(g, g.windowEnd))
      }),
      { numRuns: 500 },
    )
  })

  it("is invariant under input ordering", () => {
    // #given any random graph
    fc.assert(
      fc.property(graphArb, (g) => {
        // #when the version list is reversed
        // #then the closure member set does not change
        return sameSet(memberSet(g, g.windowEnd), memberSet(g, g.windowEnd, true))
      }),
      { numRuns: 500 },
    )
  })

  it("grows monotonically as the window widens", () => {
    // #given any random graph and a wider window
    fc.assert(
      fc.property(graphArb, (g) => {
        const narrow = memberSet(g, g.windowEnd)
        const wide = memberSet(g, 100)
        // #then every member under the narrow window survives under the wider one
        for (const member of narrow) {
          if (!wide.has(member)) return false
        }
        return true
      }),
      { numRuns: 500 },
    )
  })
})

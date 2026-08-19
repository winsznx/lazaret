import { describe, expect, it } from "vitest"
import { unwrapCell, unwrapRow } from "../src/cells"

describe("unwrapCell", () => {
  it("unwraps typed scalar cells to plain values", () => {
    // #given the typed cells HydraDB returns
    // #then each is reduced to its plain value
    expect(unwrapCell({ type: "vertex_id", value: 2 })).toBe(2)
    expect(unwrapCell({ type: "integer", value: 100 })).toBe(100)
    expect(unwrapCell({ type: "string", value: "react" })).toBe("react")
    expect(unwrapCell({ type: "boolean", value: true })).toBe(true)
    expect(unwrapCell({ type: "null", value: null })).toBeNull()
  })

  it("returns null for an unrecognised value shape", () => {
    // #given a cell whose value is a nested object
    // #then it is treated as absent rather than leaking structure
    expect(unwrapCell({ type: "map", value: { nested: 1 } })).toBeNull()
  })
})

describe("unwrapRow", () => {
  it("maps columns to their cell values", () => {
    // #given a header and one row of cells
    const row = unwrapRow(
      ["vid", "range"],
      [
        { type: "vertex_id", value: 10 },
        { type: "string", value: "^1.0.0" },
      ],
    )

    // #then the row is keyed by column name
    expect(row).toEqual({ vid: 10, range: "^1.0.0" })
  })
})

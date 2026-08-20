import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// The refmodel package is the independent verification oracle. Production API
// code must derive its answers from HydraDB through its own path, so it may not
// import refmodel at runtime. This rule fails the build if that boundary is
// crossed, which is what keeps "the oracle verifies production" honest rather
// than production quietly reusing the oracle it is checked against.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src")
const IMPORTS_REFMODEL = /(?:^|\n)\s*(?:import|export)[^;\n]*from\s*["']@lazaret\/refmodel["']/

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.name.endsWith(".ts")) out.push(full)
  }
  return out
}

describe("architecture boundary", () => {
  it("apps/api/src never imports the refmodel oracle", () => {
    const offenders = tsFiles(SRC)
      .filter((file) => IMPORTS_REFMODEL.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })
})

import { readFileSync } from "node:fs"
import { basename } from "node:path"

// lazaret check <package-lock.json> [--incident <id>] [--api <url>]
//
// An incident-response CLI. It sends a lockfile to a running Lazaret API,
// classifies it against the compiled incident graph, prints the verdict with
// evidence, and exits non-zero when the service is exposed so it can gate CI.
// Points at the hosted API by default; override with --api or LAZARET_API.

const DEFAULT_API =
  process.env.LAZARET_API ?? "https://biotechnology-hon-indirect-strategies.trycloudflare.com"
const DEFAULT_INCIDENT = "chalk-debug-2025-09"

interface PackageVerdict {
  name: string
  class: string
  pinnedVersion?: string
  admittedVersion?: string
  admittingRange?: string
  reason?: string
}
interface ServiceVerdict {
  service: string
  class: string
  packages: PackageVerdict[]
  outOfSlice: string[]
}
interface Provenance {
  hydraMs: number
  queryCount: number
}

function flag(name: string, fallback: string): string {
  const eq = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  if (eq !== undefined) return eq.slice(name.length + 3)
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1] !== undefined) return process.argv[idx + 1] as string
  return fallback
}

function usage(): never {
  console.error("usage: lazaret check <package-lock.json> [--incident <id>] [--api <url>]")
  process.exit(2)
}

async function main(): Promise<void> {
  if (process.argv[2] !== "check") usage()
  const file = process.argv[3]
  if (file === undefined || file.startsWith("--")) usage()
  const incident = flag("incident", DEFAULT_INCIDENT)
  const api = flag("api", DEFAULT_API).replace(/\/$/, "")
  const service = basename(file).replace(/\.json$/, "")

  let lockfile: unknown
  try {
    lockfile = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    console.error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const response = await fetch(`${api}/v1/verdict?fresh=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incident, lockfiles: [{ service, lockfile }] }),
  })
  if (!response.ok) {
    console.error(`lazaret api ${response.status}: ${(await response.text()).slice(0, 200)}`)
    process.exit(2)
  }
  const body = (await response.json()) as {
    verdicts: ServiceVerdict[]
    provenance?: Provenance
  }
  const verdict = body.verdicts[0]
  if (verdict === undefined) {
    console.error("no verdict returned")
    process.exit(2)
  }

  const exposed = verdict.packages.filter((pkg) => pkg.class.startsWith("EXPOSED"))
  console.log(`lazaret · incident ${incident}`)
  console.log(`${verdict.service}: ${verdict.class}`)
  for (const pkg of exposed) {
    if (pkg.class === "EXPOSED_PINNED") {
      console.log(`  pinned  ${pkg.name}@${pkg.pinnedVersion ?? "?"}`)
    } else {
      console.log(`  window  ${pkg.name}: ${pkg.admittingRange ?? "?"} admits ${pkg.admittedVersion ?? "?"}`)
    }
  }
  if (verdict.outOfSlice.length > 0) {
    console.log(`  abstained on ${verdict.outOfSlice.length} out-of-slice package(s)`)
  }
  if (body.provenance !== undefined) {
    console.log(
      `  ${body.provenance.queryCount} HydraDB read(s), ${Math.round(body.provenance.hydraMs)} ms`,
    )
  }
  process.exit(verdict.class.startsWith("EXPOSED") ? 1 : 0)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
})

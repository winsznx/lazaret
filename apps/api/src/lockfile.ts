import type { Lockfile, LockfileEntry } from "./types"

// npm package names: optional @scope/, no leading dot or underscore, url-safe.
const NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i
const RANGE_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NAME_PATTERN.test(name)
}

function nameFromPath(path: string): string | null {
  const marker = "node_modules/"
  const index = path.lastIndexOf(marker)
  if (index === -1) return null
  const name = path.slice(index + marker.length)
  return name.length > 0 ? name : null
}

// Build the declared-range map on a null-prototype object so a hostile
// dependency name like "__proto__" becomes an ordinary own key rather than
// mutating Object.prototype (SECURITY.md threat model).
function mergeRanges(entry: Record<string, unknown>): Record<string, string> {
  const ranges: Record<string, string> = Object.create(null) as Record<string, string>
  for (const field of RANGE_FIELDS) {
    const map = entry[field]
    if (!isRecord(map)) continue
    for (const [name, range] of Object.entries(map)) {
      if (typeof range === "string" && isValidName(name)) ranges[name] = range
    }
  }
  return ranges
}

export function parseLockfile(service: string, doc: unknown): Lockfile {
  if (!isRecord(doc)) throw new Error("lockfile must be a JSON object")
  const packages = doc["packages"]
  if (!isRecord(packages)) {
    throw new Error("unsupported lockfile: expected a package-lock v2 or v3 packages map")
  }

  const entries: LockfileEntry[] = []
  for (const [path, raw] of Object.entries(packages)) {
    if (!isRecord(raw)) continue
    const version = typeof raw["version"] === "string" ? raw["version"] : ""
    const dependencies = mergeRanges(raw)

    if (path === "") {
      const docName = typeof doc["name"] === "string" ? doc["name"] : null
      const rawName = typeof raw["name"] === "string" ? raw["name"] : null
      entries.push({
        name: docName ?? rawName ?? service,
        version: version.length > 0 ? version : "0.0.0",
        dependencies,
        root: true,
      })
      continue
    }

    const explicit = typeof raw["name"] === "string" ? raw["name"] : null
    const name = explicit ?? nameFromPath(path)
    if (name === null || !isValidName(name) || version.length === 0) continue
    entries.push({ name, version, dependencies })
  }

  return { service, entries }
}

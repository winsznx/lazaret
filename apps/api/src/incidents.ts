import { readdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const INCIDENT_DIR = resolve(REPO_ROOT, "fixtures/incidents")

export interface IncidentTarget {
  pkg: string
  version: string
  publishedAt?: number
}

export interface Incident {
  id: string
  sourceId: string
  targets: IncidentTarget[]
  windowStart: number
  windowEnd: number
  windowEndEstimated: boolean
  sources?: string[]
}

// The micro fixture is for tests; the API serves the real incidents.
export function loadIncidents(): Incident[] {
  return readdirSync(INCIDENT_DIR)
    .filter((file) => file.endsWith(".json") && !file.includes("micro"))
    .map((file) => JSON.parse(readFileSync(resolve(INCIDENT_DIR, file), "utf8")) as Incident)
}

export function loadDotenv(): void {
  if (typeof process.loadEnvFile !== "function") return
  try {
    process.loadEnvFile(resolve(REPO_ROOT, ".env"))
  } catch {
    // no .env; use the ambient environment
  }
}

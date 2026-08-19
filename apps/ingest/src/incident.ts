import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { REPO_ROOT } from "./env"

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

export function loadIncident(relativePath: string): Incident {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), "utf8")) as Incident
}

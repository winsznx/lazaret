import { npmHighImpact } from "npm-high-impact"

// Package names at the center of the incidents Lazaret replays. Seeding these
// explicitly guarantees the incident ecosystem is crawled even if a budget cap
// stops short of them in the high-impact list.
export const INCIDENT_SEEDS: string[] = [
  "@tanstack/react-router",
  "@tanstack/router-core",
  "@tanstack/react-query",
  "@tanstack/query-core",
  "@tanstack/react-table",
  "@tanstack/table-core",
]

export function seedNames(extra: string[], limit: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of [...extra, ...INCIDENT_SEEDS, ...npmHighImpact]) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= limit) break
  }
  return out
}

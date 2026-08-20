import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { arch, platform } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Regenerates the committed evidence artifacts that back claims.json. Slice and
// closure figures come from the on-disk load and compile reports; the blast
// benchmark is measured live against a running API so the numbers are the
// deployed system's, not a guess. Every artifact carries provenance metadata so
// a judge can see the commit, HydraDB image, environment, and raw observations
// behind each number, and rerun this to reproduce them.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const EVIDENCE_DIR = resolve(REPO_ROOT, "evidence")
const API = process.env.LAZARET_API ?? "http://127.0.0.1:8080"
const INCIDENT = "chalk-debug-2025-09"

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim()
  } catch {
    return "unknown"
  }
}

function hydraImage(): string {
  try {
    const compose = readFileSync(resolve(REPO_ROOT, "docker-compose.yml"), "utf8")
    const match = compose.match(/image:\s*(ghcr\.io\/hydra-db\/hydradb@sha256:[a-f0-9]+)/)
    return match?.[1] ?? "unknown"
  } catch {
    return "unknown"
  }
}

function metadata(): Record<string, string> {
  return {
    gitSha: gitSha(),
    hydraImage: hydraImage(),
    generatedAt: new Date().toISOString(),
    os: platform(),
    arch: arch(),
    node: process.version,
    apiBase: API,
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round((sorted[index] ?? 0) * 10) / 10
}

async function blastLatency(t: number): Promise<{ rows: number; latencyMs: number }> {
  const response = await fetch(`${API}/v1/blast/${INCIDENT}?t=${t}`)
  if (!response.ok) throw new Error(`blast failed: ${response.status}`)
  const body = (await response.json()) as { count: number; latencyMs: number }
  return { rows: body.count, latencyMs: body.latencyMs }
}

async function benchmarkFrame(
  label: string,
  t: number,
  samples: number,
): Promise<Record<string, unknown>> {
  const cold = await blastLatency(t)
  await blastLatency(t) // discard one warmup
  const raw: number[] = []
  let rows = cold.rows
  for (let i = 0; i < samples; i += 1) {
    const observation = await blastLatency(t)
    raw.push(observation.latencyMs)
    rows = observation.rows
  }
  const sorted = [...raw].sort((a, b) => a - b)
  return {
    label,
    t,
    rows,
    coldMs: Math.round(cold.latencyMs * 10) / 10,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    sampleCount: samples,
    raw,
  }
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const meta = metadata()

  // Slice counts from the load report the loader wrote.
  const loadReportPath = resolve(REPO_ROOT, "data/slice/load-report.json")
  if (existsSync(loadReportPath)) {
    const report = readJson<{ packages: number; versions: number; dependsOn: number }>(
      loadReportPath,
    )
    writeFileSync(
      resolve(EVIDENCE_DIR, "slice.json"),
      JSON.stringify(
        {
          metadata: meta,
          packages: report.packages,
          versions: report.versions,
          dependsOn: report.dependsOn,
        },
        null,
        2,
      ),
    )
    console.log(`slice.json: ${report.packages} packages, ${report.dependsOn} edges`)
  } else {
    console.warn("skipping slice.json: data/slice/load-report.json not found")
  }

  // Closure size and depth from the compile artifact.
  const compilePath = resolve(REPO_ROOT, `data/compile-${INCIDENT}.json`)
  if (existsSync(compilePath)) {
    const compile = readJson<{
      members: number
      depthHistogram: number[]
      capHit: boolean
      reverseReads: number
      ms: number
    }>(compilePath)
    writeFileSync(
      resolve(EVIDENCE_DIR, `compile-${INCIDENT}.json`),
      JSON.stringify(
        {
          metadata: meta,
          members: compile.members,
          depths: compile.depthHistogram.length,
          depthHistogram: compile.depthHistogram,
          capHit: compile.capHit,
          reverseReads: compile.reverseReads,
          compileMs: Math.round(compile.ms),
        },
        null,
        2,
      ),
    )
    console.log(`compile-${INCIDENT}.json: ${compile.members} members, ${compile.depthHistogram.length} depths`)
  } else {
    console.warn(`skipping compile artifact: ${compilePath} not found`)
  }

  // Blast benchmark measured live against the running API.
  try {
    const incidents = (await (await fetch(`${API}/v1/incidents`)).json()) as {
      incidents: { id: string; windowStart: number; windowEnd: number }[]
    }
    const incident = incidents.incidents.find((entry) => entry.id === INCIDENT)
    if (incident === undefined) throw new Error(`${INCIDENT} not served by ${API}`)
    const mid = incident.windowStart + Math.round((incident.windowEnd - incident.windowStart) / 2)
    const full = await benchmarkFrame("full-frame", 9_999_999_999, 100)
    const midFrame = await benchmarkFrame("mid-window-frame", mid, 100)
    writeFileSync(
      resolve(EVIDENCE_DIR, "benchmark-blast.json"),
      JSON.stringify({ metadata: meta, incident: INCIDENT, full, mid: midFrame }, null, 2),
    )
    console.log(
      `benchmark-blast.json: full p50=${(full as { p50Ms: number }).p50Ms}ms p95=${(full as { p95Ms: number }).p95Ms}ms cold=${(full as { coldMs: number }).coldMs}ms`,
    )
  } catch (error) {
    console.warn(`skipping benchmark: ${error instanceof Error ? error.message : String(error)}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

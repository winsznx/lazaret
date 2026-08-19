import neo4j from "neo4j-driver"
import type { Driver } from "neo4j-driver"

export interface HydraConfig {
  httpUrl: string
  boltUrl: string
  token: string
  graph: string
  namespace: string
  cellId: string
}

export function configFromEnv(): HydraConfig {
  return {
    httpUrl: process.env.HYDRADB_HTTP_URL ?? "http://127.0.0.1:8443",
    boltUrl: process.env.HYDRADB_BOLT_URL ?? "bolt://127.0.0.1:7687",
    token: process.env.HYDRADB_AUTH_TOKEN ?? "local-development-token-32-bytes",
    graph: process.env.HYDRADB_GRAPH ?? "default",
    namespace: process.env.HYDRADB_NAMESPACE ?? "default",
    cellId: process.env.HYDRADB_CELL_ID ?? "cell-0",
  }
}

export function makeDriver(cfg: HydraConfig): Driver {
  return neo4j.driver(cfg.boltUrl, neo4j.auth.basic("neo4j", cfg.token), {
    disableLosslessIntegers: true,
    connectionAcquisitionTimeout: 30_000,
  })
}

export interface HttpQueryOptions {
  parameters?: Record<string, unknown>
  consistency?: "causal" | "strong"
}

export interface HttpQueryResult {
  status: number
  ok: boolean
  body: unknown
  ms: number
}

export async function httpQuery(
  cfg: HydraConfig,
  query: string,
  options: HttpQueryOptions = {},
): Promise<HttpQueryResult> {
  const url = `${cfg.httpUrl}/v1/graphs/${cfg.graph}/query`
  const payload: Record<string, unknown> = { cell_id: cfg.cellId, query }
  if (options.parameters !== undefined) payload.parameters = options.parameters
  if (options.consistency !== undefined) payload.consistency = options.consistency

  const started = performance.now()
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "X-Graph-Namespace": cfg.namespace,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  const ms = performance.now() - started

  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, ok: response.ok, body, ms }
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now()
  const result = await fn()
  return { result, ms: performance.now() - started }
}

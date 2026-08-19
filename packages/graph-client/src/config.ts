export interface HydraConfig {
  httpUrl: string
  boltUrl: string
  token: string
  graph: string
  namespace: string
  cellId: string
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): HydraConfig {
  return {
    httpUrl: env.HYDRADB_HTTP_URL ?? "http://127.0.0.1:8443",
    boltUrl: env.HYDRADB_BOLT_URL ?? "bolt://127.0.0.1:7687",
    token: env.HYDRADB_AUTH_TOKEN ?? "local-development-token-32-bytes",
    graph: env.HYDRADB_GRAPH ?? "default",
    namespace: env.HYDRADB_NAMESPACE ?? "default",
    cellId: env.HYDRADB_CELL_ID ?? "cell-0",
  }
}

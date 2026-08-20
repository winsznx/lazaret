import { configFromEnv, GraphClient } from "@lazaret/graph-client"
import { loadDotenv, loadIncidents } from "./incidents"
import { createServer } from "./server"

async function main(): Promise<void> {
  loadDotenv()
  const client = new GraphClient(configFromEnv())
  const incidents = loadIncidents()
  const app = await createServer(client, incidents)
  const port = Number(process.env.PORT ?? 8080)
  const host = process.env.HOST ?? "0.0.0.0"
  await app.listen({ port, host })
  console.log(`lazaret api on http://${host}:${port} serving ${incidents.length} incident(s)`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

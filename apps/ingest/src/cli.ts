import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { configFromEnv, GraphClient } from "@lazaret/graph-client"
import { loadDotenv, REPO_ROOT } from "./env"
import { loadSlice } from "./loader"
import type { NormalizedSlice } from "./records"

function readSlice(relativePath: string): NormalizedSlice {
  const raw = readFileSync(resolve(REPO_ROOT, relativePath), "utf8")
  return JSON.parse(raw) as NormalizedSlice
}

async function countLabel(client: GraphClient, label: string): Promise<number> {
  const row = await client.queryOne(`MATCH (n:${label}) RETURN count(*) AS c`)
  const value = row?.["c"]
  return typeof value === "number" ? value : 0
}

async function countEdges(client: GraphClient, relType: string): Promise<number> {
  const row = await client.queryOne(`MATCH ()-[r:${relType}]->() RETURN count(*) AS c`)
  const value = row?.["c"]
  return typeof value === "number" ? value : 0
}

async function seedFixture(client: GraphClient): Promise<void> {
  const slice = readSlice("fixtures/micro/slice.json")
  const report = await loadSlice(client, slice)
  console.log(
    `loaded micro-slice: ${report.packages} packages, ${report.versions} versions ` +
      `(${report.reconstructed} reconstructed), ${report.dependsOn} DEPENDS_ON, ` +
      `${report.hasVersion} HAS_VERSION in ${Math.round(report.ms)}ms`,
  )
}

async function stats(client: GraphClient): Promise<void> {
  const [packages, versions, advisories, dependsOn] = await Promise.all([
    countLabel(client, "Package"),
    countLabel(client, "Version"),
    countLabel(client, "Advisory"),
    countEdges(client, "DEPENDS_ON"),
  ])
  console.log(
    `packages=${packages} versions=${versions} advisories=${advisories} depends_on=${dependsOn}`,
  )
}

async function main(): Promise<void> {
  loadDotenv()
  const command = process.argv[2] ?? "help"
  const client = new GraphClient(configFromEnv())
  try {
    switch (command) {
      case "seed-fixture":
        await seedFixture(client)
        break
      case "stats":
        await stats(client)
        break
      default:
        console.log("usage: cli <seed-fixture|stats>")
    }
  } finally {
    await client.close()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

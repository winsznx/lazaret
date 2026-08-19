import neo4j from "neo4j-driver"
import type { Driver, Session } from "neo4j-driver"
import { configFromEnv, httpQuery, makeDriver } from "./hydra.ts"
import type { HydraConfig } from "./hydra.ts"

interface QueryCell {
  type: string
  value: unknown
}

interface QueryBody {
  columns: string[]
  rows: QueryCell[][]
  next_cursor: string | null
  bookmark: string
  read_epoch: number | null
}

function asQueryBody(body: unknown): QueryBody {
  if (body === null || typeof body !== "object" || !("rows" in body)) {
    throw new Error(`unexpected query body: ${JSON.stringify(body).slice(0, 300)}`)
  }
  return body as QueryBody
}

function scalar(body: QueryBody): number | string | boolean | null {
  const cell = body.rows[0]?.[0]
  if (cell === undefined) return null
  return cell.value as number | string | boolean | null
}

async function countLabel(cfg: HydraConfig, label: string): Promise<number> {
  const res = await httpQuery(cfg, `MATCH (n:${label}) RETURN count(*) AS c`)
  const value = scalar(asQueryBody(res.body))
  return typeof value === "number" ? value : Number(value)
}

async function runBatches(
  session: Session,
  query: string,
  rows: Record<string, unknown>[],
  batchSize: number,
): Promise<number> {
  const started = performance.now()
  for (let i = 0; i < rows.length; i += batchSize) {
    await session.run(query, { rows: rows.slice(i, i + batchSize) })
  }
  return performance.now() - started
}

function rate(count: number, ms: number): number {
  return Math.round(count / (ms / 1000))
}

const VERTEX_UPSERT = "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:TNode, n.name = row.name"
const EDGE_UPSERT =
  "UNWIND $rows AS row MATCH (s:TNode {id: row.s}), (d:TNode {id: row.d}) MERGE (s)-[r:TDEP {id: row.rid}]->(d) SET r.kind = row.kind"

async function checkRoundTrip(driver: Driver, cfg: HydraConfig): Promise<void> {
  const session = driver.session({ database: cfg.graph })
  try {
    await session.run("UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Rt", {
      rows: [{ id: neo4j.int(90001) }, { id: neo4j.int(90002) }],
    })
    await session.run(
      "UNWIND $rows AS row MATCH (s:Rt {id: row.s}), (d:Rt {id: row.d}) MERGE (s)-[r:RT {id: row.rid}]->(d)",
      { rows: [{ s: neo4j.int(90001), d: neo4j.int(90002), rid: neo4j.int(1) }] },
    )
    const res = await session.run("MATCH (a:Rt {id: $a})-[:RT]->(b) RETURN b.id AS id", {
      a: neo4j.int(90001),
    })
    const id = res.records[0]?.get("id") as number
    console.log(`  bolt round-trip: read back id=${id} (${id === 90002 ? "OK" : "MISMATCH"})`)
  } finally {
    await session.close()
  }
}

async function checkBigId(driver: Driver, cfg: HydraConfig): Promise<void> {
  const session = driver.session({ database: cfg.graph })
  const maxSafe = 9007199254740991 // 2^53 - 1
  try {
    await session.run("UNWIND $rows AS row MERGE (n {id: row.id}) SET n:BigIdProbe", {
      rows: [{ id: neo4j.int(maxSafe) }],
    })
    const bolt = await session.run("MATCH (n:BigIdProbe {id: $id}) RETURN n.id AS id", {
      id: neo4j.int(maxSafe),
    })
    const boltId = bolt.records[0]?.get("id") as number
    const http = await httpQuery(cfg, "MATCH (n:BigIdProbe {id: $id}) RETURN n.id AS id", {
      parameters: { id: maxSafe },
    })
    const httpId = scalar(asQueryBody(http.body))
    console.log(
      `  big-id 2^53-1: bolt=${boltId} (${boltId === maxSafe ? "exact" : "LOSS"}), http=${String(httpId)} (${httpId === maxSafe ? "exact" : "LOSS"})`,
    )
  } finally {
    await session.close()
  }
}

async function checkThroughput(driver: Driver, cfg: HydraConfig): Promise<void> {
  const sizes = [250, 500, 1000]
  const count = 40000
  for (let s = 0; s < sizes.length; s += 1) {
    const batchSize = sizes[s] ?? 1000
    const base = 200_000_000 + s * 1_000_000
    const session = driver.session({ database: cfg.graph })
    try {
      const vertexRows = Array.from({ length: count }, (_, i) => ({
        id: neo4j.int(base + i),
        name: `n${base + i}`,
      }))
      const vertexMs = await runBatches(session, VERTEX_UPSERT, vertexRows, batchSize)

      const edgeRows = Array.from({ length: count - 1 }, (_, i) => ({
        s: neo4j.int(base + i),
        d: neo4j.int(base + i + 1),
        rid: neo4j.int(base + i),
        kind: "prod",
      }))
      const edgeMs = await runBatches(session, EDGE_UPSERT, edgeRows, batchSize)

      console.log(
        `  batch=${batchSize}: vertices ${rate(count, vertexMs)} rows/s (${Math.round(vertexMs)}ms), edges ${rate(count - 1, edgeMs)} rows/s (${Math.round(edgeMs)}ms)`,
      )
    } finally {
      await session.close()
    }
  }
}

async function buildReverseGraph(
  driver: Driver,
  cfg: HydraConfig,
  edgeTarget: number,
  batchSize: number,
): Promise<{ hotPid: number; hotDegree: number; edges: number; loadMs: number }> {
  const packages = 5000
  const degree = 20
  const versions = Math.ceil(edgeTarget / degree)
  const pkgBase = 1
  const verBase = 10_000_000
  const session = driver.session({ database: cfg.graph })
  const degreeOf = new Map<number, number>()
  try {
    const pkgRows = Array.from({ length: packages }, (_, i) => ({
      id: neo4j.int(pkgBase + i),
      name: `pkg-${i}`,
    }))
    await runBatches(
      session,
      "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Package, n.name = row.name",
      pkgRows,
      batchSize,
    )

    const verRows = Array.from({ length: versions }, (_, i) => ({
      id: neo4j.int(verBase + i),
      semver: "1.0.0",
    }))
    await runBatches(
      session,
      "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Version, n.semver = row.semver",
      verRows,
      batchSize,
    )

    const edgeRows: Record<string, unknown>[] = []
    let rid = 50_000_000
    for (let v = 0; v < versions; v += 1) {
      const chosen = new Set<number>()
      for (let d = 0; d < degree; d += 1) {
        const pkg = 1 + Math.floor((packages - 1) * Math.pow(Math.random(), 3))
        if (chosen.has(pkg)) continue
        chosen.add(pkg)
        degreeOf.set(pkg, (degreeOf.get(pkg) ?? 0) + 1)
        edgeRows.push({
          s: neo4j.int(verBase + v),
          d: neo4j.int(pkg),
          rid: neo4j.int(rid),
          range: "^1.0.0",
          kind: "prod",
        })
        rid += 1
      }
    }
    const loadMs = await runBatches(
      session,
      "UNWIND $rows AS row MATCH (s:Version {id: row.s}), (d:Package {id: row.d}) MERGE (s)-[r:DEPENDS_ON {id: row.rid}]->(d) SET r.range = row.range, r.kind = row.kind",
      edgeRows,
      batchSize,
    )

    let hotPid = 1
    let hotDegree = 0
    for (const [pid, deg] of degreeOf) {
      if (deg > hotDegree) {
        hotDegree = deg
        hotPid = pid
      }
    }
    console.log(
      `  built reverse graph: ${packages} pkgs, ${versions} versions, ${edgeRows.length} edges in ${Math.round(loadMs)}ms (${rate(edgeRows.length, loadMs)} edges/s); hot pkg ${hotPid} has ${hotDegree} dependents`,
    )
    return { hotPid, hotDegree, edges: edgeRows.length, loadMs }
  } finally {
    await session.close()
  }
}

async function checkReverseExpansion(cfg: HydraConfig, hotPid: number): Promise<void> {
  const pageQuery =
    "MATCH (p:Package {id: $pid})<-[e:DEPENDS_ON]-(v:Version) RETURN v.id AS vid, e.range AS range ORDER BY vid SKIP $skip LIMIT $limit"
  const cold = await httpQuery(cfg, pageQuery, {
    parameters: { pid: hotPid, skip: 0, limit: 1000 },
  })
  const coldBody = asQueryBody(cold.body)
  const warm = await httpQuery(cfg, pageQuery, {
    parameters: { pid: hotPid, skip: 0, limit: 1000 },
  })
  console.log(
    `  reverse expansion on pkg ${hotPid}: page(1000) cold ${cold.ms.toFixed(1)}ms, warm ${warm.ms.toFixed(1)}ms, rows=${coldBody.rows.length}, next_cursor=${coldBody.next_cursor === null ? "null" : "set"}`,
  )
}

async function checkPageLimit(cfg: HydraConfig, hotPid: number): Promise<void> {
  const unbounded =
    "MATCH (p:Package {id: $pid})<-[e:DEPENDS_ON]-(v:Version) RETURN v.id AS vid ORDER BY vid"
  const res = await httpQuery(cfg, unbounded, { parameters: { pid: hotPid } })
  const body = asQueryBody(res.body)
  console.log(
    `  admission probe (no LIMIT): status=${res.status}, rows=${body.rows.length}, next_cursor=${body.next_cursor === null ? "null" : String(body.next_cursor)}`,
  )
  if (body.next_cursor !== null) {
    for (const key of ["cursor", "next_cursor", "start_cursor", "from_cursor"]) {
      const follow = await httpQuery(cfg, unbounded, {
        parameters: { pid: hotPid, [key]: body.next_cursor },
      })
      const followBody = asQueryBody(follow.body)
      const firstCold = body.rows[0]?.[0]?.value
      const firstNext = followBody.rows[0]?.[0]?.value
      console.log(
        `    resume via parameters.${key}: rows=${followBody.rows.length}, advanced=${firstNext !== firstCold}`,
      )
    }
  }
}

async function checkPaths(cfg: HydraConfig, src: number, dst: number): Promise<void> {
  for (const dir of ["outgoing", "incoming", "both"]) {
    const q = `CALL algo.SPpaths({sourceNode: $src, targetNode: $dst, relTypes: ['DEPENDS_ON'], relDirection: '${dir}', maxLen: 6, pathCount: 3}) YIELD path RETURN path`
    const res = await httpQuery(cfg, q, { parameters: { src, dst } })
    const ok = res.ok
    const detail = ok ? `rows=${asQueryBody(res.body).rows.length}` : String(res.body).slice(0, 120)
    console.log(`  algo.SPpaths relDirection='${dir}': status=${res.status} ${detail}`)
  }
}

async function checkIdempotence(driver: Driver, cfg: HydraConfig): Promise<void> {
  const session = driver.session({ database: cfg.graph })
  const base = 300_000_000
  const n = 2000
  try {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: neo4j.int(base + i),
      name: `idem${i}`,
    }))
    const query = "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:IdemNode, n.name = row.name"
    await runBatches(session, query, rows, 1000)
    const first = await countLabel(cfg, "IdemNode")
    await runBatches(session, query, rows, 1000)
    const second = await countLabel(cfg, "IdemNode")
    console.log(
      `  idempotence: after first run ${first}, after rerun ${second} (${first === second ? "STABLE" : "DRIFT"})`,
    )
  } finally {
    await session.close()
  }
}

async function checkIdemWrite(driver: Driver, cfg: HydraConfig): Promise<void> {
  const session = driver.session({ database: cfg.graph })
  const base = 400_000_000
  const n = 5000
  try {
    const rows = Array.from({ length: n }, (_, i) => ({ id: neo4j.int(base + i) }))
    await runBatches(
      session,
      "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:IdemKill",
      rows,
      1000,
    )
    console.log(`  idem-write: IdemKill count=${await countLabel(cfg, "IdemKill")} (expect ${n})`)
  } finally {
    await session.close()
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "all"
  const edgeArg = process.argv.find((a) => a.startsWith("--edges="))
  const batchArg = process.argv.find((a) => a.startsWith("--batch="))
  const edgeTarget = edgeArg ? Number(edgeArg.split("=")[1]) : 1_000_000
  const batchSize = batchArg ? Number(batchArg.split("=")[1]) : 1000

  const cfg = configFromEnv()
  const driver = makeDriver(cfg)
  try {
    if (cmd === "roundtrip" || cmd === "all") await checkRoundTrip(driver, cfg)
    if (cmd === "bigid" || cmd === "all") await checkBigId(driver, cfg)
    if (cmd === "throughput" || cmd === "all") await checkThroughput(driver, cfg)
    if (["reverse", "paths", "pagelimit", "reads", "all"].includes(cmd)) {
      const { hotPid } = await buildReverseGraph(driver, cfg, edgeTarget, batchSize)
      if (["reverse", "reads", "all"].includes(cmd)) await checkReverseExpansion(cfg, hotPid)
      if (["pagelimit", "reads", "all"].includes(cmd)) await checkPageLimit(cfg, hotPid)
      if (["paths", "reads", "all"].includes(cmd)) await checkPaths(cfg, 10_000_000, hotPid)
    }
    if (cmd === "idempotence" || cmd === "all") await checkIdempotence(driver, cfg)
    if (cmd === "idem-write") await checkIdemWrite(driver, cfg)
  } finally {
    await driver.close()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack : String(error)
  console.error(message)
  process.exit(1)
})

import neo4j from "neo4j-driver"
import type { Driver } from "neo4j-driver"
import type { CellValue, TypedCell } from "./cells"
import { unwrapRow } from "./cells"
import type { HydraConfig } from "./config"
import type {
  AdvisoryInput,
  DependsOnInput,
  ExposedViaInput,
  ExposesInput,
  HasVersionInput,
  PackageInput,
  TargetsInput,
  VersionInput,
} from "./schema"

export type Row = Record<string, CellValue>

interface NdjsonHeader {
  type: "header"
  columns: string[]
}

interface NdjsonRow {
  type: "row"
  values: TypedCell[]
}

const DEFAULT_BATCH = 1000

export class GraphClient {
  private readonly cfg: HydraConfig
  private driverInstance: Driver | null = null

  constructor(cfg: HydraConfig) {
    this.cfg = cfg
  }

  private driver(): Driver {
    if (this.driverInstance === null) {
      this.driverInstance = neo4j.driver(
        this.cfg.boltUrl,
        neo4j.auth.basic("neo4j", this.cfg.token),
        { disableLosslessIntegers: true, connectionAcquisitionTimeout: 30_000 },
      )
    }
    return this.driverInstance
  }

  async close(): Promise<void> {
    if (this.driverInstance !== null) {
      await this.driverInstance.close()
      this.driverInstance = null
    }
  }

  async writeBatch(
    cypher: string,
    rows: Record<string, unknown>[],
    batchSize = DEFAULT_BATCH,
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += batchSize) {
      await this.runBatchWithRetry(cypher, rows.slice(i, i + batchSize))
    }
  }

  private async runBatchWithRetry(
    cypher: string,
    rows: Record<string, unknown>[],
    attempts = 4,
  ): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const session = this.driver().session({ database: this.cfg.graph })
      try {
        await session.run(cypher, { rows })
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      } finally {
        await session.close()
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  upsertPackages(rows: PackageInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Package, n.name = row.name",
      rows.map((r) => ({ id: neo4j.int(r.id), name: r.name })),
    )
  }

  upsertVersions(rows: VersionInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Version, n.pkg_name = row.pkg_name, n.semver = row.semver, n.published_at = row.published_at, n.malicious = row.malicious, n.reconstructed = row.reconstructed",
      rows.map((r) => ({
        id: neo4j.int(r.id),
        pkg_name: r.pkgName,
        semver: r.semver,
        published_at: neo4j.int(r.publishedAt),
        malicious: r.malicious,
        reconstructed: r.reconstructed,
      })),
    )
  }

  upsertDependsOn(rows: DependsOnInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MATCH (s:Version {id: row.s}), (d:Package {id: row.d}) MERGE (s)-[r:DEPENDS_ON {id: row.rid}]->(d) SET r.range = row.range, r.kind = row.kind",
      rows.map((r) => ({
        s: neo4j.int(r.srcId),
        d: neo4j.int(r.dstId),
        rid: neo4j.int(r.rid),
        range: r.range,
        kind: r.kind,
      })),
    )
  }

  upsertHasVersion(rows: HasVersionInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MATCH (p:Package {id: row.p}), (v:Version {id: row.v}) MERGE (p)-[r:HAS_VERSION {id: row.rid}]->(v)",
      rows.map((r) => ({ p: neo4j.int(r.pkgId), v: neo4j.int(r.verId), rid: neo4j.int(r.rid) })),
    )
  }

  upsertAdvisories(rows: AdvisoryInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Advisory, n.source_id = row.source_id, n.published_at = row.published_at, n.window_start = row.window_start, n.window_end = row.window_end, n.window_end_estimated = row.window_end_estimated",
      rows.map((r) => ({
        id: neo4j.int(r.id),
        source_id: r.sourceId,
        published_at: neo4j.int(r.publishedAt),
        window_start: neo4j.int(r.windowStart),
        window_end: neo4j.int(r.windowEnd),
        window_end_estimated: r.windowEndEstimated,
      })),
    )
  }

  upsertTargets(rows: TargetsInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MATCH (a:Advisory {id: row.a}), (v:Version {id: row.v}) MERGE (a)-[r:TARGETS {id: row.rid}]->(v)",
      rows.map((r) => ({ a: neo4j.int(r.advId), v: neo4j.int(r.verId), rid: neo4j.int(r.rid) })),
    )
  }

  upsertExposes(rows: ExposesInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MATCH (a:Advisory {id: row.a}), (v:Version {id: row.v}) MERGE (a)-[r:EXPOSES {id: row.rid}]->(v) SET r.depth = row.depth, r.t_first = row.t_first",
      rows.map((r) => ({
        a: neo4j.int(r.advId),
        v: neo4j.int(r.verId),
        rid: neo4j.int(r.rid),
        depth: neo4j.int(r.depth),
        t_first: neo4j.int(r.tFirst),
      })),
    )
  }

  upsertExposedVia(rows: ExposedViaInput[]): Promise<void> {
    return this.writeBatch(
      "UNWIND $rows AS row MATCH (c:Version {id: row.c}), (p:Version {id: row.p}) MERGE (c)-[r:EXPOSED_VIA {id: row.rid}]->(p) SET r.adv_low = row.adv_low, r.adv_high = row.adv_high",
      rows.map((r) => ({
        c: neo4j.int(r.childId),
        p: neo4j.int(r.parentId),
        rid: neo4j.int(r.rid),
        adv_low: neo4j.int(r.advLow),
        adv_high: neo4j.int(r.advHigh),
      })),
    )
  }

  // All reads stream over NDJSON, which returns the full result set past the
  // 1024-row page cap of the JSON endpoint (see DECISIONS ADR-0006).
  async *queryStream(cypher: string, params: Record<string, unknown> = {}): AsyncGenerator<Row> {
    const url = `${this.cfg.httpUrl}/v1/graphs/${this.cfg.graph}/query`
    const body: Record<string, unknown> = { cell_id: this.cfg.cellId, query: cypher }
    if (Object.keys(params).length > 0) body.parameters = params

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "X-Graph-Namespace": this.cfg.namespace,
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify(body),
    })
    if (!response.ok || response.body === null) {
      const detail = response.body === null ? "no response body" : await response.text()
      throw new Error(`query failed with ${response.status}: ${detail.slice(0, 300)}`)
    }

    const decoder = new TextDecoder()
    let buffer = ""
    let columns: string[] = []
    const chunks = response.body as unknown as AsyncIterable<Uint8Array>
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const parsed = parseLine(line)
        if (parsed !== null) {
          if (parsed.type === "header") columns = parsed.columns
          else yield unwrapRow(columns, parsed.values)
        }
        newline = buffer.indexOf("\n")
      }
    }
    const parsed = parseLine(buffer)
    if (parsed !== null && parsed.type === "row") yield unwrapRow(columns, parsed.values)
  }

  async queryAll(cypher: string, params: Record<string, unknown> = {}): Promise<Row[]> {
    const rows: Row[] = []
    for await (const row of this.queryStream(cypher, params)) rows.push(row)
    return rows
  }

  async queryOne(cypher: string, params: Record<string, unknown> = {}): Promise<Row | null> {
    for await (const row of this.queryStream(cypher, params)) return row
    return null
  }
}

function parseLine(line: string): NdjsonHeader | NdjsonRow | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const parsed: unknown = JSON.parse(trimmed)
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return null
  const type = (parsed as { type: unknown }).type
  if (type === "header") return parsed as NdjsonHeader
  if (type === "row") return parsed as NdjsonRow
  return null
}

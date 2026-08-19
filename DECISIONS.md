# Decisions

Design decisions with their evidence. Newest first. Each entry states the decision, why it holds, and what would change it.

## ADR-0006: Read paths and the node-plus-indexer topology

Status: accepted, 2026-08-19 (P0).

Reverse adjacency is only fast when `graph-indexer` runs beside `graph-node` and publishes CSC generations. Measured on a 290,058-edge graph: with the indexer running, reverse expansion on a normal-degree package (24 to 28 dependents) returns in about 20 ms, while the same query on a synthetic mega-hub with 10,557 dependents takes about 5.5 s, roughly linear in fan-in at about 0.5 ms per dependent. Without the indexer every reverse read is a full relationship scan of the whole graph. So the deployment always runs both processes, and the node adopts published generations on its own with no extra discovery configuration.

Read paths:
- Bounded reads use the JSON `/v1/graphs/{g}/query` endpoint. It caps a result at `GRAPH_DEFAULT_PAGE_SIZE`, measured at 1024 rows, and returns a `next_cursor`, but that cursor is not resumable through the JSON body. Every attempt returns HTTP 422.
- Large reads use the NDJSON streaming variant (`Accept: application/x-ndjson`). It returns a header line, one line per row past the 1024 cap, and a summary line carrying `has_more`. A 10,557-row reverse expansion streamed in full this way.
- The compiler frontier reads are streamed, so hot hubs are the only case needing care.

`algo.SPpaths` accepts directed `relDirection` values `outgoing` and `incoming`. `both` timed out with HTTP 408 on the mega-hub, so evidence-path queries use a directed relDirection. `GRAPH_MAX_QUERY_SCAN_EDGES` and `GRAPH_MAX_QUERY_RUNTIME_MS` are the admission knobs behind that timeout.

## ADR-0005: Node ids are 53-bit, not 64-bit

Status: accepted, 2026-08-19 (P0).

The plan keyed nodes on the first 8 bytes of BLAKE3 with the top bit cleared, a 63-bit integer. The HTTP JSON API returns ids as JSON numbers, and JavaScript parses those as IEEE-754 doubles, so any id above 2^53 - 1 loses precision on read. Measured: an id of exactly 2^53 - 1 round-trips exactly over both Bolt and HTTP. So Lazaret masks the BLAKE3 digest to 53 bits. Collision probability at slice scale stays low, and the append-only `ids.jsonl` manifest still aborts on any collision rather than assuming it away.

## ADR-0004: The seam spike gates all scale work (resolved)

Status: resolved, 2026-08-19. Verdict: go, no pivot.

The five unknowns, measured against the pinned image on this machine (Apple Silicon, arm64):

1. Edge-property `WHERE` (`e.t_first <= $t`) parses and executes correctly, including the empty-result boundary. Blast-radius-at-t is a direct server-side query, and the app-side fallback is not needed.
2. `algo.SPpaths` accepts `relDirection` `outgoing` and `incoming`; `both` times out on hot hubs. Reverse-direction `MATCH` patterns work.
3. `UNWIND` batch items are capped at 1024 by admission control. Loader batch size is 1000. JSON reads cap at 1024 rows; large reads stream over NDJSON.
4. The Neo4j JavaScript driver connects over Bolt with basic auth, user `neo4j` and the token as password, database `default`. Round trips and UNWIND batches work.
5. `strong` read cost was not separately timed in P0. `strong` is used once as a post-load fence and `causal` on the hot path, per the plan. The number lands in the P3 benchmark table.

Throughput at batch 1000: vertex upserts about 12,000 to 16,000 rows/s, edge upserts about 1,300 to 3,400 rows/s, edges slower because each row matches two endpoints. Edge load is the ingest bottleneck to watch at full-slice scale.

Idempotence: rerunning a MERGE batch leaves counts unchanged, and after a node restart the data is durable and a rerun reconverges, so the crawler, loader, and compiler are all safely restartable.

Also settled: plain `MERGE ... SET` and chained `MERGE` are rejected ("MERGE with following clauses is not executable"). Property upserts must use the `UNWIND` batch form over the client transport, which is exactly the loader and compiler write path. HTTP reads accept a `parameters` map for `$` bindings.

## ADR-0003: HydraDB runtime facts are verified against the pinned repo

Status: accepted, 2026-08-19.

The runtime contract Lazaret depends on is taken from a fresh clone of `hydra-db/hydradb` at commit `6a2fbb192f37f51a93690a2ae2d2f5e27e6e4219`, not from memory or the marketing page.

- Image `ghcr.io/hydra-db/hydradb:latest`, multi-arch for `linux/amd64` and `linux/arm64` after release 0.1.0, so Apple Silicon needs no extra flags.
- Ports: Bolt 7687, HTTP query API 8443, admin and metrics 9090.
- The full local env set, `--user "$(id -u):$(id -g)"`, and `RUST_MIN_STACK=33554432` are required, the last one because the node otherwise serves `/readyz` then aborts on the first query.
- HTTP query shape: `POST /v1/graphs/{graph}/query` with `Authorization: Bearer`, `X-Graph-Namespace`, body `{"cell_id","query"}`. Consistency is `causal` or `strong` in the body.
- The Cypher subset matches what section 5 of the plan assumes: one directed relationship type per pattern, bounded variable-length paths, no intermediate-hop property filters, `WHERE` limited to the six comparators plus `STARTS WITH`, `RETURN` projections and `count/sum/avg/collect`, `MERGE` by id, `UNWIND` batches only over the client transport.

Source: HydraDB `README.md` and `cypher-compat.md` at the pinned commit.

## ADR-0002: Compile the exposure closure into the graph at write time

Status: accepted, 2026-08-19.

The exposure closure is a semver-filtered, liveness-windowed, transitive reverse-dependency traversal. HydraDB's Cypher subset cannot express semver, has no `IN`, and cannot filter properties on the intermediate hops of a variable-length path. Rather than fight the query language, Lazaret runs the fixpoint app-side once per incident and materializes `EXPOSES` and `EXPOSED_VIA` edges back into the graph. Every later question is then a single bounded read.

This is the central technical bet. It turns a hard traversal into a one-time compile plus cheap replay, and it makes HydraDB's narrow surface an asset rather than a limitation. The risk is that the compile is where all the real work lives, so it carries a reference-model parity check and published read and write stats.

## ADR-0001: Consume HydraDB as an unmodified network service

Status: accepted, 2026-08-19.

HydraDB is AGPL-3.0. Lazaret runs it as a separate, unmodified server over Bolt and HTTP, which keeps Lazaret's own code under MIT. Any patch to HydraDB itself is AGPL and is published as a fork branch plus an upstream pull request, tracked in [CONTRIBUTIONS.md](CONTRIBUTIONS.md). This keeps the license boundary clean and honest.

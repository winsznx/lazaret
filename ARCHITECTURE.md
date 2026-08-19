# Architecture

Lazaret answers one question well: given a compromised npm package, which services in a lockfile were actually exposed, and by what path. This document describes how the pieces fit and why the design is shaped the way it is.

## Constraint that shapes everything

HydraDB implements a narrow OpenCypher subset (see the HydraDB `cypher-compat.md`). Three limits drive the design:

1. No `IN`, no `CONTAINS`, no `ENDS WITH`, no `IS NULL` in `WHERE`. Only boolean combinations of `= <> < > <= >= STARTS WITH`.
2. Variable-length paths must be bounded, and intermediate hops cannot be property-filtered.
3. No semver awareness. Property values are int, float, bool, and string only.

Exposure is a semver-filtered, liveness-windowed, transitive reverse-dependency closure. None of that fits inside the query language. So Lazaret computes the closure once, app-side, and writes the result back as graph edges. Every later question reads those edges with a bounded query.

## Components

Monorepo, pnpm workspaces, TypeScript on Node 22+.

- `packages/refmodel` is the plaintext reference resolver. It computes the exposure closure and lockfile verdicts in memory from a plain JSON snapshot, using node-semver. It never talks to HydraDB. It is the independent oracle that graph results are checked against.
- `packages/graph-client` is the HydraDB client. Batched `UNWIND` writes go over Bolt with the Neo4j driver. Reads use the HTTP JSON API. Every statement is parameterized and every read paginates.
- `apps/ingest` is the crawl-and-load pipeline plus the advisory compiler, exposed as a CLI.
- `apps/api` is the Fastify service that serves verdicts, blast-radius-at-t, evidence paths, and stats.
- `apps/web` is the Vite and React replay and verdict UI.
- `fixtures/` holds micro-graphs, sample lockfiles, recorded packuments, OSV records, and incident configs.
- `scripts/` holds the seam spike, the claim checker, and deployment harnesses.

## Data flow

```
seed names -> packument crawler -> normalized JSONL -> graph loader (UNWIND over Bolt) -> HydraDB
OSV/GHSA advisories -> normalizer -> incident config
advisory + graph -> compiler (frontier BFS) -> EXPOSES / EXPOSED_VIA edges -> HydraDB
HydraDB -> API reads -> UI and JSON
```

## Graph schema and identity

HydraDB nodes key on non-negative integer ids, so identity is deterministic. `id = the low 53 bits of BLAKE3(kind || ":" || canonical_key)`, kept inside the JavaScript safe-integer range because the HTTP API returns ids as JSON numbers (see DECISIONS ADR-0005). Kinds are `pkg`, `ver`, and `adv`. The ingester keeps an append-only `ids.jsonl` manifest and aborts on collision rather than assuming it away.

Nodes:

- `Package {id, name}`
- `Version {id, pkg_name, semver, published_at, malicious, reconstructed}`
- `Advisory {id, source_id, published_at, window_start, window_end, window_end_estimated}`

Edges:

- `(Package)-[:HAS_VERSION]->(Version)`
- `(Version)-[:DEPENDS_ON {range, kind}]->(Package)`, kind is `prod`, `peer`, or `optional`. Dev dependencies are excluded by default, and that choice is stated in every claim.
- `(Advisory)-[:TARGETS]->(Version)` for known-malicious versions.
- `(Advisory)-[:EXPOSES {depth, t_first}]->(Version)`, compiled.
- `(Version)-[:EXPOSED_VIA {adv_low, adv_high}]->(Version)`, compiled, a BFS parent pointer toward the root. The advisory id is split into two integers because properties are scalars.

Every property is always written. HydraDB has no `IS NULL`, so absence is never testable and booleans are explicit. Timestamps are epoch seconds as integers so `<=` window comparisons work in `WHERE`.

## The advisory compiler

The exposure fixpoint, implemented identically in `refmodel` and the compiler:

- `W0` is the set of advisory target versions.
- `W(n+1)` adds every version `v` with an edge `v -[:DEPENDS_ON {range r}]-> P` such that some version `w` of `P` is in `Wn`, `semver.satisfies(w, r)` holds with npm prerelease semantics, and `w` was live in the window.
- The closure is the union of all `Wn`. `depth(v)` is the smallest `n` that contains `v`. `t_first(v)` is the earliest moment the whole minimal chain existed.
- Production and peer edges count. Optional counts but is annotated. Dev is excluded by default.

The compiler runs this as a frontier BFS. For each frontier package it issues one reverse-expansion read against HydraDB, evaluates semver satisfaction locally, and admits versions into the closure. Admitted versions get an `EXPOSES` edge and an `EXPOSED_VIA` parent edge, written in idempotent `UNWIND` batches, so the compiler is restartable at any point. Every compile writes a record with counts, a depth histogram, wall time, and HydraDB read and write stats.

After compilation:

- Blast radius at time t is one read of `EXPOSES` edges filtered by `t_first <= t`.
- The evidence path walks `EXPOSED_VIA` parent pointers, or uses `algo.SPpaths` when a path object renders better.
- A verdict is a batched id membership check against the compiled closure.

## Reference model and parity

`refmodel` computes the same closure in memory over a plain JSON snapshot. Independence from the production path comes from a disjoint computation, an in-memory fixpoint versus a graph BFS plus materialization, not from reimplementing semver twice. The core invariant is that the refmodel closure set equals the graph `EXPOSES` set exactly, checked on every fixture and sampled on the real incident.

## Read consistency

HydraDB offers `causal` (default hot path) and `strong` (refreshes the reader from object storage before pinning the snapshot). Loads finish with one `strong` read to fence benchmarks. Product queries run under `causal`.

## Benchmark methodology

Measured on the hosted instance and reproduced locally: load throughput for vertex and edge batches at several sizes, Bolt versus HTTP; compiler wall time per incident with a read and write breakdown; product query latency p50 and p95 for blast-at-t, path, and verdict, cold and warm. Line counts and test counts are never presented as results.

## Incident sources

The TanStack wave of May 11 2026 is the headline incident: 84 malicious versions across 42 `@tanstack` packages published between 19:20 and 19:26 UTC, public for 20 to 26 minutes before detection. Exact removal times are not in the registry, so window ends are configured per incident from published reports and labeled as estimates in the claim ledger. Sources are recorded in each incident config under `fixtures/incidents/`.

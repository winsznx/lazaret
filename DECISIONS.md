# Decisions

Design decisions with their evidence. Newest first. Each entry states the decision, why it holds, and what would change it.

## ADR-0004: The seam spike gates all scale work (open)

Status: open, resolved in P0.

Five facts about HydraDB are not verifiable from the docs and must be measured against a running node before any pipeline is built on them:

1. Whether `WHERE` on a bound edge property (`e.t_first <= $t`) parses and executes. The HydraDB docs show `WHERE` only on node bindings. If it does not execute, blast-radius-at-t returns `t_first` and filters app-side, which changes nothing user-visible and is recorded here if used.
2. The accepted `relDirection` values for `algo.SPpaths` and friends, and whether reverse-direction patterns behave as documented.
3. Realistic `UNWIND` batch sizes and read page sizes under the server's admission limits.
4. Neo4j-driver Bolt compatibility from Node against HydraDB.
5. The cost of a `strong` read.

Each gets a measured line here when P0 completes. A no-go on scale triggers a smaller-slice decision, recorded before any further work.

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

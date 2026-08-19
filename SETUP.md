# Setup

## Prerequisites

- Node 22 or newer and pnpm 11 (`corepack enable` provides pnpm).
- Docker, to run the local HydraDB stack.

## Install

```bash
pnpm install
```

## Run the local HydraDB stack

HydraDB is consumed as an unmodified container. Lazaret runs two roles: a
`graph-node` for queries and mutations, and a `graph-indexer` that builds the
reverse-adjacency index that keeps reverse expansion fast (see DECISIONS
ADR-0006). Both are pinned to a multi-arch image digest in `docker-compose.yml`.

```bash
bash scripts/dev-up.sh
```

The script creates the store and cache directories, writes a development auth
token, exports the host UID and GID so the container can write the bind-mounted
data, brings both services up, and waits for the node to report ready on
`http://127.0.0.1:9090/readyz`.

Stop the stack with `bash scripts/dev-down.sh`, or `bash scripts/dev-down.sh --volumes` to also delete the graph data.

## Verify the node

A listening port is not proof the node works. A round-tripped write is.

```bash
TOKEN='local-development-token-32-bytes'

curl -sS http://127.0.0.1:8443/v1/graphs/default/query \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Graph-Namespace: default' \
  -H 'Content-Type: application/json' \
  --data '{"cell_id":"cell-0","query":"CREATE (a {id: 1})-[:FOLLOWS]->(b {id: 2})"}'

curl -sS http://127.0.0.1:8443/v1/graphs/default/query \
  -H "Authorization: Bearer $TOKEN" \
  -H 'X-Graph-Namespace: default' \
  -H 'Content-Type: application/json' \
  --data '{"cell_id":"cell-0","query":"MATCH (a {id: 1})-[:FOLLOWS]->(b) RETURN b.id AS id"}'
```

The second call returns one row containing `{"type":"vertex_id","value":2}`.

## Environment

Copy `.env.example` to `.env` and fill it in. `GITHUB_TOKEN` is needed for
GitHub Advisory enrichment; OSV works without it. The HydraDB defaults match the
compose stack, so a local run needs no edits.

```bash
cp .env.example .env
```

## Load the fixture micro-slice

With the stack up, load the deterministic micro-slice used by the tests and the
fast demo path:

```bash
pnpm run seed:fixture
pnpm run stats
```

## Checks

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check:claims
```

`pnpm run ci` runs all four. The crawl and compile commands are documented as
the phases that add them land.

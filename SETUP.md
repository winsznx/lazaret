# Setup

## Prerequisites

- Node 22 or newer and pnpm 11 (`corepack enable` will provide pnpm).
- Docker, to run a local HydraDB node.

## Install

```bash
pnpm install
```

## Run a local HydraDB node

HydraDB is consumed as an unmodified container. The command below starts a single plaintext development node backed by a host directory. It mirrors the HydraDB README, pinned in [DECISIONS.md](DECISIONS.md) at ADR-0003.

```bash
mkdir -p hydradb-data/store hydradb-data/cache
printf '%s\n' 'local-development-token-32-bytes' > hydradb-data/auth-token

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -p 7687:7687 -p 8443:8443 -p 9090:9090 \
  -v "$PWD/hydradb-data:/data" \
  -e CLOUD_PROVIDER=local \
  -e LOCAL_PATH=/data/store \
  -e GRAPH_NAMESPACE=default \
  -e GRAPH_ID=default \
  -e GRAPH_CELL_ID=cell-0 \
  -e GRAPH_CELLS=cell-0 \
  -e GRAPH_NODE_ID=node-0 \
  -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
  -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_DATA_CACHE_DIR=/data/cache \
  -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
  -e GRAPH_ALLOW_PLAINTEXT=true \
  -e RUST_MIN_STACK=33554432 \
  ghcr.io/hydra-db/hydradb:latest
```

The node runs in the foreground. `LOCAL_PATH` must point at a directory that already exists, which is why the store directory is created first. `--user` is required because the image runs as UID 10001 and the bind mount is owned by the host user. `RUST_MIN_STACK` is required or the node aborts on the first query.

A compose file that wraps this lands with the ingest pipeline.

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

Copy `.env.example` to `.env` and fill it in. `GITHUB_TOKEN` is needed for GitHub Advisory enrichment; OSV works without it.

```bash
cp .env.example .env
```

## Checks

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check:claims
```

`pnpm run ci` runs all four. Application commands (`seed:fixture`, `verify`, and the crawl and compile CLIs) are documented as the phases that add them land.

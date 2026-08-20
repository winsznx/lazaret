#!/usr/bin/env bash
# Clean-room reproduction: bring up the pinned HydraDB image, run the live
# fixture verification (compiled EXPOSES vs the independent reference model),
# and re-check every claim in the ledger. Runnable from a fresh clone with only
# Docker and pnpm installed. The configFromEnv defaults already point at this
# local node, so no .env is required.
#
# Set LAZARET_REPRO_KEEP=1 to leave the node running afterwards (useful locally).
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p hydradb-data/store hydradb-data/cache-node hydradb-data/cache-indexer
if [ ! -f hydradb-data/auth-token ]; then
  printf '%s\n' 'local-development-token-32-bytes' >hydradb-data/auth-token
fi

LAZARET_UID="$(id -u)"
LAZARET_GID="$(id -g)"
export LAZARET_UID LAZARET_GID

if [ "${LAZARET_REPRO_KEEP:-0}" != "1" ]; then
  trap 'docker compose down >/dev/null 2>&1 || true' EXIT
fi

echo "==> starting pinned HydraDB node + indexer"
docker compose up -d graph-node graph-indexer

echo "==> waiting for graph-node readiness on :9090"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:9090/readyz >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "graph-node did not become ready in time" >&2
  docker compose logs --tail 40 graph-node >&2
  exit 1
fi

echo "==> installing workspace dependencies"
pnpm install --frozen-lockfile

echo "==> live fixture parity (compiled graph vs reference model)"
pnpm exec tsx apps/ingest/src/cli.ts verify

echo "==> re-checking the claim ledger"
pnpm run check:claims

echo "repro OK: live fixture parity holds and every claim re-verified"

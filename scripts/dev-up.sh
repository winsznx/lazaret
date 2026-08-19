#!/usr/bin/env bash
# Bring up a local HydraDB node plus indexer for development.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p hydradb-data/store hydradb-data/cache-node hydradb-data/cache-indexer
if [ ! -f hydradb-data/auth-token ]; then
  printf '%s\n' 'local-development-token-32-bytes' >hydradb-data/auth-token
fi

LAZARET_UID="$(id -u)"
LAZARET_GID="$(id -g)"
export LAZARET_UID LAZARET_GID

docker compose up -d

echo "waiting for graph-node readiness on :9090 ..."
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:9090/readyz >/dev/null 2>&1; then
    echo "graph-node ready"
    exit 0
  fi
  sleep 2
done

echo "graph-node did not become ready in time" >&2
docker compose logs --tail 40 graph-node >&2
exit 1

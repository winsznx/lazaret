#!/usr/bin/env bash
# Stop the local HydraDB stack. Pass --volumes to also delete the graph data.
set -euo pipefail
cd "$(dirname "$0")/.."

LAZARET_UID="$(id -u)"
LAZARET_GID="$(id -g)"
export LAZARET_UID LAZARET_GID

docker compose down "$@"

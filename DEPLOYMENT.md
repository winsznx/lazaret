# Deployment

Lazaret runs in three tiers:

- Web (Vite SPA) on Cloudflare Pages.
- API (Fastify) plus HydraDB (node and indexer) on a single VPS, on a private
  Docker network with no inbound ports.
- A Cloudflare Tunnel gives the API a public HTTPS hostname, so the Pages app
  can call it without exposing HydraDB or managing certificates.

HydraDB is a stateful Rust service over object storage, so it cannot run on
Workers. It lives on the VPS with a local-path object store on a persistent
volume. R2 is a drop-in alternative through `CLOUD_PROVIDER`.

## 1. VPS: bring up HydraDB and the API

Prerequisites: Docker and the Docker Compose plugin.

```bash
git clone https://github.com/winsznx/lazaret.git
cd lazaret

mkdir -p prod-data/store prod-data/cache-node prod-data/cache-indexer
head -c 32 /dev/urandom | base64 | tr -d '\n' > prod-data/auth-token

cat > .env <<EOF
LAZARET_UID=$(id -u)
LAZARET_GID=$(id -g)
HYDRADB_AUTH_TOKEN=$(cat prod-data/auth-token)
CF_TUNNEL_TOKEN=<paste from the Cloudflare tunnel you create in step 2>
EOF

docker compose -f docker-compose.prod.yml up -d --build
```

The `graph-node`, `graph-indexer`, `api`, and `cloudflared` services come up on
a private network. Nothing is published to the host.

## 2. Cloudflare Tunnel for the API

In the Cloudflare dashboard, Zero Trust, Networks, Tunnels: create a tunnel,
copy its token into `CF_TUNNEL_TOKEN` in `.env`, and add a public hostname (for
example `api.lazaret.<your-domain>`) that routes to `http://api:8080`. Restart
the stack so cloudflared picks up the token:

```bash
docker compose -f docker-compose.prod.yml up -d
```

Confirm the tunnel is live:

```bash
curl -s https://api.lazaret.<your-domain>/healthz
```

## 3. Populate the graph on the VPS

The `api` container carries the ingest CLI and reaches HydraDB over the private
network, so crawl, load, and compile run from inside it:

```bash
docker compose -f docker-compose.prod.yml exec api pnpm exec tsx apps/ingest/src/cli.ts crawl --max=3000 --depth=1 --out=data/slice
docker compose -f docker-compose.prod.yml exec api pnpm exec tsx apps/ingest/src/cli.ts load-dir --dir=data/slice
docker compose -f docker-compose.prod.yml exec api pnpm exec tsx apps/ingest/src/cli.ts compile --incident=fixtures/incidents/chalk-debug-2025-09.json
docker compose -f docker-compose.prod.yml exec api pnpm exec tsx apps/ingest/src/cli.ts compile --incident=fixtures/incidents/tanstack-2026-05.json
```

Verify the incident is served:

```bash
curl -s https://api.lazaret.<your-domain>/v1/incidents
```

## 4. Web on Cloudflare Pages

Build the SPA against the tunnel hostname and deploy:

```bash
cd apps/web
VITE_API_URL="https://api.lazaret.<your-domain>" pnpm run build
pnpm dlx wrangler pages deploy dist --project-name lazaret
```

`VITE_API_URL` is baked in at build time. Open the Pages URL and the app loads
the incidents, replays the closure, and returns verdicts through the tunnel.

## Alternative: a domain on the VPS instead of a tunnel

If you would rather terminate TLS on the VPS with a real domain, run Caddy in
front of the API using `deploy/Caddyfile` and point the domain's DNS at the VPS.
The tunnel is the recommended path because it needs no open ports.

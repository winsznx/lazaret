# Lazaret

Supply-chain blast radius over a HydraDB dependency graph. When an npm package is compromised, Lazaret answers which of your services were actually exposed, in milliseconds, with the dependency path as evidence, and replays the attack spreading through the real npm graph minute by minute.

Built for Hack Hydra, Track 2A (supply-chain blast radius).

## The result

Over a slice of the real npm graph (3,980 packages, 31,700 versions, 85,780 `DEPENDS_ON` edges in HydraDB), Lazaret compiles the real September 2025 chalk/debug worm, 16 registry-confirmed compromised versions, into a **983-version exposure closure across six depth levels in 3.4 seconds**. After that one-time compile, the blast radius at any minute of the incident returns in tens of milliseconds warm (**72 ms median, 103 ms p95** over 100 samples), and any lockfile gets a verdict with a concrete evidence path such as `webpack-cli@7.2.1 -> ... -> debug@4.4.2`.

Every number here lives in [`claims.json`](claims.json), is backed by a committed artifact under [`evidence/`](evidence/) that records the commit, HydraDB image digest, environment, and raw observations, and is re-checked by `pnpm check:claims`. A stale claim fails CI.

## Run it in two minutes

```bash
pnpm install
bash scripts/dev-up.sh      # HydraDB node + indexer via Docker, waits for ready
pnpm run seed:fixture       # load the deterministic micro-slice
pnpm run verify             # compiled EXPOSES == reference-model closure, exact, plus the claim checker
```

`pnpm run verify` is the honesty check: it compiles the fixture incident into HydraDB and asserts the graph's `EXPOSES` set equals an independent in-memory reference resolver, exactly, depths and all.

To see it at real scale with the UI:

```bash
pnpm exec tsx apps/ingest/src/cli.ts crawl --max=3000 --depth=1     # ~2 min against the live registry
pnpm exec tsx apps/ingest/src/cli.ts load-dir
pnpm exec tsx apps/ingest/src/cli.ts compile --incident=fixtures/incidents/chalk-debug-2025-09.json
pnpm run api                       # http://127.0.0.1:8080
pnpm --filter @lazaret/web dev     # http://127.0.0.1:5173
```

Live demo: [lazaret.pages.dev](https://lazaret.pages.dev), served from a single VPS running HydraDB behind a Cloudflare tunnel. The 3-minute video link lands here once recorded. See [DEPLOYMENT.md](DEPLOYMENT.md).

## The problem

Supply-chain attacks are automated now. On September 8 2025 the qix maintainer account was compromised and pushed malicious versions of chalk, debug, ansi-styles and more than a dozen other packages within eight minutes. In the May 2026 TanStack wave, 84 malicious versions across 42 packages went live in six minutes. The defender's problem is speed. When a package is compromised at 09:00, which of your services are exposed by 09:06?

That question is a transitive reverse-dependency closure over a graph with tens of millions of versioned nodes, filtered by semver satisfaction and a liveness window. A similarity index cannot answer it.

## The mechanism

HydraDB speaks a deliberately narrow OpenCypher subset. It has no `IN`, it cannot filter properties on the intermediate hops of a variable-length traversal, and it does not evaluate semver. So Lazaret does not try to express the closure as one clever query. It compiles the incident into the graph once.

An app-side compiler runs the exposure fixpoint, semver satisfaction plus a liveness window, as a frontier BFS over the HydraDB dependency graph. It then materializes `EXPOSES` and `EXPOSED_VIA` edges back into the graph. After that compile step, every product question is a single bounded HydraDB query: the blast radius at time t, the evidence path for a version, the verdict for a lockfile. The narrow query surface forces semantic closure to write time, and the payoff is one-hop replay.

## How HydraDB is used

HydraDB is the graph store and the traversal engine, not a cache in front of something else. The dependency graph of packages, versions, and `DEPENDS_ON` edges lives in HydraDB. The compiler's frontier expansion is a reverse-adjacency read against HydraDB, made fast by the `graph-indexer` that publishes CSC generations. The compiled `EXPOSES` and `EXPOSED_VIA` edges are written back with batched `UNWIND` mutations and read for every replay frame and every verdict. Remove HydraDB and there is no graph to traverse and nothing to replay.

Lazaret runs HydraDB as an unmodified server over Bolt and HTTP, so Lazaret's own code stays MIT while HydraDB remains AGPL-3.0. See [CONTRIBUTIONS.md](CONTRIBUTIONS.md) for the license boundary.

## What is here

- `packages/refmodel`: the independent semver fixpoint and verdict oracle, no graph. 25 tests plus 1,500 property cases.
- `packages/graph-client`: the typed HydraDB client, UNWIND batch writers and NDJSON streaming reads, 53-bit ids.
- `apps/ingest`: the npm crawler, loader, and the advisory compiler, with a `verify` that proves parity against the reference model.
- `apps/api`: the Fastify service, blast radius at t, evidence path, and lockfile verdicts.
- `apps/web`: the Vite and React replay and verdict UI.

## Verdict semantics

For each service in an uploaded lockfile, per incident: `EXPOSED_PINNED` (the tree resolves a compromised version), `EXPOSED_WINDOW` (a declared range would resolve into the attack), `CLEAN` (in the slice and neither fires), or `OUT_OF_SLICE` (a referenced package is outside the slice, so Lazaret abstains rather than guessing). Uploaded lockfiles are processed in memory and never stored (see [SECURITY.md](SECURITY.md)).

## Limitations

- The slice is a bounded crawl seeded from npm-high-impact plus the incident packages, not all of npm. Every claim says "a slice of N", never "all of npm".
- Malicious version numbers and publish times are reconstructed from the live npm registry `time` map, which survives even after the versions are removed. Incident window ends are estimates from published detection reports and are flagged as such.
- Latency numbers are from a local single-node HydraDB on Apple Silicon.

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [DECISIONS.md](DECISIONS.md), [SETUP.md](SETUP.md), and [DEPLOYMENT.md](DEPLOYMENT.md).

## Attribution

Lazaret builds on HydraDB (AGPL-3.0, consumed unmodified as a network service), node-semver, the public npm registry, the npm-high-impact seed list, and the incident write-ups from the TanStack postmortem, GHSA-g7cv-rxg3-hmpx, and the Snyk, Wiz, StepSecurity, and Aikido reports on the September 2025 worm.

## License

MIT. See [LICENSE](LICENSE).

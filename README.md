# Lazaret

Supply-chain blast radius over a HydraDB dependency graph. When an npm package is compromised, Lazaret answers which of your services were actually exposed, in seconds, with the dependency path as evidence, and replays the attack spreading through the real npm graph minute by minute.

Built for Hack Hydra, Track 2A (supply-chain blast radius).

## Status

Under active development during the hackathon build window. This section tracks what is live, so nothing below is claimed before it works.

- [ ] Reference model and fixtures
- [ ] npm slice loaded into HydraDB
- [ ] Advisory compiler and incident replay
- [ ] Verdict API and lockfile parsing
- [ ] Hosted demo and 3-minute video

Numbers anywhere in this repo come from `claims.json` and are re-verified by `pnpm check:claims`. A stale claim fails CI.

## The problem

Supply-chain attacks are automated now. In the TanStack compromise on May 11 2026, 84 malicious versions across 42 packages went live within six minutes of a CI breach, and the worm went on to hit more than 160 other npm and PyPI packages. The defender's problem is speed. When a package is compromised at 09:00, which of your services are exposed by 09:06?

That question is a transitive reverse-dependency closure over a graph with tens of millions of versioned nodes, filtered by semver satisfaction and a liveness window. A similarity index cannot answer it.

## The mechanism

HydraDB speaks a deliberately narrow OpenCypher subset. It has no `IN`, it cannot filter properties on the intermediate hops of a variable-length traversal, and it does not evaluate semver. So Lazaret does not try to express the closure as one clever query. It compiles the incident into the graph once.

An app-side compiler runs the exposure fixpoint, semver satisfaction plus a liveness window, as a frontier BFS over the HydraDB dependency graph. It then materializes `EXPOSES` and `EXPOSED_VIA` edges back into the graph. After that compile step, every product question is a single bounded HydraDB query: the blast radius at time t, the evidence path for a version, the verdict for a lockfile. The narrow query surface forces semantic closure to write time, and the payoff is one-hop replay.

## How HydraDB is used

HydraDB is the graph store and the traversal engine, not a cache in front of something else. The dependency graph of packages, versions, and `DEPENDS_ON` edges lives in HydraDB. The compiler's frontier expansion is a reverse-adjacency read against HydraDB. The compiled `EXPOSES` and `EXPOSED_VIA` edges are written back with batched `UNWIND` mutations and read for every replay frame and every verdict. Remove HydraDB and there is no graph to traverse and nothing to replay.

Lazaret runs HydraDB as an unmodified server over Bolt and HTTP, so Lazaret's own code stays MIT while HydraDB remains AGPL-3.0. See [CONTRIBUTIONS.md](CONTRIBUTIONS.md) for the license boundary and any upstream work.

## Verify it fastest

See [SETUP.md](SETUP.md) for the full path. The target flow, wired up as the phases in Status land:

```bash
pnpm install
docker compose up -d      # single-node HydraDB
pnpm seed:fixture         # load the micro-slice, compile the fixture advisory
pnpm verify               # reference-model parity plus the claim checker
```

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) covers the storage model, the compiler, the graph schema, and the benchmark methodology. [SECURITY.md](SECURITY.md) covers the threat model and the privacy boundary for uploaded lockfiles. [DECISIONS.md](DECISIONS.md) records the design decisions and their evidence.

## Attribution

Lazaret builds on HydraDB (AGPL-3.0, consumed unmodified as a network service), node-semver, the public npm registry, OSV and GitHub Advisory data, the npm-high-impact seed list, and the incident write-ups cited in [ARCHITECTURE.md](ARCHITECTURE.md). Each source is credited where the code uses it.

## License

MIT. See [LICENSE](LICENSE).

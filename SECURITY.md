# Security and privacy

Lazaret ingests public data and answers questions about lockfiles that a user uploads. The design keeps uploaded content private and treats every input as hostile.

## Privacy boundary

| Data | Boundary |
|---|---|
| Ecosystem graph, advisories, replays, compile stats | Public |
| Uploaded lockfiles and their verdicts | Session-only, held in memory, never persisted |
| HydraDB auth token, `GITHUB_TOKEN` | Server environment only |
| Judge reproduction | Needs none of the maintainer's private credentials |

Lockfile content is never written to HydraDB, never written to disk, and package names from uploads are never logged. This is stated on the upload UI itself, not only here.

## Threat model

- Hostile lockfile upload. Inputs are capped in size and parsed with a prototype-pollution guard (null-prototype maps). Package names are validated against npm naming rules before use. No filesystem path is ever derived from uploaded content.
- Query injection. Only parameterized statements reach HydraDB. Node ids are integers computed server-side. Names are never interpolated into Cypher.
- Denial of service. Traversal depth is bounded by construction, since HydraDB rejects unbounded variable-length patterns. Server admission limits, per-IP rate limiting, and pagination caps sit on top.
- Data poisoning. The npm registry and OSV are fetched over TLS only. Advisory sources are pinned to GitHub and OSV. Incident configs carry their source URLs.
- Honesty risks. Reconstructed malicious version nodes always carry a flag and a UI badge. Window-end estimates are labeled with their source. Cached replay frames are disclosed separately from live query latency in the claim ledger.
- HydraDB exposure. The auth token is read from a file. Plaintext is used only inside the local compose network. Public ingress terminates TLS at the proxy. The admin and metrics port is not published.

## Reporting

This is a hackathon project. Security issues can be raised as GitHub issues on the repository.

# Contributions and the HydraDB license boundary

## License boundary

HydraDB is licensed AGPL-3.0. Lazaret uses it as an unmodified network service, reached over Bolt (port 7687) and the HTTP query API (port 8443). Lazaret ships no HydraDB source and links against nothing from the HydraDB codebase, so Lazaret's own code is MIT.

If Lazaret ever needs a change inside HydraDB, that change is AGPL. It will be published as a branch on a fork of `hydra-db/hydradb` and offered upstream as a pull request, and it will be listed below with a link. As of now, no HydraDB modification is used.

## Upstream interaction

Anything filed against `hydra-db/hydradb`, an issue, a question that produced a documented answer, or a pull request, is listed here with a link and a one-line summary. This section is empty until the first item is filed.

## Reference

The HydraDB runtime contract Lazaret depends on is pinned in [DECISIONS.md](DECISIONS.md) at ADR-0003, tied to a specific upstream commit so the dependency is reproducible.

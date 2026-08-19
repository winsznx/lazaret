import type { Dependency, DependencyKind, GraphSnapshot, VersionNode } from "../src/types"

export function ver(
  pkg: string,
  version: string,
  publishedAt: number,
  deps: Dependency[] = [],
  flags: { malicious?: boolean; reconstructed?: boolean } = {},
): VersionNode {
  return {
    pkg,
    version,
    publishedAt,
    malicious: flags.malicious ?? false,
    reconstructed: flags.reconstructed ?? false,
    dependencies: deps,
  }
}

export function dep(pkg: string, range: string, kind: DependencyKind = "prod"): Dependency {
  return { pkg, range, kind }
}

export function snapshot(...versions: VersionNode[]): GraphSnapshot {
  return { versions }
}

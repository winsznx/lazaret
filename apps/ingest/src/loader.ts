import { edgeId, nodeId } from "@lazaret/graph-client"
import type {
  DependsOnInput,
  GraphClient,
  HasVersionInput,
  PackageInput,
  VersionInput,
} from "@lazaret/graph-client"
import type { NormalizedSlice } from "./records"

export interface LoadReport {
  packages: number
  versions: number
  dependsOn: number
  hasVersion: number
  reconstructed: number
  ms: number
}

export interface IdManifestEntry {
  id: number
  kind: string
  key: string
}

// Deterministic ids can in principle collide; the manifest detects it rather
// than assuming it away (ARCHITECTURE, ADR-0005).
function makeClaim(
  onManifest?: (entry: IdManifestEntry) => void,
): (id: number, kind: string, key: string) => void {
  const seen = new Map<number, string>()
  return (id, kind, key) => {
    const identity = `${kind}:${key}`
    const existing = seen.get(id)
    if (existing !== undefined && existing !== identity) {
      throw new Error(`id collision on ${id}: ${existing} vs ${identity}`)
    }
    seen.set(id, identity)
    if (onManifest !== undefined) onManifest({ id, kind, key })
  }
}

export async function loadSlice(
  client: GraphClient,
  slice: NormalizedSlice,
  onManifest?: (entry: IdManifestEntry) => void,
): Promise<LoadReport> {
  const started = performance.now()
  const claim = makeClaim(onManifest)

  const packageNames = new Set<string>()
  for (const pkg of slice.packages) packageNames.add(pkg.name)
  for (const version of slice.versions) packageNames.add(version.pkg)
  for (const edge of slice.edges) packageNames.add(edge.toPackage)

  const packageInputs: PackageInput[] = []
  for (const name of packageNames) {
    const id = nodeId("pkg", name)
    claim(id, "pkg", name)
    packageInputs.push({ id, name })
  }
  await client.upsertPackages(packageInputs)

  const versionInputs: VersionInput[] = []
  const hasVersion: HasVersionInput[] = []
  let reconstructed = 0
  for (const version of slice.versions) {
    const key = `${version.pkg}@${version.version}`
    const id = nodeId("ver", key)
    claim(id, "ver", key)
    if (version.reconstructed === true) reconstructed += 1
    versionInputs.push({
      id,
      pkgName: version.pkg,
      semver: version.version,
      publishedAt: version.publishedAt,
      malicious: version.malicious ?? false,
      reconstructed: version.reconstructed ?? false,
    })
    hasVersion.push({
      pkgId: nodeId("pkg", version.pkg),
      verId: id,
      rid: edgeId("HAS_VERSION", key),
    })
  }
  await client.upsertVersions(versionInputs)
  await client.upsertHasVersion(hasVersion)

  const dependsOn: DependsOnInput[] = slice.edges.map((edge) => {
    const fromKey = `${edge.fromPkg}@${edge.fromVersion}`
    return {
      srcId: nodeId("ver", fromKey),
      dstId: nodeId("pkg", edge.toPackage),
      rid: edgeId("DEPENDS_ON", `${fromKey}->${edge.toPackage}:${edge.kind}`),
      range: edge.range,
      kind: edge.kind,
    }
  })
  await client.upsertDependsOn(dependsOn)

  return {
    packages: packageInputs.length,
    versions: versionInputs.length,
    dependsOn: dependsOn.length,
    hasVersion: hasVersion.length,
    reconstructed,
    ms: performance.now() - started,
  }
}

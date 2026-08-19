import semver from "semver"

// npm's own resolution semantics: prereleases only satisfy a range that carries
// a prerelease at the same [major, minor, patch]. Anything that is not a valid
// registry semver range (git urls, workspace:, file:) admits nothing.
export function satisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: false, loose: false })
  } catch {
    return false
  }
}

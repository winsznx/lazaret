import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Builds the deterministic real-lockfile cohort. For each candidate repo it
// pins the default-branch HEAD commit, fetches package-lock.json at that exact
// SHA, validates it is an npm v2/v3 lockfile, and records it in a manifest with
// the repo, commit, path, raw URL, retrieval time, and package count. Only
// entries that actually resolve are kept, so the manifest never claims a
// lockfile that is not really there.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const CAMPAIGN_DIR = resolve(REPO_ROOT, "fixtures/campaign")
const LOCKFILE_DIR = resolve(CAMPAIGN_DIR, "lockfiles")
const MAX_BYTES = 9 * 1024 * 1024
const MAX_SUCCESS = 55

interface Candidates {
  selectionRule: string
  path: string
  repos: string[]
}

interface ManifestEntry {
  repo: string
  ref: string
  path: string
  rawUrl: string
  retrievedAt: string
  lockfileVersion: number
  packages: number
}

function slug(repo: string): string {
  return repo.replace(/\//g, "__")
}

function headSha(repo: string): string | null {
  try {
    return execSync(`gh api repos/${repo}/commits/HEAD --jq .sha`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const candidates = JSON.parse(
    readFileSync(resolve(CAMPAIGN_DIR, "candidates.json"), "utf8"),
  ) as Candidates
  mkdirSync(LOCKFILE_DIR, { recursive: true })

  const entries: ManifestEntry[] = []
  for (const repo of candidates.repos) {
    if (entries.length >= MAX_SUCCESS) break
    const sha = headSha(repo)
    if (sha === null) {
      console.warn(`skip ${repo}: could not resolve HEAD`)
      continue
    }
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${sha}/${candidates.path}`
    try {
      const response = await fetch(rawUrl)
      if (!response.ok) {
        console.warn(`skip ${repo}: raw ${response.status}`)
        continue
      }
      const text = await response.text()
      if (text.length > MAX_BYTES) {
        console.warn(`skip ${repo}: lockfile ${Math.round(text.length / 1024)}KB over cap`)
        continue
      }
      const parsed = JSON.parse(text) as { lockfileVersion?: number; packages?: unknown }
      if (typeof parsed.packages !== "object" || parsed.packages === null) {
        console.warn(`skip ${repo}: not a v2/v3 lockfile (no packages map)`)
        continue
      }
      const packageCount = Object.keys(parsed.packages as Record<string, unknown>).length
      writeFileSync(resolve(LOCKFILE_DIR, `${slug(repo)}.json`), text)
      entries.push({
        repo,
        ref: sha,
        path: candidates.path,
        rawUrl,
        retrievedAt: new Date().toISOString(),
        lockfileVersion: typeof parsed.lockfileVersion === "number" ? parsed.lockfileVersion : 0,
        packages: packageCount,
      })
      console.log(`ok   ${repo} @ ${sha.slice(0, 10)} (${packageCount} packages)`)
    } catch (error) {
      console.warn(`skip ${repo}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const manifest = {
    selectionRule: candidates.selectionRule,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  }
  writeFileSync(resolve(CAMPAIGN_DIR, "manifest.json"), JSON.stringify(manifest, null, 2))
  console.log(`\nmanifest: ${entries.length} lockfiles pinned`)
  if (!existsSync(resolve(CAMPAIGN_DIR, "manifest.json"))) process.exit(1)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})

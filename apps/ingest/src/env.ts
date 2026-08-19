import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

export function loadDotenv(): void {
  if (typeof process.loadEnvFile !== "function") return
  try {
    process.loadEnvFile(resolve(REPO_ROOT, ".env"))
  } catch {
    // no .env file; fall back to the ambient environment
  }
}

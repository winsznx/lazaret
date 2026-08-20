export function clock(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(11, 19)} UTC`
}

export function dateTimeUtc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

export function num(value: number): string {
  return value.toLocaleString("en-US")
}

export const GITHUB_URL = "https://github.com/winsznx/lazaret"
export const PRIMARY_INCIDENT = "chalk-debug-2025-09"

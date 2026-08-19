export function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function asBool(value: unknown): boolean {
  return value === true
}

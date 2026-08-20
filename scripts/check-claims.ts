import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..")
const CLAIMS_PATH = resolve(REPO_ROOT, "claims.json")

type Comparable = number | string | boolean
type CompareOp = "eq" | "lte" | "gte"

interface FileVerify {
  type: "file"
  path: string
  pointer?: string
  op?: CompareOp
  expect: Comparable
}

interface HttpVerify {
  type: "http"
  url: string
  pointer?: string
  op?: CompareOp
  expect?: Comparable
  expectStatus?: number
}

type VerifySpec = FileVerify | HttpVerify

interface Claim {
  id: string
  statement: string
  rung: string
  value: Comparable
  measuredAt: string
  evidence: string
  limitations?: string
  verify: VerifySpec
}

interface CheckResult {
  ok: boolean
  detail: string
}

const REQUIRED_FIELDS = [
  "id",
  "statement",
  "rung",
  "value",
  "measuredAt",
  "evidence",
  "verify",
] as const

function resolvePointer(root: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer === "") return root
  const segments = pointer
    .replace(/^#/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
  let current: unknown = root
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      throw new Error(`pointer "${pointer}" hit a non-object at "${segment}"`)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function compare(actual: unknown, expected: Comparable, op: CompareOp = "eq"): CheckResult {
  if (op === "eq") {
    const ok = actual === expected
    return {
      ok,
      detail: ok
        ? `matched ${JSON.stringify(expected)}`
        : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    }
  }
  if (typeof actual !== "number" || typeof expected !== "number") {
    return { ok: false, detail: `op ${op} needs numbers, got ${JSON.stringify(actual)}` }
  }
  const ok = op === "lte" ? actual <= expected : actual >= expected
  const symbol = op === "lte" ? "<=" : ">="
  return {
    ok,
    detail: ok ? `${actual} ${symbol} ${expected}` : `expected ${symbol} ${expected}, got ${actual}`,
  }
}

async function verifyFile(spec: FileVerify): Promise<CheckResult> {
  const target = resolve(REPO_ROOT, spec.path)
  const raw = await readFile(target, "utf8")
  const parsed: unknown = JSON.parse(raw)
  const actual = resolvePointer(parsed, spec.pointer)
  return compare(actual, spec.expect, spec.op)
}

async function verifyHttp(spec: HttpVerify): Promise<CheckResult> {
  const response = await fetch(spec.url)
  if (spec.expectStatus !== undefined && response.status !== spec.expectStatus) {
    return { ok: false, detail: `expected status ${spec.expectStatus}, got ${response.status}` }
  }
  if (spec.expect === undefined) {
    return { ok: response.ok, detail: `status ${response.status}` }
  }
  const parsed: unknown = await response.json()
  const actual = resolvePointer(parsed, spec.pointer)
  return compare(actual, spec.expect, spec.op)
}

async function runVerify(spec: VerifySpec): Promise<CheckResult> {
  switch (spec.type) {
    case "file":
      return verifyFile(spec)
    case "http":
      return verifyHttp(spec)
    default:
      return { ok: false, detail: `unknown verify type ${JSON.stringify((spec as { type: unknown }).type)}` }
  }
}

function validateShape(claim: Record<string, unknown>, index: number): string[] {
  const problems: string[] = []
  for (const field of REQUIRED_FIELDS) {
    if (!(field in claim)) problems.push(`claim[${index}] missing "${field}"`)
  }
  return problems
}

async function main(): Promise<void> {
  const raw = await readFile(CLAIMS_PATH, "utf8")
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== "object" || !("claims" in parsed)) {
    throw new Error("claims.json must be an object with a claims array")
  }
  const claims = (parsed as { claims: unknown }).claims
  if (!Array.isArray(claims)) {
    throw new Error("claims.json: claims must be an array")
  }

  if (claims.length === 0) {
    console.log("check-claims: 0 claims to verify")
    return
  }

  const shapeProblems = claims.flatMap((claim, index) =>
    validateShape(claim as Record<string, unknown>, index),
  )
  if (shapeProblems.length > 0) {
    for (const problem of shapeProblems) console.error(`  x ${problem}`)
    throw new Error(`${shapeProblems.length} malformed claim(s)`)
  }

  let failures = 0
  for (const claim of claims as Claim[]) {
    try {
      const result = await runVerify(claim.verify)
      const mark = result.ok ? "ok" : "DRIFT"
      console.log(`  [${mark}] ${claim.id}: ${result.detail}`)
      if (!result.ok) failures += 1
    } catch (error) {
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`  [ERROR] ${claim.id}: ${message}`)
    }
  }

  console.log(`check-claims: ${claims.length - failures}/${claims.length} verified`)
  if (failures > 0) {
    throw new Error(`${failures} claim(s) failed verification`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`check-claims failed: ${message}`)
  process.exit(1)
})

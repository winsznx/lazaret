import { blake3 } from "@noble/hashes/blake3"

// HydraDB ids are non-negative integers and the HTTP API returns them as JSON
// numbers, so ids must stay inside the JavaScript safe-integer range. We take
// the low 53 bits of a BLAKE3 digest (see DECISIONS ADR-0005).
const MASK_53 = 0x1fffffffffffffn

export function hashId(input: string): number {
  const digest = blake3(input)
  let acc = 0n
  for (let i = 0; i < 8; i += 1) {
    acc = (acc << 8n) | BigInt(digest[i] ?? 0)
  }
  return Number(acc & MASK_53)
}

export type NodeKind = "pkg" | "ver" | "adv"

export function nodeId(kind: NodeKind, key: string): number {
  return hashId(`${kind}:${key}`)
}

export function edgeId(relType: string, key: string): number {
  return hashId(`rel:${relType}:${key}`)
}

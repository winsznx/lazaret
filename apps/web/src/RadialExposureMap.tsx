import { useMemo, useRef, useState } from "react"
import type { BlastMember } from "./api"

const SIZE = 760
const CENTER = SIZE / 2
const INNER_R = 52
const OUTER_R = 344

export interface MapChainStep {
  pkg: string
  version: string
}

interface Props {
  members: BlastMember[]
  t: number
  maxDepth: number
  selectedKey: string | null
  chain: MapChainStep[]
  onSelect: (member: BlastMember) => void
}

interface PlacedNode {
  key: string
  member: BlastMember
  x: number
  y: number
}

function keyOf(pkg: string, version: string): string {
  return `${pkg}@${version}`
}

export function RadialExposureMap({
  members,
  t,
  maxDepth,
  selectedKey,
  chain,
  onSelect,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ member: BlastMember; left: number; top: number } | null>(
    null,
  )

  const { nodes, positions } = useMemo(() => {
    const byDepth = new Map<number, BlastMember[]>()
    for (const member of members) {
      const list = byDepth.get(member.depth)
      if (list === undefined) byDepth.set(member.depth, [member])
      else list.push(member)
    }
    const ringGap = maxDepth > 0 ? (OUTER_R - INNER_R) / maxDepth : 0
    const placed: PlacedNode[] = []
    const positionMap = new Map<string, PlacedNode>()
    for (let depth = 0; depth <= maxDepth; depth += 1) {
      const ring = byDepth.get(depth) ?? []
      const radius = depth === 0 ? (ring.length > 1 ? INNER_R * 0.5 : 0) : INNER_R + depth * ringGap
      const offset = depth * 0.618
      ring.forEach((member, index) => {
        const angle = (index / Math.max(ring.length, 1)) * Math.PI * 2 + offset
        const node: PlacedNode = {
          key: keyOf(member.pkg, member.semver),
          member,
          x: CENTER + radius * Math.cos(angle),
          y: CENTER + radius * Math.sin(angle),
        }
        placed.push(node)
        positionMap.set(node.key, node)
      })
    }
    return { nodes: placed, positions: positionMap }
  }, [members, maxDepth])

  const chainKeys = new Set(chain.map((step) => keyOf(step.pkg, step.version)))
  const hasSelection = selectedKey !== null
  const chainPoints = chain
    .map((step) => positions.get(keyOf(step.pkg, step.version)))
    .filter((node): node is PlacedNode => node !== undefined)
    .map((node) => `${node.x.toFixed(1)},${node.y.toFixed(1)}`)
    .join(" ")

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" role="img" aria-label="Radial exposure map">
        {Array.from({ length: maxDepth + 1 }, (_unused, depth) => {
          const radius =
            depth === 0
              ? INNER_R * 0.5
              : INNER_R + depth * ((OUTER_R - INNER_R) / Math.max(maxDepth, 1))
          return (
            <g key={depth}>
              <circle
                cx={CENTER}
                cy={CENTER}
                r={radius}
                fill="none"
                stroke="#ececee"
                strokeWidth={1}
              />
              {depth > 0 && (
                <text
                  x={CENTER + 4}
                  y={CENTER - radius - 4}
                  fill="#a1a1aa"
                  fontSize={10}
                  fontFamily="var(--mono)"
                >
                  depth {depth}
                </text>
              )}
            </g>
          )
        })}

        {chainPoints.length > 0 && (
          <polyline
            key={selectedKey ?? "none"}
            points={chainPoints}
            fill="none"
            stroke="#09090b"
            strokeWidth={1.6}
            strokeLinejoin="round"
            className="chain-draw"
          />
        )}

        {nodes.map((node) => {
          const exposed = node.member.t_first <= t
          const isSelected = node.key === selectedKey
          const inChain = chainKeys.has(node.key)
          let fill = "#d9d9de"
          if (exposed) fill = "#ff5a00"
          if (inChain) fill = "#09090b"
          if (isSelected) fill = "#09090b"
          const radius = isSelected ? 6.5 : node.member.depth === 0 ? 4.6 : 3.1
          const dim = hasSelection && !isSelected && !inChain
          return (
            <circle
              key={node.key}
              cx={node.x}
              cy={node.y}
              r={radius}
              fill={fill}
              opacity={dim ? 0.16 : 1}
              style={{
                transition: "fill 380ms ease, opacity 280ms ease, r 200ms ease",
                cursor: "pointer",
              }}
              onMouseEnter={(event) => {
                const rect = containerRef.current?.getBoundingClientRect()
                if (rect === undefined) return
                setHover({
                  member: node.member,
                  left: event.clientX - rect.left,
                  top: event.clientY - rect.top,
                })
              }}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(node.member)}
            />
          )
        })}
      </svg>

      {hover !== null && (
        <div
          style={{
            position: "absolute",
            left: hover.left + 12,
            top: hover.top + 12,
            pointerEvents: "none",
            background: "#09090b",
            color: "#fff",
            borderRadius: 10,
            padding: "8px 10px",
            fontSize: 12,
            maxWidth: 260,
            zIndex: 5,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            {hover.member.pkg}@{hover.member.semver}
          </div>
          <div style={{ color: "#a1a1aa", marginTop: 2 }}>
            depth {hover.member.depth} · {hover.member.t_first <= t ? "exposed" : "not yet exposed"}
          </div>
        </div>
      )}
    </div>
  )
}

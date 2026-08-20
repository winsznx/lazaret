import { useEffect, useMemo, useState } from "react"
import { apiBase, getBlast, getPath } from "./api"
import type { BlastMember, BlastResponse, IncidentSummary, PathMember } from "./api"

const DEPTH_COLORS = ["--d0", "--d1", "--d2", "--d3", "--d4", "--d5"]

function depthColor(depth: number): string {
  const token = DEPTH_COLORS[depth] ?? "--d-deep"
  return `var(${token})`
}

function utc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", "Z")
}

interface Props {
  incidents: IncidentSummary[]
}

export function Replay({ incidents }: Props): JSX.Element {
  const [incidentId, setIncidentId] = useState<string | null>(null)
  const [t, setT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [blast, setBlast] = useState<BlastResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chain, setChain] = useState<{ member: BlastMember; path: PathMember[] } | null>(null)

  const incident = incidents.find((entry) => entry.id === incidentId) ?? incidents[0] ?? null
  const tStart = incident !== null ? incident.windowStart - 600 : 0
  const tEnd = incident !== null ? incident.windowEnd + 3600 : 0
  const effectiveT = t ?? (incident !== null ? incident.windowEnd : 0)

  useEffect(() => {
    if (incident === null) return
    let cancelled = false
    const handle = setTimeout(() => {
      getBlast(incident.id, effectiveT)
        .then((result) => {
          if (!cancelled) {
            setBlast(result)
            setError(null)
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
        })
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [incident, effectiveT])

  useEffect(() => {
    if (!playing || incident === null) return
    const step = Math.max(1, Math.round((tEnd - tStart) / 60))
    const timer = setInterval(() => {
      setT((prev) => {
        const next = (prev ?? tStart) + step
        if (next >= tEnd) {
          setPlaying(false)
          return tEnd
        }
        return next
      })
    }, 220)
    return () => {
      clearInterval(timer)
    }
  }, [playing, incident, tStart, tEnd])

  const columns = useMemo(() => {
    const members = blast?.members ?? []
    const byDepth = new Map<number, BlastMember[]>()
    let maxDepth = 0
    for (const member of members) {
      maxDepth = Math.max(maxDepth, member.depth)
      const list = byDepth.get(member.depth)
      if (list === undefined) byDepth.set(member.depth, [member])
      else list.push(member)
    }
    return { byDepth, maxDepth, total: members.length }
  }, [blast])

  if (incident === null) {
    return (
      <div className="panel">
        <h2>Replay</h2>
        <div className="sub">
          No compiled incident is available yet. Bring up the stack, load a slice, and run{" "}
          <code>compile</code>.
        </div>
      </div>
    )
  }

  const width = 1120
  const height = 340
  const columnCount = columns.maxDepth + 1
  const columnWidth = width / Math.max(columnCount, 1)
  const pitch = 9
  const radius = 3

  const onDot = (member: BlastMember): void => {
    getPath(incident.id, member.pkg, member.semver)
      .then((path) => setChain({ member, path }))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const curl = `curl -s "${apiBase()}/v1/blast/${incident.id}?t=${effectiveT}"`

  return (
    <div>
      <div className="panel">
        <div className="row">
          <select
            className="select"
            value={incident.id}
            onChange={(event) => {
              setIncidentId(event.target.value)
              setT(null)
              setPlaying(false)
            }}
          >
            {incidents.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id} ({entry.exposed} exposed)
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            onClick={() => {
              setT(tStart)
              setPlaying(true)
            }}
          >
            ▶ Play the wave
          </button>
          <button className="btn" onClick={() => setPlaying(false)}>
            Pause
          </button>
          <div className="hud" style={{ marginLeft: "auto" }}>
            <div>
              <div className="big">{columns.total}</div>
              exposed at frame
            </div>
            <div>
              <div className="big">{blast?.latencyMs ?? 0}ms</div>
              server query
            </div>
          </div>
        </div>

        <div className="timeline">
          <input
            type="range"
            min={tStart}
            max={tEnd}
            step={Math.max(1, Math.round((tEnd - tStart) / 240))}
            value={effectiveT}
            onChange={(event) => {
              setPlaying(false)
              setT(Number(event.target.value))
            }}
          />
          <div className="t-labels">
            <span>{utc(tStart)}</span>
            <span>frame: {utc(effectiveT)}</span>
            <span>{utc(tEnd)}</span>
          </div>
        </div>

        <svg className="viz" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
          {Array.from({ length: columnCount }, (_unused, depth) => {
            const members = columns.byDepth.get(depth) ?? []
            const x0 = depth * columnWidth
            const perRow = Math.max(1, Math.floor((columnWidth - 16) / pitch))
            return (
              <g key={depth}>
                <text x={x0 + 12} y={22} fill="#7b8494" fontSize={12} fontFamily="monospace">
                  depth {depth}
                </text>
                <text
                  x={x0 + 12}
                  y={40}
                  fill={depthColor(depth)}
                  fontSize={16}
                  fontFamily="monospace"
                  fontWeight={700}
                >
                  {members.length}
                </text>
                {members.slice(0, perRow * 34).map((member, index) => {
                  const cx = x0 + 12 + (index % perRow) * pitch + radius
                  const cy = 58 + Math.floor(index / perRow) * pitch + radius
                  return (
                    <circle
                      key={`${member.pkg}@${member.semver}`}
                      cx={cx}
                      cy={cy}
                      r={radius}
                      fill={depthColor(depth)}
                      opacity={0.85}
                      style={{ cursor: "pointer" }}
                      onClick={() => onDot(member)}
                    >
                      <title>{`${member.pkg}@${member.semver} (depth ${depth})`}</title>
                    </circle>
                  )
                })}
              </g>
            )
          })}
        </svg>

        <div className="legend">
          <span>
            <span className="dot" style={{ background: "var(--d0)" }} /> depth 0 — malicious targets
          </span>
          <span>
            <span className="dot" style={{ background: "var(--d1)" }} /> direct dependents
          </span>
          <span>
            <span className="dot" style={{ background: "var(--d3)" }} /> transitive, deeper
          </span>
          <span className="muted">dots appear as t passes each version's t_first</span>
        </div>

        {error !== null && <div className="err">query error: {error}</div>}
        <code className="curl">{curl}</code>
      </div>

      {chain !== null && (
        <aside className="drawer">
          <button className="btn close" onClick={() => setChain(null)}>
            close
          </button>
          <h3>
            {chain.member.pkg}@{chain.member.semver}
          </h3>
          <div className="sub">
            Evidence path from the malicious root to this version. Each edge is a real{" "}
            <code>DEPENDS_ON</code> a range that admits the compromised version.
          </div>
          <ol className="chain">
            {chain.path.map((step) => (
              <li
                key={`${step.pkg}@${step.version}`}
                style={{ borderColor: depthColor(step.depth) }}
              >
                {step.pkg}@{step.version}
                <span className="depth-tag">depth {step.depth}</span>
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  )
}

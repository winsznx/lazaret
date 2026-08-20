import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getBlast, getIncidents, getPath } from "./api"
import type { BlastMember, IncidentSummary, PathMember } from "./api"
import { clock, dateTimeUtc, dateUtc, num } from "./lib"
import { RadialExposureMap } from "./RadialExposureMap"
import { Skeleton, Unavailable } from "./ui"

interface Props {
  incidentId: string
  embedded?: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function IncidentRoom({ incidentId, embedded = false }: Props): JSX.Element {
  const [incident, setIncident] = useState<IncidentSummary | null>(null)
  const [members, setMembers] = useState<BlastMember[]>([])
  const [t, setT] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<BlastMember | null>(null)
  const [chain, setChain] = useState<PathMember[]>([])
  const [frame, setFrame] = useState<{ latencyMs: number; count: number; cypher: string } | null>(
    null,
  )
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")

  useEffect(() => {
    let cancelled = false
    setStatus("loading")
    Promise.all([getIncidents(), getBlast(incidentId, 9_999_999_999)])
      .then(([incidents, blast]) => {
        if (cancelled) return
        const found = incidents.find((entry) => entry.id === incidentId) ?? null
        setIncident(found)
        setMembers(blast.members)
        setStatus("ready")
      })
      .catch(() => {
        if (!cancelled) setStatus("error")
      })
    return () => {
      cancelled = true
    }
  }, [incidentId])

  const maxDepth = useMemo(() => {
    let depth = 0
    for (const member of members) depth = Math.max(depth, member.depth)
    return depth
  }, [members])

  // The timeline axis is the detection window itself, compromise to detected.
  // Member exposure times trail for months past detection, so using their full
  // span would crush the two-hour window into a single pixel and pile the two
  // marks on top of each other.
  const axis = useMemo(() => {
    if (incident === null) return { min: 0, max: 1 }
    const min = incident.windowStart
    const max = incident.windowEnd > incident.windowStart ? incident.windowEnd : min + 1
    return { min, max }
  }, [incident])

  const windowLabel = useMemo(() => {
    const seconds = axis.max - axis.min
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}-minute`
    return `${Math.round(seconds / 3600)}-hour`
  }, [axis])

  const tail = useMemo(() => {
    if (incident === null) return { inWindow: 0, afterWindow: 0, last: 0 }
    let inWindow = 0
    let afterWindow = 0
    let last = 0
    for (const member of members) {
      if (member.t_first <= incident.windowEnd) inWindow += 1
      else afterWindow += 1
      if (member.t_first > last) last = member.t_first
    }
    return { inWindow, afterWindow, last }
  }, [incident, members])

  const effectiveT = t ?? axis.max

  // Replay once on load.
  useEffect(() => {
    if (status !== "ready" || members.length === 0) return
    setT(axis.min)
    setPlaying(true)
  }, [status, members.length, axis.min])

  useEffect(() => {
    if (!playing) return
    const step = Math.max(1, Math.round((axis.max - axis.min) / 90))
    const timer = setInterval(() => {
      setT((prev) => {
        const next = (prev ?? axis.min) + step
        if (next >= axis.max) {
          setPlaying(false)
          return axis.max
        }
        return next
      })
    }, 90)
    return () => clearInterval(timer)
  }, [playing, axis.min, axis.max])

  // Per-frame server query for the latency HUD and Cypher provenance.
  useEffect(() => {
    if (status !== "ready") return
    let cancelled = false
    const handle = setTimeout(() => {
      getBlast(incidentId, effectiveT)
        .then((blast) => {
          if (!cancelled) {
            setFrame({
              latencyMs: blast.latencyMs,
              count: blast.count,
              cypher: blast.cypher ?? "",
            })
          }
        })
        .catch(() => undefined)
    }, 110)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [incidentId, effectiveT, status])

  const select = useCallback(
    (member: BlastMember) => {
      setSelected(member)
      setChain([])
      getPath(incidentId, member.pkg, member.semver)
        .then((path) => setChain(path))
        .catch(() => setChain([]))
    },
    [incidentId],
  )

  const exposedNow = useMemo(
    () => members.filter((member) => member.t_first <= effectiveT).length,
    [members, effectiveT],
  )

  if (status === "loading") {
    return (
      <div className="card" style={{ minHeight: 520 }}>
        <Skeleton height={28} width={280} />
        <div style={{ height: 20 }} />
        <Skeleton height={420} />
      </div>
    )
  }
  if (status === "error" || incident === null) {
    return (
      <Unavailable
        title="Incident room unavailable"
        detail={`Could not reach the Lazaret API for "${incidentId}". Start the API with pnpm run api and compile this incident, then reload.`}
      />
    )
  }

  const selectedKey = selected !== null ? `${selected.pkg}@${selected.semver}` : null

  return (
    <div className="card" style={{ padding: embedded ? 24 : 28 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 340px" }}>
          <div className="eyebrow">Incident room</div>
          <div className="h" style={{ marginTop: 6 }}>
            {incident.id}
          </div>
          <div className="meta" style={{ marginTop: 8 }}>
            {incident.sourceId}
          </div>
          <div style={{ display: "flex", gap: 28, marginTop: 18, flexWrap: "wrap" }}>
            <MetaStat value={num(incident.targets)} label="malicious targets" />
            <MetaStat value={num(incident.exposed)} label="compiled exposed" />
            <MetaStat value={num(maxDepth)} label="max depth" />
          </div>
        </div>
        <div style={{ textAlign: "right", minWidth: 210 }}>
          <div className="stat-num" style={{ color: "var(--ember)", fontSize: 52 }}>
            {num(exposedNow)}
          </div>
          <div className="stat-label">exposed at this frame</div>
          <div
            style={{
              marginTop: 12,
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <span className="chip chip-neutral mono">
              {frame !== null ? `${frame.latencyMs} ms query` : "…"}
            </span>
            <span className="chip chip-neutral mono">HydraDB · causal</span>
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: embedded ? "1fr" : "minmax(0, 1.9fr) minmax(280px, 1fr)",
          gap: 24,
          marginTop: 20,
          alignItems: "start",
        }}
      >
        <div style={{ borderTop: "1px solid var(--cloud)", paddingTop: 16 }}>
          <RadialExposureMap
            members={members}
            t={effectiveT}
            maxDepth={maxDepth}
            selectedKey={selectedKey}
            chain={chain.map((step) => ({ pkg: step.pkg, version: step.version }))}
            onSelect={select}
          />
          <Timeline
            tMin={axis.min}
            tMax={axis.max}
            t={effectiveT}
            windowStart={incident.windowStart}
            windowEnd={incident.windowEnd}
            windowEndEstimated={incident.windowEndEstimated}
            playing={playing}
            onChange={(value) => {
              setPlaying(false)
              setT(value)
            }}
            onTogglePlay={() => {
              if (playing) {
                setPlaying(false)
              } else {
                setT((prev) => (prev !== null && prev >= axis.max ? axis.min : prev))
                setPlaying(true)
              }
            }}
          />
          {tail.afterWindow > 0 && (
            <p className="meta" style={{ marginTop: 14, lineHeight: 1.55, maxWidth: 560 }}>
              {num(tail.inWindow)} exposed inside the {windowLabel} detection window.{" "}
              {num(tail.afterWindow)} more dependents kept resolving the malicious range after
              detection, the latest on {dateUtc(tail.last)}.
            </p>
          )}
        </div>

        <Inspector
          incident={incident}
          selected={selected}
          chain={chain}
          cypher={frame?.cypher ?? null}
        />
      </div>
    </div>
  )
}

function MetaStat({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{value}</div>
      <div className="meta">{label}</div>
    </div>
  )
}

interface TimelineProps {
  tMin: number
  tMax: number
  t: number
  windowStart: number
  windowEnd: number
  windowEndEstimated: boolean
  playing: boolean
  onChange: (t: number) => void
  onTogglePlay: () => void
}

function Timeline({
  tMin,
  tMax,
  t,
  windowStart,
  windowEnd,
  windowEndEstimated,
  playing,
  onChange,
  onTogglePlay,
}: TimelineProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const pct = ((t - tMin) / (tMax - tMin)) * 100
  const markPct = (value: number): number => clamp(((value - tMin) / (tMax - tMin)) * 100, 0, 100)

  const setFromClientX = (clientX: number): void => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const p = clamp((clientX - rect.left) / rect.width, 0, 1)
    onChange(tMin + p * (tMax - tMin))
  }

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
        <button className="btn btn-dark btn-sm" onClick={onTogglePlay}>
          {playing ? "Pause" : "Play incident"}
        </button>
        <span className="mono" style={{ color: "var(--iron)" }}>
          {clock(t)}
        </span>
      </div>
      <div
        ref={trackRef}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setFromClientX(event.clientX)
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) setFromClientX(event.clientX)
        }}
        style={{ position: "relative", height: 46, cursor: "pointer", userSelect: "none" }}
      >
        <div
          style={{
            position: "absolute",
            top: 18,
            left: 0,
            right: 0,
            height: 3,
            background: "var(--cloud)",
            borderRadius: 3,
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 18,
            left: 0,
            width: `${pct}%`,
            height: 3,
            background: "var(--ember)",
            borderRadius: 3,
          }}
        />
        {[
          { at: windowStart, label: "compromise" },
          { at: windowEnd, label: windowEndEstimated ? "detected (est.)" : "detected" },
        ].map((mark) => {
          const p = markPct(mark.at)
          const transform =
            p <= 1 ? "translateX(0)" : p >= 99 ? "translateX(-100%)" : "translateX(-50%)"
          return (
            <div key={mark.label}>
              <div
                style={{
                  position: "absolute",
                  top: 8,
                  left: `${p}%`,
                  width: 1,
                  height: 22,
                  background: "var(--ash)",
                }}
              />
              <div
                className="meta"
                style={{
                  position: "absolute",
                  top: 32,
                  left: `${p}%`,
                  transform,
                  whiteSpace: "nowrap",
                }}
              >
                {mark.label}
              </div>
            </div>
          )
        })}
        <div
          style={{
            position: "absolute",
            top: 12,
            left: `${pct}%`,
            transform: "translateX(-50%)",
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--obsidian)",
            border: "2px solid var(--snow)",
          }}
        />
      </div>
    </div>
  )
}

interface InspectorProps {
  incident: IncidentSummary
  selected: BlastMember | null
  chain: PathMember[]
  cypher: string | null
}

function Inspector({ incident, selected, chain, cypher }: InspectorProps): JSX.Element {
  return (
    <div style={{ borderTop: "1px solid var(--cloud)", paddingTop: 16 }}>
      {selected === null ? (
        <div>
          <div className="eyebrow">Evidence inspector</div>
          <p className="meta" style={{ marginTop: 10, lineHeight: 1.6 }}>
            Select any node in the map to see when it became exposed, its dependency depth, and the
            concrete path that proves it, straight from the compiled EXPOSED_VIA edges in HydraDB.
          </p>
          <div style={{ marginTop: 16 }} className="meta">
            Window {dateTimeUtc(incident.windowStart)} to {dateTimeUtc(incident.windowEnd)}
            {incident.windowEndEstimated ? " (end estimated)" : ""}
          </div>
        </div>
      ) : (
        <div>
          <div className="eyebrow">Selected evidence</div>
          <div className="sub" style={{ marginTop: 8, wordBreak: "break-all" }}>
            {selected.pkg}
          </div>
          <div className="mono" style={{ color: "var(--iron)" }}>
            {selected.semver}
          </div>
          <div style={{ display: "flex", gap: 20, marginTop: 14 }}>
            <MetaStat value={`d${selected.depth}`} label="dependency depth" />
            <MetaStat value={clock(selected.t_first)} label="exposed at" />
          </div>

          <div className="eyebrow" style={{ marginTop: 20 }}>
            Evidence path
          </div>
          <ol style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
            {chain.length === 0 ? (
              <li>
                <Skeleton height={14} width={180} />
              </li>
            ) : (
              chain.map((step, index) => (
                <li
                  key={`${step.pkg}@${step.version}`}
                  className="mono"
                  style={{
                    padding: "7px 0 7px 14px",
                    borderLeft: `2px solid ${index === chain.length - 1 ? "var(--obsidian)" : "var(--cloud)"}`,
                    fontSize: 12.5,
                    color: index === 0 ? "var(--ember)" : "var(--graphite)",
                  }}
                >
                  {step.pkg}@{step.version}
                </li>
              ))
            )}
          </ol>
        </div>
      )}

      {cypher !== null && cypher.length > 0 && (
        <details style={{ marginTop: 20 }}>
          <summary className="meta" style={{ cursor: "pointer", color: "var(--iron)" }}>
            View the HydraDB query for this frame
          </summary>
          <code className="code" style={{ marginTop: 10 }}>
            {cypher}
          </code>
        </details>
      )}
    </div>
  )
}

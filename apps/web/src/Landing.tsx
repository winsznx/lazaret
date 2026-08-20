import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import claimsDoc from "../../../claims.json"
import { getIncidents, getStats } from "./api"
import type { IncidentSummary } from "./api"
import { ExposureStack } from "./ExposureStack"
import { IncidentRoom } from "./IncidentRoom"
import { clock, num, PRIMARY_INCIDENT } from "./lib"
import { ServiceCheck } from "./ServiceCheck"
import { Skeleton } from "./ui"

interface Claim {
  id: string
  statement: string
  value: number | string | boolean
  rung: string
  measuredAt: string
  limitations?: string
  verify: { type: string }
}

const claims = (claimsDoc as { claims: Claim[] }).claims

interface Stats {
  packages: number
  versions: number
  advisories: number
  incidents: number
}

export function Landing(): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null)
  const [incidents, setIncidents] = useState<IncidentSummary[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([getStats(), getIncidents()])
      .then(([loadedStats, loadedIncidents]) => {
        if (cancelled) return
        setStats(loadedStats)
        setIncidents(loadedIncidents)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const primary =
    incidents.find((entry) => entry.id === PRIMARY_INCIDENT) ??
    incidents.find((entry) => entry.compiled) ??
    null

  return (
    <div>
      {/* Hero */}
      <section className="section" id="top">
        <div
          className="shell"
          style={{
            display: "grid",
            gridTemplateColumns: "1.18fr 1fr",
            gap: 48,
            alignItems: "center",
          }}
        >
          <div>
            <span className="chip chip-ember-soft">GRAPH-NATIVE INCIDENT RESPONSE</span>
            <h1 className="display" style={{ marginTop: 20 }}>
              Compile the compromise.
              <br />
              Replay the blast radius.
            </h1>
            <p className="lead" style={{ marginTop: 20, maxWidth: 520 }}>
              Lazaret turns a package compromise into durable exposure state in HydraDB, then shows
              which services were exposed, when, and through which dependency path.
            </p>
            <div style={{ display: "flex", gap: 12, marginTop: 28 }}>
              <Link className="btn btn-dark" to={`/incident/${primary?.id ?? PRIMARY_INCIDENT}`}>
                Open incident room
              </Link>
              <Link className="btn btn-ghost" to="/check">
                Check a lockfile
              </Link>
            </div>
            <div style={{ display: "flex", gap: 40, marginTop: 40 }}>
              <HeroStat
                ready={ready}
                value={stats ? num(stats.packages) : null}
                label="packages in graph"
              />
              <HeroStat ready={ready} value={stats ? num(stats.versions) : null} label="versions" />
              <HeroStat
                ready={ready}
                value={primary ? num(primary.exposed) : null}
                label="exposed members"
              />
            </div>
          </div>
          <div
            className="card"
            style={{ height: 460, padding: 0, overflow: "hidden", background: "var(--snow)" }}
          >
            <ExposureStack />
          </div>
        </div>
      </section>

      {/* Incident story */}
      <section className="section" id="how">
        <div className="shell">
          <h2 className="h-lg" style={{ maxWidth: 720 }}>
            A package ships bad.
            <br />
            Six minutes later, what changed?
          </h2>
          <p className="lead" style={{ marginTop: 18, maxWidth: 640 }}>
            On September 8 2025 a maintainer account was compromised and pushed malicious versions
            of chalk, debug and more than a dozen other packages inside eight minutes. The versions
            were live long enough for installs to resolve them.
          </p>
          {primary !== null ? (
            <div
              className="card"
              style={{ marginTop: 28, display: "flex", flexWrap: "wrap", gap: 32 }}
            >
              <StoryStat
                value={num(primary.targets)}
                label="malicious versions published"
                sub={clock(primary.windowStart)}
              />
              <Arrow />
              <StoryStat
                value={num(primary.exposed)}
                label="versions exposed in the graph"
                sub="compiled once, then replayed"
              />
              <Arrow />
              <StoryStat
                value={primary.windowEndEstimated ? "~ est." : "known"}
                label="remediation window"
                sub={`${clock(primary.windowStart)} to ${clock(primary.windowEnd)}`}
              />
            </div>
          ) : (
            <div className="card" style={{ marginTop: 28 }}>
              <Skeleton height={60} />
            </div>
          )}
        </div>
      </section>

      {/* Mechanism */}
      <section className="section">
        <div className="shell">
          <div className="band-dark">
            <span className="eyebrow" style={{ color: "var(--ember)" }}>
              The mechanism
            </span>
            <h2 className="h-lg" style={{ marginTop: 12, color: "var(--snow)" }}>
              Compile once.
              <br />
              Ask repeatedly.
            </h2>
            <p className="lead" style={{ marginTop: 16, maxWidth: 620 }}>
              HydraDB&apos;s query surface cannot express semver or a transitive closure. So Lazaret
              runs the exposure fixpoint once and writes the answer back as graph edges. Every
              question after that is a single bounded read.
            </p>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginTop: 32,
                flexWrap: "wrap",
              }}
            >
              {["npm graph", "incident compiler", "EXPOSES / EXPOSED_VIA", "replay + verdicts"].map(
                (stage, index) => (
                  <div key={stage} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div
                      className="mono"
                      style={{
                        border: "1px solid #3f3f46",
                        color: index >= 2 ? "var(--ember)" : "var(--paper)",
                        borderRadius: 12,
                        padding: "10px 14px",
                        fontSize: 12.5,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {stage}
                    </div>
                    {index < 3 && <span style={{ color: "var(--steel)" }}>→</span>}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Live product */}
      <section className="section">
        <div className="shell">
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 22,
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <h2 className="h-lg">The incident room, live.</h2>
            <Link className="btn btn-ghost" to={`/incident/${primary?.id ?? PRIMARY_INCIDENT}`}>
              Open full room
            </Link>
          </div>
          <IncidentRoom incidentId={primary?.id ?? PRIMARY_INCIDENT} embedded />
        </div>
      </section>

      {/* Service check */}
      <section className="section">
        <div className="shell" style={{ maxWidth: 820 }}>
          <h2 className="h-lg">Was my service exposed?</h2>
          <p className="lead" style={{ marginTop: 16, marginBottom: 28 }}>
            Drop a lockfile. Lazaret checks the resolved tree against the compiled exposure graph
            and returns a verdict with evidence, never a guess.
          </p>
          <ServiceCheck compact />
        </div>
      </section>

      {/* Evidence */}
      <section className="section">
        <div className="shell">
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 22,
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <h2 className="h-lg">Proof is part of the product.</h2>
            <Link className="btn btn-ghost" to="/evidence">
              All evidence
            </Link>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 16,
            }}
          >
            {claims.slice(0, 4).map((claim) => (
              <div key={claim.id} className="card">
                <div className="stat-num" style={{ fontSize: 34 }}>
                  {String(claim.value)}
                </div>
                <p
                  style={{
                    margin: "12px 0 0",
                    fontSize: 14,
                    color: "var(--iron)",
                    lineHeight: 1.5,
                  }}
                >
                  {claim.statement}
                </p>
                <div className="meta" style={{ marginTop: 12 }}>
                  {claim.rung} · {claim.verify.type === "static" ? "recorded" : "machine-checked"}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

function HeroStat({
  ready,
  value,
  label,
}: {
  ready: boolean
  value: string | null
  label: string
}): JSX.Element {
  return (
    <div>
      <div className="stat-num">{value ?? (ready ? "—" : <Skeleton height={36} width={90} />)}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function StoryStat({
  value,
  label,
  sub,
}: {
  value: string
  label: string
  sub: string
}): JSX.Element {
  return (
    <div style={{ flex: "1 1 180px" }}>
      <div className="stat-num" style={{ fontSize: 32 }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
      <div className="meta mono" style={{ marginTop: 6 }}>
        {sub}
      </div>
    </div>
  )
}

function Arrow(): JSX.Element {
  return (
    <div style={{ alignSelf: "center", color: "var(--ash)", fontSize: 22 }} aria-hidden>
      →
    </div>
  )
}

export function Footer(): JSX.Element {
  return (
    <footer style={{ borderTop: "1px solid var(--cloud)", marginTop: 40 }}>
      <div
        className="shell"
        style={{
          padding: "32px 40px",
          display: "flex",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div className="meta">
          Lazaret · supply-chain blast radius on HydraDB · Hack Hydra Track 2A
        </div>
        <div className="meta">MIT. HydraDB consumed unmodified (AGPL-3.0).</div>
      </div>
    </footer>
  )
}

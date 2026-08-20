import { useEffect, useState } from "react"
import { apiBase, getIncidents, getStats } from "./api"
import type { IncidentSummary } from "./api"
import { Claims } from "./Claims"
import { Replay } from "./Replay"
import { Verdict } from "./Verdict"

type View = "replay" | "verdict" | "claims"

interface Stats {
  packages: number
  versions: number
  advisories: number
  incidents: number
}

export function App(): JSX.Element {
  const [view, setView] = useState<View>("replay")
  const [incidents, setIncidents] = useState<IncidentSummary[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([getIncidents(), getStats()])
      .then(([loadedIncidents, loadedStats]) => {
        if (cancelled) return
        setIncidents(loadedIncidents)
        setStats(loadedStats)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const compiled = incidents.filter((incident) => incident.compiled)

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">
            <span>lazaret</span> // supply-chain blast radius
          </div>
          <div className="tagline">
            When a package is compromised, which of your services were actually exposed. Compiled
            once into a HydraDB graph, replayed in one hop.
          </div>
        </div>
        {stats !== null && (
          <div className="stats">
            <span>
              <b>{stats.packages.toLocaleString()}</b> packages
            </span>
            <span>
              <b>{stats.versions.toLocaleString()}</b> versions
            </span>
            <span>
              <b>{stats.advisories}</b> incidents
            </span>
          </div>
        )}
        <nav className="nav">
          <button className={view === "replay" ? "active" : ""} onClick={() => setView("replay")}>
            Replay
          </button>
          <button className={view === "verdict" ? "active" : ""} onClick={() => setView("verdict")}>
            Verdict
          </button>
          <button className={view === "claims" ? "active" : ""} onClick={() => setView("claims")}>
            Claims
          </button>
        </nav>
      </header>

      <main className="main">
        {error !== null && (
          <div className="panel err">
            API error: {error}. Is the api running at {apiBase()}?
          </div>
        )}
        {view === "replay" && <Replay incidents={compiled} />}
        {view === "verdict" && <Verdict incidents={compiled} />}
        {view === "claims" && <Claims />}
      </main>
    </div>
  )
}

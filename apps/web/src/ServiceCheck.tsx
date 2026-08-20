import { useEffect, useState } from "react"
import billingService from "../../../fixtures/lockfiles/billing-service.json"
import docsSite from "../../../fixtures/lockfiles/docs-site.json"
import webDashboard from "../../../fixtures/lockfiles/web-dashboard.json"
import { getIncidents, postVerdict } from "./api"
import type { PackageVerdict, ServiceVerdict } from "./api"
import { PRIMARY_INCIDENT } from "./lib"
import { StatusChip } from "./ui"

interface Upload {
  service: string
  lockfile: unknown
}

const SAMPLES: Upload[] = [
  { service: "billing-service", lockfile: billingService },
  { service: "web-dashboard", lockfile: webDashboard },
  { service: "docs-site", lockfile: docsSite },
]

function why(verdict: ServiceVerdict): string {
  switch (verdict.class) {
    case "EXPOSED_PINNED":
      return "The resolved dependency tree pins a version flagged in this incident. The compromised code is already in the lockfile."
    case "EXPOSED_WINDOW":
      return "No compromised version is pinned, but a declared range admits one. A fresh install or update during the incident window would resolve into the attack."
    case "CLEAN":
      return "Every referenced package is inside the compiled slice, and no resolved version or declared range reaches a compromised version."
    case "OUT_OF_SLICE":
      return "Lazaret does not have enough graph coverage for one or more packages here, so it abstains rather than guessing."
  }
}

function evidenceLine(pkg: PackageVerdict): string | null {
  if (pkg.class === "EXPOSED_PINNED") return `pinned ${pkg.name}@${pkg.pinnedVersion ?? "?"}`
  if (pkg.class === "EXPOSED_WINDOW") {
    return `range ${pkg.admittingRange ?? "?"} admits ${pkg.name}@${pkg.admittedVersion ?? "?"}`
  }
  return null
}

export function ServiceCheck({ compact = false }: { compact?: boolean }): JSX.Element {
  const [incidentId, setIncidentId] = useState<string>(PRIMARY_INCIDENT)
  const [incidents, setIncidents] = useState<string[]>([])
  const [verdicts, setVerdicts] = useState<ServiceVerdict[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getIncidents()
      .then((list) => {
        if (cancelled) return
        const compiled = list.filter((entry) => entry.compiled).map((entry) => entry.id)
        setIncidents(compiled)
        if (compiled.length > 0 && !compiled.includes(incidentId))
          setIncidentId(compiled[0] ?? incidentId)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [incidentId])

  const run = (uploads: Upload[]): void => {
    if (uploads.length === 0) return
    setBusy(true)
    postVerdict(incidentId, uploads)
      .then((response) => {
        setVerdicts(response.verdicts)
        setError(null)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setOver(false)
    const files = Array.from(event.dataTransfer.files)
    Promise.all(
      files.map(async (file) => ({
        service: file.name.replace(/\.json$/, ""),
        lockfile: JSON.parse(await file.text()) as unknown,
      })),
    )
      .then(run)
      .catch(() => setError("Could not read one of the dropped files as JSON."))
  }

  return (
    <div>
      {incidents.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span className="meta">Incident</span>
          <select
            className="btn btn-neutral btn-sm"
            value={incidentId}
            onChange={(event) => {
              setIncidentId(event.target.value)
              setVerdicts([])
            }}
          >
            {incidents.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>
      )}

      <div
        className="card"
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        style={{
          border: over ? "1.5px dashed var(--ember)" : "1.5px dashed var(--mist)",
          textAlign: "center",
          padding: compact ? 32 : 52,
          background: over ? "var(--ember-soft)" : "var(--snow)",
          transition: "background 160ms ease, border-color 160ms ease",
        }}
      >
        <div className="sub" style={{ marginBottom: 8 }}>
          Drop a package-lock.json
        </div>
        <p className="meta" style={{ maxWidth: 460, margin: "0 auto 18px" }}>
          Lazaret evaluates the resolved dependency tree against the compiled exposure graph. Files
          are processed in memory and never stored.
        </p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {SAMPLES.map((sample) => (
            <button
              key={sample.service}
              className="btn btn-neutral btn-sm"
              onClick={() => run([sample])}
            >
              {sample.service}
            </button>
          ))}
          <button className="btn btn-dark btn-sm" onClick={() => run(SAMPLES)} disabled={busy}>
            {busy ? "Checking…" : "Check all samples"}
          </button>
        </div>
      </div>

      {error !== null && (
        <div className="meta" style={{ color: "var(--ember)", marginTop: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
        {verdicts.map((verdict) => {
          const isOpen = open === verdict.service
          return (
            <div key={verdict.service} className="card" style={{ padding: 20 }}>
              <div
                style={{ display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}
                onClick={() => setOpen(isOpen ? null : verdict.service)}
              >
                <div className="sub" style={{ flex: 1, wordBreak: "break-all" }}>
                  {verdict.service}
                </div>
                <StatusChip verdict={verdict.class} />
                <span className="meta">{isOpen ? "hide" : "why"}</span>
              </div>
              {isOpen && (
                <div style={{ marginTop: 16, borderTop: "1px solid var(--cloud)", paddingTop: 16 }}>
                  <div className="eyebrow">Why Lazaret returned this verdict</div>
                  <p className="meta" style={{ marginTop: 8, lineHeight: 1.6 }}>
                    {why(verdict)}
                  </p>
                  <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
                    {verdict.packages
                      .filter((pkg) => pkg.class !== "CLEAN")
                      .map((pkg) => {
                        const line = evidenceLine(pkg)
                        return (
                          <li
                            key={pkg.name}
                            className="mono"
                            style={{ fontSize: 12.5, padding: "5px 0", color: "var(--graphite)" }}
                          >
                            {line ?? pkg.name}
                            {pkg.chain !== undefined && pkg.chain.length > 1 && (
                              <span className="muted">
                                {"  ·  "}
                                {pkg.chain.map((step) => `${step.pkg}@${step.version}`).join(" → ")}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    {verdict.outOfSlice.length > 0 && (
                      <li
                        className="mono"
                        style={{ fontSize: 12.5, padding: "5px 0", color: "var(--fog)" }}
                      >
                        out of slice: {verdict.outOfSlice.join(", ")}
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

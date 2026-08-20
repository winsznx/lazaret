import { useState } from "react"
import billingService from "../../../fixtures/lockfiles/billing-service.json"
import docsSite from "../../../fixtures/lockfiles/docs-site.json"
import webDashboard from "../../../fixtures/lockfiles/web-dashboard.json"
import { postVerdict } from "./api"
import type { IncidentSummary, PackageVerdict, ServiceVerdict } from "./api"

interface Props {
  incidents: IncidentSummary[]
}

interface Uploaded {
  service: string
  lockfile: unknown
}

const SAMPLES: Uploaded[] = [
  { service: "billing-service", lockfile: billingService },
  { service: "web-dashboard", lockfile: webDashboard },
  { service: "docs-site", lockfile: docsSite },
]

function evidence(pkg: PackageVerdict): string {
  if (pkg.class === "EXPOSED_PINNED") return `pinned ${pkg.name}@${pkg.pinnedVersion ?? "?"}`
  if (pkg.class === "EXPOSED_WINDOW") {
    return `range ${pkg.admittingRange ?? "?"} admits ${pkg.name}@${pkg.admittedVersion ?? "?"}`
  }
  return pkg.class
}

export function Verdict({ incidents }: Props): JSX.Element {
  const [incidentId, setIncidentId] = useState<string | null>(null)
  const [verdicts, setVerdicts] = useState<ServiceVerdict[]>([])
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [selected, setSelected] = useState<ServiceVerdict | null>(null)

  const incident = incidents.find((entry) => entry.id === incidentId) ?? incidents[0] ?? null

  const run = (uploads: Uploaded[]): void => {
    if (incident === null || uploads.length === 0) return
    postVerdict(incident.id, uploads)
      .then((response) => {
        setVerdicts(response.verdicts)
        setError(null)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setOver(false)
    const files = Array.from(event.dataTransfer.files)
    Promise.all(
      files.map(async (file) => {
        const text = await file.text()
        return { service: file.name.replace(/\.json$/, ""), lockfile: JSON.parse(text) as unknown }
      }),
    )
      .then((uploads) => run(uploads))
      .catch(() => setError("could not read one of the dropped files as JSON"))
  }

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(verdicts, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "lazaret-verdicts.json"
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (incident === null) {
    return (
      <div className="panel">
        <h2>Verdict</h2>
        <div className="sub">No compiled incident is available yet.</div>
      </div>
    )
  }

  return (
    <div>
      <div className="panel">
        <h2>Verdict board</h2>
        <div className="sub">
          Drop your <code>package-lock.json</code> files. Lazaret checks each service against the{" "}
          {incident.id} closure. Lockfiles are processed in memory and never stored.
        </div>
        <div className="row" style={{ marginBottom: 14 }}>
          <select
            className="select"
            value={incident.id}
            onChange={(event) => {
              setIncidentId(event.target.value)
              setVerdicts([])
            }}
          >
            {incidents.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => run(SAMPLES)}>
            Load sample lockfiles
          </button>
          {verdicts.length > 0 && (
            <button className="btn" onClick={exportJson}>
              Export JSON
            </button>
          )}
        </div>

        <div
          className={over ? "dropzone over" : "dropzone"}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          drop package-lock.json files here, or load the samples above
        </div>

        {error !== null && <div className="err">verdict error: {error}</div>}

        <div className="board">
          {verdicts.map((service) => (
            <div key={service.service} className="card" onClick={() => setSelected(service)}>
              <div className="svc">{service.service}</div>
              <span className={`badge ${service.class}`}>{service.class}</span>
              <div className="meta">
                {service.packages.length} packages checked
                {service.outOfSlice.length > 0 && `, ${service.outOfSlice.length} out of slice`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {selected !== null && (
        <aside className="drawer">
          <button className="btn close" onClick={() => setSelected(null)}>
            close
          </button>
          <h3>{selected.service}</h3>
          <span className={`badge ${selected.class}`}>{selected.class}</span>
          <ul className="pkg-list">
            {selected.packages
              .filter((pkg) => pkg.class !== "CLEAN")
              .map((pkg) => (
                <li key={pkg.name}>
                  <span>{pkg.name}</span>
                  <span className="muted">{evidence(pkg)}</span>
                </li>
              ))}
          </ul>
          {selected.packages
            .filter((pkg) => pkg.chain !== undefined && pkg.chain.length > 0)
            .slice(0, 1)
            .map((pkg) => (
              <div key={pkg.name} style={{ marginTop: 16 }}>
                <div className="sub">Evidence path for {pkg.name}</div>
                <ol className="chain">
                  {(pkg.chain ?? []).map((step) => (
                    <li key={`${step.pkg}@${step.version}`}>
                      {step.pkg}@{step.version}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
        </aside>
      )}
    </div>
  )
}

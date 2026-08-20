import claimsDoc from "../../../claims.json"
import { Footer } from "./Landing"

interface Claim {
  id: string
  statement: string
  value: number | string | boolean
  rung: string
  measuredAt: string
  evidence: string
  limitations?: string
  verify: { type: string }
}

const doc = claimsDoc as { description: string; claims: Claim[] }

const REPRO = [
  "bash scripts/dev-up.sh",
  "pnpm run seed:fixture",
  "pnpm run verify",
  "pnpm exec tsx apps/ingest/src/cli.ts compile --incident=fixtures/incidents/chalk-debug-2025-09.json",
]

const LIMITATIONS = [
  "The slice is a bounded crawl seeded from npm-high-impact plus the incident packages, not all of npm. Counts move with the crawl budget.",
  "Malicious version numbers and publish times are reconstructed from the live npm registry time map, which survives after the versions are removed. Incident window ends are estimates from published detection reports.",
  "Latency figures are from a local single-node HydraDB on Apple Silicon.",
]

function verificationLabel(type: string): string {
  if (type === "http" || type === "file") return "Machine-verified"
  return "Recorded · re-derivable"
}

export function EvidencePage(): JSX.Element {
  return (
    <div>
      <section className="section" style={{ paddingTop: 36 }}>
        <div className="shell">
          <span className="eyebrow">Evidence</span>
          <h1 className="h-lg" style={{ marginTop: 10, maxWidth: 820 }}>
            Every claim should lead back to something you can inspect or reproduce.
          </h1>
          <p className="lead" style={{ marginTop: 16, maxWidth: 640 }}>
            {doc.description} Static claims are shape-checked in CI and re-derivable with the exact
            command shown. Nothing here is asserted as live-verified unless the checker actually
            verifies it.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: 16,
              marginTop: 32,
            }}
          >
            {doc.claims.map((claim) => (
              <div key={claim.id} className="card">
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div className="stat-num" style={{ fontSize: 40 }}>
                    {String(claim.value)}
                  </div>
                  <span className="chip chip-neutral">{verificationLabel(claim.verify.type)}</span>
                </div>
                <p
                  style={{
                    margin: "14px 0 0",
                    fontSize: 15,
                    color: "var(--graphite)",
                    lineHeight: 1.55,
                  }}
                >
                  {claim.statement}
                </p>
                <div className="meta" style={{ marginTop: 14 }}>
                  {claim.rung} · measured {claim.measuredAt.slice(0, 10)}
                </div>
                <div
                  className="mono"
                  style={{
                    marginTop: 10,
                    color: "var(--fog)",
                    fontSize: 11.5,
                    wordBreak: "break-word",
                  }}
                >
                  {claim.evidence}
                </div>
                {claim.limitations !== undefined && (
                  <p
                    className="meta"
                    style={{ marginTop: 12, borderTop: "1px solid var(--cloud)", paddingTop: 12 }}
                  >
                    Limitation: {claim.limitations}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 40 }}>
            <div className="card">
              <div className="eyebrow">Reproduce it</div>
              <p className="meta" style={{ margin: "10px 0 14px" }}>
                From a clean clone with Docker and pnpm. The verify step proves the compiled graph
                equals an independent reference resolver, exactly.
              </p>
              <code className="code">{REPRO.join("\n")}</code>
            </div>
            <div className="card">
              <div className="eyebrow">Limitations, stated plainly</div>
              <ul style={{ margin: "12px 0 0", paddingLeft: 18 }}>
                {LIMITATIONS.map((item) => (
                  <li
                    key={item}
                    style={{
                      fontSize: 13.5,
                      color: "var(--iron)",
                      lineHeight: 1.55,
                      marginBottom: 10,
                    }}
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>
      <Footer />
    </div>
  )
}

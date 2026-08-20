import { Footer } from "./Landing"
import { ServiceCheck } from "./ServiceCheck"

export function CheckPage(): JSX.Element {
  return (
    <div>
      <section className="section" style={{ paddingTop: 36 }}>
        <div className="shell" style={{ maxWidth: 880 }}>
          <span className="eyebrow">Service check</span>
          <h1 className="h-lg" style={{ marginTop: 10 }}>
            Check a service against this incident.
          </h1>
          <p className="lead" style={{ marginTop: 16, marginBottom: 30, maxWidth: 620 }}>
            Drop a package-lock.json. Lazaret evaluates the resolved dependency tree against the
            compiled exposure graph. Files are processed in memory and never stored.
          </p>
          <ServiceCheck />
        </div>
      </section>
      <Footer />
    </div>
  )
}

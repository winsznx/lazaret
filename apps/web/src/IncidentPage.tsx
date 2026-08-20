import { useParams } from "react-router-dom"
import { IncidentRoom } from "./IncidentRoom"
import { Footer } from "./Landing"
import { PRIMARY_INCIDENT } from "./lib"

export function IncidentPage(): JSX.Element {
  const { id } = useParams<{ id: string }>()
  return (
    <div>
      <section className="section" style={{ paddingTop: 36 }}>
        <div className="shell">
          <IncidentRoom incidentId={id ?? PRIMARY_INCIDENT} />
        </div>
      </section>
      <Footer />
    </div>
  )
}

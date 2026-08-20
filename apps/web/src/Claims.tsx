import claimsDoc from "../../../claims.json"

interface Claim {
  id: string
  statement: string
  rung: string
  value: number | string | boolean
  measuredAt: string
  evidence: string
  limitations?: string
}

const doc = claimsDoc as { description: string; claims: Claim[] }

export function Claims(): JSX.Element {
  return (
    <div className="panel">
      <h2>Claim ledger</h2>
      <div className="sub">
        Every public number Lazaret reports, with an evidence pointer and a machine check.{" "}
        <code>pnpm check:claims</code> re-verifies each claim and fails CI on drift.{" "}
        {doc.description}
      </div>
      <table className="claims">
        <thead>
          <tr>
            <th>Claim</th>
            <th>Value</th>
            <th>Rung</th>
            <th>Measured</th>
            <th>Limitations</th>
          </tr>
        </thead>
        <tbody>
          {doc.claims.map((claim) => (
            <tr key={claim.id}>
              <td>{claim.statement}</td>
              <td>
                <b>{String(claim.value)}</b>
              </td>
              <td className="rung">{claim.rung}</td>
              <td className="muted">{claim.measuredAt.slice(0, 10)}</td>
              <td className="muted">{claim.limitations ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

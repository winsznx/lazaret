import { Link } from "react-router-dom"
import { GITHUB_URL, PRIMARY_INCIDENT } from "./lib"

export function Nav(): JSX.Element {
  return (
    <header className="nav">
      <div className="nav-inner">
        <Link to="/" className="nav-brand">
          lazaret<span className="dot">.</span>
        </Link>
        <nav className="nav-links">
          <Link to="/#how">How it works</Link>
          <Link to="/evidence">Evidence</Link>
          <a href={`${GITHUB_URL}/blob/main/ARCHITECTURE.md`} target="_blank" rel="noreferrer">
            Docs
          </a>
        </nav>
        <div className="nav-right">
          <a className="btn btn-ghost" href={GITHUB_URL} target="_blank" rel="noreferrer">
            View GitHub
          </a>
          <Link className="btn btn-dark" to={`/incident/${PRIMARY_INCIDENT}`}>
            Open incident room
          </Link>
        </div>
      </div>
    </header>
  )
}

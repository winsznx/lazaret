import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { CheckPage } from "./CheckPage"
import { EvidencePage } from "./EvidencePage"
import { IncidentPage } from "./IncidentPage"
import { Landing } from "./Landing"
import { Nav } from "./Nav"
import "./theme.css"

const root = document.getElementById("root")
if (root === null) throw new Error("root element missing")

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/incident/:id" element={<IncidentPage />} />
        <Route path="/check" element={<CheckPage />} />
        <Route path="/evidence" element={<EvidencePage />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)

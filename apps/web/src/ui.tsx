import type { PackageClass } from "./api"

const CLASS_CHIP: Record<PackageClass, { className: string; label: string }> = {
  EXPOSED_PINNED: { className: "chip chip-ember", label: "Exposed · pinned" },
  EXPOSED_WINDOW: { className: "chip chip-ember-outline", label: "Exposed · window" },
  CLEAN: { className: "chip chip-ink", label: "Clean" },
  OUT_OF_SLICE: { className: "chip chip-dashed", label: "Out of slice" },
}

export function StatusChip({ verdict }: { verdict: PackageClass }): JSX.Element {
  const chip = CLASS_CHIP[verdict]
  return <span className={chip.className}>{chip.label}</span>
}

export function Skeleton({
  height = 16,
  width = "100%",
}: {
  height?: number
  width?: number | string
}): JSX.Element {
  return <div className="skeleton" style={{ height, width }} />
}

export function Unavailable({ title, detail }: { title: string; detail: string }): JSX.Element {
  return (
    <div className="state">
      <div className="sub" style={{ color: "var(--iron)", marginBottom: 8 }}>
        {title}
      </div>
      <div className="meta" style={{ maxWidth: 460, margin: "0 auto" }}>
        {detail}
      </div>
    </div>
  )
}

export function Stat({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div>
      <div className="stat-num">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

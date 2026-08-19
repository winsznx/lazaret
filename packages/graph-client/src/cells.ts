export interface TypedCell {
  type: string
  value: unknown
}

export type CellValue = number | string | boolean | null

export function unwrapCell(cell: TypedCell): CellValue {
  const value = cell.value
  if (value === null) return null
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value
  }
  return null
}

export function unwrapRow(columns: string[], cells: TypedCell[]): Record<string, CellValue> {
  const row: Record<string, CellValue> = {}
  for (let i = 0; i < columns.length; i += 1) {
    const key = columns[i]
    const cell = cells[i]
    if (key === undefined || cell === undefined) continue
    row[key] = unwrapCell(cell)
  }
  return row
}

import type { DiffLineRow } from "@/lib/diff/block-diff"

import { InlineParts } from "@/components/detail/diff/InlineParts"

interface UnifiedLineDiffProps {
  rows: Array<DiffLineRow>
}

/** Cap rendered rows so a pathological diff cannot blow up the DOM. */
const MAX_ROWS = 600

function gutterCell(value: number | undefined): string {
  return value === undefined ? "" : String(value)
}

function signFor(kind: DiffLineRow["kind"]): string {
  if (kind === "add") return "+"
  if (kind === "del") return "−"
  return " "
}

function rowClass(kind: DiffLineRow["kind"]): string {
  if (kind === "add") return "bg-[color-mix(in_srgb,var(--color-ok)_12%,transparent)]"
  if (kind === "del") return "bg-[color-mix(in_srgb,var(--color-fail)_12%,transparent)]"
  return ""
}

function DiffRow({ row }: { row: DiffLineRow }) {
  return (
    <div className={`flex items-start gap-2 ${rowClass(row.kind)}`}>
      <span className="w-8 flex-shrink-0 select-none text-right text-[var(--color-muted)] opacity-60">{gutterCell(row.oldNo)}</span>
      <span className="w-8 flex-shrink-0 select-none text-right text-[var(--color-muted)] opacity-60">{gutterCell(row.newNo)}</span>
      <span className="w-3 flex-shrink-0 select-none text-center text-[var(--color-muted)]">{signFor(row.kind)}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {row.words ?
          <InlineParts parts={row.words} />
        : row.text}
      </span>
    </div>
  )
}

export function UnifiedLineDiff({ rows }: UnifiedLineDiffProps) {
  const shown = rows.slice(0, MAX_ROWS)
  const overflow = rows.length - shown.length
  return (
    <div className="mono text-[12px] leading-[1.5]">
      {shown.map((row, i) => (
        <DiffRow
          key={i}
          row={row}
        />
      ))}
      {overflow > 0 ?
        <div className="mt-1 text-[var(--color-muted)] opacity-70">+{overflow} more lines.</div>
      : null}
    </div>
  )
}

import {
  //
  MODEL_COLUMNS,
  type ModelColumnKey,
  type ModelColumnVisibility,
} from "@/lib/model-columns"

interface ModelsColumnMenuProps {
  columns: ModelColumnVisibility
  onToggle: (key: ModelColumnKey) => void
  onReset: () => void
}

export function ModelsColumnMenu({ columns, onToggle, onReset }: ModelsColumnMenuProps) {
  return (
    <details className="relative">
      <summary className="mono cursor-pointer list-none border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text)] hover:text-[var(--color-primary)]">
        Columns
      </summary>
      <div className="absolute right-0 z-10 mt-1 min-w-[180px] border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
        <div className="mb-1 flex items-center justify-between border-b border-[var(--color-border)] pb-1">
          <span className="text-[11px] uppercase tracking-wider text-[var(--color-muted)]">Columns</span>
          <button
            type="button"
            className="text-[11px] text-[var(--color-primary)]"
            onClick={onReset}
          >
            Reset
          </button>
        </div>
        {MODEL_COLUMNS.map((col) => (
          <label
            key={col.key}
            className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px]"
          >
            <input
              type="checkbox"
              data-col={col.key}
              checked={columns[col.key]}
              onChange={() => onToggle(col.key)}
            />
            <span>{col.label}</span>
          </label>
        ))}
      </div>
    </details>
  )
}

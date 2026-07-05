import type { ReactNode } from "react"

/**
 * Shared key-value primitives for the model-detail tabs.
 *
 * Every tab is "pick fields + label them"; layout/spacing/`—` placeholder live
 * here so the tab components stay declarative and consistent. Missing values
 * (undefined / null / empty string) render a dim em-dash — the whole detail
 * panel reads a raw upstream `Model` whose optional fields are frequently absent
 * (`fetchModels` is `as unknown as Model`, no runtime validation).
 */

/** A titled group of rows. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 border-b border-[var(--color-border)] pb-1 text-[11px] uppercase tracking-wider text-[var(--color-muted)]">{title}</div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

/** One label→value row. `value` accepts a scalar (formatted via {@link renderValue}) or arbitrary nodes as children. */
export function Row({ label, value, children }: { label: string; value?: string | number | boolean | null; children?: ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5 text-[12px]">
      <span className="w-[190px] shrink-0 text-[var(--color-muted)]">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[var(--color-text)]">{children ?? renderValue(value)}</span>
    </div>
  )
}

/** dim em-dash for absent; `yes`/`no` for booleans; otherwise the string form. */
export function renderValue(v: string | number | boolean | null | undefined): ReactNode {
  if (v === undefined || v === null || v === "") return <span className="text-[#555]">—</span>
  if (typeof v === "boolean") return v ? <span className="text-[var(--color-ok)]">yes</span> : <span className="text-[#888]">no</span>
  return String(v)
}

/** A tonal chip (plan / policy / media-type). */
export function Chip({ children }: { children: ReactNode }) {
  return <span className="mr-1 inline-block border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[#cdb]">{children}</span>
}

/** ✓ (ok) / · (dim) capability cell. */
export function Bool({ on }: { on: boolean }) {
  return on ? <span className="text-[var(--color-ok)]">✓ yes</span> : <span className="text-[#555]">· no</span>
}

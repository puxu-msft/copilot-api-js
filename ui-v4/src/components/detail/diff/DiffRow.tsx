import type {
  //
  AlignKind,
  InlineDiffPart,
} from "@/lib/diff/block-diff"

import { InlineParts } from "./InlineParts"

const KIND_SIGN: Record<AlignKind, string> = {
  same: "=",
  added: "+",
  removed: "−",
  modified: "~",
}

const KIND_COLOR: Record<AlignKind, string> = {
  same: "var(--color-muted)",
  added: "var(--color-ok)",
  removed: "var(--color-fail)",
  modified: "var(--color-warn)",
}

const KIND_TINT: Record<AlignKind, string> = {
  same: "",
  added: "bg-[color-mix(in_srgb,var(--color-ok)_8%,transparent)]",
  removed: "bg-[color-mix(in_srgb,var(--color-fail)_8%,transparent)]",
  modified: "bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)]",
}

interface DiffRowProps {
  kind: AlignKind
  label?: string
  bodyText?: string
  inlineParts?: Array<InlineDiffPart>
}

export function DiffRow({ kind, label, bodyText, inlineParts }: DiffRowProps) {
  const sameMuted = kind === "same" ? "opacity-70" : ""
  return (
    <div className={`mono flex items-start gap-2 px-2 py-0.5 text-[13px] ${KIND_TINT[kind]} ${sameMuted}`}>
      <span
        className="shrink-0 select-none"
        style={{ color: KIND_COLOR[kind] }}
      >
        {KIND_SIGN[kind]}
      </span>
      {label !== undefined && <span className="shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-muted)]">{label}</span>}
      {kind === "modified" && inlineParts ?
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--color-text)]">
          <InlineParts parts={inlineParts} />
        </span>
      : <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text)]">{bodyText}</span>}
    </div>
  )
}

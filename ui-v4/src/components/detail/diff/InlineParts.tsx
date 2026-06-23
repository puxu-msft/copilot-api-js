import type { InlineDiffPart } from "@/lib/diff/block-diff"

interface InlinePartsProps {
  parts: Array<InlineDiffPart>
}

function partClass(part: InlineDiffPart): string {
  if (part.added) return "bg-[color-mix(in_srgb,var(--color-ok)_22%,transparent)]"
  if (part.removed) return "bg-[color-mix(in_srgb,var(--color-fail)_22%,transparent)] line-through"
  return ""
}

export function InlineParts({ parts }: InlinePartsProps) {
  return (
    <span className="mono whitespace-pre-wrap break-words">
      {parts.map((part, i) => (
        <span
          key={i}
          className={partClass(part)}
        >
          {part.value}
        </span>
      ))}
    </span>
  )
}

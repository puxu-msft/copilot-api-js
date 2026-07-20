import { useState } from "react"

import { BlockJsonModal } from "@/components/detail/BlockJsonModal"

interface JsonModalButtonProps {
  /** The value shown (verbatim) when the modal opens — a content block or a whole message object. */
  value: unknown
  /** Accessible label / tooltip, e.g. "View block JSON" or "View message JSON". */
  label: string
  /** Extra classes for the trigger button (positioning/visibility is owned by the caller). */
  className?: string
}

/**
 * A `{ }` trigger button that opens {@link BlockJsonModal} for `value`, owning its own
 * open state. Shared by BlockChrome (per content block) and MessageBlock (whole message)
 * so the affordance + modal wiring lives in exactly one place.
 */
export function JsonModalButton({ value, label, className }: JsonModalButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={(e) => {
          // Don't let the affordance toggle any (future) interactive content beneath it.
          e.stopPropagation()
          setOpen(true)
        }}
        className={className}
      >
        {"{ }"}
      </button>
      {open ?
        <BlockJsonModal
          value={value}
          onClose={() => setOpen(false)}
        />
      : null}
    </>
  )
}

import type { ReactNode } from "react"

import { useEffect } from "react"
import { createPortal } from "react-dom"

interface ModalProps {
  /** Optional header title; the header row is omitted when absent. */
  title?: ReactNode
  onClose: () => void
  children: ReactNode
}

/**
 * Centered overlay modal, portaled to `document.body`.
 *
 * Closes on Escape, on backdrop click, and via the header `×`. Clicks inside the
 * content area are stopped so they don't bubble to the backdrop. The first shared
 * overlay primitive in ui-v4 — styling follows the Terminal Amber theme tokens and
 * is intentionally minimal (no scroll-lock / focus-trap) for this internal tool;
 * those can layer on later without changing the interface.
 */
export function Modal({ title, onClose, children }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    globalThis.addEventListener("keydown", onKey)
    return () => globalThis.removeEventListener("keydown", onKey)
  }, [onClose])

  return createPortal(
    <div
      data-testid="modal-backdrop"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-[900px] flex-col border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
          <div className="mono text-[12px] uppercase tracking-wider text-[var(--color-muted)]">{title}</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="mono px-1 text-[16px] leading-none text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

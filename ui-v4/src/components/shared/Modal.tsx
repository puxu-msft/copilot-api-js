import type { ReactNode } from "react"

import { Dialog } from "radix-ui"

interface ModalProps {
  /** Optional header title; rendered into the required Radix Dialog.Title (empty when absent). */
  title?: ReactNode
  onClose: () => void
  children: ReactNode
}

/**
 * Centered overlay modal, built on Radix `Dialog` (headless) — styled to the
 * Terminal Amber theme via the shared CSS tokens (see docs/radix-styling.md).
 *
 * Radix provides focus-trap, scroll-lock, focus-restore-on-close, `aria-modal`,
 * and portal — capabilities the previous hand-rolled version intentionally left
 * out. `onClose` is driven by `onOpenChange` (Escape + the header ×). Backdrop
 * dismissal is kept as an explicit `Overlay` click (preserving the original
 * click-to-close contract + `data-testid`); Radix's own pointer-outside dismiss
 * is disabled (`preventDefault`) so the two paths don't both fire `onClose`.
 * Escape still closes (that is `onEscapeKeyDown`, independent of interact-outside).
 */
export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="modal-backdrop"
          onClick={onClose}
          className="fixed inset-0 z-50 bg-black/60 p-4"
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-[900px] -translate-x-1/2 -translate-y-1/2 flex-col border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl outline-none"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
            <Dialog.Title className="mono text-[12px] uppercase tracking-wider text-[var(--color-muted)]">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="mono px-1 text-[16px] leading-none text-[var(--color-muted)] hover:text-[var(--color-text)]"
            >
              ×
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

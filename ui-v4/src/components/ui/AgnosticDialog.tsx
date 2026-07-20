import type { ReactNode } from "react"

import { Dialog } from "radix-ui"

import { Modal } from "@/components/shared/Modal"
import { useUiStore } from "@/stores/ui-store"

/**
 * Design-version-agnostic dialog seam (RFC §2 B↔C boundary / round2-A3).
 *
 * B content bodies (currently only `detail/BlockJsonModal`) must serve **both**
 * presentation trees, so they must not name a specific tree's dialog skin. They
 * depend on this neutral adapter instead of importing `shared/Modal` (the legacy
 * tree's hand-rolled Radix skin) directly.
 *
 * P4 landed the deferred `designVersion` fork of this seam: it now reads
 * `designVersion` (this file is the whitelisted dialog seam — the only reader
 * outside `shell/`, `stores/ui-store`, and `lib/data-design`) and mounts the
 * **shadcn** neutral dialog vs the legacy `Modal`, **without touching any B file**
 * (`BlockJsonModal` is unaware). Keeping the fork here (not in B) is what keeps
 * `designVersion` out of the B grep-guard dirs.
 *
 * Both skins emit the **same three affordances** so B's callers and the
 * `Modal.vitest` / `BlockJsonModal.vitest` / `AgnosticDialog.vitest` contract hold:
 *  - `title` → the Dialog title,
 *  - `onClose` → fired on Escape + backdrop click + the header × (any dismissal),
 *  - `data-testid="modal-backdrop"` on the click-to-dismiss overlay.
 */
export interface AgnosticDialogProps {
  /** Optional header title. */
  title?: ReactNode
  /** Called on Escape, backdrop click, and the header × (any dismissal path). */
  onClose: () => void
  children: ReactNode
}

/**
 * shadcn (neutral) dialog skin — mirrors the legacy `Modal` contract exactly but on
 * neutral semantic tokens. Built on Radix `Dialog` primitives directly (the composed
 * `ui/dialog` `DialogContent` is a centered card that bundles its own portal/overlay
 * with no `modal-backdrop` testid + no explicit backdrop-click close, so we compose
 * the primitives here to preserve the three affordances). Radix owns focus-trap,
 * scroll-lock, focus-restore, `aria-modal`, and portal. Backdrop dismissal is an
 * explicit `Overlay` click (keeps the testid + click-to-close contract); Radix's own
 * pointer-outside dismiss is disabled so the two paths don't both fire `onClose`.
 */
function ShadcnDialog({ title, onClose, children }: AgnosticDialogProps) {
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
          className="fixed inset-0 z-50 bg-black/50 p-4 supports-backdrop-filter:backdrop-blur-xs"
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-[900px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-popover text-popover-foreground ring-1 ring-foreground/10 outline-none"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <Dialog.Title className="mono text-[12px] uppercase tracking-wider text-muted-foreground">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="mono px-1 text-[16px] leading-none text-muted-foreground hover:text-foreground"
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

export function AgnosticDialog({ title, onClose, children }: AgnosticDialogProps) {
  const designVersion = useUiStore((s) => s.designVersion)
  if (designVersion === "shadcn") {
    return (
      <ShadcnDialog
        title={title}
        onClose={onClose}
      >
        {children}
      </ShadcnDialog>
    )
  }
  return (
    <Modal
      title={title}
      onClose={onClose}
    >
      {children}
    </Modal>
  )
}

import type { ReactNode } from "react"

import { Modal } from "@/components/shared/Modal"

/**
 * Design-version-agnostic dialog seam (RFC §2 B↔C boundary / round2-A3).
 *
 * B content bodies (currently only `detail/BlockJsonModal`) must serve **both**
 * presentation trees, so they must not name a specific tree's dialog skin. They
 * depend on this neutral adapter instead of importing `shared/Modal` (the legacy
 * tree's hand-rolled Radix skin) directly.
 *
 * Today it still delegates to the legacy `shared/Modal` — C6 landed the dual-tree
 * `designVersion` switch but deliberately left this seam delegating to legacy, so
 * `BlockJsonModal` shows the legacy modal skin even inside the shadcn tree for now.
 * **The `designVersion` fork of this seam is deferred to the per-page phase** (a
 * per-page backlog item): that is where this file becomes the fork point — read
 * `designVersion` and mount the shadcn `Dialog` (neutral skin) vs the legacy
 * `Modal`, **without touching any B file**. Keeping the seam here (not in B) is
 * what lets `designVersion` stay out of the B grep-guard dirs when that fork lands.
 *
 * Contract preserved verbatim (the legacy `Modal` renders these, so the tests in
 * `Modal.vitest`/`BlockJsonModal.vitest` keep passing): `title` → Dialog.Title,
 * `onClose` → Escape + backdrop + × close, and `data-testid="modal-backdrop"` on
 * the click-to-dismiss overlay. When the shadcn branch is added, it must emit the
 * same three affordances so the contract holds across both skins.
 */
export interface AgnosticDialogProps {
  /** Optional header title. */
  title?: ReactNode
  /** Called on Escape, backdrop click, and the header × (any dismissal path). */
  onClose: () => void
  children: ReactNode
}

export function AgnosticDialog({ title, onClose, children }: AgnosticDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onClose}
    >
      {children}
    </Modal>
  )
}

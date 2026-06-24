import type { ReactNode } from "react"

import { useResizableWidth } from "@/hooks/useResizableWidth"

/**
 * Resizable, sticky TOC sidebar shell shared by ConvoSegment + StagesSegment.
 *
 * Wraps the detail TOC tree in the existing sticky nav shell, but with a
 * user-draggable width persisted across sessions (see {@link useResizableWidth}).
 * A thin vertical drag handle on the right edge adjusts the width on pointer-drag.
 *
 * Layout: a sticky flex row whose width is the (clamped, persisted) state value —
 * the scrollable tree column flexes, and a non-scrolling hairline handle sits at
 * the right edge so it stays put regardless of the tree's `overflow-auto` scroll.
 */
export function TocSidebar({ children }: { children: ReactNode }) {
  const { width, dragging, dragEdgeX, handleProps } = useResizableWidth()

  return (
    <div
      style={{ width }}
      className="sticky top-0 flex max-h-[calc(100vh-200px)] shrink-0 self-start"
    >
      <nav className="min-w-0 flex-1 overflow-auto border-r border-[var(--color-border)] pr-1">{children}</nav>
      <div
        {...handleProps}
        role="separator"
        aria-label="resize toc"
        aria-orientation="vertical"
        title="Drag to resize"
        className="-ml-px w-[5px] shrink-0 cursor-col-resize touch-none select-none bg-transparent transition-colors hover:bg-[var(--color-primary)]/40"
      />
      {dragging && dragEdgeX !== undefined ?
        // Composited preview line at the cursor: the actual layout doesn't change
        // until release, so the heavy content pane never reflows mid-drag.
        // `translateX` keeps it on the GPU (no layout/paint of siblings).
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-y-0 left-0 z-50 w-[2px] bg-[var(--color-primary)]"
          style={{ transform: `translateX(${dragEdgeX}px)` }}
        />
      : null}
    </div>
  )
}

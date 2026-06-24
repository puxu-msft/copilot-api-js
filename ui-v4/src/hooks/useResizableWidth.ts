import {
  //
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

/** Inclusive lower bound for the resizable width (px). */
export const TOC_WIDTH_MIN = 140
/** Inclusive upper bound for the resizable width (px). */
export const TOC_WIDTH_MAX = 520
/** Fallback width when nothing is persisted / the stored value is invalid (px). */
export const TOC_WIDTH_DEFAULT = 200
/** localStorage key under which the user's chosen TOC width is persisted. */
export const TOC_WIDTH_STORAGE_KEY = "ui-v4-toc-width"

/** Clamp a candidate width into [{@link min}, {@link max}]; NaN falls back to {@link min}. */
export function clampWidth(value: number, min: number = TOC_WIDTH_MIN, max: number = TOC_WIDTH_MAX): number {
  if (Number.isNaN(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Read the persisted width from localStorage, guarding SSR / invalid values → default. */
function readPersistedWidth(storageKey: string): number {
  if (typeof globalThis.window === "undefined" || typeof globalThis.localStorage === "undefined") return TOC_WIDTH_DEFAULT
  try {
    const raw = globalThis.localStorage.getItem(storageKey)
    if (raw === null) return TOC_WIDTH_DEFAULT
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return TOC_WIDTH_DEFAULT
    return clampWidth(parsed)
  } catch {
    // localStorage can throw (private mode / disabled) — fall back to default.
    return TOC_WIDTH_DEFAULT
  }
}

/** Best-effort persist; swallow storage errors (quota / disabled) since width is non-critical. */
function persistWidth(storageKey: string, width: number): void {
  if (typeof globalThis.window === "undefined" || typeof globalThis.localStorage === "undefined") return
  try {
    globalThis.localStorage.setItem(storageKey, String(Math.round(width)))
  } catch {
    // Non-critical: ignore storage failures.
  }
}

/** Props spread onto the drag handle element to wire up pointer-based resizing. */
interface HandleProps {
  onPointerDown: (event: React.PointerEvent) => void
}

interface UseResizableWidth {
  /** Committed width in px (clamped, restored from localStorage; updated only on drag-END). */
  width: number
  /** True while a resize drag is in progress. */
  dragging: boolean
  /** Cursor viewport-X during a drag (for the preview guide line); undefined when idle. */
  dragEdgeX: number | undefined
  /** Props to spread onto the drag-handle element (pointer-down starts a drag). */
  handleProps: HandleProps
}

/**
 * User-resizable width with localStorage persistence, driven by pointer drag.
 *
 * On mount the persisted width (key {@link TOC_WIDTH_STORAGE_KEY}) is restored,
 * guarding SSR / invalid stored values → {@link TOC_WIDTH_DEFAULT}.
 *
 * **Deferred-apply (preview-line) resize — performance-critical.** With a large,
 * syntax-highlighted content pane next to the sidebar, resizing the flex layout
 * LIVE reflows + repaints that heavy column on every pointermove → jank. So the
 * committed `width` is updated only on drag-END; during the drag the consumer
 * draws a cheap, composited preview guide line at `dragEdgeX` (the cursor X)
 * while the actual layout stays put → **zero content reflow while dragging**,
 * smooth regardless of data size; a single reflow happens on release.
 *
 * The drag uses the canonical **capture-free** pattern: `pointerdown` on the
 * handle records `startX`/`startWidth` and attaches `pointermove`/`pointerup`
 * (+ `pointercancel`) listeners to `window` (window reliably receives every move
 * while the button is held; no `setPointerCapture` needed). During the drag
 * `document.body.style.userSelect`/`cursor` are pinned so text-selection /
 * cursor flicker can't eat events; both are restored on end. Listeners + body
 * overrides are torn down on drag-end **and** on unmount (no leaks).
 */
export function useResizableWidth(storageKey: string = TOC_WIDTH_STORAGE_KEY): UseResizableWidth {
  const [width, setWidth] = useState<number>(() => readPersistedWidth(storageKey))

  // Latest committed width, mirrored into a ref so a fresh pointerdown reads the
  // current value without re-subscribing per render.
  const widthRef = useRef(width)
  widthRef.current = width

  // Cursor X during an active drag (drives the preview guide line); undefined = idle.
  const [dragEdgeX, setDragEdgeX] = useState<number | undefined>(undefined)

  // Tears down the active drag (listeners + body-style overrides). Idempotent:
  // safe to call from pointerup, a fresh pointerdown, or unmount.
  const cleanupRef = useRef<(() => void) | undefined>(undefined)

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // Only react to the primary button; ignore right/middle-click drags.
      if (event.button !== 0) return
      event.preventDefault()

      // Tear down any stale drag (defensive — a missed pointerup should not strand listeners).
      cleanupRef.current?.()

      const startX = event.clientX
      const startWidth = widthRef.current
      // The width that will be committed on release; updated live but NOT applied
      // to the layout until drag-end (only the preview line follows the cursor).
      let pending = startWidth
      setDragEdgeX(startX)

      const onMove = (moveEvent: PointerEvent) => {
        pending = clampWidth(startWidth + (moveEvent.clientX - startX))
        // Move the (composited) preview line only — the sidebar width is untouched,
        // so the heavy content column never reflows during the drag.
        setDragEdgeX(moveEvent.clientX)
      }
      const commit = () => {
        cleanupRef.current?.()
        cleanupRef.current = undefined
        setDragEdgeX(undefined)
        // Single layout change for the whole drag → one reflow of the content pane.
        setWidth(pending)
        persistWidth(storageKey, pending)
      }

      globalThis.addEventListener("pointermove", onMove)
      globalThis.addEventListener("pointerup", commit)
      globalThis.addEventListener("pointercancel", commit)

      // Suppress text selection + pin the resize cursor for the whole drag so a
      // stray selection or cursor change can't swallow pointer events.
      const body = globalThis.document.body
      const prevUserSelect = body.style.userSelect
      const prevCursor = body.style.cursor
      body.style.userSelect = "none"
      body.style.cursor = "col-resize"

      cleanupRef.current = () => {
        globalThis.removeEventListener("pointermove", onMove)
        globalThis.removeEventListener("pointerup", commit)
        globalThis.removeEventListener("pointercancel", commit)
        body.style.userSelect = prevUserSelect
        body.style.cursor = prevCursor
      }
    },
    [storageKey],
  )

  // Unmount: tear down any in-flight drag (listeners + body-style overrides).
  useEffect(
    () => () => {
      cleanupRef.current?.()
      cleanupRef.current = undefined
    },
    [],
  )

  return { width, dragging: dragEdgeX !== undefined, dragEdgeX, handleProps: { onPointerDown } }
}

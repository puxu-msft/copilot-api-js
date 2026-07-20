import {
  //
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import { StrictMode } from "react"
import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"

import { TocSidebar } from "@/components/detail/toc/TocSidebar"
import {
  //
  TOC_WIDTH_MAX,
  TOC_WIDTH_MIN,
  TOC_WIDTH_STORAGE_KEY,
} from "@/hooks/useResizableWidth"

/** Pull the numeric px width off the sticky sidebar wrapper's inline style. */
function widthOf(container: HTMLElement): number {
  const sticky = container.querySelector<HTMLElement>("[style*='width']")
  expect(sticky).not.toBeNull()
  return Number.parseInt(sticky?.style.width ?? "", 10)
}

/**
 * Drive a realistic capture-free drag: pointerdown on the handle, then
 * `pointermove`/`pointerup` dispatched on `window` — mirroring the real browser,
 * where the hook attaches its move/up listeners to `window` (NOT the handle and
 * NOT `document`). Firing on `window` is what a held-button drag delivers.
 */
function drag(handle: Element, fromX: number, toX: number): void {
  fireEvent.pointerDown(handle, { clientX: fromX, pointerId: 1, button: 0 })
  act(() => {
    globalThis.dispatchEvent(new globalThis.PointerEvent("pointermove", { clientX: toX }))
  })
}

function endDrag(toX: number): void {
  act(() => {
    globalThis.dispatchEvent(new globalThis.PointerEvent("pointerup", { clientX: toX }))
  })
}

describe("TocSidebar", () => {
  beforeEach(() => {
    globalThis.localStorage.clear()
  })
  afterEach(() => {
    globalThis.localStorage.clear()
    // Defensive: a test that left the drag open would have pinned these.
    globalThis.document.body.style.userSelect = ""
    globalThis.document.body.style.cursor = ""
  })

  it("renders its children (the tree) inside the nav", () => {
    render(
      <TocSidebar>
        <div data-testid="toc-child">tree content</div>
      </TocSidebar>,
    )
    const child = screen.getByTestId("toc-child")
    expect(child).toBeDefined()
    expect(child.closest("nav")).not.toBeNull()
  })

  it("renders a resize handle with separator role + aria-label", () => {
    render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    expect(handle).toBeDefined()
    expect(handle.className).toContain("cursor-col-resize")
  })

  it("renders the default 200px width on first mount (nothing persisted)", () => {
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    expect(widthOf(container)).toBe(200)
  })

  it("resizes via keyboard (Arrow/Home/End) — WAI-ARIA Window Splitter", () => {
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    // Keyboard-focusable + exposes the resize range for AT.
    expect(handle.getAttribute("tabindex")).toBe("0")
    expect(handle.getAttribute("aria-valuemin")).toBe(String(TOC_WIDTH_MIN))
    expect(handle.getAttribute("aria-valuemax")).toBe(String(TOC_WIDTH_MAX))

    const start = widthOf(container) // 200 default
    // Non-inverted (handle on the right edge): ArrowRight grows, ArrowLeft shrinks (16px step).
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowRight" })
    })
    expect(widthOf(container)).toBe(start + 16)
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowLeft" })
    })
    expect(widthOf(container)).toBe(start)
    // Home / End jump to the bounds.
    act(() => {
      fireEvent.keyDown(handle, { key: "End" })
    })
    expect(widthOf(container)).toBe(TOC_WIDTH_MAX)
    act(() => {
      fireEvent.keyDown(handle, { key: "Home" })
    })
    expect(widthOf(container)).toBe(TOC_WIDTH_MIN)
  })

  it("defers the width change to drag-END (no live reflow), shows a preview line while dragging, persists on release", () => {
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    const before = widthOf(container)

    drag(handle, 100, 180)

    // Deferred-apply: the committed sidebar width is UNCHANGED during the drag, so
    // the heavy content pane never reflows mid-drag (the perf fix).
    expect(widthOf(container)).toBe(before)
    // A composited preview guide line follows the cursor (translateX) during the drag.
    const preview = container.querySelector<HTMLElement>("[style*='translateX']")
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute("style")).toContain("translateX(180px)")

    endDrag(180)

    // On release the width commits ONCE (single reflow): start + (180 − 100) = +80.
    expect(widthOf(container)).toBe(before + 80)
    // Preview line is gone after release.
    expect(container.querySelector("[style*='translateX']")).toBeNull()
    // Drag-end persists the committed width.
    expect(globalThis.localStorage.getItem(TOC_WIDTH_STORAGE_KEY)).toBe(String(before + 80))
  })

  // REGRESSION GUARD for the real user-reported bug: the handle looked draggable
  // (cursor/hover worked, pointerdown fired, pointer capture was set) but width
  // never changed. Root cause: React 18 dev StrictMode mounts→unmounts→remounts
  // reusing the same refs; the old hook's unmount cleanup flipped a `mountedRef`
  // to `false` that was never reset on remount, so every `onMove` returned early
  // via its `if (!mountedRef.current) return` guard. Under `<StrictMode>` the
  // double-invoke is exercised — this test FAILS on the old (capture+mountedRef)
  // implementation and PASSES on the capture-free rewrite.
  it("still resizes after a StrictMode mount→unmount→remount cycle (real-bug repro)", () => {
    const { container } = render(
      <StrictMode>
        <TocSidebar>
          <div>tree</div>
        </TocSidebar>
      </StrictMode>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    const before = widthOf(container)

    drag(handle, 100, 175)
    // Deferred: unchanged during the drag…
    expect(widthOf(container)).toBe(before)
    endDrag(175)

    // …committed on release. The bug was the width NEVER changing across the whole
    // gesture; here it must end up +75.
    expect(widthOf(container)).toBe(before + 75)
    expect(widthOf(container)).toBeGreaterThan(before)
  })

  it("does not leave a body-style override stranded after a completed drag", () => {
    render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    drag(handle, 0, 50)
    // During the drag the body is pinned non-selectable.
    expect(globalThis.document.body.style.userSelect).toBe("none")
    endDrag(50)
    // …and restored on drag-end.
    expect(globalThis.document.body.style.userSelect).toBe("")
    expect(globalThis.document.body.style.cursor).toBe("")
  })

  it("clamps the width to the max bound (520) when dragged far right", () => {
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    drag(handle, 0, 99_999)
    endDrag(99_999)
    expect(widthOf(container)).toBe(520)
  })

  it("clamps the width to the min bound (140) when dragged far left", () => {
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    drag(handle, 0, -99_999)
    endDrag(-99_999)
    expect(widthOf(container)).toBe(140)
  })

  it("restores a persisted width on (re)mount", () => {
    globalThis.localStorage.setItem(TOC_WIDTH_STORAGE_KEY, "340")
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    expect(widthOf(container)).toBe(340)
  })

  it("clamps an out-of-range persisted width back into bounds on mount", () => {
    globalThis.localStorage.setItem(TOC_WIDTH_STORAGE_KEY, "9999")
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    expect(widthOf(container)).toBe(520)
  })

  it("falls back to default for an invalid persisted value", () => {
    globalThis.localStorage.setItem(TOC_WIDTH_STORAGE_KEY, "not-a-number")
    const { container } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    expect(widthOf(container)).toBe(200)
  })

  it("stops tracking after unmount (no leaked listeners / setState)", () => {
    const { container, unmount } = render(
      <TocSidebar>
        <div>tree</div>
      </TocSidebar>,
    )
    const handle = screen.getByRole("separator", { name: "resize toc" })
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1, button: 0 })
    unmount()
    // A stray move after unmount must not throw (listeners cleaned up).
    expect(() => globalThis.dispatchEvent(new globalThis.PointerEvent("pointermove", { clientX: 300 }))).not.toThrow()
    expect(container.querySelector("nav")).toBeNull()
    // Unmount-during-drag must also restore the body style (no leak).
    expect(globalThis.document.body.style.userSelect).toBe("")
  })
})

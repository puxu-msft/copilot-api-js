import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { JsonTreeView } from "@/components/tools/JsonTreeView"

describe("JsonTreeView (Radix Collapsible)", () => {
  it("renders nested keys and primitives", () => {
    render(<JsonTreeView value={{ a: 1, nested: { b: "x" } }} />)
    expect(screen.getByText("a")).toBeDefined()
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("nested")).toBeDefined()
    expect(screen.getByText(/"x"/)).toBeDefined()
  })

  it("collapse toggle is a keyboard-operable button with aria-expanded", async () => {
    const user = userEvent.setup()
    render(<JsonTreeView value={{ nested: { b: "x" } }} />)
    // The container node's trigger is a real button (was a div onClick).
    const trigger = screen.getByRole("button", { name: /nested/i })
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText(/"x"/)).toBeDefined()
    // Keyboard toggle: Enter collapses → child disappears + aria-expanded flips.
    trigger.focus()
    await user.keyboard("{Enter}")
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText(/"x"/)).toBeNull()
  })
})

describe("JsonTreeView toolbar (default off — back-compat)", () => {
  it("renders NO toolbar controls when `toolbar` is omitted", () => {
    render(<JsonTreeView value={{ a: 1 }} />)
    // Negative: no bulk-control buttons. Positive control: content still renders.
    expect(screen.queryByRole("button", { name: /expand all/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /collapse all/i })).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("a")).toBeDefined()
  })
})

describe("JsonTreeView toolbar — expand/collapse all", () => {
  // depth<3 opens by default, so nest 5 levels: the deepest leaf starts hidden.
  const deep = { a: { b: { c: { d: { leaf: 1 } } } } }

  it("expand all opens containers below the auto-collapse depth", () => {
    render(
      <JsonTreeView
        value={deep}
        toolbar
      />,
    )
    // Positive control: a top-level key is present; the deep leaf starts hidden.
    expect(screen.getByText("a")).toBeDefined()
    expect(screen.queryByText("leaf")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /expand all/i }))
    expect(screen.getByText("leaf")).toBeDefined()
  })

  it("collapse all hides nested containers again", () => {
    render(
      <JsonTreeView
        value={deep}
        toolbar
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /expand all/i }))
    expect(screen.getByText("leaf")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: /collapse all/i }))
    expect(screen.queryByText("leaf")).toBeNull()
  })
})

describe("JsonTreeView toolbar — lazy large arrays", () => {
  const big = { arr: Array.from({ length: 500 }, (_, i) => i) }

  it("renders only the first page and a load-more button; expand-all does NOT materialize the rest", () => {
    render(
      <JsonTreeView
        value={big}
        toolbar
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /expand all/i }))

    // First page (200) is rendered: index/value 100 visible; 300 (page-2) is not.
    // (Each number appears twice — as array index key and as value — so match all.)
    expect(screen.getAllByText("100").length).toBeGreaterThan(0)
    expect(screen.queryAllByText("300")).toHaveLength(0)
    // Invariant: expand-all opens the CONTAINER but keeps the array lazily paged.
    expect(screen.getByRole("button", { name: /load more/i })).toBeDefined()
  })

  it("load more reveals the next page", () => {
    render(
      <JsonTreeView
        value={big}
        toolbar
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /expand all/i }))
    expect(screen.queryAllByText("300")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: /load more/i }))
    // page grew 200 → 400, so index 300 is now rendered.
    expect(screen.getAllByText("300").length).toBeGreaterThan(0)
  })

  it("does NOT page (nor show load-more) when the toolbar is off — bare-caller back-compat", () => {
    // A bare caller (toolbar omitted) passing a >200-entry container must render
    // every entry exactly as before — no cap, no interaction affordance.
    render(<JsonTreeView value={big} />)
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull()
    // Index 300 (beyond LAZY_THRESHOLD) is present → nothing was hidden.
    expect(screen.getAllByText("300").length).toBeGreaterThan(0)
  })

  it("search reveals a matching entry past the first lazy page", () => {
    // 300-entry array whose only match sits at index 250 (beyond the 200 page).
    const withDeepMatch = { arr: Array.from({ length: 300 }, (_, i) => (i === 250 ? "needle" : "x")) }
    render(
      <JsonTreeView
        value={withDeepMatch}
        toolbar
      />,
    )
    // Positive control: hidden before search (default page = 200).
    expect(screen.queryByText(/needle/)).toBeNull()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "needle" } })
    // Search must render the reported match even though it lives past the page.
    expect(screen.getByText(/needle/)).toBeDefined()
  })
})

describe("JsonTreeView toolbar — copy value/path", () => {
  it("copy path emits the JSON path `$.a[0].b`", async () => {
    const spy = vi.spyOn(await import("@/lib/clipboard"), "copyText").mockResolvedValue(true)
    render(
      <JsonTreeView
        value={{ a: [{ b: 1 }] }}
        toolbar
      />,
    )
    // `b` is at depth 3 (< AUTO_COLLAPSE parents open by default) → visible.
    fireEvent.click(screen.getByRole("button", { name: "copy path $.a[0].b" }))
    expect(spy).toHaveBeenCalledWith("$.a[0].b")
    spy.mockRestore()
  })

  it("copy value emits the subtree JSON", async () => {
    const spy = vi.spyOn(await import("@/lib/clipboard"), "copyText").mockResolvedValue(true)
    render(
      <JsonTreeView
        value={{ a: [{ b: 1 }] }}
        toolbar
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "copy value $.a" }))
    expect(spy).toHaveBeenCalledWith(JSON.stringify([{ b: 1 }], null, 2))
    spy.mockRestore()
  })
})

describe("JsonTreeView toolbar — search", () => {
  const deep = { a: { b: { c: { needleKey: "hay" } } } }

  it("force-expands ancestors of a match and highlights the matching node", () => {
    const { container } = render(
      <JsonTreeView
        value={deep}
        toolbar
      />,
    )
    // Positive control: deep match hidden before search.
    expect(screen.queryByText("needleKey")).toBeNull()

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "needle" } })

    // Ancestors force-open → the matching node is now visible + flagged.
    expect(screen.getByText("needleKey")).toBeDefined()
    expect(container.querySelector('[data-json-match="true"]')).not.toBeNull()
  })

  it("clearing the query collapses back to depth defaults", () => {
    render(
      <JsonTreeView
        value={deep}
        toolbar
      />,
    )
    const box = screen.getByRole("textbox")
    fireEvent.change(box, { target: { value: "needle" } })
    expect(screen.getByText("needleKey")).toBeDefined()
    fireEvent.change(box, { target: { value: "" } })
    expect(screen.queryByText("needleKey")).toBeNull()
  })
})

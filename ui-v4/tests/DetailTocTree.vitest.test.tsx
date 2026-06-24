import {
  //
  fireEvent,
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { TocNode } from "@/lib/content/toc"

import { DetailTocTree } from "@/components/detail/toc/DetailTocTree"

const tree: Array<TocNode> = [
  {
    label: "user: hello",
    anchorId: "pfx-msg-0",
    kind: "user",
    children: [{ label: "text: hello", anchorId: "pfx-msg-0-blk-0", kind: "text" }],
  },
  {
    label: "assistant: hi",
    anchorId: "pfx-msg-1",
    kind: "assistant",
    children: [
      { label: "text: hi", anchorId: "pfx-msg-1-blk-0", kind: "text" },
      { label: "tool_use: Edit", anchorId: "pfx-msg-1-blk-1", kind: "tool_use" },
    ],
  },
]

describe("DetailTocTree", () => {
  it("renders message-level labels with block children collapsed by default", () => {
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={() => {}}
      />,
    )

    // Message rows visible.
    expect(screen.getByText("user: hello")).toBeDefined()
    expect(screen.getByText("assistant: hi")).toBeDefined()
    // Block children hidden by default.
    expect(screen.queryByText("tool_use: Edit")).toBeNull()
    expect(screen.queryByText("text: hello")).toBeNull()
  })

  it("clicking a node's label calls onSelect with its anchorId", () => {
    const onSelect = vi.fn()
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={onSelect}
      />,
    )

    fireEvent.click(screen.getByText("assistant: hi"))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith("pfx-msg-1")
  })

  it("the +/− toggle reveals children without firing onSelect", () => {
    const onSelect = vi.fn()
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={onSelect}
      />,
    )

    // Collapsed → expand button shows `+` and aria-label "expand".
    const toggles = screen.getAllByLabelText("expand")
    expect(toggles[1].textContent).toBe("+")
    // Second message's toggle (assistant).
    fireEvent.click(toggles[1])

    // After expanding, the toggle flips to the `−` collapse glyph.
    expect(screen.getByLabelText("collapse").textContent).toBe("−")
    // Children now visible.
    expect(screen.getByText("tool_use: Edit")).toBeDefined()
    expect(screen.getByText("text: hi")).toBeDefined()
    // Toggle must NOT fire onSelect.
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("collapsing an expanded node hides its children again", () => {
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={() => {}}
      />,
    )

    const expandToggles = screen.getAllByLabelText("expand")
    fireEvent.click(expandToggles[0]) // expand user message
    expect(screen.getByText("text: hello")).toBeDefined()

    // Now a collapse toggle exists for that node.
    fireEvent.click(screen.getByLabelText("collapse"))
    expect(screen.queryByText("text: hello")).toBeNull()
  })

  it("highlights the node matching activeAnchor", () => {
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={() => {}}
        activeAnchor="pfx-msg-1"
      />,
    )

    const activeRow = screen.getByText("assistant: hi").closest("div")
    const inactiveRow = screen.getByText("user: hello").closest("div")

    // Active row: left accent bar + amber text; inactive row has neither.
    expect(activeRow?.className).toContain("text-[var(--color-primary)]")
    expect(activeRow?.className).toContain("border-l-[var(--color-primary)]")
    expect(inactiveRow?.className).not.toContain("text-[var(--color-primary)]")
    expect(inactiveRow?.className).not.toContain("border-l-[var(--color-primary)]")
  })

  it("numbers rows hierarchically (top-level 1/2, children 1.1, 1.2)", () => {
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={() => {}}
      />,
    )

    // Top-level sequence numbers.
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()

    // Expand the assistant message → its children read 2.1, 2.2.
    fireEvent.click(screen.getAllByLabelText("expand")[1])
    expect(screen.getByText("2.1")).toBeDefined()
    expect(screen.getByText("2.2")).toBeDefined()
  })

  it("tints each row's label by kind and exposes the full label via title", () => {
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={() => {}}
      />,
    )

    // The kind color now tints the label button itself (no separate dot).
    // user role → amber primary; assistant role → soft blue (#9ad) — mirrors
    // MessageBlock's ROLE_COLOR so the two views stay consistent.
    const userLabel = screen.getByText("user: hello")
    const assistantLabel = screen.getByText("assistant: hi")

    expect(userLabel.style.color).toBe("var(--color-primary)")
    expect(assistantLabel.style.color).toBe("rgb(153, 170, 221)")

    // Truncated rows reveal their full text on hover via `title`.
    expect(userLabel.getAttribute("title")).toBe("user: hello")
  })

  it("renders recursively to arbitrary depth", () => {
    const deep: Array<TocNode> = [
      {
        label: "leg",
        anchorId: "leg-0",
        kind: "leg",
        children: [
          {
            label: "msg",
            anchorId: "leg-0-msg-0",
            kind: "user",
            children: [{ label: "blk", anchorId: "leg-0-msg-0-blk-0", kind: "text" }],
          },
        ],
      },
    ]
    render(
      <DetailTocTree
        nodes={deep}
        onSelect={() => {}}
      />,
    )

    // Expand both levels (each only has its own collapse toggle visible at a time).
    fireEvent.click(screen.getByLabelText("expand"))
    fireEvent.click(screen.getByLabelText("expand"))

    expect(screen.getByText("blk")).toBeDefined()
    // Three-deep numbering: 1 → 1.1 → 1.1.1.
    expect(screen.getByText("1.1.1")).toBeDefined()
  })
})

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
    label: "user · hello",
    anchorId: "pfx-msg-0",
    kind: "user",
    children: [{ label: "hello", anchorId: "pfx-msg-0-blk-0", kind: "text" }],
  },
  {
    label: "assistant · hi",
    anchorId: "pfx-msg-1",
    kind: "assistant",
    children: [
      { label: "hi", anchorId: "pfx-msg-1-blk-0", kind: "text" },
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
    expect(screen.getByText("user · hello")).toBeDefined()
    expect(screen.getByText("assistant · hi")).toBeDefined()
    // Block children hidden by default.
    expect(screen.queryByText("tool_use: Edit")).toBeNull()
    expect(screen.queryByText("hello")).toBeNull()
  })

  it("clicking a node's label calls onSelect with its anchorId", () => {
    const onSelect = vi.fn()
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={onSelect}
      />,
    )

    fireEvent.click(screen.getByText("assistant · hi"))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith("pfx-msg-1")
  })

  it("the toggle reveals children without firing onSelect", () => {
    const onSelect = vi.fn()
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={onSelect}
      />,
    )

    // Collapsed → expand button shows ▸ for the assistant row.
    const toggles = screen.getAllByLabelText("expand")
    // Second message's toggle (assistant).
    fireEvent.click(toggles[1])

    // Children now visible.
    expect(screen.getByText("tool_use: Edit")).toBeDefined()
    expect(screen.getByText("hi")).toBeDefined()
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
    expect(screen.getByText("hello")).toBeDefined()

    // Now a collapse toggle exists for that node.
    fireEvent.click(screen.getByLabelText("collapse"))
    expect(screen.queryByText("hello")).toBeNull()
  })

  it("highlights the node matching activeAnchor", () => {
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={() => {}}
        activeAnchor="pfx-msg-1"
      />,
    )

    const activeRow = screen.getByText("assistant · hi").closest("div")
    const inactiveRow = screen.getByText("user · hello").closest("div")

    // Active row: left accent bar + amber text; inactive row has neither.
    expect(activeRow?.className).toContain("text-[var(--color-primary)]")
    expect(activeRow?.className).toContain("border-l-[var(--color-primary)]")
    expect(inactiveRow?.className).not.toContain("text-[var(--color-primary)]")
    expect(inactiveRow?.className).not.toContain("border-l-[var(--color-primary)]")
  })

  it("renders a kind-colored marker per node", () => {
    render(
      <DetailTocTree
        nodes={tree}
        onSelect={() => {}}
      />,
    )

    // The kind dot is the marker element immediately preceding each label button.
    // user role → amber primary; assistant role → soft blue (#9ad) — mirrors
    // MessageBlock's ROLE_COLOR so the two views stay consistent.
    const userRow = screen.getByText("user · hello").closest("div")
    const assistantRow = screen.getByText("assistant · hi").closest("div")

    const userDot = userRow?.querySelector("span[aria-hidden]")
    const assistantDot = assistantRow?.querySelector("span[aria-hidden]")

    expect(userDot).not.toBeNull()
    expect((userDot as HTMLElement).style.color).toBe("var(--color-primary)")
    expect((assistantDot as HTMLElement).style.color).toBe("rgb(153, 170, 221)")
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
  })
})

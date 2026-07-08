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

import { BlockJsonModal } from "@/components/detail/BlockJsonModal"

// Copy routes through the shared clipboard helper — mock it to observe the payload.
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }))
import { copyText } from "@/lib/clipboard"

const BLOCK = { type: "tool_use", id: "x", name: "Read", input: { path: "a.ts" } }

describe("BlockJsonModal", () => {
  it("titles the modal with the block type", () => {
    render(
      <BlockJsonModal
        value={BLOCK}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText("tool_use JSON")).toBeDefined()
  })

  it("defaults to the Source view showing the JSON (and no tree summary)", () => {
    render(
      <BlockJsonModal
        value={BLOCK}
        onClose={() => {}}
      />,
    )
    // Positive: the Source code view renders the block's JSON text. The modal is portaled to
    // document.body, and CodeBlock's textContent concatenates its token spans (robust to
    // shiki's async highlight re-render).
    expect(document.body.textContent).toContain('"tool_use"')
    expect(document.body.textContent).toContain('"a.ts"')
    // Negative: JsonTreeView's container summary ("{…} N keys") is tree-only; absent in Source view.
    expect(screen.queryByText(/keys/)).toBeNull()
  })

  it("switches to a collapsible tree when the Tree tab is selected", () => {
    render(
      <BlockJsonModal
        value={BLOCK}
        onClose={() => {}}
      />,
    )
    // RawJsonView labels its tabs 原文 / 树; click the tree tab.
    fireEvent.click(screen.getByRole("tab", { name: /树|tree/i }))
    // Root object has 4 keys (type/id/name/input) → tree summary appears.
    expect(screen.getByText(/4 keys/)).toBeDefined()
  })

  it("copies the pretty-printed block JSON via the Source toolbar", () => {
    render(
      <BlockJsonModal
        value={BLOCK}
        onClose={() => {}}
      />,
    )
    // Copy now lives in the CodeBlock toolbar (default Source view), routed through copyText.
    fireEvent.click(screen.getByText("Copy"))
    expect(copyText).toHaveBeenCalledWith(JSON.stringify(BLOCK, null, 2))
  })

  it("falls back to a generic title when the value has no type", () => {
    render(
      <BlockJsonModal
        value={{ foo: 1 }}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText("block JSON")).toBeDefined()
  })
})

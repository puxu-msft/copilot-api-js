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

  it("defaults to the Source view (no tree summary until toggled)", () => {
    render(
      <BlockJsonModal
        value={BLOCK}
        onClose={() => {}}
      />,
    )
    // JsonTreeView's container summary ("{…} N keys") is tree-only; absent in Source view.
    expect(screen.queryByText(/keys/)).toBeNull()
  })

  it("switches to a collapsible tree when Tree is selected", () => {
    render(
      <BlockJsonModal
        value={BLOCK}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByText("Tree"))
    // Root object has 4 keys (type/id/name/input) → tree summary appears.
    expect(screen.getByText(/4 keys/)).toBeDefined()
  })

  it("copies the pretty-printed block JSON", () => {
    render(
      <BlockJsonModal
        value={BLOCK}
        onClose={() => {}}
      />,
    )
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

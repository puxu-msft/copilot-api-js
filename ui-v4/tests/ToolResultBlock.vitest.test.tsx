import {
  //
  render,
  screen,
} from "@testing-library/react"
import {
  //
  describe,
  expect,
  it,
} from "vitest"

import { ToolResultBlock } from "@/components/detail/blocks/ToolResultBlock"

describe("ToolResultBlock", () => {
  it("renders nested content-block array via ContentRenderer (recursion + cycle)", () => {
    render(<ToolResultBlock block={{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "nested text" }] }} />)
    expect(screen.getByText(/nested text/)).toBeDefined()
    // 不应回退成原始 JSON dump
    expect(screen.queryByText(/"type"/)).toBeNull()
  })

  it("renders nested image block via ImageBlock (recursion end-to-end)", () => {
    render(
      <ToolResultBlock
        block={{
          type: "tool_result",
          tool_use_id: "tu_img",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }],
        }}
      />,
    )
    const img = screen.getByAltText<HTMLImageElement>("content")
    expect(img.src).toContain("data:image/png;base64,iVBORw0KGgo=")
  })

  it("renders plain string content directly (not JSON-wrapped)", () => {
    render(<ToolResultBlock block={{ type: "tool_result", tool_use_id: "tu_2", content: "plain string" }} />)
    expect(screen.getByText(/plain string/)).toBeDefined()
    expect(screen.queryByText(/"plain string"/)).toBeNull()
  })

  it("falls back to JSON dump for non-array object content", () => {
    render(<ToolResultBlock block={{ type: "tool_result", tool_use_id: "tu_3", content: { some: "object" } as never }} />)
    expect(screen.getByText(/"some": "object"/)).toBeDefined()
  })
})

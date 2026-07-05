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

import { TextBlock } from "@/components/detail/blocks/TextBlock"
import { ToolUseBlock } from "@/components/detail/blocks/ToolUseBlock"

describe("blocks", () => {
  it("TextBlock renders text", () => {
    render(<TextBlock block={{ type: "text", text: "hello world" }} />)
    expect(screen.getByText(/hello world/)).toBeDefined()
  })
  it("TextBlock carries a type label wrapper consistent with other blocks", () => {
    render(<TextBlock block={{ type: "text", text: "hello world" }} />)
    expect(screen.getByText("text")).toBeDefined()
  })
  it("ToolUseBlock renders tool name + input json", () => {
    render(<ToolUseBlock block={{ type: "tool_use", id: "x", name: "Edit", input: { path: "a.ts" } }} />)
    expect(screen.getByText(/Edit/)).toBeDefined()
    expect(screen.getByText(/a\.ts/)).toBeDefined()
  })
})

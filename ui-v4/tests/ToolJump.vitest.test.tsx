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

import type { ToolPair } from "@/lib/content/tool-pairing"

import { ToolResultBlock } from "@/components/detail/blocks/ToolResultBlock"
import { ToolUseBlock } from "@/components/detail/blocks/ToolUseBlock"
import { ToolPairingProvider } from "@/components/detail/ToolPairingContext"

function withPairing(pairing: Map<string, ToolPair>, scrollTo: (id: string) => void, node: React.ReactNode) {
  return <ToolPairingProvider value={{ pairing, scrollTo }}>{node}</ToolPairingProvider>
}

const PAIR = new Map<string, ToolPair>([["t1", { useAnchor: "convo-msg-0-blk-1", resultAnchor: "convo-msg-1-blk-0" }]])

describe("tool_use ↔ tool_result jump", () => {
  it("tool_use jumps to the result anchor", () => {
    const scrollTo = vi.fn()
    render(withPairing(PAIR, scrollTo, <ToolUseBlock block={{ type: "tool_use", id: "t1", name: "Read", input: {} }} />))
    fireEvent.click(screen.getByLabelText("Jump to tool result"))
    expect(scrollTo).toHaveBeenCalledWith("convo-msg-1-blk-0")
  })

  it("tool_result jumps to the call anchor", () => {
    const scrollTo = vi.fn()
    render(withPairing(PAIR, scrollTo, <ToolResultBlock block={{ type: "tool_result", tool_use_id: "t1", content: "ok" }} />))
    fireEvent.click(screen.getByLabelText("Jump to tool call"))
    expect(scrollTo).toHaveBeenCalledWith("convo-msg-0-blk-1")
  })

  it("renders no jump button without a pairing provider", () => {
    render(<ToolUseBlock block={{ type: "tool_use", id: "t1", name: "Read", input: {} }} />)
    expect(screen.queryByLabelText("Jump to tool result")).toBeNull()
  })

  it("renders no jump button when the counterpart anchor is absent", () => {
    const scrollTo = vi.fn()
    const soloPair = new Map<string, ToolPair>([["t1", { useAnchor: "convo-msg-0-blk-1" }]])
    render(withPairing(soloPair, scrollTo, <ToolUseBlock block={{ type: "tool_use", id: "t1", name: "Read", input: {} }} />))
    expect(screen.queryByLabelText("Jump to tool result")).toBeNull()
  })
})

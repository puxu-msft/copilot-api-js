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

import type { HistoryEntry } from "@/types"

import { ResponseSegment } from "@/components/detail/segments/ResponseSegment"

const withResponse = {
  id: "r1",
  startedAt: 0,
  endpoint: "anthropic-messages",
  inboundRequest: { messages: [] },
  outboundResponse: {
    success: true,
    model: "claude-opus-4.8",
    status: 200,
    content: { role: "assistant", content: "upstream answer" },
  },
  sseEvents: [
    { offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` },
    { offsetMs: 12, type: "content_block_delta", raw: `{"type":"content_block_delta","text":"hi"}` },
  ],
  inboundResponse: {
    sseEvents: [{ offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` }],
  },
} as unknown as HistoryEntry

const empty = {
  id: "r2",
  startedAt: 0,
  endpoint: "anthropic-messages",
  inboundRequest: { messages: [] },
} as unknown as HistoryEntry

describe("ResponseSegment", () => {
  it("renders upstream content and status line (no SSE frames here)", () => {
    render(<ResponseSegment entry={withResponse} />)
    // upstream content (via MessageBlock)
    expect(screen.getByText(/upstream answer/)).toBeDefined()
    // status line
    expect(screen.getByText(/status 200/)).toBeDefined()
    // SSE frame lists + diff moved to the SSE tab — not present here.
    expect(screen.queryByText(/upstream sse \(/)).toBeNull()
    expect(screen.queryByText(/upstream vs forwarded/)).toBeNull()
  })

  it("renders the 无响应数据 fallback when there is no response data", () => {
    render(<ResponseSegment entry={empty} />)
    expect(screen.getByText(/无响应数据/)).toBeDefined()
  })
})

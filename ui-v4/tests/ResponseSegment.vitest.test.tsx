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
  it("renders upstream content, frame lists, and the SSE diff area", () => {
    render(<ResponseSegment entry={withResponse} />)
    // upstream content (via MessageBlock)
    expect(screen.getByText(/upstream answer/)).toBeDefined()
    // status line
    expect(screen.getByText(/status 200/)).toBeDefined()
    // upstream frame list header (2 frames)
    expect(screen.getByText(/upstream sse \(2 frames\)/)).toBeDefined()
    // forwarded frame list header (1 frame)
    expect(screen.getByText(/forwarded sse \(1 frames\)/)).toBeDefined()
    // diff area label
    expect(screen.getByText(/upstream vs forwarded/)).toBeDefined()
  })

  it("renders the 无响应数据 fallback when there is no response data", () => {
    render(<ResponseSegment entry={empty} />)
    expect(screen.getByText(/无响应数据/)).toBeDefined()
  })
})

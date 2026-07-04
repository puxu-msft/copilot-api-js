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
  state: "completed",
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
  // A proper forwarded Anthropic text stream → the Proxy→Client section renders the reconstructed content.
  inboundResponse: {
    sseEvents: [
      { offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` },
      { offsetMs: 2, type: "content_block_start", raw: `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` },
      {
        offsetMs: 4,
        type: "content_block_delta",
        raw: `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"forwarded client answer"}}`,
      },
      { offsetMs: 6, type: "content_block_stop", raw: `{"type":"content_block_stop","index":0}` },
      { offsetMs: 8, type: "message_stop", raw: `{"type":"message_stop"}` },
    ],
  },
} as unknown as HistoryEntry

const empty = {
  id: "r2",
  startedAt: 0,
  endpoint: "anthropic-messages",
  inboundRequest: { messages: [] },
} as unknown as HistoryEntry

// A failed streaming request (e.g. AskUserQuestion unrepairable tool input): the UPSTREAM leg
// succeeded (200 stream), the proxy rejected the result → failureReason carries the verdict, the
// forwarded track carries the synthesized error frame the client received.
const streamingFailure = {
  id: "r3",
  startedAt: 0,
  endpoint: "anthropic-messages",
  state: "failed",
  failureReason: "unrepairable malformed tool_use input (tool=AskUserQuestion)",
  inboundRequest: { messages: [] },
  outboundResponse: {
    success: true,
    model: "claude-opus-4.8",
    content: { role: "assistant", content: "partial upstream answer" },
  },
  sseEvents: [{ offsetMs: 0, type: "message_stop", raw: `{"type":"message_stop"}` }],
  inboundResponse: {
    sseEvents: [
      {
        offsetMs: 2,
        type: "content_block_start",
        raw: `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"AskUserQuestion","input":{}}}`,
      },
      { offsetMs: 4, type: "content_block_delta", raw: `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{,,,}"}}` },
      { offsetMs: 6, type: "content_block_stop", raw: `{"type":"content_block_stop","index":0}` },
      {
        offsetMs: 20,
        type: "error",
        raw: `{"type":"error","error":{"type":"invalid_request_error","message":"Tool call input for AskUserQuestion was malformed and could not be repaired"}}`,
      },
    ],
  },
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

  it("renders the reconstructed client content in the Proxy → Client section for a streaming response", () => {
    render(<ResponseSegment entry={withResponse} />)
    expect(screen.getByText(/Forwarded \(proxy → client\)/)).toBeDefined()
    // The forwarded stream is accumulated into semantic content (not a frame summary).
    expect(screen.getByText(/forwarded client answer/)).toBeDefined()
    expect(screen.queryByText(/frames forwarded/)).toBeNull()
  })

  it("renders the 无响应数据 fallback when there is no response data", () => {
    render(<ResponseSegment entry={empty} />)
    expect(screen.getByText(/无响应数据/)).toBeDefined()
  })

  it("surfaces the failure verdict in an Outcome banner, the reconstructed tool call, and the client-received error frame", () => {
    render(<ResponseSegment entry={streamingFailure} />)
    // Outcome banner carries the proxy verdict (failureReason), not buried in the upstream leg.
    expect(screen.getByText(/Outcome \(request verdict\)/)).toBeDefined()
    expect(screen.getAllByText(/unrepairable malformed tool_use input/).length).toBeGreaterThan(0)
    // Upstream leg is shown HONESTLY as ok (success:true) — the failure was proxy-introduced.
    expect(screen.getByText(/· ok$/)).toBeDefined()
    // Proxy → Client section reconstructs the (malformed) tool call the client received + the error frame.
    expect(screen.getAllByText(/AskUserQuestion/).length).toBeGreaterThan(0)
    expect(screen.getByText(/invalid_request_error: Tool call input for AskUserQuestion/)).toBeDefined()
  })
})

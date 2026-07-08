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

import { SseEventsSegment } from "@/components/detail/segments/SseEventsSegment"

const withFrames = {
  id: "r1",
  startedAt: 0,
  endpoint: "anthropic-messages",
  clientRequest: { messages: [] },
  attempts: [
    {
      index: 0,
      durationMs: 0,
      upstreamResponse: {
        success: true,
        sseEvents: [
          { offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` },
          { offsetMs: 12, type: "content_block_delta", raw: `{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}` },
        ],
      },
    },
  ],
  clientResponse: {
    sseEvents: [{ offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` }],
  },
} as unknown as HistoryEntry

const noFrames = {
  id: "r2",
  startedAt: 0,
  endpoint: "anthropic-messages",
  clientRequest: { messages: [] },
  attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, model: "m", status: 200, body: { role: "assistant", content: "x" } } }],
} as unknown as HistoryEntry

const withSyntheticFrames = {
  id: "r3",
  startedAt: 0,
  endpoint: "anthropic-messages",
  clientRequest: { messages: [] },
  attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, sseEvents: [{ offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` }] } }],
  clientResponse: {
    sseEvents: [
      { offsetMs: 0, type: "content_block_start", raw: `{"type":"content_block_start","index":0}`, synthetic: "anchor" },
      { offsetMs: 5, type: "content_block_delta", raw: `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":""}}`, synthetic: "keepalive" },
      { offsetMs: 9, type: "content_block_stop", raw: `{"type":"content_block_stop","index":0}`, synthetic: "anchor" },
    ],
  },
} as unknown as HistoryEntry

describe("SseEventsSegment", () => {
  it("renders upstream + forwarded frame lists and the diff area", () => {
    render(<SseEventsSegment entry={withFrames} />)
    expect(screen.getByText(/upstream sse \(2 frames\)/)).toBeDefined()
    expect(screen.getByText(/forwarded sse \(1 frames\)/)).toBeDefined()
    expect(screen.getByText(/upstream vs forwarded/)).toBeDefined()
  })

  it("renders the 无 SSE 帧 fallback for non-streaming responses", () => {
    render(<SseEventsSegment entry={noFrames} />)
    expect(screen.getByText(/无 SSE 帧/)).toBeDefined()
  })

  it("badges synthetic anchor + keepalive frames so proxy-injected frames are distinguishable", () => {
    render(<SseEventsSegment entry={withSyntheticFrames} />)
    // Forwarded track carries the two anchor frames + one keepalive delta.
    expect(screen.getAllByText("anchor").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("keepalive").length).toBeGreaterThanOrEqual(1)
  })
})

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
} from "vitest"

import type { HistoryEntry } from "@/types"

import { ResponseSegment } from "@/components/detail/segments/ResponseSegment"

const withResponse = {
  id: "r1",
  startedAt: 0,
  endpoint: "anthropic-messages",
  state: "completed",
  clientRequest: { messages: [] },
  attempts: [
    {
      index: 0,
      durationMs: 0,
      upstreamResponse: {
        success: true,
        model: "claude-opus-4.8",
        status: 200,
        body: { role: "assistant", content: "upstream answer" },
        sseEvents: [
          { offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` },
          { offsetMs: 12, type: "content_block_delta", raw: `{"type":"content_block_delta","text":"hi"}` },
        ],
      },
    },
  ],
  // A proper forwarded Anthropic text stream → the Proxy→Client section renders the reconstructed content.
  clientResponse: {
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

const refusalWithNamedCategory = {
  id: "refusal-named",
  startedAt: 0,
  endpoint: "anthropic-messages",
  state: "failed",
  clientRequest: { messages: [] },
  attempts: [
    {
      index: 0,
      durationMs: 1,
      upstreamResponse: {
        success: true,
        model: "claude-opus-5",
        status: 200,
        stopReason: "refusal",
        stopDetails: {
          type: "refusal",
          category: "cyber",
          explanation: "FULL_EXPLANATION_START\nEvery diagnostic line must remain visible.\nFULL_EXPLANATION_END",
          recommended_model: "claude-opus-4-8",
        },
      },
    },
  ],
} as unknown as HistoryEntry

const refusalWithUncategorizedCategory = {
  ...refusalWithNamedCategory,
  id: "refusal-uncategorized",
  attempts: [
    {
      index: 0,
      durationMs: 1,
      upstreamResponse: {
        success: true,
        model: "claude-opus-4.8",
        status: 200,
        stopReason: "refusal",
        stopDetails: { type: "refusal", category: null, explanation: "No named category matched." },
      },
    },
  ],
} as unknown as HistoryEntry

const refusalWithMissingCategory = {
  ...refusalWithNamedCategory,
  id: "refusal-missing",
  attempts: [
    {
      index: 0,
      durationMs: 1,
      upstreamResponse: {
        success: true,
        model: "claude-opus-4.8",
        status: 200,
        stopReason: "refusal",
        stopDetails: { type: "refusal", explanation: "Legacy upstream omitted category." },
      },
    },
  ],
} as unknown as HistoryEntry

const empty = {
  id: "r2",
  startedAt: 0,
  endpoint: "anthropic-messages",
  clientRequest: { messages: [] },
} as unknown as HistoryEntry

// NEW-LEG entry (RFC 2026-07-07 data-model restructure): the response lives on the per-attempt
// `upstreamResponse` (final attempt) + `clientResponse` legs (the legacy `outboundResponse` /
// `inboundResponse` / top-level `sseEvents` legs were removed in P4c). `body` (not `content`),
// `stopReason` (not `stop_reason`).
const newLegOnly = {
  id: "r4",
  startedAt: 0,
  endpoint: "anthropic-messages",
  state: "completed",
  clientRequest: { messages: [] },
  model: { requested: "claude-req", resolved: "claude-opus-4.8" },
  attempts: [
    {
      index: 0,
      durationMs: 10,
      upstreamRequest: { body: {} },
      upstreamResponse: {
        success: true,
        status: 200,
        model: "claude-opus-4.8",
        body: { role: "assistant", content: "new-leg upstream answer" },
      },
    },
  ],
  clientResponse: {
    sseEvents: [
      { offsetMs: 0, type: "message_start", raw: `{"type":"message_start"}` },
      { offsetMs: 2, type: "content_block_start", raw: `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` },
      {
        offsetMs: 4,
        type: "content_block_delta",
        raw: `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"new-leg forwarded answer"}}`,
      },
      { offsetMs: 6, type: "content_block_stop", raw: `{"type":"content_block_stop","index":0}` },
      { offsetMs: 8, type: "message_stop", raw: `{"type":"message_stop"}` },
    ],
  },
} as unknown as HistoryEntry

// A failed streaming request (e.g. AskUserQuestion unrepairable tool input): the UPSTREAM leg
// succeeded (200 stream), the proxy rejected the result → failureReason carries the verdict, the
// forwarded track carries the synthesized error frame the client received.
const streamingFailure = {
  id: "r3",
  startedAt: 0,
  endpoint: "anthropic-messages",
  state: "failed",
  _index: { derived: { failureReason: "unrepairable malformed tool_use input (tool=AskUserQuestion)" } },
  clientRequest: { messages: [] },
  attempts: [
    {
      index: 0,
      durationMs: 0,
      upstreamResponse: {
        success: true,
        model: "claude-opus-4.8",
        body: { role: "assistant", content: "partial upstream answer" },
        sseEvents: [{ offsetMs: 0, type: "message_stop", raw: `{"type":"message_stop"}` }],
      },
    },
  ],
  clientResponse: {
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

  it("toggles to Code view — shows the message objects as pretty JSON", () => {
    render(<ResponseSegment entry={withResponse} />)
    // Rendered mode: the JSON structure is not shown verbatim.
    expect(screen.queryByText(/"type": "text"/)).toBeNull()
    fireEvent.click(screen.getByText("Code"))
    // Upstream leg → upstreamResponse.body as JSON.
    expect(screen.getByText(/"upstream answer"/)).toBeDefined()
    // Forwarded leg → the reconstructed client message object as JSON (role + text block).
    expect(screen.getAllByText(/"role": "assistant"/).length).toBeGreaterThan(0)
    expect(screen.getByText(/"type": "text"/)).toBeDefined()
    expect(screen.getByText(/forwarded client answer/)).toBeDefined()
  })

  it("renders a dedicated refusal diagnostic with the named category and complete explanation", () => {
    const { container } = render(<ResponseSegment entry={refusalWithNamedCategory} />)

    expect(screen.getByText("Refusal diagnostic (upstream)")).toBeDefined()
    expect(screen.getByText("cyber")).toBeDefined()
    expect(container.textContent).toContain("FULL_EXPLANATION_START")
    expect(container.textContent).toContain("Every diagnostic line must remain visible.")
    expect(container.textContent).toContain("FULL_EXPLANATION_END")
  })

  it("keeps an explicit upstream null distinguishable from an unreadable category", () => {
    const { unmount } = render(<ResponseSegment entry={refusalWithUncategorizedCategory} />)
    expect(screen.getByText("uncategorized")).toBeDefined()
    expect(screen.getByText(/explicit null/)).toBeDefined()

    unmount()
    render(<ResponseSegment entry={refusalWithMissingCategory} />)
    expect(screen.getByText("unknown")).toBeDefined()
    // `unknown` covers both an absent field and a malformed one — the backend union stopped calling
    // this case "missing" once an empty-string category had to land in the same bucket.
    expect(screen.getByText(/absent or unreadable/)).toBeDefined()
  })

  it("preserves the complete raw stopDetails object in a JSON view", () => {
    const { container } = render(<ResponseSegment entry={refusalWithNamedCategory} />)

    expect(screen.getByText("Raw stop_details")).toBeDefined()
    expect(container.textContent).toContain('"recommended_model": "claude-opus-4-8"')
    expect(container.textContent).toContain('"category": "cyber"')
  })

  it("renders the 无响应数据 fallback when there is no response data", () => {
    render(<ResponseSegment entry={empty} />)
    expect(screen.getByText(/无响应数据/)).toBeDefined()
  })

  it("reads the NEW per-attempt upstreamResponse + clientResponse legs when the legacy top-level legs are absent", () => {
    render(<ResponseSegment entry={newLegOnly} />)
    // Upstream leg body comes from attempts[final].upstreamResponse.body (not legacy outboundResponse.content).
    expect(screen.getByText(/new-leg upstream answer/)).toBeDefined()
    // Status line derives from the new leg's status/model/success.
    expect(screen.getByText(/status 200/)).toBeDefined()
    expect(screen.getByText(/claude-opus-4\.8 · ok/)).toBeDefined()
    // Forwarded content reconstructed from clientResponse.sseEvents (not legacy inboundResponse.sseEvents).
    expect(screen.getByText(/Forwarded \(proxy → client\)/)).toBeDefined()
    expect(screen.getByText(/new-leg forwarded answer/)).toBeDefined()
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

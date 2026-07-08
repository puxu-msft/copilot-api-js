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

import { DiagnosticBar } from "@/components/detail/DiagnosticBar"

describe("DiagnosticBar", () => {
  it("shows endpoint, state, duration, tokens", () => {
    const entry = {
      id: "r1",
      startedAt: 0,
      endpoint: "anthropic-messages",
      state: "completed",
      durationMs: 1200,
      _index: { derived: { attemptCount: 2 } },
      clientRequest: {},
      attempts: [{ index: 0, durationMs: 0, upstreamResponse: { success: true, model: "claude", usage: { input_tokens: 100, output_tokens: 50 } } }],
    } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    expect(screen.getByText(/anthropic-messages/)).toBeDefined()
    expect(screen.getByText(/1\.2s/)).toBeDefined()
    expect(screen.getByText(/completed/)).toBeDefined()
    // Base token text (no cache) — net input ↑ and output ↓.
    expect(screen.getByText(/↑100 ↓50 tok/)).toBeDefined()
  })
  it("renders the disjoint cache/reasoning breakdown when present", () => {
    const entry = {
      id: "rc",
      startedAt: 0,
      endpoint: "anthropic-messages",
      state: "completed",
      clientRequest: {},
      attempts: [
        {
          index: 0,
          durationMs: 0,
          upstreamResponse: {
            success: true,
            model: "claude",
            usage: {
              input_tokens: 600,
              output_tokens: 250,
              cache_read_input_tokens: 400,
              cache_creation_input_tokens: 100,
              output_tokens_details: { reasoning_tokens: 80 },
            },
          },
        },
      ],
    } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    // input_tokens is NET (600), disjoint from the cache/reasoning segments.
    expect(screen.getByText(/↑600 ↓250 · cache-read 400 · cache-write 100 · reasoning 80 tok/)).toBeDefined()
  })
  it("omits missing fields gracefully", () => {
    const entry = { id: "r2", startedAt: 0, endpoint: "anthropic-messages", state: "failed", clientRequest: {} } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    expect(screen.getByText(/failed/)).toBeDefined()
  })
  it("surfaces the failure verdict for a failed request", () => {
    const entry = {
      id: "r3",
      startedAt: 0,
      endpoint: "anthropic-messages",
      state: "failed",
      _index: { derived: { failureReason: "unrepairable malformed tool_use input (tool=AskUserQuestion)" } },
      clientRequest: {},
    } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    expect(screen.getByText(/unrepairable malformed tool_use input/)).toBeDefined()
  })
})

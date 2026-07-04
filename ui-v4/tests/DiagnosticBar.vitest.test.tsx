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
      attemptCount: 2,
      inboundRequest: {},
      outboundResponse: { success: true, model: "claude", usage: { input_tokens: 100, output_tokens: 50 } },
    } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    expect(screen.getByText(/anthropic-messages/)).toBeDefined()
    expect(screen.getByText(/1\.2s/)).toBeDefined()
    expect(screen.getByText(/completed/)).toBeDefined()
  })
  it("omits missing fields gracefully", () => {
    const entry = { id: "r2", startedAt: 0, endpoint: "anthropic-messages", state: "failed", inboundRequest: {} } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    expect(screen.getByText(/failed/)).toBeDefined()
  })
  it("surfaces the failure verdict for a failed request", () => {
    const entry = {
      id: "r3",
      startedAt: 0,
      endpoint: "anthropic-messages",
      state: "failed",
      failureReason: "unrepairable malformed tool_use input (tool=AskUserQuestion)",
      inboundRequest: {},
    } as HistoryEntry
    render(<DiagnosticBar entry={entry} />)
    expect(screen.getByText(/unrepairable malformed tool_use input/)).toBeDefined()
  })
})

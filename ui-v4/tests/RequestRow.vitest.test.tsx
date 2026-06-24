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

import type { EntrySummary } from "@/types"

import { RequestRow } from "@/components/requests/RequestRow"

const base = (over: Partial<EntrySummary>): EntrySummary => ({
  id: "x",
  startedAt: new Date(2026, 0, 1, 9, 5, 3).getTime(),
  endpoint: "anthropic-messages",
  messageCount: 0,
  previewText: "",
  searchText: "",
  ...over,
})

describe("RequestRow", () => {
  it("completed history row renders time / model / endpoint / tokens / preview", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 1500, output_tokens: 250 },
          durationMs: 1200,
          previewText: "hello from the model",
        })}
      />,
    )
    expect(screen.getByText("09:05:03")).toBeDefined()
    expect(screen.getByText("claude-opus-4.8")).toBeDefined()
    expect(screen.getByText("anthropic messages")).toBeDefined()
    expect(screen.getByText("↑1.5K")).toBeDefined()
    expect(screen.getByText("↓250")).toBeDefined()
    expect(screen.getByText("hello from the model")).toBeDefined()
  })

  it("failed history row renders the failure summary, not a preview", () => {
    render(
      <RequestRow
        entry={base({
          state: "failed",
          currentStrategy: "auto-truncate",
          attemptCount: 3,
          responseError: "413 too large",
          previewText: "should not show",
        })}
      />,
    )
    expect(screen.getByText("failed · auto-truncate · ×3 · 413 too large")).toBeDefined()
    expect(screen.queryByText("should not show")).toBeNull()
  })

  it("slow history row carries the anomaly highlight class on duration", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          durationMs: 90_000,
          usage: { input_tokens: 100, output_tokens: 10 },
        })}
      />,
    )
    const dur = screen.getByText("1m30s")
    expect(dur.className).toContain("row-anomaly")
  })

  it("cache-miss history row carries the anomaly highlight class on cache cell", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          usage: { input_tokens: 30_000, output_tokens: 50 },
        })}
      />,
    )
    const cache = screen.getByText("(miss)")
    expect(cache.className).toContain("row-anomaly")
  })

  it("live row is compact: state / model / duration, no tokens or preview", () => {
    render(<RequestRow live={{ state: "streaming", model: "live-model", durationMs: 3400 }} />)
    expect(screen.getByText(/streaming/)).toBeDefined()
    expect(screen.getByText("live-model")).toBeDefined()
    expect(screen.getByText("3.4s")).toBeDefined()
    expect(screen.queryByText(/↑/)).toBeNull()
    expect(screen.queryByText(/↓/)).toBeNull()
  })

  it("history row renders ↑req↓resp bytes and the (Nx) multiplier badge when present", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 1500, output_tokens: 250 },
          requestBytes: 1536,
          responseBytes: 2_516_582,
          multiplier: 3,
        })}
      />,
    )
    expect(screen.getByText("↑1.5KB ↓2.4MB")).toBeDefined()
    expect(screen.getByText("(3x)")).toBeDefined()
    // token arrows remain their own cells, distinct from byte arrows
    expect(screen.getByText("↑1.5K")).toBeDefined()
    expect(screen.getByText("↓250")).toBeDefined()
  })

  it("history row with only request bytes renders ↑ side only (no dangling ↓)", () => {
    // Failed/aborted rows can have request bytes but no response bytes.
    render(
      <RequestRow
        entry={base({
          state: "failed",
          responseModel: "claude-opus-4.8",
          requestBytes: 1536,
        })}
      />,
    )
    // getByText is an exact text-content match → the bytes cell is exactly
    // "↑1.5KB" (would be "↑1.5KB ↓" if the ↓ side dangled). The token cell's
    // own ↓ is a separate element, so we assert the combined dangling form is absent.
    expect(screen.getByText("↑1.5KB")).toBeDefined()
    expect(screen.queryByText("↑1.5KB ↓")).toBeNull()
  })

  it("old history row without bytes/multiplier renders no byte arrows and no multiplier badge", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 1500, output_tokens: 250 },
        })}
      />,
    )
    // token arrows still present, but no KB/MB byte arrows and no (Nx) badge
    expect(screen.getByText("↑1.5K")).toBeDefined()
    expect(screen.queryByText(/↑.*KB|↑.*MB/)).toBeNull()
    expect(screen.queryByText(/\(\d+x\)/)).toBeNull()
  })
})

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
    // tokens are grouped into one cell: ↑in ↓out (no cache read here → no +Nc)
    expect(screen.getByText("↑1.5K ↓250")).toBeDefined()
    expect(screen.getByText("hello from the model")).toBeDefined()
  })

  it("duration renders as plain seconds with a + prefix, immediately after the time", () => {
    const { container } = render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 100, output_tokens: 10 },
          durationMs: 1200,
        })}
      />,
    )
    expect(screen.getByText("+1.2s")).toBeDefined()
    // duration cell follows the HH:MM:SS time cell in DOM order
    const cells = [...container.querySelectorAll("span")].map((s) => s.textContent)
    const timeIdx = cells.indexOf("09:05:03")
    const durIdx = cells.indexOf("+1.2s")
    expect(timeIdx).toBeGreaterThanOrEqual(0)
    expect(durIdx).toBe(timeIdx + 1)
  })

  it("a >60s duration renders seconds (+Ns), never the 2m3.4s minutes form", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          durationMs: 123_400,
          usage: { input_tokens: 100, output_tokens: 10 },
        })}
      />,
    )
    expect(screen.getByText("+123.4s")).toBeDefined()
    expect(screen.queryByText(/m\d/)).toBeNull()
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
    const dur = screen.getByText("+90.0s")
    expect(dur.className).toContain("row-anomaly")
  })

  it("cache-miss history row carries the anomaly highlight class on the token cell", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          usage: { input_tokens: 30_000, output_tokens: 50 },
        })}
      />,
    )
    // large input with no cache read → token cell flagged amber (no +Nc since no cache)
    const tokens = screen.getByText("↑30.0K ↓50")
    expect(tokens.className).toContain("row-anomaly")
  })

  it("groups cached input tokens into the up-token cell and shows bytes before tokens", () => {
    const { container } = render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 1500, output_tokens: 250, cache_read_input_tokens: 340 },
          requestBytes: 1536,
          responseBytes: 2_516_582,
          multiplier: 3,
        })}
      />,
    )
    // bytes cell unchanged content
    expect(screen.getByText("↑1.5KB ↓2.4MB")).toBeDefined()
    expect(screen.getByText("(3x)")).toBeDefined()
    // token cell groups input + cached suffix + output into one cell
    expect(screen.getByText("↑1.5K+340c ↓250")).toBeDefined()
    // bytes cell precedes the token cell in DOM order
    const cells = [...container.querySelectorAll("span")].map((s) => s.textContent)
    const bytesIdx = cells.indexOf("↑1.5KB ↓2.4MB")
    const tokenIdx = cells.indexOf("↑1.5K+340c ↓250")
    expect(bytesIdx).toBeGreaterThanOrEqual(0)
    expect(tokenIdx).toBeGreaterThan(bytesIdx)
  })

  it("token cell omits the +Nc suffix when there is no cache read", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 1500, output_tokens: 250 },
        })}
      />,
    )
    expect(screen.getByText("↑1.5K ↓250")).toBeDefined()
    expect(screen.queryByText(/\+\d+c/)).toBeNull()
  })

  it("hides the (Nx) badge for standard-rate (multiplier=1) and undefined models", () => {
    const { rerender } = render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 1500, output_tokens: 250 },
          multiplier: 1,
        })}
      />,
    )
    expect(screen.queryByText(/\(\d+x\)/)).toBeNull()
    rerender(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 1500, output_tokens: 250 },
        })}
      />,
    )
    expect(screen.queryByText(/\(\d+x\)/)).toBeNull()
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
    // grouped token cell still present, but no KB/MB byte arrows and no (Nx) badge
    expect(screen.getByText("↑1.5K ↓250")).toBeDefined()
    expect(screen.queryByText(/↑.*KB|↑.*MB/)).toBeNull()
    expect(screen.queryByText(/\(\d+x\)/)).toBeNull()
  })

  it("preview cell carries the full untruncated previewText as its hover title", () => {
    const long = "this is a very long preview that the row will visually ellipsize ".repeat(5).trim()
    render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          previewText: long,
        })}
      />,
    )
    // the visible text is truncated (≤120 + "..."), but the title is the FULL preview
    const cell = screen.getByText((_, el) => el?.getAttribute("title") === long)
    expect(cell).toBeDefined()
    expect(cell.getAttribute("title")).toBe(long)
  })

  it("model cell carries the full model name as its hover title", () => {
    render(
      <RequestRow
        entry={base({
          state: "completed",
          responseModel: "claude-opus-4.8",
          usage: { input_tokens: 100, output_tokens: 10 },
        })}
      />,
    )
    const model = screen.getByText("claude-opus-4.8")
    expect(model.getAttribute("title")).toBe("claude-opus-4.8")
  })

  it("failed history row carries the full failure summary as the cell title", () => {
    render(
      <RequestRow
        entry={base({
          state: "failed",
          currentStrategy: "auto-truncate",
          attemptCount: 3,
          responseError: "413 too large",
        })}
      />,
    )
    const cell = screen.getByText("failed · auto-truncate · ×3 · 413 too large")
    expect(cell.getAttribute("title")).toBe("failed · auto-truncate · ×3 · 413 too large")
  })
})

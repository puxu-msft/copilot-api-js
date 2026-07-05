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

import { SystemSegment } from "@/components/detail/segments/SystemSegment"

function entryWith(system: unknown, effectiveSystem?: unknown): HistoryEntry {
  return {
    id: "r1",
    startedAt: 0,
    endpoint: "anthropic-messages",
    inboundRequest: { messages: [], system },
    ...(effectiveSystem === undefined ? {} : { effectiveRequest: { messages: [], system: effectiveSystem } }),
  } as unknown as HistoryEntry
}

describe("SystemSegment", () => {
  it("renders the string system prompt in the rendered view by default, with a Rendered/Raw toggle", () => {
    render(<SystemSegment entry={entryWith("you are a helpful assistant")} />)
    expect(screen.getByText(/you are a helpful assistant/)).toBeDefined()
    expect(screen.getByText("Rendered")).toBeDefined()
    expect(screen.getByText("Raw body")).toBeDefined()
  })

  it("renders array system with cache_control in its richest form (cached indicator + labels)", () => {
    const system = [
      { type: "text", text: "block A body" },
      { type: "text", text: "block B body", cache_control: { type: "ephemeral" } },
    ]
    render(<SystemSegment entry={entryWith(system)} />)
    expect(screen.getByText("cached")).toBeDefined()
    expect(screen.getByText("[cache: ephemeral]")).toBeDefined()
    expect(screen.getByText(/block A body/)).toBeDefined()
    expect(screen.getByText(/block B body/)).toBeDefined()
  })

  it("surfaces the inbound→effective rewrite toggle when systems differ", () => {
    render(<SystemSegment entry={entryWith("old system text", "new system text")} />)
    expect(screen.getByText("modified")).toBeDefined()
    expect(screen.getByText("Original")).toBeDefined()
    expect(screen.getByText("Rewritten")).toBeDefined()
    expect(screen.getByText("Diff")).toBeDefined()
  })

  it("Raw body shows the untouched system JSON (block structure + cache_control)", () => {
    const system = [{ type: "text", text: "raw sys body", cache_control: { type: "ephemeral" } }]
    const { container } = render(<SystemSegment entry={entryWith(system)} />)
    fireEvent.click(screen.getByText("Raw body"))
    // shiki may split tokens across spans, so assert against aggregated textContent.
    const text = container.textContent
    expect(text).toContain("cache_control")
    expect(text).toContain("ephemeral")
    expect(text).toContain("raw sys body")
  })

  it("shows a placeholder and no toggle when there is no system prompt", () => {
    render(<SystemSegment entry={entryWith(undefined)} />)
    expect(screen.getByText(/无 system prompt/)).toBeDefined()
    expect(screen.queryByText("Rendered")).toBeNull()
    expect(screen.queryByText("Raw body")).toBeNull()
  })
})

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

import type { SystemBlock } from "@/types"

import { SystemMessage } from "@/components/detail/blocks/SystemMessage"

describe("SystemMessage", () => {
  it("renders string system with no rewrite and shows no view toggle", () => {
    render(<SystemMessage system="you are a helpful assistant" />)
    expect(screen.getByText(/you are a helpful assistant/)).toBeDefined()
    expect(screen.queryByText("Original")).toBeNull()
    expect(screen.queryByText("Diff")).toBeNull()
    expect(screen.queryByText("modified")).toBeNull()
  })

  it("renders system text with a line-number gutter", () => {
    render(<SystemMessage system={["first line", "second line"].join("\n")} />)
    // LineNumberedText renders a per-line gutter with 1-based numbers.
    expect(screen.getByText("1")).toBeDefined()
    expect(screen.getByText("2")).toBeDefined()
    expect(screen.getByText(/first line/)).toBeDefined()
    expect(screen.getByText(/second line/)).toBeDefined()
  })

  it("shows modified badge + toggle when rewrittenSystem differs", () => {
    render(
      <SystemMessage
        system={["line one", "old middle", "line three"].join("\n")}
        rewrittenSystem={["line one", "new middle", "line three"].join("\n")}
      />,
    )
    expect(screen.getByText("modified")).toBeDefined()
    expect(screen.getByText("Original")).toBeDefined()
    expect(screen.getByText("Rewritten")).toBeDefined()
    expect(screen.getByText("Diff")).toBeDefined()
  })

  it("toggles to Rewritten then Diff view", () => {
    const original = ["alpha", "old middle", "omega"].join("\n")
    const rewritten = ["alpha", "new middle", "omega"].join("\n")
    render(
      <SystemMessage
        system={original}
        rewrittenSystem={rewritten}
      />,
    )

    // Original mode (default): rewritten-only word should not be present.
    expect(screen.getByText(/old middle/)).toBeDefined()

    // Rewritten mode shows the rewritten text.
    fireEvent.click(screen.getByText("Rewritten"))
    expect(screen.getByText(/new middle/)).toBeDefined()

    // Diff mode renders the unified diff with both changed words highlighted.
    fireEvent.click(screen.getByText("Diff"))
    expect(screen.getByText("old")).toBeDefined()
    expect(screen.getByText("new")).toBeDefined()
  })

  it("shows rewritten (not modified) badge when rewrite is identical text", () => {
    render(
      <SystemMessage
        system="same text"
        rewrittenSystem="same text"
      />,
    )
    expect(screen.getByText("rewritten")).toBeDefined()
    expect(screen.queryByText("modified")).toBeNull()
    // Toggle still present because rewrite data exists.
    expect(screen.getByText("Diff")).toBeDefined()
  })

  it("renders array system with cache_control: cached indicator + block labels", () => {
    const system: Array<SystemBlock> = [
      { type: "text", text: "first block body" },
      { type: "text", text: "second block body", cache_control: { type: "ephemeral" } },
    ]
    render(<SystemMessage system={system} />)
    expect(screen.getByText("cached")).toBeDefined()
    expect(screen.getByText("text[0]")).toBeDefined()
    expect(screen.getByText("text[1]")).toBeDefined()
    expect(screen.getByText("[cache: ephemeral]")).toBeDefined()
    expect(screen.getByText(/first block body/)).toBeDefined()
    expect(screen.getByText(/second block body/)).toBeDefined()
  })

  it("shows Block count changed notice in diff mode when block counts differ", () => {
    const system: Array<SystemBlock> = [{ type: "text", text: "only one" }]
    const rewritten: Array<SystemBlock> = [
      { type: "text", text: "only one" },
      { type: "text", text: "extra added" },
    ]
    render(
      <SystemMessage
        system={system}
        rewrittenSystem={rewritten}
      />,
    )
    fireEvent.click(screen.getByText("Diff"))
    expect(screen.getByText(/Block count changed: 1 → 2/)).toBeDefined()
  })

  it("shows a removed badge when an effective leg exists (hasEffective) but rewrittenSystem is absent", () => {
    render(
      <SystemMessage
        system="inbound system body"
        hasEffective
        rewrittenSystem={undefined}
      />,
    )
    expect(screen.getByText("removed")).toBeDefined()
    // The removal is a rewrite, so the view toggle appears.
    expect(screen.getByText("Diff")).toBeDefined()
    expect(screen.queryByText("modified")).toBeNull()
  })

  it("shows an added badge and opens on Rewritten when original is absent but a rewrite injects a system", () => {
    render(
      <SystemMessage
        system=""
        hasEffective
        originalPresent={false}
        rewrittenSystem="injected system body"
      />,
    )
    expect(screen.getByText("added")).toBeDefined()
    // Added opens on Rewritten (the original is empty), so injected content shows immediately.
    expect(screen.getByText(/injected system body/)).toBeDefined()
  })

  it("classifies a present-but-empty inbound removed by a rewrite as removed (presence over text)", () => {
    // Both inbound "" and the dropped effective project to "" text, so a text-only
    // check would call this 'unchanged'; presence flags make it 'removed'.
    render(
      <SystemMessage
        system=""
        hasEffective
        originalPresent
        rewrittenSystem={undefined}
      />,
    )
    expect(screen.getByText("removed")).toBeDefined()
    expect(screen.queryByText("rewritten")).toBeNull()
  })
})

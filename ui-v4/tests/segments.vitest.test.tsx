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

import { ConvoSegment } from "@/components/detail/segments/ConvoSegment"
import { HeadersSegment } from "@/components/detail/segments/HeadersSegment"
import { MetaSegment } from "@/components/detail/segments/MetaSegment"
import { StagesSegment } from "@/components/detail/segments/StagesSegment"

const base = {
  id: "r1",
  startedAt: 0,
  endpoint: "anthropic-messages",
  inboundRequest: { messages: [{ role: "user", content: "convo hello" }] },
} as unknown as HistoryEntry

describe("detail segments", () => {
  it("ConvoSegment renders inbound conversation", () => {
    render(<ConvoSegment entry={base} />)
    expect(screen.getByText(/convo hello/)).toBeDefined()
  })
  it("StagesSegment shows Inbound leg label", () => {
    render(<StagesSegment entry={base} />)
    expect(screen.getByText(/Inbound/)).toBeDefined()
  })
  it("StagesSegment renders all three request legs side-by-side in a container-query grid", () => {
    const e = {
      ...base,
      effectiveRequest: { messages: [{ role: "user", content: "eff hello" }] },
      outboundRequest: { messages: [{ role: "user", content: "wire hello" }] },
    } as unknown as HistoryEntry
    const { container } = render(<StagesSegment entry={e} />)
    expect(screen.getByText(/Inbound \(client → proxy\)/)).toBeDefined()
    expect(screen.getByText(/Effective \(after rewrites\)/)).toBeDefined()
    expect(screen.getByText(/Wire \(proxy → upstream\)/)).toBeDefined()
    const cq = container.querySelector(String.raw`.\@container`)
    expect(cq).not.toBeNull()
    const grid = cq?.querySelector("div")
    expect(grid?.className).toContain("grid")
    expect(grid?.className).toContain("grid-cols-1")
    expect(grid?.className).toContain("@4xl:grid-cols-3")
  })
  it("HeadersSegment shows a header key/leg", () => {
    const e = { ...base, httpHeaders: { inboundRequest: { "x-test": "v1" } } } as HistoryEntry
    render(<HeadersSegment entry={e} />)
    expect(screen.getByText(/x-test/)).toBeDefined()
  })
  it("MetaSegment shows strategy + warnings", () => {
    const e = { ...base, currentStrategy: "network-retry", warningMessages: [{ code: "W1", message: "careful" }] } as HistoryEntry
    render(<MetaSegment entry={e} />)
    expect(screen.getByText(/network-retry/)).toBeDefined()
    expect(screen.getByText(/careful/)).toBeDefined()
  })
})

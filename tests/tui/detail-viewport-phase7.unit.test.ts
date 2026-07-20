import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  AttemptSnapshot,
  RequestContextSnapshot,
} from "~/lib/observability"
import type { DetailView } from "~/lib/tui/render/panel"

import {
  //
  buildDetailDocument,
  layoutDetailViewport,
} from "~/lib/tui/render/detail"

function entry(attempts: Array<AttemptSnapshot>): DetailView {
  const ctx: RequestContextSnapshot = {
    id: "req-detail",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    state: "streaming",
    startTime: 0,
    queueWaitMs: 0,
  }
  return { ctx, attempts }
}

const attempts = Array.from({ length: 60 }, (_, attemptIndex) => ({ attemptIndex, strategy: `strategy-${attemptIndex}` }))

describe("detail document and viewport", () => {
  test("document lines have stable unique keys including all attempts", () => {
    const document = buildDetailDocument(entry(attempts), 1000)
    const keys = [document.header.key, ...document.body.map((line) => line.key)]
    expect(new Set(keys).size).toBe(keys.length)
    expect(document.body.filter((line) => line.key.startsWith("attempt:"))).toHaveLength(60)
  })

  for (const rows of [3, 10, 24]) {
    test(`all 60 attempts are reachable at rows=${rows}`, () => {
      const document = buildDetailDocument(entry(attempts), 1000)
      const end = layoutDetailViewport(document, { rows, columns: 100, offset: Number.MAX_SAFE_INTEGER })
      expect(end.offset).toBe(end.maxOffset)
      expect(end.lines.join("\n")).toContain("strategy-59")
      expect(end.lines[0]).toContain("req-detail")
      expect(end.lines.at(-1)).toContain("esc back")
    })
  }

  test("resize clamps offset while keeping fixed header and keybar", () => {
    const document = buildDetailDocument(entry(attempts), 1000)
    const small = layoutDetailViewport(document, { rows: 3, columns: 80, offset: Number.MAX_SAFE_INTEGER })
    const large = layoutDetailViewport(document, { rows: 24, columns: 80, offset: small.offset })
    expect(large.offset).toBe(large.maxOffset)
    expect(large.offset).toBeLessThan(small.offset)
    expect(large.lines[0]).toContain("req-detail")
    expect(large.lines.at(-1)).toContain("esc back")
  })
})

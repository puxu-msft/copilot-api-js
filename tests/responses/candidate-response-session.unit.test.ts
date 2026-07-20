/**
 * Unit 2 (spec/plan 2026-07-20-synthetic-frame-forwarded-track-completeness §Phase A):
 * `responseFrame` must preserve the Symbol-keyed `hook-rewrite` provenance tag (and `id`/`retry`)
 * when it re-renders a Responses stream frame — it previously rebuilt a FRESH literal, dropping the
 * tag on BOTH the HTTP and WS transport (origin.ts:53-57 documented gap). The `...frame` spread fixes
 * it; combined with the probe (buffered-merge identity pass-through + delivery-session default branch +
 * makeWsSink.write reading readSyntheticKind), a single change covers both transports.
 *
 * Direct unit oracle on the ONLY new code. The end-to-end plumbing (tag surviving to the forwarded
 * history track) is already proven by tests/pipeline/hooks/driver-provenance.unit.test.ts (spread vs
 * fresh-literal controls, 13 pass) + the §0 static trace.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { ResponsesStreamEvent } from "~/types/api/openai-responses"

import { readSyntheticKind, tagFrameSynthetic } from "~/lib/pipeline/frame-origin"
import { responseFrame } from "~/routes/responses/candidate-response-session"

const DELTA_EVENT = { type: "response.output_text.delta" } as unknown as ResponsesStreamEvent
const DELTA_DATA = JSON.stringify({ type: "response.output_text.delta", delta: "x" })

describe("responseFrame — hook-rewrite provenance + id/retry preservation (Unit 2)", () => {
  test("HTTP: a hook-rewritten frame keeps synthetic:'hook-rewrite' through re-render", () => {
    const src = tagFrameSynthetic({ event: "response.output_text.delta", data: DELTA_DATA }, "hook-rewrite")
    const out = responseFrame("http", src, DELTA_EVENT, null)
    expect(readSyntheticKind(out)).toBe("hook-rewrite")
    expect(out.event).toBe("response.output_text.delta")
  })

  test("WS: a hook-rewritten frame keeps synthetic:'hook-rewrite' through re-render", () => {
    const src = tagFrameSynthetic({ event: "response.output_text.delta", data: DELTA_DATA }, "hook-rewrite")
    const out = responseFrame("ws", src, DELTA_EVENT, null)
    expect(readSyntheticKind(out)).toBe("hook-rewrite")
    expect(out.data).toBe(DELTA_DATA)
  })

  test("HTTP: event line falls back to event.type when frame.event is undefined (viaFallback leg)", () => {
    // viaFallback frames are CC→Responses-translated with frame.event === undefined; a bare {...frame,
    // data} without the explicit fallback would omit the `event:` line and break the wire.
    const src: { data: string; event?: string } = { data: DELTA_DATA }
    const out = responseFrame("http", src, DELTA_EVENT, null)
    expect(out.event).toBe("response.output_text.delta")
  })

  test("HTTP: id/retry are preserved (richest-data-flow — previously dropped)", () => {
    const src = { event: "response.output_text.delta", data: DELTA_DATA, id: "evt_1", retry: 3000 }
    const out = responseFrame("http", src, DELTA_EVENT, null)
    expect(out.id).toBe("evt_1")
    expect(out.retry).toBe(3000)
  })

  test("an untagged (real upstream) frame carries no synthetic marker after re-render (golden-equivalent)", () => {
    const src = { event: "response.output_text.delta", data: DELTA_DATA }
    expect(readSyntheticKind(responseFrame("http", src, DELTA_EVENT, null))).toBeUndefined()
    expect(readSyntheticKind(responseFrame("ws", src, DELTA_EVENT, null))).toBeUndefined()
  })
})

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { HistoryEntry, MessageContent, SseEventRecord } from "@/types"

import {
  hasEffectiveLeg,
  resolveEffectiveMessages,
  resolveEffectiveSystem,
  resolveForwardedContent,
  resolveForwardedSse,
  resolveHeaders,
  resolveUpstreamResponse,
  resolveUpstreamSse,
  resolveWirePayload,
} from "@/composables/entry-legs"

/**
 * NEW-LEG-only positive sample for the Vue read-side resolver (`entry-legs.ts` —
 * the single point every Vue detail consumer routes through). The 100+ existing
 * ui vitest/bun fixtures are all LEGACY-shaped, so they only exercise the
 * `?? legacy` fallback arm; the new-leg READ arm + the non-trivial field-name
 * bridging (`upstreamResponse.stopReason` → `stop_reason`, `.body` → `content`)
 * had ZERO coverage. build/typecheck only prove it compiles + is rollup-pure,
 * NOT that it reads the right field.
 *
 * This entry carries ONLY the new legs (per-attempt `upstreamRequest` /
 * `upstreamResponse` / `effectiveSource`, per-entry `clientResponse`) and NO
 * legacy top-level leg (`outboundResponse` / `inboundResponse` / `effectiveRequest`
 * / `outboundRequest` / top-level `sseEvents` / `httpHeaders`). Independent oracle:
 * every asserted value is a distinct literal set ONLY on the new leg, so a
 * legacy-only reader would fall through to `undefined` — proving the resolver
 * truly reaches the new leg rather than passing vacuously.
 */

// --- Independent oracle literals: each set ONLY on the new leg. ---
const UP_BODY: MessageContent = { role: "assistant", content: "NEW-LEG-UPSTREAM-BODY" }
const UP_USAGE = { input_tokens: 11, output_tokens: 22 }
const UP_SSE: Array<SseEventRecord> = [{ offsetMs: 1, type: "message_start", raw: "UP-FRAME" }]
const CLIENT_BODY: MessageContent = { role: "assistant", content: "NEW-LEG-FORWARDED-BODY" }
const CLIENT_SSE: Array<SseEventRecord> = [{ offsetMs: 2, type: "content_block_delta", raw: "FWD-FRAME" }]
const EFF_MESSAGES: Array<MessageContent> = [{ role: "user", content: "NEW-LEG-EFFECTIVE-MSG" }]
const EFF_SYSTEM = "NEW-LEG-EFFECTIVE-SYSTEM"
const WIRE_BODY = { wire: "NEW-LEG-UPSTREAM-REQUEST-BODY" }
const UP_REQ_HEADERS = { "x-up-req": "new-leg" }
const UP_RESP_HEADERS = { "x-up-resp": "new-leg" }
const CLIENT_REQ_HEADERS = { "x-client-req": "new-leg" }
const CLIENT_RESP_HEADERS = { "x-client-resp": "new-leg" }
const ATTEMPT_ERROR = "NEW-LEG-ATTEMPT-ERROR"

/** Entry with ONLY the new legs populated — no legacy top-level legs at all. */
function newLegOnlyEntry(): HistoryEntry {
  return {
    id: "new-leg-only",
    endpoint: "anthropic-messages",
    startedAt: 0,
    // NOTE: no inboundRequest structured leg needed for these resolvers; keep the
    // fixture strictly new-leg to guarantee the legacy arm is genuinely empty.
    clientRequest: { headers: CLIENT_REQ_HEADERS, body: { in: "raw" }, stream: true },
    clientResponse: { status: 200, headers: CLIENT_RESP_HEADERS, body: CLIENT_BODY, sseEvents: CLIENT_SSE },
    model: { requested: "claude-x", resolved: "claude-x-resolved" },
    attempts: [
      {
        index: 0,
        durationMs: 5,
        error: ATTEMPT_ERROR,
        effectiveSource: { messages: EFF_MESSAGES, system: EFF_SYSTEM },
        upstreamRequest: { headers: UP_REQ_HEADERS, body: WIRE_BODY },
        upstreamResponse: {
          success: true,
          status: 201,
          model: "claude-x-upstream",
          stopReason: "end_turn",
          body: UP_BODY,
          usage: UP_USAGE,
          sseEvents: UP_SSE,
          headers: UP_RESP_HEADERS,
        },
      },
    ],
  } as unknown as HistoryEntry
}

describe("entry-legs new-leg read + field bridging (Vue single-point resolver)", () => {
  test("fixture guard: legacy top-level legs are genuinely absent (non-vacuous oracle)", () => {
    const e = newLegOnlyEntry()
    // If any of these were set, the resolvers could pass via the legacy arm and the
    // test would be vacuous. Assert they are undefined so a fall-through resolves to
    // undefined — i.e. any populated result below MUST have come from the new leg.
    expect(e.outboundResponse).toBeUndefined()
    expect(e.inboundResponse).toBeUndefined()
    expect(e.effectiveRequest).toBeUndefined()
    expect(e.outboundRequest).toBeUndefined()
    expect(e.sseEvents).toBeUndefined()
    expect(e.httpHeaders).toBeUndefined()
  })

  test("resolveUpstreamResponse reads new upstreamResponse leg + bridges stopReason→stop_reason, body→content", () => {
    const view = resolveUpstreamResponse(newLegOnlyEntry())
    expect(view).toBeDefined()
    // Field-name bridge — the load-bearing part reviewer flagged as untested.
    expect(view!.stop_reason).toBe("end_turn") // from up.stopReason
    expect(view!.content).toBe(UP_BODY) // from up.body
    // Straight pass-through fields off the new leg.
    expect(view!.success).toBe(true)
    expect(view!.status).toBe(201)
    expect(view!.model).toBe("claude-x-upstream")
    expect(view!.usage).toBe(UP_USAGE)
    expect(view!.sseEvents).toBe(UP_SSE)
    // Response-side error home is the ATTEMPT, not the response leg.
    expect(view!.error).toBe(ATTEMPT_ERROR)
  })

  test("resolveUpstreamSse reads the new upstreamResponse.sseEvents", () => {
    expect(resolveUpstreamSse(newLegOnlyEntry())).toBe(UP_SSE)
  })

  test("resolveForwarded* read the new clientResponse leg (forwarded track)", () => {
    const e = newLegOnlyEntry()
    expect(resolveForwardedContent(e)).toBe(CLIENT_BODY)
    expect(resolveForwardedSse(e)).toBe(CLIENT_SSE)
  })

  test("hasEffectiveLeg + resolveEffective* read the new final-attempt effectiveSource", () => {
    const e = newLegOnlyEntry()
    expect(hasEffectiveLeg(e)).toBe(true)
    expect(resolveEffectiveMessages(e)).toBe(EFF_MESSAGES)
    expect(resolveEffectiveSystem(e)).toBe(EFF_SYSTEM)
  })

  test("resolveWirePayload reads the new upstreamRequest.body", () => {
    expect(resolveWirePayload(newLegOnlyEntry())).toBe(WIRE_BODY)
  })

  test("resolveHeaders reads all four new legs' headers", () => {
    const headers = resolveHeaders(newLegOnlyEntry())
    expect(headers.inboundRequest).toBe(CLIENT_REQ_HEADERS) // clientRequest.headers
    expect(headers.outboundRequest).toBe(UP_REQ_HEADERS) // finalUpstreamRequest.headers
    expect(headers.outboundResponse).toBe(UP_RESP_HEADERS) // finalUpstreamResponse.headers
    expect(headers.inboundResponse).toBe(CLIENT_RESP_HEADERS) // clientResponse.headers
  })
})

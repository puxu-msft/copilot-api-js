/**
 * CLI e2e (Tier 2) upstream hook: first mock a contentless REFUSAL, then normal turns.
 *
 * Contentless means no client-visible text/tool_use. This fixture uses the observed zero-content-block
 * shape; the proxy's refusal recovery (S5) transforms its first exchange per config:
 *   - refusal_sse_rewrite: end_turn + refusal_end_turn_text: ""  → empty END_TURN (stall bait)
 *   - refusal_sse_rewrite: end_turn + non-empty text             → recovery text (no stall)
 * Every later exchange returns a normal text turn so a resumed CLI session can prove it still works.
 *
 * Loaded via config `hooks.upstream_module` + `enabled: true` + `POST /api/hooks/reload`.
 *
 * NOTE: the loader now compiles hooks to a UNIQUE project-internal file (RFC 2026-07-14 Phase 5),
 * which resolves `~/` aliases and has none of the old `data:`-URL brace/quote/import quirks — so
 * imports + object literals are fine now. This fixture keeps its BASE64 frame payloads (harmless,
 * and avoids re-verifying the retired data-URL traps): each frame is an [event, base64(dataJson)]
 * tuple decoded via `atob()` at runtime, un-marked (no `hook-mock` synthetic tag) — fine for a
 * CLI-behavior test.
 *
 * First payload (contentless refusal): message_start → message_delta{stop_reason:refusal} → EOF.
 * It deliberately has zero content blocks, matching one recovered production sample, and omits the
 * optional upstream message_stop so the proxy's synthetic completion terminator is load-bearing.
 */
import { mockAnthropicMessage } from "~/lib/pipeline/hooks"

const REFUSAL: Array<[string, string]> = [
  [
    "message_start",
    "eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIsIm1lc3NhZ2UiOnsiaWQiOiJtX3JlZiIsInR5cGUiOiJtZXNzYWdlIiwicm9sZSI6ImFzc2lzdGFudCIsIm1vZGVsIjoiY2xhdWRlLXNvbm5ldC00LjYiLCJjb250ZW50IjpbXSwic3RvcF9yZWFzb24iOm51bGwsInN0b3Bfc2VxdWVuY2UiOm51bGwsInVzYWdlIjp7ImlucHV0X3Rva2VucyI6NSwib3V0cHV0X3Rva2VucyI6MH19fQ==",
  ],
  [
    "message_delta",
    "eyJ0eXBlIjoibWVzc2FnZV9kZWx0YSIsImRlbHRhIjp7InN0b3BfcmVhc29uIjoicmVmdXNhbCIsInN0b3BfZGV0YWlscyI6eyJ0eXBlIjoicmVmdXNhbCJ9LCJzdG9wX3NlcXVlbmNlIjpudWxsfSwidXNhZ2UiOnsib3V0cHV0X3Rva2VucyI6OH19",
  ],
]

export const hooks = {
  exchange: async (wire: { body?: unknown }) => {
    // A normal response is unlocked only by the explicit second user message. An automatic empty-turn
    // "continue" request does not contain this token and therefore keeps receiving the refusal.
    if (JSON.stringify(wire.body).includes("SECOND_USER_TURN_REQUEST")) {
      return mockAnthropicMessage("SECOND_TURN_OK_MARKER")
    }

    async function* gen() {
      for (const r of REFUSAL) yield { event: r[0], data: atob(r[1]) }
    }
    return { frames: gen(), headers: new Headers() }
  },
}

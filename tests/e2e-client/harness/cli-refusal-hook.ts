/**
 * CLI e2e (Tier 2) upstream hook: mock a thinking-only REFUSAL upstream response.
 *
 * The proxy's refusal recovery (S5) then transforms this per config:
 *   - refusal_sse_rewrite: end_turn + refusal_end_turn_text: ""  → thinking-only END_TURN (stall bait)
 *   - refusal_sse_rewrite: end_turn + non-empty text             → thinking + recovery text (no stall)
 *
 * Loaded via config `hooks.upstream_module` + `enabled: true` + `POST /api/hooks/reload`.
 *
 * THREE data-URL-loader traps this file is written to avoid (loader.ts transpiles + loads via a
 * `data:` URL; see reload-and-l2.it.test.ts:106 + the exp/cli-e2e-stall PoC bisect):
 *   1. NO imports — the `~/lib/pipeline/hooks` alias does NOT resolve in a data-URL module.
 *   2/3. NO `JSON.stringify`, and NO literal `{`/`}`/`"` payloads in the source — either makes
 *      Bun.Transpiler's data-URL load return `{__esModule, default}` and the named `exchange`
 *      export silently vanish ("exports none of: exchange"). So each frame's SSE `data` is stored
 *      BASE64-encoded (source has no JSON braces/quotes) and decoded via `atob()` at runtime. Frames
 *      are [event, base64(dataJson)] string tuples, un-marked (no `hook-mock` synthetic tag) — fine
 *      for a CLI-behavior test.
 *
 * Payloads (thinking-only refusal): message_start → thinking block (start/thinking_delta/
 * signature_delta/stop) → message_delta{stop_reason:refusal} → message_stop.
 */
const RAW: Array<[string, string]> = [
  [
    "message_start",
    "eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIsIm1lc3NhZ2UiOnsiaWQiOiJtX3JlZiIsInR5cGUiOiJtZXNzYWdlIiwicm9sZSI6ImFzc2lzdGFudCIsIm1vZGVsIjoiY2xhdWRlLXNvbm5ldC00LjYiLCJjb250ZW50IjpbXSwic3RvcF9yZWFzb24iOm51bGwsInN0b3Bfc2VxdWVuY2UiOm51bGwsInVzYWdlIjp7ImlucHV0X3Rva2VucyI6NSwib3V0cHV0X3Rva2VucyI6MH19fQ==",
  ],
  [
    "content_block_start",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjowLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0aGlua2luZyIsInRoaW5raW5nIjoiIiwic2lnbmF0dXJlIjoiIn19",
  ],
  [
    "content_block_delta",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjowLCJkZWx0YSI6eyJ0eXBlIjoidGhpbmtpbmdfZGVsdGEiLCJ0aGlua2luZyI6ImNvbnNpZGVyaW5nIHRoZSByZXF1ZXN0In19",
  ],
  [
    "content_block_delta",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjowLCJkZWx0YSI6eyJ0eXBlIjoic2lnbmF0dXJlX2RlbHRhIiwic2lnbmF0dXJlIjoiU0lHLUNMSS1SRUYifX0=",
  ],
  ["content_block_stop", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjB9"],
  [
    "message_delta",
    "eyJ0eXBlIjoibWVzc2FnZV9kZWx0YSIsImRlbHRhIjp7InN0b3BfcmVhc29uIjoicmVmdXNhbCIsInN0b3BfZGV0YWlscyI6eyJ0eXBlIjoicmVmdXNhbCJ9LCJzdG9wX3NlcXVlbmNlIjpudWxsfSwidXNhZ2UiOnsib3V0cHV0X3Rva2VucyI6OH19",
  ],
  ["message_stop", "eyJ0eXBlIjoibWVzc2FnZV9zdG9wIn0="],
]

export const hooks = {
  exchange: async () => {
    async function* gen() {
      for (const r of RAW) yield { event: r[0], data: atob(r[1]) }
    }
    return { frames: gen(), headers: new Headers() }
  },
}

/**
 * Upstream hook for the graceful-restart handover e2e (tests/e2e/handover.e2e.test.ts):
 * every exchange is answered locally (no real GHC call) so the test doesn't burn quota
 * and runs deterministically. A request whose body contains the literal substring
 * `SLOWMARKER` sleeps `250` ms before responding — that's the "in-flight slow request"
 * the test holds open across the handover window (old process must finish draining it,
 * not get interrupted by the new process's takeover).
 *
 * The response text embeds `process["pid"]` so the test can tell WHICH process (old vs
 * new) actually served a given request — the core "new connections go to the new
 * process" oracle.
 *
 * Loaded via config `hooks.upstream_module` + `enabled: true` + `POST /api/hooks/reload`
 * (see skill `upstream-hook-mocking`).
 *
 * TWO data-URL-loader traps this file is written to avoid (loader.ts transpiles + loads
 * via a `data:` URL — see tests/e2e-client/harness/cli-refusal-hook.ts's header comment
 * + exp/cli-e2e-stall/FINDINGS.md for the original bisect):
 *   1. NO imports — the `~/lib/pipeline/hooks` alias does not resolve in a data-URL module.
 *   2. NO dot-property-access anywhere in the source (`foo.bar`, `foo.bar()`) — empirically
 *      (this task's own bisect, 2026-07-16), Bun 1.3.14's `Bun.Transpiler` data-URL load
 *      silently degrades ANY member-expression dot access (not just object literals/
 *      JSON.stringify as previously documented) to `{__esModule, default}`, dropping the
 *      named `onExchange` export ("exports none of: onExchange"). Bracket-notation property
 *      access (`foo["bar"]`, `foo["bar"]()`) is unaffected and behaves identically at
 *      runtime — so every property/method access below uses bracket notation.
 *
 * Frames: message_start → text block (start/delta/stop) → message_delta{end_turn} →
 * message_stop. Minimal but wire-valid Anthropic SSE (mirrors toolkit.ts's
 * mockAnthropicMessage, hand-rolled here since the toolkit import doesn't resolve
 * in this data-URL-loaded, import-free file).
 */
const FRAMES: Array<[string, string]> = [
  [
    "message_start",
    "eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIsIm1lc3NhZ2UiOnsiaWQiOiJtX2hvIiwidHlwZSI6Im1lc3NhZ2UiLCJyb2xlIjoiYXNzaXN0YW50IiwibW9kZWwiOiJ4IiwiY29udGVudCI6W10sInN0b3BfcmVhc29uIjpudWxsLCJzdG9wX3NlcXVlbmNlIjpudWxsLCJ1c2FnZSI6eyJpbnB1dF90b2tlbnMiOjEsIm91dHB1dF90b2tlbnMiOjB9fX0=",
  ],
  ["content_block_start", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjowLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],
  ["content_block_delta", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjowLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiJfX1RFWFRfXyJ9fQ=="],
  ["content_block_stop", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjB9"],
  [
    "message_delta",
    "eyJ0eXBlIjoibWVzc2FnZV9kZWx0YSIsImRlbHRhIjp7InN0b3BfcmVhc29uIjoiZW5kX3R1cm4iLCJzdG9wX3NlcXVlbmNlIjpudWxsfSwidXNhZ2UiOnsib3V0cHV0X3Rva2VucyI6MX19",
  ],
  ["message_stop", "eyJ0eXBlIjoibWVzc2FnZV9zdG9wIn0="],
]

export const onExchange = async (wire: { body?: unknown }) => {
  const bodyStr = JSON["stringify"](wire["body"])
  const isSlow = bodyStr["indexOf"]("SLOWMARKER") >= 0
  if (isSlow) {
    // Held open across the handover window — long enough that the test's spawned
    // "new" process has definitely bound + signaled by the time this resolves,
    // short enough the test doesn't drag (empirically ~250ms is comfortably above
    // reusePort-bind + SIGUSR2 delivery latency, see loader-check probe).
    await Bun["sleep"](1500)
  }
  const marker = "served-by-pid-" + String(process["pid"])
  async function* gen() {
    for (const r of FRAMES) {
      const decoded = atob(r[1])["replace"]("__TEXT__", marker)
      yield { event: r[0], data: decoded }
    }
  }
  return { frames: gen(), headers: new Headers() }
}

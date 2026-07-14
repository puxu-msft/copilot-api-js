/**
 * CLI e2e (Tier 2) upstream hook: mock the block-level buffered-retry "anchor-coexist" wire
 * (spec 2026-07-11-block-level-buffered-retry.md §4.3 target shape) — TEXT-ONLY real blocks.
 *
 * Complements the Tier-1 SDK test (anthropic-buffered.it.test.ts / P1 criterion ①, which proved
 * the real `@anthropic-ai/sdk` accumulator ACCEPTS this wire). The SDK's accumulator is a
 * necessary-but-not-sufficient oracle: the real Claude Code CLI runs a SEPARATE, possibly-stricter
 * agent-loop state machine on top of the SDK. This hook feeds that real CLI the identical wire
 * shape so the CLI itself becomes the oracle for "does the agent loop assemble this as ONE
 * complete turn, or does it stall/misparse?" (see anthropic-cli.e2e.test.ts for the assertions).
 *
 * Wire (mirrors exp/block-level-anchor-coexist/fixture.ts, but text-only — no tool_use, so the
 * turn can't legitimately end at num_turns>1 for an UNRELATED reason like "the agent must now
 * execute a tool"; text-only isolates the anchor-coexistence property itself):
 *   message_start
 *   → content_block_start@0 (empty-text ANCHOR — opens, stays open the WHOLE stream)
 *   → content_block_delta@0 (anchor's own first empty text_delta — a keepalive)
 *   → content_block_start@1 … delta@1 "Hello " … content_block_stop@1   (real text block #1)
 *   → content_block_delta@0 (INTER-BLOCK keepalive on the still-open anchor — coexistence: @0
 *     and the just-closed @1 both existed at once)
 *   → content_block_start@2 … delta@2 "COEXIST_OK_MARKER" … content_block_stop@2 (real block #2)
 *   → content_block_stop@0   (anchor close-off — ONLY at the terminal, after both real blocks)
 *   → message_delta{stop_reason:end_turn} → message_stop
 *
 * The assembled text a client should see: "Hello COEXIST_OK_MARKER" (anchor@0's own empty text
 * contributes nothing).
 *
 * Loaded via config `hooks.upstream_module` + `enabled: true` + `POST /api/hooks/reload`.
 *
 * THREE data-URL-loader traps this file is written to avoid (loader.ts transpiles + loads via a
 * `data:` URL; see cli-refusal-hook.ts's comment + exp/cli-e2e-stall PoC bisect):
 *   1. NO imports — the `~/lib/pipeline/hooks` alias does NOT resolve in a data-URL module.
 *   2/3. NO `JSON.stringify`, and NO literal `{`/`}`/`"` payloads in the source — either makes
 *      Bun.Transpiler's data-URL load return `{__esModule, default}` and the named `onExchange`
 *      export silently vanish ("exports none of: onExchange"). So each frame's SSE `data` is stored
 *      BASE64-encoded (source has no JSON braces/quotes) and decoded via `atob()` at runtime. Frames
 *      are [event, base64(dataJson)] string tuples, un-marked (no `hook-mock` synthetic tag) — fine
 *      for a CLI-behavior test.
 */
const RAW: Array<[string, string]> = [
  [
    "message_start",
    "eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIsIm1lc3NhZ2UiOnsiaWQiOiJtX2NvZXgiLCJ0eXBlIjoibWVzc2FnZSIsInJvbGUiOiJhc3Npc3RhbnQiLCJtb2RlbCI6ImNsYXVkZS1zb25uZXQtNC42IiwiY29udGVudCI6W10sInN0b3BfcmVhc29uIjpudWxsLCJzdG9wX3NlcXVlbmNlIjpudWxsLCJ1c2FnZSI6eyJpbnB1dF90b2tlbnMiOjUsIm91dHB1dF90b2tlbnMiOjB9fX0=",
  ],
  [
    "content_block_start",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjowLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ==",
  ],
  [
    "content_block_delta",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjowLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiIifX0=",
  ],
  [
    "content_block_start",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjoxLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ==",
  ],
  [
    "content_block_delta",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjoxLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiJIZWxsbyAifX0=",
  ],
  [
    "content_block_stop",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjF9",
  ],
  [
    "content_block_delta",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjowLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiIifX0=",
  ],
  [
    "content_block_start",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjoyLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ==",
  ],
  [
    "content_block_delta",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjoyLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiJDT0VYSVNUX09LX01BUktFUiJ9fQ==",
  ],
  [
    "content_block_stop",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjJ9",
  ],
  [
    "content_block_stop",
    "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjB9",
  ],
  [
    "message_delta",
    "eyJ0eXBlIjoibWVzc2FnZV9kZWx0YSIsImRlbHRhIjp7InN0b3BfcmVhc29uIjoiZW5kX3R1cm4iLCJzdG9wX3NlcXVlbmNlIjpudWxsfSwidXNhZ2UiOnsib3V0cHV0X3Rva2VucyI6MjB9fQ==",
  ],
  ["message_stop", "eyJ0eXBlIjoibWVzc2FnZV9zdG9wIn0="],
]

export const onExchange = async () => {
  async function* gen() {
    for (const r of RAW) yield { event: r[0], data: atob(r[1]) }
  }
  return { frames: gen(), headers: new Headers() }
}

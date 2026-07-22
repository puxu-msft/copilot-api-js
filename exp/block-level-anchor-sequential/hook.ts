/**
 * PoC hook (exp/block-level-anchor-sequential): SEQUENTIAL-anchor wire — the CLI-safe alternative to
 * the anchor-COEXIST wire (spec 2026-07-11 §4.5 备选). KEY invariant: at no point are two content
 * blocks open at once. The keepalive anchor opens+emits+CLOSES before any real block opens; each
 * inter-block gap gets its OWN fresh empty-text anchor block (open+delta+close). This tests whether
 * the real claude CLI agent-loop accepts a standard sequential block stream with empty-text keepalive
 * blocks interspersed — WITHOUT the coexisting-open-index shape that made the CLI stall.
 *
 * Assembled text a client should see: "Hello SEQUENTIAL_OK_MARKER".
 * base64 frames (data-URL loader traps: no imports / no JSON braces/quotes in source).
 */
const RAW: Array<[string, string]> = [
  ["message_start", "eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIsIm1lc3NhZ2UiOnsiaWQiOiJtX3NlcSIsInR5cGUiOiJtZXNzYWdlIiwicm9sZSI6ImFzc2lzdGFudCIsIm1vZGVsIjoiY2xhdWRlLXNvbm5ldC00LjYiLCJjb250ZW50IjpbXSwic3RvcF9yZWFzb24iOm51bGwsInN0b3Bfc2VxdWVuY2UiOm51bGwsInVzYWdlIjp7ImlucHV0X3Rva2VucyI6NSwib3V0cHV0X3Rva2VucyI6MH19fQ=="],
  ["content_block_start", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjowLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],
  ["content_block_delta", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjowLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiIifX0="],
  ["content_block_stop", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjB9"],
  ["content_block_start", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjoxLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],
  ["content_block_delta", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjoxLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiJIZWxsbyAifX0="],
  ["content_block_stop", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjF9"],
  ["content_block_start", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjoyLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],
  ["content_block_delta", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjoyLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiIifX0="],
  ["content_block_stop", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjJ9"],
  ["content_block_start", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjozLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],
  ["content_block_delta", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjozLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiJTRVFVRU5USUFMX09LX01BUktFUiJ9fQ=="],
  ["content_block_stop", "eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjN9"],
  ["message_delta", "eyJ0eXBlIjoibWVzc2FnZV9kZWx0YSIsImRlbHRhIjp7InN0b3BfcmVhc29uIjoiZW5kX3R1cm4iLCJzdG9wX3NlcXVlbmNlIjpudWxsfSwidXNhZ2UiOnsib3V0cHV0X3Rva2VucyI6MjB9fQ=="],
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

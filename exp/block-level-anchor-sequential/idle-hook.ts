/** G2 idle hook: sequential anchor with a >310s inter-block gap kept alive by text_delta@2 every 15s.
 * Tests whether the sequential-anchor gap keepalive resets Claude Code CLI 300s no-real-content deadline. */
const PRE: Array<[string,string]> = [["message_start","eyJ0eXBlIjoibWVzc2FnZV9zdGFydCIsIm1lc3NhZ2UiOnsiaWQiOiJtX2lkbGUiLCJ0eXBlIjoibWVzc2FnZSIsInJvbGUiOiJhc3Npc3RhbnQiLCJtb2RlbCI6ImNsYXVkZS1zb25uZXQtNC42IiwiY29udGVudCI6W10sInN0b3BfcmVhc29uIjpudWxsLCJzdG9wX3NlcXVlbmNlIjpudWxsLCJ1c2FnZSI6eyJpbnB1dF90b2tlbnMiOjUsIm91dHB1dF90b2tlbnMiOjB9fX0="],["content_block_start","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjowLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],["content_block_delta","eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjowLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiIifX0="],["content_block_stop","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjB9"],["content_block_start","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjoxLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],["content_block_delta","eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjoxLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiJCZWZvcmUgaWRsZS4gIn19"],["content_block_stop","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjF9"],["content_block_start","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjoyLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="]]
const GAP_KEEPALIVE = "eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjoyLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiIifX0="
const POST: Array<[string,string]> = [["content_block_stop","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjJ9"],["content_block_start","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdGFydCIsImluZGV4IjozLCJjb250ZW50X2Jsb2NrIjp7InR5cGUiOiJ0ZXh0IiwidGV4dCI6IiJ9fQ=="],["content_block_delta","eyJ0eXBlIjoiY29udGVudF9ibG9ja19kZWx0YSIsImluZGV4IjozLCJkZWx0YSI6eyJ0eXBlIjoidGV4dF9kZWx0YSIsInRleHQiOiJJRExFX1NVUlZJVkVEX01BUktFUiJ9fQ=="],["content_block_stop","eyJ0eXBlIjoiY29udGVudF9ibG9ja19zdG9wIiwiaW5kZXgiOjN9"],["message_delta","eyJ0eXBlIjoibWVzc2FnZV9kZWx0YSIsImRlbHRhIjp7InN0b3BfcmVhc29uIjoiZW5kX3R1cm4iLCJzdG9wX3NlcXVlbmNlIjpudWxsfSwidXNhZ2UiOnsib3V0cHV0X3Rva2VucyI6MjB9fQ=="],["message_stop","eyJ0eXBlIjoibWVzc2FnZV9zdG9wIn0="]]
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms))
export const hooks = {
  exchange: async () => {
    async function* gen() {
      for (const r of PRE) yield { event: r[0], data: atob(r[1]) }
      // >310s gap: 21 keepalives x 15s = 315s
      for (let i=0;i<21;i++){ await sleep(15000); yield { event: "content_block_delta", data: atob(GAP_KEEPALIVE) } }
      for (const r of POST) yield { event: r[0], data: atob(r[1]) }
    }
    return { frames: gen(), headers: new Headers() }
  },
}

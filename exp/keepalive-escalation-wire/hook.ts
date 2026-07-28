/**
 * 上游 mock：开一个真实 text 块 → 静默 12s → 收尾。
 *
 * 用来回答一个问题：**我方管线到底会不会把「升级期的空 content_block_delta」送上客户端 wire？**
 * G2 那次实测（21 帧空 delta 一个都没到 CC）留下的丢失层从未定位；而 2026-07-27 落地的
 * keepalive 升级（`stream_keepalive_escalate_sec`）正是靠这条帧活命——若管线自己吞掉它，
 * 那个修复就是无效的。把升级阈值压到秒级即可在 15 秒内得到判据。
 */
const b64 = (o: unknown): string => btoa(JSON.stringify(o))
const PRE: Array<[string, string]> = [
  ["message_start", b64({ type: "message_start", message: { id: "msg_probe", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })],
  ["content_block_start", b64({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })],
  ["content_block_delta", b64({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "before-silence " } })],
]
const POST: Array<[string, string]> = [
  ["content_block_delta", b64({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SURVIVED" } })],
  ["content_block_stop", b64({ type: "content_block_stop", index: 0 })],
  ["message_delta", b64({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } })],
  ["message_stop", b64({ type: "message_stop" })],
]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const hooks = {
  exchange: async () => {
    async function* gen() {
      for (const [event, data] of PRE) yield { event, data: atob(data) }
      await sleep(12_000) // 块内静默：升级阈值 3s 会在这期间触发
      for (const [event, data] of POST) yield { event, data: atob(data) }
    }
    return { frames: gen(), headers: new Headers() }
  },
}

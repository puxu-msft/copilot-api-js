const encode = (value: unknown): string => btoa(JSON.stringify(value))

const FRAMES: ReadonlyArray<readonly [event: string, data: string]> = [
  [
    "message_start",
    encode({
      type: "message_start",
      message: {
        id: "msg_allocator_baseline",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
  ],
  ["content_block_start", encode({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })],
  ["content_block_delta", encode({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "allocator baseline" } })],
  ["content_block_stop", encode({ type: "content_block_stop", index: 0 })],
  ["message_delta", encode({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })],
  ["message_stop", encode({ type: "message_stop" })],
]

export const hooks = {
  exchange: async () => {
    async function* frames() {
      for (const [event, data] of FRAMES) yield { event, data: atob(data) }
    }
    return { frames: frames(), headers: new Headers() }
  },
}

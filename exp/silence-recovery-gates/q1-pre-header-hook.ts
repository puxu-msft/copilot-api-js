import { mockAnthropicMessage } from "~/lib/pipeline/hooks"

/** Deliberately holds the proxy's upstream open before it has any response headers. */
export const hooks = {
  exchange: async () => {
    const delayMs = Number.parseInt(process.env.Q1_PRE_HEADER_DELAY_MS ?? "0", 10)
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error(`invalid Q1_PRE_HEADER_DELAY_MS: ${process.env.Q1_PRE_HEADER_DELAY_MS}`)
    await Bun.sleep(delayMs)
    return mockAnthropicMessage(`Q1_PRE_HEADER_OK after ${delayMs}ms`)
  },
}

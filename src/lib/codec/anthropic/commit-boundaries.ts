import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * Anthropic 的 block 级 commit 边界（spec §3.1）：一个内容块完成（content_block_stop）、
 * 或流终止（message_stop）、或上游终态 error 帧（spec §5.3 M1——H2 终态必是 commit 边界）。
 * 纯读帧类型；非 JSON / 无 data（keepalive/ping）非边界。
 */
export function anthropicCommitBoundaries(frame: ClientFrame): boolean {
  if (frame.data === undefined) return false
  try {
    const t = (JSON.parse(frame.data) as { type?: string }).type
    return t === "content_block_stop" || t === "message_stop" || t === "error"
  } catch {
    return false
  }
}

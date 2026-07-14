import type { ClientFrame } from "~/lib/pipeline/types"

/**
 * Anthropic 的 block 级 commit 边界（spec §3.1）：一个内容块完成（content_block_stop），
 * 或上游终态 error 帧（spec §5.3 M1——H2 终态必是 commit 边界）。
 *
 * `message_stop` **不是** mid-stream commit 边界（spec §4.3）。若把它当边界，响应尾部
 * （`message_delta` + `message_stop`）会在循环内提前 flush 到 wire，而 anchor 的收口
 * `content_block_stop@0` 由终态 drain-flush（isTerminalFlush=true）emit，于是收口会**晚于**
 * `message_stop` 到达客户端，破坏 §4.3 的终态顺序（anchor 收口须先于 tail）。因此让 tail
 * 保持 BUFFERED：流终止改由 driver 的 `sawMessageStop`（独立终态信号，非本谓词）判定，终态
 * drain-flush 先 emit anchor 收口、再写出缓冲的 `message_delta` / `message_stop`。
 *
 * 纯读帧类型；非 JSON / 无 data（keepalive/ping）非边界。
 */
export function anthropicCommitBoundaries(frame: ClientFrame): boolean {
  if (frame.data === undefined) return false
  try {
    const t = (JSON.parse(frame.data) as { type?: string }).type
    return t === "content_block_stop" || t === "error"
  } catch {
    return false
  }
}

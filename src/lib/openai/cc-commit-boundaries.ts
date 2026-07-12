import type { ClientFrame } from "~/lib/pipeline/types"

export function ccCommitBoundaries(frame: ClientFrame): boolean {
  if (frame.data === undefined || frame.data === "[DONE]") return false
  try {
    const p = JSON.parse(frame.data) as { error?: unknown }
    return p.error !== undefined // 上游终态 error 帧是 commit 边界（spec §5.3 M1）；deltas 非边界
  } catch {
    return false
  }
}

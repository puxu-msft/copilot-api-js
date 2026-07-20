import type { ClientFrame } from "~/lib/pipeline/types"

export function ccCommitBoundaries(frame: ClientFrame): boolean {
  if (frame.data === undefined || frame.data === "[DONE]") return false
  try {
    const p = JSON.parse(frame.data) as { error?: unknown }
    // `!== undefined` (not the accumulator's truthy `if (errorField)`, see stream-accumulator.ts):
    // the accumulator's truthy check guards a hypothetical `{"error":null}` frame from a
    // null-deref when it destructures `errorField.message`/`.type`; this boundary check never
    // dereferences the field, only tests its presence — GHC's real error frames are always
    // `{"error":{message,type}}` (never `{"error":null}`), so the divergence is unreachable in
    // practice. Do NOT unify to `!== undefined` there — it would reintroduce that null-deref risk.
    return p.error !== undefined // 上游终态 error 帧是 commit 边界（spec §5.3 M1）；deltas 非边界
  } catch {
    return false
  }
}

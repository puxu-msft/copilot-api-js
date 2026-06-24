import type { MessageContent } from "@/lib/content/types"
import type { RewriteMark } from "@/lib/diff/block-diff"

import { diffMessageList } from "@/lib/diff/block-diff"

/**
 * Per-message rewrite marks for the inbound→effective transform.
 *
 * Walks the aligned `diffMessageList` rows with a dual cursor so each mark lands
 * on the right message index in EACH leg's own order:
 *   - `same`     → both legs advance, unmarked
 *   - `modified` → both legs advance, marked `"modified"`
 *   - `added`    → only the effective leg advances, marked `"added"`
 *   - `removed`  → only the inbound leg advances, marked `"removed"`
 *
 * So `inboundMarks[i]` aligns with `inbound[i]` and `effectiveMarks[i]` with
 * `effective[i]` (each result length === its leg's message count). Returns `{}`
 * when either side is absent (no diff to derive). The wire leg is a further
 * transform and is intentionally not covered here.
 */
export function deriveRewriteMarks(
  inbound: Array<MessageContent> | undefined,
  effective: Array<MessageContent> | undefined,
): { inboundMarks?: Array<RewriteMark | undefined>; effectiveMarks?: Array<RewriteMark | undefined> } {
  if (inbound === undefined || effective === undefined) return {}
  const rows = diffMessageList(inbound, effective)
  const inboundMarks: Array<RewriteMark | undefined> = []
  const effectiveMarks: Array<RewriteMark | undefined> = []
  let li = 0
  let ri = 0
  for (const row of rows) {
    switch (row.kind) {
      case "same": {
        inboundMarks[li++] = undefined
        effectiveMarks[ri++] = undefined
        break
      }
      case "modified": {
        inboundMarks[li++] = "modified"
        effectiveMarks[ri++] = "modified"
        break
      }
      case "added": {
        effectiveMarks[ri++] = "added"
        break
      }
      default: {
        inboundMarks[li++] = "removed"
      }
    }
  }
  return { inboundMarks, effectiveMarks }
}

/**
 * v4 pipeline — the `errorFrameCanonical` Anthropic response rewrite (S5, order 50 = runs FIRST).
 *
 * A raw upstream `event:error` frame (H2 — a terminal upstream decision delivered mid-stream) is,
 * absent this rewrite, forwarded VERBATIM to the client (`stream-accumulator.ts` only RECORDS it into
 * `acc.streamError` for the handler's H2 bookkeeping; nothing reshapes it). Non-Anthropic upstreams
 * emit non-canonical error bodies, so the client SDK cannot reliably branch on `error.type`. This
 * rewrite reshapes such a frame — BEFORE forwarding — into a canonical Anthropic `event:error`
 * envelope (G-3: the single canonical constructor is `error-shaping.ts`'s `buildCanonicalErrorFrameFromRaw`).
 *
 * Two-axis endpoint gate (HIGH-2): `ANTHROPIC_RESPONSE_REWRITES` is folded into the union
 * `ALL_RESPONSE_REWRITES`, which the gemini / chat-completions / responses drivers ALSO receive. Only
 * the `targetEndpoint === /v1/messages` legs process the Anthropic upstream wire, so this rewrite gates
 * on `targetEndpoint` (NOT `clientFormat`) exactly like the five sibling adapters' `ANTHROPIC(env)`
 * predicate (`response-rewrite-adapters.ts`). The inline predicate mirrors that private helper rather
 * than exporting a shared const — same "hand-built small predicate, no cross-file export" convention the
 * sibling files (`thinking-quarantine`, `reverse-anthropic-rewrite`, `request-rewrite-adapter`) already
 * follow.
 *
 * Ordering (order 50, ahead of `recoverRefusal`'s 400): `recoverRefusal` in `error` mode SYNTHESIZES a
 * canonical `event:error` frame. `passThrough` (driver.ts) runs strictly forward, so a rewrite at order
 * 50 only ever sees UPSTREAM-ORIGINAL frames — the refusal-synthesized canonical frame flows to LATER
 * rewrites only and can never reach this one for a wrongful second reshape.
 */

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FrameAction,
  ResponseRewrite,
  RewriteState,
} from "~/lib/pipeline/rewrite-registry"
import type { UpstreamFrame } from "~/lib/pipeline/types"

import { buildCanonicalErrorFrameFromRaw } from "~/lib/anthropic/error-shaping"
import { ENDPOINT } from "~/lib/models/endpoint"
import { tagFrameSynthetic } from "~/lib/pipeline/frame-origin"
import { RESPONSE_REWRITE_ORDER } from "~/lib/pipeline/rewrite-registry"
import { state } from "~/lib/state"

export const errorFrameCanonicalRewrite: ResponseRewrite = {
  name: "errorFrameCanonical",
  order: RESPONSE_REWRITE_ORDER.errorFrameCanonical,
  // HIGH-2 two-axis gate: MESSAGES leg only (never the gemini/cc/responses legs sharing
  // ALL_RESPONSE_REWRITES) AND the master error-shaping toggle on (off = byte-identical passthrough,
  // the golden lock — the frame is forwarded verbatim as today).
  appliesTo: (env: RequestEnvelope): boolean => env.targetEndpoint === ENDPOINT.MESSAGES && state.errorShapingEnabled,
  transform: (frame: UpstreamFrame, _state: RewriteState): FrameAction => {
    if (frame.event !== "error") return { kind: "emit", frames: [frame] }
    // history/types.ts SyntheticOriginKind doc (Phase 3 wiring): this reshaped frame REPLACES the
    // upstream terminator on the FORWARDED track, so it must be tagged distinguishable from genuine
    // upstream traffic (richest-data-flow §3) — mirrors `recover-refusal.ts`'s error-mode frame tagging.
    return { kind: "emit", frames: [tagFrameSynthetic(buildCanonicalErrorFrameFromRaw(frame), "error-shaping-canonical")] }
  },
}

/**
 * v4 pipeline — OpenAI Responses response-rewrite adapters (Stage A A.C).
 *
 * Wraps the stateful `fixStreamEventIds` correction (GHC Responses returns
 * inconsistent item IDs between `response.output_item.added` and `.done`; clients
 * like `@ai-sdk/openai` validate ID continuity — DESIGN.md `fixResponsesStreamIds`)
 * as a `ResponseRewrite` so the driver's S5 chain drives it. This replaces the
 * per-frame closures duplicated in BOTH transports' forward paths
 * (`handler-v4.ts` `forwardFrame` + `ws.ts` `forwardWsFrame`) — registering once
 * makes HTTP + WS share the SAME stateful rewrite instance (RFC §4.C).
 *
 * **Why only fixIds (not tool-name restore):** the driver applies S5 rewrites
 * BEFORE `codec.renderResponse` (S6). For DIRECT Responses `renderResponse` is
 * identity, so an S5 rewrite sees Responses-protocol frames. But the FALLBACK
 * (`/chat/completions`) `renderResponse` translates CC→Responses, so its S5 frames
 * are CC — a Responses-shaped rewrite there would silently no-op. `fixStreamEventIds`
 * is DIRECT-only (gated by `appliesTo`), so it always sees Responses frames in S5
 * and migrates cleanly. Tool-name restore applies to direct AND fallback and must
 * run on the RENDERED Responses frames (post-S6), so it stays handler-side as the
 * shared `restoreResponsesStreamFrameToolNames` helper (a forwarded-only transform,
 * applied after accumulation — moving it to S5 would break fallback restoration).
 * A post-render rewrite stage is Stage B (driver-owned writeout), out of scope here.
 */

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  FrameAction,
  ResponseRewrite,
  RewriteState,
} from "~/lib/pipeline/rewrite-registry"

import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  createStreamIdTracker,
  fixStreamEventIds,
  type StreamIdTracker,
} from "~/lib/openai/stream-id-sync"
import {
  //
  freshFrames,
  preserveFrame,
} from "~/lib/pipeline/rewrite-registry"
import { state } from "~/lib/state"

const RESPONSES = (env: RequestEnvelope): boolean => env.clientFormat === "openai-responses"

interface FixStreamIdsState extends RewriteState {
  tracker: StreamIdTracker
}

/**
 * fix-stream-ids (DIRECT only, stateful cross-frame). Patches `.done` / arguments
 * events to reuse the canonical `.added` item ID (tracked in `state.tracker`).
 * `appliesTo` mirrors the legacy gate `!viaFallback && state.fixResponsesStreamIds`
 * (`viaFallback` = `targetEndpoint === CHAT_COMPLETIONS`); the fallback emits
 * internally-consistent IDs and never needed fixing.
 */
const fixStreamIdsRewrite: ResponseRewrite = {
  name: "responses-fix-stream-ids",
  order: 100,
  appliesTo: (env) => RESPONSES(env) && env.targetEndpoint === ENDPOINT.RESPONSES && state.fixResponsesStreamIds,
  createState: (): FixStreamIdsState => ({ tracker: createStreamIdTracker() }),
  transform: (frame, st): FrameAction => {
    const fixed = fixStreamEventIds(frame.data ?? "", frame.event, (st as FixStreamIdsState).tracker)
    return fixed === frame.data ? preserveFrame(frame) : freshFrames({ ...frame, data: fixed })
  },
}

/**
 * The Responses streaming response rewrites, in registry form. Passed to the
 * driver via `deps.responseRewrites` by BOTH the HTTP handler and the WS handler,
 * so the two transports share the same S5 chain (the `appliesTo` format guard
 * keeps these inert for non-Responses formats sharing the module registry).
 */
export const RESPONSES_RESPONSE_REWRITES: ReadonlyArray<ResponseRewrite> = [fixStreamIdsRewrite]

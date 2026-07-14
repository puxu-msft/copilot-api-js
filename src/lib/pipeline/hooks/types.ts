import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

/**
 * Symmetric four-point hook surface (RFC 2026-07-14-symmetric-four-point-hooks).
 *
 * Grouped by two axes:
 *   - `client | upstream` = the body/frame FORMAT the hook sees (client-native vs upstream/target).
 *   - `inbound | outbound` = direction relative to the proxy (flowing IN vs flowing OUT).
 *
 * `exchange` is the non-directional boundary interceptor (wraps `transport.send`, straddles
 * upstream.outbound → upstream.inbound). All leaves optional; an omitted leaf = that boundary
 * passes through verbatim. A rewrite hook returning `undefined` = observe (pass through after
 * side effects). `on*` prefixes are intentionally dropped at the hook-export layer.
 *
 * Migration (v3): `onRequest → upstream.outbound`, `onExchange → exchange`,
 * `rewriteUpstreamFrame → upstream.inbound`. `client.inbound` (client-native request rewrite,
 * one-shot) lands in RFC Phase 4; `client.outbound` (per-client-frame response rewrite) is
 * declared/named but its per-frame wiring is gated on sink-egress unification (RFC Phase 6).
 */
export interface UpstreamHook {
  /** client-native format (client-original request in, response out). Phase 4 adds `inbound`. */
  client?: {
    // inbound?: (env: RequestEnvelope) => RequestEnvelope | undefined   // RFC Phase 4
    // outbound?: ...                                                    // RFC Phase 6 (gated)
  }
  /** upstream/target format. */
  upstream?: {
    /** Per upstream response frame (was `rewriteUpstreamFrame`). Return undefined to drop the frame. */
    inbound?: (frame: UpstreamFrame, env: RequestEnvelope) => UpstreamFrame | undefined
    /** Upstream-bound request, post-sanitize/pre-exchange, one-shot (was `onRequest`). */
    outbound?: (env: RequestEnvelope) => RequestEnvelope | undefined
  }
  /** Boundary interceptor wrapping the whole upstream call, per attempt (was `onExchange`). */
  exchange?: (wire: PreparedRequest, env: RequestEnvelope, next: () => Promise<UpstreamStream>) => Promise<UpstreamStream>
}

export interface UpstreamHookState {
  hook: UpstreamHook
  module: string
  loadedAt: number
  version: string // `${loadedAt}-${monotonic seq}` — unique + strictly increasing across reloads, even within the same millisecond
  exports: Array<string> // leaf mount-point paths actually exported, e.g. ["exchange", "upstream.inbound"]
  lastReloadError?: string
}

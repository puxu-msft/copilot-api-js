import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  ClientFrame,
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
  /** client-native format (client-original request in, response out). */
  client?: {
    /**
     * Client-native inbound request rewrite, ONE-SHOT, at driver S1a→S1b (after parse, before
     * translate/sanitize) — the ONLY point where every format's body is client-native (RFC §3). The
     * driver hands the hook a defensive body clone and, on `undefined`, keeps the original parsed env
     * (immutable-return + defense-in-depth: §3.5). Return a new env to rewrite the request.
     */
    inbound?: (env: RequestEnvelope) => RequestEnvelope | undefined
    /**
     * Per rendered client frame (client-protocol format), at S6 render→yield, before the sink write.
     * Return a new frame to rewrite it, or `undefined` to drop it. COVERAGE (RFC §5 / spec §9): sees
     * the frames produced by `codec.renderResponse` — NOT sink-layer synthetic/heartbeat/anchor frames
     * (which don't flow through the render yield point; a full sink-egress unification to cover those
     * is a deferred-backlog enhancement). A rewrite inherits the same forwarded-track provenance-mark
     * coverage gap as `upstream.inbound` (§9).
     */
    outbound?: (frame: ClientFrame, env: RequestEnvelope) => ClientFrame | undefined
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

import {
  //
  resolveBufferedCaps,
  state,
} from "~/lib/state"

/**
 * Resolve buffered-retry mode + the forced client keepalive interval for the
 * Responses (SSE/HTTP) streaming path. Mirrors Anthropic's
 * `resolveBufferedAndHeartbeat` (`src/routes/messages/handler-v4.ts`):
 *
 * - `buffered`: `state.responsesBufferedRetry` — Codex mid-stream auto-retry is
 *   opt-in (default OFF). When on, Responses adopts the driver's
 *   `runResponseBufferedSink`, buffering every rendered frame until a terminal
 *   event and only committing on a clean drain (transport-close/truncation
 *   re-runs the exchange up to the retry cap).
 * - `heartbeatSec`: the buffered path withholds ALL real frames until commit, so
 *   long upstream silence would otherwise trip Codex's 300s idle deadline. It
 *   therefore FORCES a keepalive interval (`streamKeepalivePingSec` when the
 *   operator set it, else `resolveBufferedCaps("responses").heartbeatSec`). The
 *   live path heartbeats only when the operator set `streamKeepalivePingSec`.
 */
export function resolveResponsesBufferedAndHeartbeat(): { buffered: boolean; heartbeatSec: number } {
  const buffered = state.responsesBufferedRetry
  const forcedHeartbeatSec = state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : resolveBufferedCaps("responses").heartbeatSec
  const heartbeatSec = buffered ? forcedHeartbeatSec : state.streamKeepalivePingSec
  return { buffered, heartbeatSec }
}

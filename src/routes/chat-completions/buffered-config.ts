import { resolveBufferedCaps } from "~/lib/config/model-overrides"
import { state } from "~/lib/state"

/**
 * Resolve buffered-retry mode + the forced client keepalive interval for the
 * Chat Completions (SSE/HTTP) streaming path. Mirrors the Responses
 * `resolveResponsesBufferedAndHeartbeat`:
 *
 * - `buffered`: `state.chatCompletionsBufferedRetry` — Chat Completions
 *   mid-stream auto-retry is opt-in (default OFF). When on, the driver's
 *   `runBufferedSink` buffers every rendered frame until a terminal event
 *   and only commits on a clean drain (transport-close/truncation re-runs
 *   the exchange up to the retry cap).
 * - `heartbeatSec`: the buffered path withholds ALL real frames until commit,
 *   so long upstream silence would otherwise trip GHC's idle deadline. It
 *   therefore FORCES a keepalive interval (`streamKeepalivePingSec` when the
 *   operator set it, else `resolveBufferedCaps("chat_completions").heartbeatSec`).
 *   The live path ALSO heartbeats whenever `streamKeepalivePingSec > 0` — the
 *   bundled default is 20 (`state.ts`), so CC live streaming emits a keepalive
 *   BY DEFAULT too, matching the Anthropic/Responses live paths. Buffered mode
 *   is distinguished only in that it FORCES the interval on even when the
 *   operator set `streamKeepalivePingSec` to 0 (disabled); it never forwards a
 *   0 to a buffered stream.
 */
export function resolveCcBufferedAndHeartbeat(): { buffered: boolean; heartbeatSec: number } {
  const buffered = state.chatCompletionsBufferedRetry
  const caps = resolveBufferedCaps("chat_completions")
  const forced = state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : caps.heartbeatSec
  return { buffered, heartbeatSec: buffered ? forced : state.streamKeepalivePingSec }
}

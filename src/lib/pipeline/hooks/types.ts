import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

export interface UpstreamHook {
  onRequest?: (env: RequestEnvelope) => RequestEnvelope | undefined
  onExchange?: (wire: PreparedRequest, env: RequestEnvelope, next: () => Promise<UpstreamStream>) => Promise<UpstreamStream>
  rewriteUpstreamFrame?: (frame: UpstreamFrame, env: RequestEnvelope) => UpstreamFrame | undefined
}

export interface UpstreamHookState {
  hook: UpstreamHook
  module: string
  loadedAt: number
  version: string // `${loadedAt}-${monotonic seq}` — unique + strictly increasing across reloads, even within the same millisecond
  exports: Array<string> // ["onExchange", ...] actual mount-point names exported
  lastReloadError?: string
}

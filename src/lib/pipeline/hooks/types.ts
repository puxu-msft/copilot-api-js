import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PreparedRequest,
  UpstreamFrame,
  UpstreamStream,
} from "~/lib/pipeline/types"

export interface UpstreamHook {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- spec §6: returning void = passthrough (ergonomic no-return hook body)
  onRequest?: (env: RequestEnvelope) => RequestEnvelope | void
  onExchange?: (wire: PreparedRequest, env: RequestEnvelope, next: () => Promise<UpstreamStream>) => Promise<UpstreamStream>
  rewriteUpstreamFrame?: (frame: UpstreamFrame, env: RequestEnvelope) => UpstreamFrame | undefined
}

export interface UpstreamHookState {
  hook: UpstreamHook
  module: string
  loadedAt: number
  version: string // String(loadedAt)
  exports: Array<string> // ["onExchange", ...] actual mount-point names exported
  lastReloadError?: string
}

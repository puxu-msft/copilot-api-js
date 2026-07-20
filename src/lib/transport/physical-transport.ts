import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  PhysicalTransport,
  PhysicalTransportResponse,
  PreparedRequest,
  Transport,
  TransportDispatchOptions,
  UpstreamDispatchLifecycle,
  UpstreamStream,
} from "~/lib/pipeline/types"

import { UpstreamTransportFallbackError } from "./fallback"

function settledLifecycle(): UpstreamDispatchLifecycle {
  const quiesced = Promise.resolve()
  return {
    cancel() {},
    async dispose() {
      return { quiesced: true, connectionReusable: false }
    },
    quiesced,
  }
}

/**
 * Adapt the migration-era `send()` shape to the mandatory physical-dispatch union.
 * Real successful transports MUST provide lifecycle; hook/mock streams remain on `Transport`.
 */
export function physicalTransportFromSend(send: Transport["send"]): PhysicalTransport {
  return {
    async open(wire: PreparedRequest, env: RequestEnvelope, options?: TransportDispatchOptions): Promise<PhysicalTransportResponse> {
      try {
        const upstream = await send(wire, env, options)
        const lifecycle = upstream.lifecycle
        if (!lifecycle) throw new Error("Physical transport returned an upstream response without a lifecycle owner")
        if (wire.stream) return { kind: "stream", upstream: upstream as UpstreamStream & { lifecycle: UpstreamDispatchLifecycle }, lifecycle }
        return { kind: "json", body: upstream.nonStream, headers: upstream.headers, lifecycle }
      } catch (error) {
        // Failed-open/fallback send paths already await their owned transport cleanup before
        // throwing. Their mandatory lifecycle is therefore a settled barrier, not a fake live owner.
        const lifecycle = settledLifecycle()
        if (error instanceof UpstreamTransportFallbackError) {
          return { kind: "fallback-before-first-event", error: error.dispatchError, lifecycle }
        }
        return { kind: "failed-open", error, lifecycle }
      }
    },
  }
}

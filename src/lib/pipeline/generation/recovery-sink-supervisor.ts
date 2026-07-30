import type { ClientSink } from "../types"

import { inheritDownstreamDeliverySession } from "../delivery/session"

/**
 * Keeps one downstream delivery alive across an attempt-local failure and its fresh recovery.
 *
 * Attempt pumps are allowed to call `close` and `finalize` from their normal `finally` paths, but
 * those calls cannot decide the lifetime of the shared client stream. Recoverable heartbeat controls
 * remain attempt-owned and are forwarded unchanged; only the permanent terminal controls are deferred
 * until the recovery owner calls {@link RecoverySinkSupervisor.settleFinal}.
 */
export interface RecoverySinkSupervisor {
  readonly sink: ClientSink
  /** Permanently close and finalize the inner delivery exactly once. */
  settleFinal(): Promise<void>
}

/** Wrap a client sink whose terminal lifetime must span more than one upstream attempt. */
export function createRecoverySinkSupervisor(inner: ClientSink): RecoverySinkSupervisor {
  let finalSettlement: Promise<void> | undefined

  const sink: ClientSink = {
    // ClientSink write methods are closure-based ports, not this-bound methods; identity inheritance below
    // additionally requires this exact reference so write-pass-through semantics are machine-checkable.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    write: inner.write,
    writeSynthetic: inner.writeSynthetic ? (frame) => inner.writeSynthetic?.(frame) ?? Promise.resolve() : undefined,
    writeKeepalive: inner.writeKeepalive ? (frame) => inner.writeKeepalive?.(frame) ?? Promise.resolve() : undefined,
    writeSyntheticEnvelope: inner.writeSyntheticEnvelope ? (frame) => inner.writeSyntheticEnvelope?.(frame) ?? Promise.resolve() : undefined,
    writeAnchor: inner.writeAnchor ? (frame) => inner.writeAnchor?.(frame) ?? Promise.resolve() : undefined,
    freezeHeartbeat: inner.freezeHeartbeat ? () => inner.freezeHeartbeat?.() : undefined,
    suspendHeartbeat: inner.suspendHeartbeat ? () => inner.suspendHeartbeat?.() : undefined,
    resumeHeartbeat: inner.resumeHeartbeat ? () => inner.resumeHeartbeat?.() : undefined,
    // Attempt-local terminal cleanup is deliberately suppressed. These controls are defined even
    // when the inner methods are absent so optional attempt cleanup cannot fall through to the inner
    // sink; the recovery owner alone settles after success, exhaustion, or a gate rejection.
    close() {},
    finalize() {},
  }
  // The driver resolves generation-owned delivery state by sink identity. Keep that capability
  // when decorating; the fallback still writes into delivery, but loses winner assertions and
  // candidateId attribution.
  inheritDownstreamDeliverySession(inner, sink, { transparency: "write-pass-through" })

  return {
    sink,
    settleFinal() {
      finalSettlement ??= (async () => {
        // Mirror the generation-owned delivery terminal order: stop heartbeat before sealing the
        // delivery callback, and await async finalizers so errors remain observable to the owner.
        inner.close?.()
        await inner.finalize?.()
      })()
      return finalSettlement
    },
  }
}

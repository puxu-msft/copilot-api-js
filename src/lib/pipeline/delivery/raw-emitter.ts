/**
 * The physical emitter the generation owner writes through.
 *
 * It takes a {@link ValidatedDeliveryEnvelope} and nothing else. That is the whole design: a port
 * that also accepted a bare `ClientFrame` would be a second, unattributable way to put bytes on the
 * wire, which is the shape every defect in this RFC has in common. With this signature there is no
 * generation send that cannot say which command produced it.
 *
 * It does not decide business intent, block authority, or provenance — those are already settled by
 * the time an envelope exists. It moves bytes and reports what happened.
 *
 * `commandId` on the envelope is a DIAGNOSTIC identity, not a credential: nothing here checks it
 * before emitting (ADR `2026-08-10-trust-the-caller-over-emission-authorization`). It exists so
 * History and traces can tell an intentional command apart from a frame that leaked out some other
 * way.
 *
 * Not called anywhere yet — the owner that uses it is published in Commit 4.
 */

import type { ValidatedDeliveryEnvelope } from "./capability"

export interface RawEmissionOutcome {
  /** The transport accepted the bytes. `false` means the wire is torn, not that the client disagreed. */
  readonly written: boolean
  /** Past the commit point: the client may already have seen these bytes, so this attempt cannot be revoked. */
  readonly committed: boolean
}

export interface OwnerRawEmitter {
  emit(envelope: ValidatedDeliveryEnvelope): Promise<RawEmissionOutcome>
}

/**
 * `EntrySummary.transportFailure` — the compact transport headline for list display.
 *
 * Two things are worth pinning here, and neither is "the field exists":
 *
 * 1. **Precedence.** Several diagnostics can be present at once, and the headline has to pick the strongest true statement. A forced teardown outranks the termination that provoked it; our own cancel outranks a bare stream error.
 * 2. **Refusal to over-claim.** A stream error is reported as a stream error, never as "the peer reset us" — a local abort, a genuine peer RST_STREAM(CANCEL) and a dead connection all arrive with rstCode 8 and cannot be separated from the stream alone (measured, exp/h2-termination-observability/). A classifier that named a culprit would be inventing one, and would read as authoritative in the UI.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { TransportTerminationSnapshot } from "~/lib/transport/http2-observation-types"

import { createModelOperationRecorder } from "~/lib/context/model-operation-record"
import { recordToEntrySummary } from "~/lib/history/v3/projection"

/** A terminal record whose single dispatch carries `diagnostics`. */
function recordWithDiagnostics(diagnostics: Array<{ kind: string; severity: "info" | "warning" | "error"; data?: unknown }>) {
  const recorder = createModelOperationRecorder({ identity: { operationId: `op-${Math.random()}`, kind: "generation", createdAt: 100 } })
  const request = recorder.registerPayload({ prompt: "p" }, { origin: { stage: "ingress", track: "client" } })
  recorder.recordIngress({ request: { payload: request } })
  const dispatch = recorder.beginAttempt({ effectiveRequest: { payload: request }, upstreamRequest: { payload: request } })
  for (const diagnostic of diagnostics) recorder.recordDispatchDiagnostic(dispatch, diagnostic)
  recorder.settleAttempt(dispatch, { verdict: "committed" })
  return recorder.commitTerminal({ outcome: "completed", committedAttempt: dispatch })
}

function snapshot(over: Record<string, unknown>): TransportTerminationSnapshot {
  return {
    schemaVersion: 1,
    firstObservedSignal: "end",
    terminalEpochMs: 1,
    headersReceived: true,
    streamId: 1,
    rstCode: null,
    error: { code: { availability: "none" }, message: { availability: "none" } },
    localCancel: { source: null, reason: { availability: "none" } },
    trailers: "not-observed-before-snapshot",
    physicalClose: "not-observed-before-snapshot",
    goaway: { availability: "not-observed-before-snapshot", events: [], protocolViolation: { availability: "none" } },
    session: {
      sessionId: "h2-7",
      origin: "https://x",
      generation: 0,
      lifecycleAtSnapshot: "active",
      activeStreamCountAtSnapshot: 1,
      ping: { sent: 0, acked: 0, outstanding: 0, lastRttMs: undefined, lastAckEpochMs: undefined, lastError: undefined },
    },
    ...over,
  } as unknown as TransportTerminationSnapshot
}

const termination = (over: Record<string, unknown>) => ({ kind: "transport.h2.termination", severity: "info" as const, data: snapshot(over) })

describe("EntrySummary.transportFailure", () => {
  test("a clean end reports nothing at all", () => {
    const summary = recordToEntrySummary(recordWithDiagnostics([termination({ firstObservedSignal: "end" })]))

    // The field flags trouble; annotating every healthy request would make it useless for scanning a list.
    expect(summary.transportFailure).toBeUndefined()
  })

  test("a local cancel is named as local, with its source", () => {
    const summary = recordToEntrySummary(
      recordWithDiagnostics([
        termination({ firstObservedSignal: "local-cancel", rstCode: 8, localCancel: { source: "body-cancel", reason: { availability: "none" } } }),
      ]),
    )

    expect(summary.transportFailure).toMatchObject({ kind: "local-cancel", localCancelSource: "body-cancel", rstCode: 8, h2SessionId: "h2-7" })
  })

  test("a stream error is NOT upgraded into a claim about who reset the stream", () => {
    const summary = recordToEntrySummary(recordWithDiagnostics([termination({ firstObservedSignal: "error", rstCode: 8 })]))

    // rstCode 8 is exactly the ambiguous case: local abort, peer CANCEL and a dead connection all carry
    // it. `transport-error` is the strongest honest statement; anything narrower would be fabricated.
    // (Named `transport-error`, not `stream-error`: that word is an existing pipeline outcome with a
    // single-minting guard, and one term with two meanings is how a codebase starts lying to itself.)
    expect(summary.transportFailure).toMatchObject({ kind: "transport-error", rstCode: 8 })
    expect(summary.transportFailure).not.toHaveProperty("localCancelSource")
  })

  test("a forced teardown outranks the termination that provoked it", () => {
    const summary = recordToEntrySummary(
      recordWithDiagnostics([
        termination({ firstObservedSignal: "local-cancel", rstCode: 8, localCancel: { source: "body-cancel", reason: { availability: "none" } } }),
        { kind: "transport.h2.barrier_timeout", severity: "warning", data: { graceMs: 10_000 } },
      ]),
    )

    // Reporting "local-cancel" here would be true but misleading: the headline fact is that the stream
    // had to be torn down, and that is what an operator scanning the list needs to see.
    expect(summary.transportFailure?.kind).toBe("forced-teardown")
  })

  test("an observed GOAWAY is reported when nothing stronger applies", () => {
    const summary = recordToEntrySummary(
      recordWithDiagnostics([
        termination({
          firstObservedSignal: "end",
          goaway: {
            availability: "observed-before-snapshot",
            events: [
              {
                sequence: 1,
                errorCode: 0,
                lastStreamID: 1,
                lastStreamIdOrder: "first",
                opaqueDataLength: { availability: "not-observed-before-snapshot" },
                evidence: { availability: "unavailable-at-source", reason: { availability: "none" } },
              },
            ],
            protocolViolation: { availability: "none" },
          },
        }),
      ]),
    )

    expect(summary.transportFailure?.kind).toBe("session-goaway")
  })

  test("a record with no transport diagnostics at all reports nothing", () => {
    const summary = recordToEntrySummary(recordWithDiagnostics([]))

    // Absence must stay ambiguous between "healthy" and "predates A4 diagnostics" — it is documented as
    // such, and inventing a value here would turn every historical request into a false clean bill.
    expect(summary.transportFailure).toBeUndefined()
  })
})

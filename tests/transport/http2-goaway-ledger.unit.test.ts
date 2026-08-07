import { expect, test } from "bun:test"

import type { DispatchHandle } from "~/lib/context/model-operation-record"

import {
  RegisteredGoawayEvidence,
  SessionGoawayLedger,
} from "~/lib/transport/http2-goaway-ledger"

const dispatch = "dispatch:ordinary-zero" as DispatchHandle

test("freezes an ordinary zero-event dispatch with the Task 7 snapshot shape", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease(dispatch)

  expect(lease.freezeAtTerminal()).toEqual({
    snapshot: {
      availability: "not-observed-before-snapshot",
      events: [],
      protocolViolation: { availability: "none" },
    },
    operationLease: null,
  })
})

test("preserves repeated GOAWAY callbacks in order without merging equal evidence digests", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease("dispatch:ordered" as DispatchHandle)
  const capture = { availability: "captured" as const, digest: "same-digest", byteLength: 4, encoding: "binary" as const }
  const append = (lastStreamID: number) => ledger.appendObserved({
    errorCode: 0,
    lastStreamID,
    opaqueDataLength: { availability: "observed", value: 4 },
    evidence: new RegisteredGoawayEvidence(capture.digest, new Uint8Array([1, 2, 3, 4])),
  })

  expect(append(9)).toBe("appended")
  expect(append(7)).toBe("appended")
  expect(append(7)).toBe("appended")
  expect(append(8)).toBe("appended-protocol-error")

  const { snapshot } = lease.freezeAtTerminal()
  expect(snapshot).toEqual({
    availability: "observed-before-snapshot",
    events: [
      { sequence: 1, errorCode: 0, lastStreamID: 9, lastStreamIdOrder: "first", opaqueDataLength: { availability: "observed", value: 4 }, evidence: capture },
      { sequence: 2, errorCode: 0, lastStreamID: 7, lastStreamIdOrder: "non-increasing", opaqueDataLength: { availability: "observed", value: 4 }, evidence: capture },
      { sequence: 3, errorCode: 0, lastStreamID: 7, lastStreamIdOrder: "non-increasing", opaqueDataLength: { availability: "observed", value: 4 }, evidence: capture },
      { sequence: 4, errorCode: 0, lastStreamID: 8, lastStreamIdOrder: "protocol-error-increase", opaqueDataLength: { availability: "observed", value: 4 }, evidence: capture },
    ],
    protocolViolation: { availability: "visible-callback", code: "PROTOCOL_ERROR", offendingSequence: 4 },
  })
})

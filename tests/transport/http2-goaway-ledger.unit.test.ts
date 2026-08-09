import {
  //
  expect,
  test,
} from "bun:test"

import type { DispatchHandle } from "~/lib/context/model-operation-record"
import type { GoawaySnapshot } from "~/lib/transport/http2-observation-types"

import {
  //
  RegisteredGoawayEvidence,
  SessionGoawayLedger,
} from "~/lib/transport/http2-goaway-ledger"

const dispatch = "dispatch:ordinary-zero" as DispatchHandle

function expectTask7Snapshot(snapshot: GoawaySnapshot): GoawaySnapshot {
  return snapshot
}

test("freezes an ordinary zero-event dispatch with the Task 7 snapshot shape", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease(dispatch)

  const result = lease.freezeAtTerminal()
  expectTask7Snapshot(result.snapshot)
  expect(result).toEqual({
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
  const append = (lastStreamID: number) =>
    ledger.appendObserved({
      errorCode: 0,
      lastStreamID,
      opaqueDataLength: { availability: "observed", value: 4 },
      evidence: new RegisteredGoawayEvidence(capture.digest, new Uint8Array([1, 2, 3, 4])),
    })

  expect(append(9)).toBe("appended")
  expect(append(7)).toBe("appended")
  expect(append(7)).toBe("appended")
  expect(append(8)).toBe("appended-protocol-error")

  const { snapshot, operationLease } = lease.freezeAtTerminal()
  expect(snapshot).toEqual({
    availability: "observed-before-snapshot",
    events: [
      { sequence: 1, errorCode: 0, lastStreamID: 9, lastStreamIdOrder: "first", opaqueDataLength: { availability: "observed", value: 4 }, evidence: capture },
      {
        sequence: 2,
        errorCode: 0,
        lastStreamID: 7,
        lastStreamIdOrder: "non-increasing",
        opaqueDataLength: { availability: "observed", value: 4 },
        evidence: capture,
      },
      {
        sequence: 3,
        errorCode: 0,
        lastStreamID: 7,
        lastStreamIdOrder: "non-increasing",
        opaqueDataLength: { availability: "observed", value: 4 },
        evidence: capture,
      },
      {
        sequence: 4,
        errorCode: 0,
        lastStreamID: 8,
        lastStreamIdOrder: "protocol-error-increase",
        opaqueDataLength: { availability: "observed", value: 4 },
        evidence: capture,
      },
    ],
    protocolViolation: { availability: "visible-callback", code: "PROTOCOL_ERROR", offendingSequence: 4 },
  })
  operationLease?.release()
})

test("freezes one shared ledger prefix per dispatch without fan-out mutation", () => {
  const ledger = new SessionGoawayLedger()
  const first = ledger.acquireDispatchLease("dispatch:first-prefix" as DispatchHandle)
  const second = ledger.acquireDispatchLease("dispatch:second-prefix" as DispatchHandle)
  const append = (digest: string, lastStreamID: number) =>
    ledger.appendObserved({
      errorCode: 0,
      lastStreamID,
      opaqueDataLength: { availability: "observed", value: 1 },
      evidence: new RegisteredGoawayEvidence(digest, new Uint8Array([lastStreamID])),
    })

  append("first-prefix", 5)
  const firstResult = first.freezeAtTerminal()
  append("second-prefix", 3)
  const secondResult = second.freezeAtTerminal()

  expect(firstResult.snapshot.events.map((event) => event.sequence)).toEqual([1])
  expect(secondResult.snapshot.events.map((event) => event.sequence)).toEqual([1, 2])
  firstResult.operationLease?.release()
  secondResult.operationLease?.release()
})

test("appends unavailable evidence without manufacturing bytes", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease("dispatch:unavailable" as DispatchHandle)
  const evidence = {
    availability: "unavailable-at-capture" as const,
    byteLength: null,
    reason: { value: "capture failed", originalByteLength: 14, truncated: false },
  }

  expect(
    ledger.appendUnavailable({
      errorCode: 2,
      lastStreamID: 4,
      opaqueDataLength: { availability: "unavailable-at-source", reason: { value: "runtime", originalByteLength: 7, truncated: false } },
      evidence,
    }),
  ).toBe("appended")
  const { snapshot, operationLease } = lease.freezeAtTerminal()
  expect(snapshot.events[0]?.evidence).toEqual(evidence)
  expect(operationLease?.evidenceBytes("missing")).toBeNull()
  operationLease?.release()
})

test("deep-clones and freezes every nested serializable union at ledger ingress", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease("dispatch:deep-immutable" as DispatchHandle)
  const scalarReason = { value: "scalar", originalByteLength: 6, truncated: false }
  const evidenceReason = { value: "evidence", originalByteLength: 8, truncated: false }
  const violationReason = { value: "violation", originalByteLength: 9, truncated: false }
  const opaqueDataLength = { availability: "unavailable-at-source" as const, reason: scalarReason }
  const evidence = { availability: "unavailable-at-capture" as const, byteLength: null, reason: evidenceReason }

  ledger.appendUnavailable({ errorCode: 2, lastStreamID: 4, opaqueDataLength, evidence })
  ledger.recordUnattributedProtocolError(violationReason)
  const { snapshot, operationLease } = lease.freezeAtTerminal()
  const serialized = JSON.stringify(snapshot)

  scalarReason.value = "mutated scalar"
  evidenceReason.value = "mutated evidence"
  violationReason.value = "mutated violation"

  expect(JSON.stringify(snapshot)).toBe(serialized)
  expect(snapshot).toEqual({
    availability: "observed-before-snapshot",
    events: [
      {
        sequence: 1,
        errorCode: 2,
        lastStreamID: 4,
        lastStreamIdOrder: "first",
        opaqueDataLength: { availability: "unavailable-at-source", reason: { value: "scalar", originalByteLength: 6, truncated: false } },
        evidence: { availability: "unavailable-at-capture", byteLength: null, reason: { value: "evidence", originalByteLength: 8, truncated: false } },
      },
    ],
    protocolViolation: {
      availability: "unattributed-protocol-error-before-callback",
      code: "PROTOCOL_ERROR",
      offendingFrame: "unavailable-at-source",
      attribution: "unattributed",
      reason: { value: "violation", originalByteLength: 9, truncated: false },
    },
  })
  expect(Object.isFrozen(snapshot.events[0]?.opaqueDataLength)).toBe(true)
  expect(Object.isFrozen(snapshot.events[0]?.evidence)).toBe(true)
  expect(Object.isFrozen(snapshot.protocolViolation)).toBe(true)
  operationLease?.release()
})

test("returns defensive evidence byte copies across sibling operation leases", () => {
  const ledger = new SessionGoawayLedger()
  const first = ledger.acquireDispatchLease("dispatch:bytes-first" as DispatchHandle)
  const second = ledger.acquireDispatchLease("dispatch:bytes-second" as DispatchHandle)
  const registered = new RegisteredGoawayEvidence("immutable-bytes", new Uint8Array([4, 2]))
  const registeredRead = registered.bytes() as Uint8Array
  registeredRead[0] = 9
  expect(registered.bytes()).toEqual(new Uint8Array([4, 2]))

  ledger.appendObserved({ errorCode: 0, lastStreamID: 1, opaqueDataLength: { availability: "observed", value: 2 }, evidence: registered })
  const firstOperation = first.freezeAtTerminal().operationLease
  const secondOperation = second.freezeAtTerminal().operationLease
  const firstRead = firstOperation?.evidenceBytes("immutable-bytes") as Uint8Array
  firstRead[0] = 8
  expect(secondOperation?.evidenceBytes("immutable-bytes")).toEqual(new Uint8Array([4, 2]))
  expect(firstOperation?.evidenceBytes("immutable-bytes")).toEqual(new Uint8Array([4, 2]))
  firstOperation?.release()
  secondOperation?.release()
})

test("keeps evidence readable after session close until the operation lease releases the last ref", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease("dispatch:ownership" as DispatchHandle)
  const evidence = new RegisteredGoawayEvidence("owned", new Uint8Array([8, 6, 7]))

  expect(
    ledger.appendObserved({
      errorCode: 0,
      lastStreamID: 5,
      opaqueDataLength: { availability: "observed", value: 3 },
      evidence,
    }),
  ).toBe("appended")
  expect(() => evidence.bytes()).toThrow("registered GOAWAY evidence already consumed")
  ledger.closeSessionOwner()

  const { operationLease } = lease.freezeAtTerminal()
  expect(operationLease?.evidenceBytes("owned")).toEqual(new Uint8Array([8, 6, 7]))
  expect(() => lease.freezeAtTerminal()).toThrow("dispatch GOAWAY lease already frozen")

  operationLease?.release()
  expect(ledger.retainedReferenceCount).toBe(0)
  expect(() => operationLease?.evidenceBytes("owned")).toThrow("operation GOAWAY lease already released")
  expect(() => operationLease?.release()).toThrow("operation GOAWAY lease already released")
})

test("does not consume registered evidence when append fails before publication", () => {
  const ledger = new SessionGoawayLedger()
  ledger.closeSessionOwner()
  const evidence = new RegisteredGoawayEvidence("rejected", new Uint8Array([1]))

  expect(() =>
    ledger.appendObserved({
      errorCode: 0,
      lastStreamID: 1,
      opaqueDataLength: { availability: "observed", value: 1 },
      evidence,
    }),
  ).toThrow("session GOAWAY ledger owner closed")
  expect(evidence.bytes()).toEqual(new Uint8Array([1]))
  evidence.release()
  expect(() => evidence.bytes()).toThrow("registered GOAWAY evidence already released")
})

test("fails loud when a dispatch lease is released twice or frozen after release", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease("dispatch:release" as DispatchHandle)

  lease.release()
  expect(() => lease.release()).toThrow("dispatch GOAWAY lease already released")
  expect(() => lease.freezeAtTerminal()).toThrow("dispatch GOAWAY lease already released")
  ledger.closeSessionOwner()
  expect(ledger.retainedReferenceCount).toBe(0)
})

test.each([
  ["stream-first", "stream reason", "session reason"],
  ["session-first", "session reason", "stream reason"],
])("keeps the first shared unattributed violation for %s ordering", (_, firstValue, secondValue) => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease(`dispatch:${firstValue}` as DispatchHandle)
  const reason = (value: string) => ({ value, originalByteLength: value.length, truncated: false })

  expect(ledger.recordUnattributedProtocolError(reason(firstValue))).toBe("recorded")
  expect(ledger.recordUnattributedProtocolError(reason(secondValue))).toBe("already-recorded")
  expect(lease.freezeAtTerminal()).toEqual({
    snapshot: {
      availability: "unavailable-at-source",
      events: [],
      protocolViolation: {
        availability: "unattributed-protocol-error-before-callback",
        code: "PROTOCOL_ERROR",
        offendingFrame: "unavailable-at-source",
        attribution: "unattributed",
        reason: reason(firstValue),
      },
    },
    operationLease: null,
  })
})

test("keeps the first violation across unattributed and visible sources", () => {
  const reason = { value: "unattributed first", originalByteLength: 18, truncated: false }

  const unattributedFirst = new SessionGoawayLedger()
  const unattributedLease = unattributedFirst.acquireDispatchLease("dispatch:unattributed-visible" as DispatchHandle)
  unattributedFirst.appendUnavailable({
    errorCode: 0,
    lastStreamID: 5,
    opaqueDataLength: { availability: "observed", value: 0 },
    evidence: { availability: "unavailable-at-source", reason: { value: "none", originalByteLength: 4, truncated: false } },
  })
  unattributedFirst.recordUnattributedProtocolError(reason)
  expect(
    unattributedFirst.appendUnavailable({
      errorCode: 0,
      lastStreamID: 6,
      opaqueDataLength: { availability: "observed", value: 0 },
      evidence: { availability: "unavailable-at-source", reason: { value: "none", originalByteLength: 4, truncated: false } },
    }),
  ).toBe("appended-protocol-error")
  const unattributedResult = unattributedLease.freezeAtTerminal()
  expect(unattributedResult.snapshot.protocolViolation).toEqual({
    availability: "unattributed-protocol-error-before-callback",
    code: "PROTOCOL_ERROR",
    offendingFrame: "unavailable-at-source",
    attribution: "unattributed",
    reason,
  })
  unattributedResult.operationLease?.release()

  const visibleFirst = new SessionGoawayLedger()
  const visibleLease = visibleFirst.acquireDispatchLease("dispatch:visible-unattributed" as DispatchHandle)
  visibleFirst.appendUnavailable({
    errorCode: 0,
    lastStreamID: 5,
    opaqueDataLength: { availability: "observed", value: 0 },
    evidence: { availability: "unavailable-at-source", reason: { value: "none", originalByteLength: 4, truncated: false } },
  })
  visibleFirst.appendUnavailable({
    errorCode: 0,
    lastStreamID: 6,
    opaqueDataLength: { availability: "observed", value: 0 },
    evidence: { availability: "unavailable-at-source", reason: { value: "none", originalByteLength: 4, truncated: false } },
  })
  expect(visibleFirst.recordUnattributedProtocolError(reason)).toBe("already-recorded")
  const visibleResult = visibleLease.freezeAtTerminal()
  expect(visibleResult.snapshot.protocolViolation).toEqual({ availability: "visible-callback", code: "PROTOCOL_ERROR", offendingSequence: 2 })
  visibleResult.operationLease?.release()
})

test("keeps the first visible offending sequence across later increases", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease("dispatch:visible-visible" as DispatchHandle)
  const append = (lastStreamID: number) =>
    ledger.appendUnavailable({
      errorCode: 0,
      lastStreamID,
      opaqueDataLength: { availability: "observed", value: 0 },
      evidence: { availability: "unavailable-at-source", reason: { value: "none", originalByteLength: 4, truncated: false } },
    })

  append(5)
  expect(append(6)).toBe("appended-protocol-error")
  expect(append(7)).toBe("appended-protocol-error")
  const result = lease.freezeAtTerminal()
  expect(result.snapshot.protocolViolation).toEqual({ availability: "visible-callback", code: "PROTOCOL_ERROR", offendingSequence: 2 })
  result.operationLease?.release()
})

test("keeps an unattributed violation on an observed event snapshot", () => {
  const ledger = new SessionGoawayLedger()
  const lease = ledger.acquireDispatchLease("dispatch:observed-unattributed" as DispatchHandle)
  const reason = { value: "stream first", originalByteLength: 12, truncated: false }

  ledger.appendObserved({
    errorCode: 0,
    lastStreamID: 3,
    opaqueDataLength: { availability: "observed", value: 1 },
    evidence: new RegisteredGoawayEvidence("observed-unattributed", new Uint8Array([1])),
  })
  ledger.recordUnattributedProtocolError(reason)

  const { snapshot, operationLease } = lease.freezeAtTerminal()
  expect(snapshot.availability).toBe("observed-before-snapshot")
  expect(snapshot.protocolViolation).toEqual({
    availability: "unattributed-protocol-error-before-callback",
    code: "PROTOCOL_ERROR",
    offendingFrame: "unavailable-at-source",
    attribution: "unattributed",
    reason,
  })
  operationLease?.release()
})

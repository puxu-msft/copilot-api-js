import { expect, test } from "bun:test"

import type { DispatchHandle } from "~/lib/context/model-operation-record"

import { SessionGoawayLedger } from "~/lib/transport/http2-goaway-ledger"

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

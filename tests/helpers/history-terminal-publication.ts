import type { ModelOperationRecord } from "~/lib/context/model-operation-record"
import type { HistoryReservation } from "~/lib/history/worker/admission"
import type { ModelOperationTerminalPublication } from "~/lib/history/worker/protocol"

import {
  //
  createModelOperationTerminalPublication,
  createRawOperationAttachmentOwner,
} from "~/lib/history/terminal-publication"

export function historyTerminalPublication(record: ModelOperationRecord): ModelOperationTerminalPublication<ModelOperationRecord> {
  return createModelOperationTerminalPublication(record, createRawOperationAttachmentOwner())
}

export function historyTestReservation(waitMs = 0): HistoryReservation {
  return {
    reservationId: "history-test-reservation",
    admittedAt: 0,
    historyAdmissionWaitMs: waitMs,
    bindOperationId: () => {},
    releaseBeforeBinding: () => {},
  }
}

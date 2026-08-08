import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import type { HistoryTerminalSink } from "./admission"
import type {
  //
  CanonicalModelOperationWireRecord,
  HistoryMessageId,
  HistoryPersistenceOutcome,
} from "./protocol"

export interface LegacyHistoryTerminalSinkOptions {
  readonly enqueueRecord: (record: ModelOperationRecord) => Promise<HistoryPersistenceOutcome>
}

function restoreLegacyAttemptAlias(record: CanonicalModelOperationWireRecord): ModelOperationRecord {
  const compatible = { ...record } as ModelOperationRecord
  Object.defineProperty(compatible, "attempts", {
    enumerable: false,
    configurable: false,
    get: () => record.dispatches,
  })
  return compatible
}

export class LegacyHistoryTerminalSink implements HistoryTerminalSink {
  private readonly options: LegacyHistoryTerminalSinkOptions
  private nextMessageId = 1

  constructor(options: LegacyHistoryTerminalSinkOptions) {
    this.options = options
  }

  enqueue(envelope: Parameters<HistoryTerminalSink["enqueue"]>[0], onOutcome: Parameters<HistoryTerminalSink["enqueue"]>[1]): HistoryMessageId {
    const messageId = this.nextMessageId++
    void Promise.resolve()
      .then(async () => await this.options.enqueueRecord(restoreLegacyAttemptAlias(envelope.publication.record)))
      .then(onOutcome, () => onOutcome("failed"))
    return messageId
  }
}

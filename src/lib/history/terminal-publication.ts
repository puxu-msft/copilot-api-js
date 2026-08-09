import type { ModelOperationRecord } from "~/lib/context/model-operation-record"

import type {
  //
  ModelOperationTerminalPublication,
  RawOperationAttachment,
  RawTargetDescriptor,
} from "./worker/protocol"

export interface RawOperationAttachmentOwner {
  transfer(): RawOperationAttachment
}

const RAW_DISABLED_TARGET: RawTargetDescriptor = Object.freeze({
  configRevision: 0,
  requested: false,
  maxObjectBytes: 0,
})

export function createRawOperationAttachmentOwner(rawTarget: RawTargetDescriptor = RAW_DISABLED_TARGET): RawOperationAttachmentOwner {
  const frozenTarget = Object.freeze({ ...rawTarget })
  let transferred = false

  return Object.freeze({
    transfer(): RawOperationAttachment {
      if (transferred) throw new Error("Raw operation attachment already transferred")
      transferred = true
      return Object.freeze({ rawTarget: frozenTarget, rawCommands: Object.freeze([]) })
    },
  })
}

export function createModelOperationTerminalPublication(
  record: ModelOperationRecord,
  rawAttachmentOwner: RawOperationAttachmentOwner,
): ModelOperationTerminalPublication<ModelOperationRecord> {
  return Object.freeze({ record, rawAttachment: rawAttachmentOwner.transfer() })
}

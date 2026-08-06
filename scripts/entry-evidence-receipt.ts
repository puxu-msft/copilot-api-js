import { closeSync, constants, linkSync, openSync, rmSync, unlinkSync, writeSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

export function writeReceiptAtomically(receiptPath: string, body: string): void {
  const temporary = path.join(path.dirname(receiptPath), `.${path.basename(receiptPath)}.${randomUUID()}.tmp`)
  let created = false
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    created = true
    try {
      writeSync(descriptor, body)
    } finally {
      closeSync(descriptor)
    }
    // link(2) is atomic and fails with EEXIST instead of replacing an existing receipt.
    linkSync(temporary, receiptPath)
    unlinkSync(temporary)
  } catch (error) {
    if (created) rmSync(temporary, { force: true })
    throw error
  }
}

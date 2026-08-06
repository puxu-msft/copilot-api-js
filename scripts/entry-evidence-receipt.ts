import { renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export function writeReceiptAtomically(receiptPath: string, body: string): void {
  const temporary = path.join(path.dirname(receiptPath), `.${path.basename(receiptPath)}.tmp`)
  try {
    writeFileSync(temporary, body)
    renameSync(temporary, receiptPath)
  } catch (error) {
    // Only the deterministic temporary file belongs to this invocation. A pre-existing receipt must survive failures unchanged.
    rmSync(temporary, { force: true })
    throw error
  }
}

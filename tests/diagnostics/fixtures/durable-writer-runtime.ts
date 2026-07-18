import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import buildRoll from "pino-roll"

import { CountingDestination } from "../../../src/lib/diagnostics/file/counting-destination"
import { DurableFileWriter } from "../../../src/lib/diagnostics/file/durable-writer"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "durable-writer-runtime-"))
const baseName = path.join(directory, "runtime.ndjson")
const destination = await buildRoll({
  file: baseName,
  frequency: "daily",
  dateFormat: "yyyy-MM-dd",
  mkdir: true,
  minLength: 4096,
  maxLength: 4 * 1024 * 1024,
  symlink: false,
})
if (destination.fd < 0) {
  await new Promise<void>((resolve, reject) => {
    destination.once("ready", resolve)
    destination.once("error", reject)
  })
}
const counted = new CountingDestination(destination)
const writer = new DurableFileWriter(destination, counted, baseName)
const head = "x".repeat(20_000)
const tail = "tail"
counted.write(head)
counted.write(tail)
await writer.durable()
const durableBytes = fs.statSync(destination.file).size
await writer.close(() => counted.write("marker"))
const result = {
  durableBytes,
  expectedDurableBytes: Buffer.byteLength(head) + Buffer.byteLength(tail),
  state: writer.health.state,
  queuedBytes: writer.health.queuedBytes,
}
fs.rmSync(directory, { recursive: true, force: true })
process.stdout.write(JSON.stringify(result))

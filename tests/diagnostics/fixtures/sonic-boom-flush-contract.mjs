import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import buildRoll from "pino-roll"

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sonic-boom-flush-contract-"))
const destination = await buildRoll({
  file: path.join(directory, "probe.ndjson"),
  frequency: "daily",
  dateFormat: "yyyy-MM-dd",
  mkdir: true,
  minLength: 4096,
  maxLength: 4 * 1024 * 1024,
  symlink: false,
})
if (destination.fd < 0) {
  await new Promise((resolve, reject) => {
    destination.once("ready", resolve)
    destination.once("error", reject)
  })
}

let queuedBytes = 0
destination.on("write", (bytes) => {
  queuedBytes -= bytes
})
const write = (data) => {
  queuedBytes += Buffer.byteLength(data)
  destination.write(data)
}
const flush = () =>
  new Promise((resolve, reject) => destination.flush((error) => (error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve())))
const fileBytes = () => fs.statSync(destination.file).size

const head = "x".repeat(20_000)
const tail = "tail"
write(head)
write(tail)
await flush()
const first = { queuedBytes, fileBytes: fileBytes() }
await flush()
const second = { queuedBytes, fileBytes: fileBytes() }
destination.end()
await new Promise((resolve, reject) => {
  destination.once("close", resolve)
  destination.once("error", reject)
})
fs.rmSync(directory, { recursive: true, force: true })
process.stdout.write(JSON.stringify({ first, second, totalBytes: Buffer.byteLength(head) + Buffer.byteLength(tail) }))

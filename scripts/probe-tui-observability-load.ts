#!/usr/bin/env bun
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Writable } from "node:stream"

import { StructuredFileSink } from "../src/lib/diagnostics/file/structured-file-sink"
import { createBus } from "../src/lib/observability"
import { TerminalUi } from "../src/lib/tui"

class NullTerminal extends Writable {
  bytes = 0
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.bytes += chunk.length
    callback()
  }
}

const count = Number(process.argv.find((arg) => arg.startsWith("--events="))?.split("=")[1] ?? 10_000)
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tui-observability-probe-"))
const bus = createBus()
const terminal = new NullTerminal()
const ui = new TerminalUi(bus, { stdout: terminal, isTTY: false, refreshIntervalMs: 0 })
const file = await StructuredFileSink.create(bus, { directory, maxSizeBytes: 0 })
const publisher = bus.scope("request")
const ctx = {
  id: "probe",
  endpoint: "anthropic-messages" as const,
  method: "POST",
  path: "/v1/messages",
  state: "streaming" as const,
  startTime: Date.now(),
  queueWaitMs: 0,
}

let maxGap = 0
let last = performance.now()
const ticker = setInterval(() => {
  const now = performance.now()
  maxGap = Math.max(maxGap, now - last)
  last = now
}, 1)
const started = performance.now()
for (let i = 0; i < count; i++) publisher.publish({ kind: "request.stream_progress", ctx, bytesIn: i, eventsIn: i })
publisher.publish({ kind: "request.aborted", ctx: { ...ctx, state: "aborted" }, entry: { id: ctx.id, endpoint: ctx.endpoint, state: "aborted" } as never })
await bus.flush()
await file.close()
clearInterval(ticker)
const elapsedMs = performance.now() - started
console.log(JSON.stringify({ count, elapsedMs, maxEventLoopGapMs: maxGap, terminalBytes: terminal.bytes, fileHealth: file.health }))
ui.destroy()
fs.rmSync(directory, { recursive: true, force: true })

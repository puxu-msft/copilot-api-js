import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import { CountingDestination } from "~/lib/diagnostics/file/counting-destination"

// eslint-disable-next-line unicorn/prefer-event-target -- mirrors the Pino DestinationStream EventEmitter contract.
class FakeDestination extends EventEmitter {
  file = "/tmp/a.ndjson"
  write(_data: string): boolean {
    return true
  }
  flush(callback?: (error?: Error | null) => void): void {
    callback?.()
  }
  end(): void {}
}

describe("CountingDestination", () => {
  test("tracks UTF-8 queued, written, dropped bytes without private fields", async () => {
    const raw = new FakeDestination()
    const counted = new CountingDestination(raw as never)
    counted.write("你\n")
    expect(counted.health.queuedBytes).toBe(Buffer.byteLength("你\n"))
    raw.emit("write", Buffer.byteLength("你\n"))
    await counted.waitForIdle()
    expect(counted.health).toEqual({ queuedBytes: 0, writtenBytes: 4, droppedBytes: 0 })
    expect(counted.takeDirtyPaths()).toEqual(["/tmp/a.ndjson"])
  })
})

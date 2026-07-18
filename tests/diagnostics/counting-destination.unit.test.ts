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

class ThrowingDestination extends FakeDestination {
  override write(_data: string): boolean {
    throw new Error("sync write failed")
  }
}

describe("CountingDestination", () => {
  test("tracks UTF-8 queued and written bytes without private fields", async () => {
    const raw = new FakeDestination()
    const counted = new CountingDestination(raw as never)
    counted.write("你\n")
    expect(counted.health).toEqual({ acceptedBytes: 4, settledBytes: 0, queuedBytes: 4, writtenBytes: 0, droppedBytes: 0 })
    raw.emit("write", Buffer.byteLength("你\n"))
    await counted.waitForSettled(4)
    expect(counted.health).toEqual({ acceptedBytes: 4, settledBytes: 4, queuedBytes: 0, writtenBytes: 4, droppedBytes: 0 })
    expect(counted.takeDirtyPaths()).toEqual(["/tmp/a.ndjson"])
  })

  test("an async destination error rejects settlement waiters instead of hanging shutdown", async () => {
    const raw = new FakeDestination()
    const counted = new CountingDestination(raw as never)
    counted.write("pending\n")
    const idle = counted.waitForSettled(counted.health.acceptedBytes)
    raw.emit("error", new Error("ENOSPC"))
    await expect(idle).rejects.toThrow("ENOSPC")
  })

  test("tracks partial writes and turns a drop into a sticky failure", async () => {
    const raw = new FakeDestination()
    const counted = new CountingDestination(raw as never)
    counted.write("abcdef")
    raw.emit("write", 2)
    expect(counted.health).toEqual({ acceptedBytes: 6, settledBytes: 2, queuedBytes: 4, writtenBytes: 2, droppedBytes: 0 })
    const idle = counted.waitForSettled(6)
    raw.emit("drop", "cdef")

    await expect(idle).rejects.toThrow(/dropped 4 bytes/i)
    await expect(counted.waitForSettled(6)).rejects.toThrow(/dropped 4 bytes/i)
    expect(counted.health).toEqual({ acceptedBytes: 6, settledBytes: 6, queuedBytes: 0, writtenBytes: 2, droppedBytes: 4 })
  })

  test("does not accept bytes when the destination write throws synchronously", () => {
    const counted = new CountingDestination(new ThrowingDestination() as never)

    expect(() => counted.write("bad")).toThrow("sync write failed")
    expect(counted.health).toEqual({ acceptedBytes: 0, settledBytes: 0, queuedBytes: 0, writtenBytes: 0, droppedBytes: 0 })
    expect(counted.failureReason?.message).toBe("sync write failed")
  })
})

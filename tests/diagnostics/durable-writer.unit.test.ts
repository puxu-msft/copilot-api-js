import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import { CountingDestination } from "~/lib/diagnostics/file/counting-destination"
import { DurableFileWriter } from "~/lib/diagnostics/file/durable-writer"

// eslint-disable-next-line unicorn/prefer-event-target -- mirrors the Pino DestinationStream EventEmitter contract.
class ControlledDestination extends EventEmitter {
  file = "/tmp/diagnostic.ndjson"
  readonly writes: Array<string> = []
  readonly flushes: Array<() => void> = []
  endCalls = 0

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  flush(callback?: (error?: Error | null) => void): void {
    const flush = this.flushes.shift()
    if (!flush) throw new Error("Unexpected flush")
    flush()
    callback?.()
  }

  end(): void {
    this.endCalls++
    queueMicrotask(() => this.emit("close"))
  }
}

function createHarness(syncSegments: (baseName: string, dirtyPaths: ReadonlyArray<string>) => Promise<void> = async () => {}) {
  const raw = new ControlledDestination()
  const counted = new CountingDestination(raw as never)
  const writer = new DurableFileWriter(raw as never, counted, "/tmp/diagnostic.ndjson", {
    syncSegments,
    listSegments: () => [raw.file],
  })
  return { raw, counted, writer }
}

describe("DurableFileWriter", () => {
  test("re-flushes a queued tail before fsync without a timing oracle", async () => {
    const order: Array<string> = []
    const { raw, counted, writer } = createHarness(async (_baseName, dirtyPaths) => {
      order.push(`fsync:${dirtyPaths.join(",")}`)
    })
    const head = "x".repeat(20_000)
    const tail = "tail"
    counted.write(head)
    counted.write(tail)
    raw.flushes.push(
      () => {
        order.push("flush:head")
        raw.emit("write", Buffer.byteLength(head))
      },
      () => {
        order.push("flush:tail")
        raw.emit("write", Buffer.byteLength(tail))
      },
    )

    await writer.durable()

    expect(order).toEqual(["flush:head", "flush:tail", "fsync:/tmp/diagnostic.ndjson"])
    expect(writer.health.queuedBytes).toBe(0)
  })

  test("checkpoints the accepted-byte generation without waiting for later producers", async () => {
    const order: Array<string> = []
    const { raw, counted, writer } = createHarness(async () => {
      order.push("fsync")
    })
    counted.write("owned")
    raw.flushes.push(() => {
      order.push("flush:owned")
      raw.emit("write", Buffer.byteLength("owned"))
      counted.write("later")
    })

    await writer.durable()

    expect(order).toEqual(["flush:owned", "fsync"])
    expect(writer.health.queuedBytes).toBe(Buffer.byteLength("later"))

    raw.flushes.push(() => raw.emit("write", Buffer.byteLength("later")))
    await writer.durable()
    expect(writer.health.queuedBytes).toBe(0)
  })

  test("serializes concurrent checkpoints while preserving each call's generation", async () => {
    const order: Array<string> = []
    const { raw, counted, writer } = createHarness(async () => {
      order.push("fsync")
    })
    counted.write("first")
    raw.flushes.push(
      () => {
        order.push("flush:first")
        raw.emit("write", Buffer.byteLength("first"))
      },
      () => {
        order.push("flush:second")
        raw.emit("write", Buffer.byteLength("second"))
      },
    )
    const first = writer.durable()
    counted.write("second")
    const second = writer.durable()

    await Promise.all([first, second])

    expect(order).toEqual(["flush:first", "fsync", "flush:second", "fsync"])
    expect(writer.health.queuedBytes).toBe(0)
  })

  test("re-fsyncs when a roll changes the active path during a checkpoint", async () => {
    const synced: Array<Array<string>> = []
    const raw = new ControlledDestination()
    const counted = new CountingDestination(raw as never)
    const writer = new DurableFileWriter(raw as never, counted, "/tmp/diagnostic.ndjson", {
      listSegments: () => (raw.file.endsWith(".2.ndjson") ? ["/tmp/diagnostic.1.ndjson", raw.file] : [raw.file]),
      syncSegments: async (_baseName, paths) => {
        synced.push([...paths])
        if (synced.length === 1) raw.file = "/tmp/diagnostic.2.ndjson"
      },
    })
    counted.write("roll")
    raw.flushes.push(() => raw.emit("write", Buffer.byteLength("roll")))

    await writer.durable()

    expect(synced).toEqual([["/tmp/diagnostic.ndjson"], ["/tmp/diagnostic.ndjson", "/tmp/diagnostic.1.ndjson", "/tmp/diagnostic.2.ndjson"]])
  })

  test("fails explicitly when a flush callback makes no byte progress", async () => {
    const { raw, counted, writer } = createHarness()
    counted.write("stuck")
    raw.flushes.push(() => {})

    await expect(writer.durable()).rejects.toThrow(/no progress/i)
    expect(writer.health.state).toBe("degraded")
  })

  test("orders ordinary drain, marker drain, fsync, end, and close", async () => {
    const order: Array<string> = []
    const { raw, counted, writer } = createHarness(async () => {
      order.push("fsync")
    })
    counted.write("ordinary")
    raw.flushes.push(
      () => {
        order.push("flush:ordinary")
        raw.emit("write", Buffer.byteLength("ordinary"))
      },
      () => {
        order.push("flush:marker")
        raw.emit("write", Buffer.byteLength("marker"))
      },
    )
    raw.on("close", () => order.push("close"))

    const first = writer.close(() => {
      order.push("marker")
      counted.write("marker")
    })
    const second = writer.close(() => {
      throw new Error("marker must be exactly once")
    })
    await Promise.all([first, second])
    order.splice(order.indexOf("close"), 0, `end:${raw.endCalls}`)

    expect(order).toEqual(["flush:ordinary", "fsync", "marker", "flush:marker", "fsync", "end:1", "close"])
    expect(writer.health.state).toBe("closed")
  })

  test("propagates fsync failure and retains a failed terminal state", async () => {
    const { raw, counted, writer } = createHarness(async () => {
      throw new Error("fsync failed")
    })
    counted.write("record")
    raw.flushes.push(() => raw.emit("write", Buffer.byteLength("record")))

    await expect(writer.durable()).rejects.toThrow("fsync failed")
    expect(writer.health.state).toBe("degraded")
  })

  test("does not let a sink-owned maintenance failure pass a later durability barrier", async () => {
    const order: Array<string> = []
    const { writer } = createHarness(async () => {
      order.push("fsync")
    })
    writer.recordFailure(new Error("retention failed"))

    await expect(writer.durable()).rejects.toThrow("retention failed")
    await expect(writer.durable()).rejects.toThrow("retention failed")
    expect(order).toEqual(["fsync", "fsync"])
    expect(writer.health.state).toBe("degraded")
  })

  test("fails shutdown when the reserved sealing marker is dropped", async () => {
    const { raw, counted, writer } = createHarness()

    await expect(
      writer.close(() => {
        counted.write("marker")
        raw.emit("drop", "marker")
      }),
    ).rejects.toThrow(/marker was dropped|dropped 6 bytes/i)
    expect(raw.endCalls).toBe(1)
    expect(writer.health.state).toBe("failed")
  })
})

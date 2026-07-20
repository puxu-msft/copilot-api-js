import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import { OutputArbiter } from "~/lib/tui/output-arbiter"

// eslint-disable-next-line unicorn/prefer-event-target -- Node Writable fault semantics use EventEmitter error/close events.
class FakeWritable extends EventEmitter {
  destroyed = false
  writableEnded = false
  chunks: Array<string> = []
  throwOnWrite = false

  write(data: string): boolean {
    if (this.throwOnWrite) throw new Error("EPIPE")
    this.chunks.push(data)
    return true
  }
}

describe("OutputArbiter", () => {
  test("a synchronous write failure faults the owner without escaping", () => {
    const stream = new FakeWritable()
    const arbiter = new OutputArbiter(stream as unknown as NodeJS.WritableStream)
    let faults = 0
    arbiter.setOnFault(() => faults++)
    stream.throwOnWrite = true

    expect(() => arbiter.write("x")).not.toThrow()
    expect(arbiter.faulted).toBe(true)
    expect(faults).toBe(1)
    expect(arbiter.write("y")).toBe(false)
    arbiter.destroy()
  })

  test("an asynchronous error event faults the owner", () => {
    const stream = new FakeWritable()
    const arbiter = new OutputArbiter(stream as unknown as NodeJS.WritableStream)
    stream.emit("error", new Error("broken"))
    expect(arbiter.faulted).toBe(true)
    expect(arbiter.write("x")).toBe(false)
    arbiter.destroy()
  })
})

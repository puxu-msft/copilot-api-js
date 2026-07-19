import {
  //
  describe,
  expect,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import { KeyDecoder } from "~/lib/tui/input/key-decoder"
import { OutputArbiter } from "~/lib/tui/output-arbiter"

// eslint-disable-next-line unicorn/prefer-event-target -- Node Writable backpressure uses EventEmitter drain/error semantics.
class BackpressuredWritable extends EventEmitter {
  destroyed = false
  writableEnded = false
  writes: Array<string> = []
  blocked = true
  write(chunk: string): boolean {
    this.writes.push(chunk)
    return !this.blocked
  }
}

describe("KeyDecoder streaming input", () => {
  test("ordinary UTF-8 split over 1/2/3 chunks is consumed as char and never becomes an action", () => {
    const bytes = Buffer.from("你")
    for (const chunks of [[bytes], [bytes.subarray(0, 1), bytes.subarray(1)], [bytes.subarray(0, 1), bytes.subarray(1, 2), bytes.subarray(2)]]) {
      const decoder = new KeyDecoder()
      const events = chunks.flatMap((chunk) => decoder.feed(chunk))
      expect(events).toEqual([{ kind: "char", char: "你" }])
      decoder.destroy()
    }
    const decoder = new KeyDecoder()
    expect(decoder.feed(Buffer.from("ｑ"))).toEqual([{ kind: "char", char: "ｑ" }])
  })

  test("split SS3 and unknown CSI are consumed atomically", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed(Buffer.from("\x1bO"))).toEqual([])
    expect(decoder.feed(Buffer.from("A"))).toEqual([{ kind: "up" }])
    expect(decoder.feed(Buffer.from("\x1b[99;2"))).toEqual([])
    expect(decoder.feed(Buffer.from("zq"))).toEqual([{ kind: "quit" }])
    decoder.destroy()
  })
})

describe("OutputArbiter backpressure", () => {
  test("bounds queued lines, keeps latest repaint, and drain settles after stream drain", async () => {
    const stream = new BackpressuredWritable()
    const arbiter = new OutputArbiter(stream as unknown as NodeJS.WritableStream, { maxQueuedLines: 2 })
    arbiter.writeLine("line-0\n")
    arbiter.writeLine("line-1\n")
    arbiter.writeLine("line-2\n")
    arbiter.writeLine("line-3\n")
    arbiter.writeFrame("frame-old")
    arbiter.writeFrame("frame-new")
    let settled = false
    const drained = arbiter.drain().then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    stream.blocked = false
    stream.emit("drain")
    await drained
    expect(stream.writes).toEqual(["line-0\n", "line-2\n", "line-3\n", "frame-new"])
    expect(arbiter.droppedLines).toBe(1)
    arbiter.destroy()
  })
})

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import { KeyDecoder } from "~/lib/tui/input/key-decoder"

describe("KeyDecoder", () => {
  test("preserves split arrow sequences across chunks", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed(Buffer.from([0x1b]))).toEqual([])
    expect(decoder.feed(Buffer.from("["))).toEqual([])
    expect(decoder.feed(Buffer.from("A"))).toEqual([{ kind: "up" }])
    decoder.destroy()
  })

  test("decodes page/home/end and semantic shutdown keys", () => {
    const decoder = new KeyDecoder()
    expect(decoder.feed(Buffer.from("\x1b[5~\x1b[6~\x1b[H\x1b[Fq\x04\x1a"))).toEqual([
      { kind: "page-up" },
      { kind: "page-down" },
      { kind: "home" },
      { kind: "end" },
      { kind: "quit" },
      { kind: "ctrl-d" },
      { kind: "suspend" },
    ])
    decoder.destroy()
  })

  test("emits a truly lone escape after disambiguation delay", async () => {
    const deferred: Array<unknown> = []
    const decoder = new KeyDecoder((events) => deferred.push(...events))
    expect(decoder.feed(Buffer.from([0x1b]))).toEqual([])
    await Bun.sleep(70)
    expect(deferred).toEqual([{ kind: "escape" }])
    decoder.destroy()
  })
})

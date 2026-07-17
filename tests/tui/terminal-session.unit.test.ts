import {
  //
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import { EventEmitter } from "node:events"

import { TerminalSession } from "~/lib/tui/terminal-session"

// eslint-disable-next-line unicorn/prefer-event-target -- Node ReadStream uses EventEmitter semantics.
class FakeInput extends EventEmitter {
  setRawMode = mock((_enabled: boolean) => this)
  resume = mock(() => this)
  pause = mock(() => this)
}

describe("TerminalSession", () => {
  test("owns raw input and restores cooked mode even when visual restore fails", () => {
    const input = new FakeInput()
    let exitHook: (() => void) | undefined
    const onData = mock((_chunk: Buffer) => {})
    const session = new TerminalSession({
      stdin: input as unknown as NodeJS.ReadStream,
      interactive: true,
      onData,
      beforeRestore: () => {
        throw new Error("visual failed")
      },
      registerExitHook: (hook) => {
        exitHook = hook
      },
    })
    expect(input.setRawMode).toHaveBeenCalledWith(true)
    input.emit("data", Buffer.from("x"))
    expect(onData).toHaveBeenCalledTimes(1)
    expect(() => exitHook?.()).not.toThrow()
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(input.pause).toHaveBeenCalled()
    session.restoreSyncBestEffort()
    expect(input.setRawMode).toHaveBeenCalledTimes(2)
  })
})

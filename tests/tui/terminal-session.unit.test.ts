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

test("suspend drains restore bytes, cooks before SIGTSTP, then SIGCONT reattaches raw input and unregisters exit hook", async () => {
  const order: Array<string> = []
  const input = new FakeInput()
  input.setRawMode = mock((enabled: boolean) => {
    order.push(`raw:${enabled}`)
    return input
  })
  input.resume = mock(() => {
    order.push("resume-input")
    return input
  })
  input.pause = mock(() => {
    order.push("pause-input")
    return input
  })
  const listeners = new Map<string, () => void>()
  const jobs = {
    platform: "linux" as const,
    pid: 42,
    on: (signal: "SIGTSTP" | "SIGCONT", listener: () => void) => {
      listeners.set(signal, listener)
      order.push(`on:${signal}`)
    },
    off: (signal: "SIGTSTP" | "SIGCONT", _listener: () => void) => {
      listeners.delete(signal)
      order.push(`off:${signal}`)
    },
    kill: (_pid: number, signal: "SIGTSTP") => {
      order.push(`kill:${signal}`)
    },
  }
  let exitHookUnregistered = false
  const session = new TerminalSession({
    stdin: input as unknown as NodeJS.ReadStream,
    interactive: true,
    onData: () => {},
    beforeRestore: () => order.push("restore-final"),
    beforeSuspend: () => order.push("restore-suspend"),
    drainOutput: async () => {
      order.push("drain")
    },
    onResume: () => order.push("repaint"),
    registerExitHook: () => () => {
      exitHookUnregistered = true
    },
    jobControl: jobs,
  })

  expect(await session.suspend()).toBe(true)
  expect(order.indexOf("restore-suspend")).toBeLessThan(order.indexOf("drain"))
  expect(order.indexOf("drain")).toBeLessThan(order.indexOf("raw:false"))
  expect(order.indexOf("raw:false")).toBeLessThan(order.indexOf("kill:SIGTSTP"))
  listeners.get("SIGCONT")?.()
  expect(order.indexOf("raw:true", order.indexOf("kill:SIGTSTP"))).toBeGreaterThan(order.indexOf("kill:SIGTSTP"))
  expect(order.at(-1)).toBe("repaint")
  session.restoreSyncBestEffort()
  expect(exitHookUnregistered).toBe(true)
})

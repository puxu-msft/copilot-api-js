import {
  //
  afterEach,
  expect,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { writePidfile } from "../../src/lib/restart/pidfile"
import { decideStartup } from "../../src/lib/restart/takeover"

const dirs: Array<string> = []
function tmpPidfile(): string {
  const d = mkdtempSync(join(tmpdir(), "takeover-"))
  dirs.push(d)
  return join(d, "copilot-api.pid")
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

test("无 pidfile → proceed（不论 flag）", () => {
  expect(decideStartup({ pidfilePath: tmpPidfile(), hasRestartFlag: false })).toEqual({ kind: "proceed" })
  expect(decideStartup({ pidfilePath: tmpPidfile(), hasRestartFlag: true })).toEqual({ kind: "proceed" })
})
test("live 前任 + 无 --restart → refuse", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 }) // pid 1 恒存活
  const d = decideStartup({ pidfilePath: p, hasRestartFlag: false })
  expect(d.kind).toBe("refuse")
})
test("live 前任 + --restart → takeover（带前任内容）", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  const d = decideStartup({ pidfilePath: p, hasRestartFlag: true })
  expect(d).toEqual({ kind: "takeover", predecessor: { pid: 1, bootTime: 1, port: 4141 } })
})
test("陈旧 pidfile（死 pid）→ proceed（当作无前任）", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 2 ** 30, bootTime: 1, port: 4141 })
  expect(decideStartup({ pidfilePath: p, hasRestartFlag: false })).toEqual({ kind: "proceed" })
})

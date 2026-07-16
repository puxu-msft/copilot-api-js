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
import { resolveManualStartup } from "../../src/lib/restart/takeover"

// resolveManualStartup 是 Task 12 从 runServer 抽出的纯决策函数（收 supervisor 分流 +
// decideStartup 两件事）。runServer 本身（IO 编排：exit/writePidfile/notifyReady/
// signalPredecessorHandoff）留给 Phase 6 e2e（tests/e2e/handover.e2e.test.ts），这里
// 只测可隔离的纯逻辑。overlap-window 数据安全（reclaim 排除 / VACUUM 跳过）已改为
// 进程存活性裁决，不再依赖本函数登记任何寄存器（见 connection.ts、lifecycle.md）。

const dirs: Array<string> = []
function tmpPidfile(): string {
  const d = mkdtempSync(join(tmpdir(), "runserver-wiring-"))
  dirs.push(d)
  return join(d, "copilot-api.pid")
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

test("supervised 环境跳过 pidfile guard（返回 skip）", () => {
  const r = resolveManualStartup({ pidfilePath: "/x", restart: false, supervised: true })
  expect(r).toEqual({ kind: "skip" })
})

test("无 live 前任 → proceed（不论 flag）", () => {
  const r = resolveManualStartup({ pidfilePath: tmpPidfile(), restart: false, supervised: false })
  expect(r).toEqual({ kind: "proceed" })
})

test("live 前任 + 无 --restart → refuse", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 }) // pid 1 恒存活
  const r = resolveManualStartup({ pidfilePath: p, restart: false, supervised: false })
  expect(r).toEqual({ kind: "refuse", predecessor: { pid: 1, bootTime: 1, port: 4141 } })
})

test("live 前任 + --restart → takeover", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  const r = resolveManualStartup({ pidfilePath: p, restart: true, supervised: false })
  expect(r).toEqual({ kind: "takeover", predecessor: { pid: 1, bootTime: 1, port: 4141 } })
})

test("陈旧 pidfile（死 pid）→ proceed", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 2 ** 30, bootTime: 1, port: 4141 })
  const r = resolveManualStartup({ pidfilePath: p, restart: true, supervised: false })
  expect(r).toEqual({ kind: "proceed" })
})

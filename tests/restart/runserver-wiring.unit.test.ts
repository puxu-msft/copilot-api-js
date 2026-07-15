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
import {
  //
  getExcludedPredecessor,
  setExcludedPredecessor,
} from "../../src/lib/restart/predecessor-registry"
import { resolveManualStartup } from "../../src/lib/restart/takeover"

// resolveManualStartup 是 Task 12 从 runServer 抽出的纯决策函数（收 supervisor 分流 +
// decideStartup + setExcludedPredecessor 三件事），承载「先登记前任、再返回决策」的
// 关键不变量（reclaim 要在 initHistory 之前读到寄存器，见 lifecycle.md）。
// runServer 本身（IO 编排：exit/writePidfile/notifyReady/signalPredecessorHandoff）
// 留给 Phase 6 e2e（tests/e2e/handover.e2e.test.ts），这里只测可隔离的纯逻辑。

const dirs: Array<string> = []
function tmpPidfile(): string {
  const d = mkdtempSync(join(tmpdir(), "runserver-wiring-"))
  dirs.push(d)
  return join(d, "copilot-api.pid")
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  setExcludedPredecessor(null) // 模块级寄存器；测试间必须复位，避免串测
})

test("supervised 环境跳过 pidfile guard（返回 skip，不碰寄存器）", () => {
  const r = resolveManualStartup({ pidfilePath: "/x", restart: false, supervised: true })
  expect(r).toEqual({ kind: "skip" })
  expect(getExcludedPredecessor()).toBeNull()
})

test("无 live 前任 → proceed（不论 flag，不碰寄存器）", () => {
  const r = resolveManualStartup({ pidfilePath: tmpPidfile(), restart: false, supervised: false })
  expect(r).toEqual({ kind: "proceed" })
  expect(getExcludedPredecessor()).toBeNull()
})

test("live 前任 + 无 --restart → refuse（不登记寄存器——不会真接管）", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 }) // pid 1 恒存活
  const r = resolveManualStartup({ pidfilePath: p, restart: false, supervised: false })
  expect(r).toEqual({ kind: "refuse", predecessor: { pid: 1, bootTime: 1, port: 4141 } })
  expect(getExcludedPredecessor()).toBeNull()
})

test("live 前任 + --restart → takeover，且已先登记前任到寄存器（reclaim 排除的关键前提）", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  expect(getExcludedPredecessor()).toBeNull() // 调用前：确认寄存器确实是空的，不是巧合通过
  const r = resolveManualStartup({ pidfilePath: p, restart: true, supervised: false })
  expect(r).toEqual({ kind: "takeover", predecessor: { pid: 1, bootTime: 1, port: 4141 } })
  expect(getExcludedPredecessor()).toEqual({ pid: 1, bootTime: 1 })
})

test("陈旧 pidfile（死 pid）→ proceed，不误登记寄存器", () => {
  const p = tmpPidfile()
  writePidfile(p, { pid: 2 ** 30, bootTime: 1, port: 4141 })
  const r = resolveManualStartup({ pidfilePath: p, restart: true, supervised: false })
  expect(r).toEqual({ kind: "proceed" })
  expect(getExcludedPredecessor()).toBeNull()
})

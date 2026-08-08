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
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  //
  isProcessAlive,
  readLivePredecessor,
  readPidfile,
  removePidfile,
  removePidfileIfOwnedBySelf,
  writePidfile,
} from "../../src/lib/restart/pidfile"

const dirs: Array<string> = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pidfile-"))
  dirs.push(d)
  return join(d, "copilot-api.pid")
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

test("write→read round-trip", () => {
  const p = tmp()
  writePidfile(p, { pid: 1234, bootTime: 999, port: 4141 })
  expect(readPidfile(p)).toEqual({ pid: 1234, bootTime: 999, port: 4141 })
})
test("readPidfile 缺失→null", () => {
  expect(readPidfile(tmp())).toBeNull()
})
test("readPidfile 损坏 JSON→null（never-throw）", () => {
  const p = tmp()
  writeFileSync(p, "{not json")
  expect(readPidfile(p)).toBeNull()
})
test("isProcessAlive：自身存活、天文数字 pid 不存活", () => {
  expect(isProcessAlive(process.pid)).toBe(true)
  expect(isProcessAlive(2 ** 30)).toBe(false)
})
test("readLivePredecessor：自身 pid 被排除（不把自己当前任）", () => {
  const p = tmp()
  writePidfile(p, { pid: process.pid, bootTime: 1, port: 4141 })
  expect(readLivePredecessor(p, process.pid)).toBeNull()
})
test("readLivePredecessor：死 pid → null", () => {
  const p = tmp()
  writePidfile(p, { pid: 2 ** 30, bootTime: 1, port: 4141 })
  expect(readLivePredecessor(p, process.pid)).toBeNull()
})
test("readLivePredecessor：活的别的进程 pid → 返回内容", () => {
  const p = tmp()
  // 用一个真实存活的其它 pid：pid 1（init）恒存活，且 ≠ 本测试进程
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  expect(readLivePredecessor(p, process.pid)).toEqual({ pid: 1, bootTime: 1, port: 4141 })
})
test("removePidfile 幂等（缺失不抛）", () => {
  const p = tmp()
  expect(() => removePidfile(p)).not.toThrow()
  writePidfile(p, { pid: 1, bootTime: 1, port: 4141 })
  removePidfile(p)
  expect(readPidfile(p)).toBeNull()
})
test("removePidfileIfOwnedBySelf：pid 匹配才删（B2 防误删后继者）", () => {
  const p = tmp()
  // 后继者已用 pid=200 覆写；自己是 pid=100 → 不该删（不是我的了）
  writePidfile(p, { pid: 200, bootTime: 2, port: 4141 })
  removePidfileIfOwnedBySelf(p, { pid: 100, bootTime: 1 })
  expect(readPidfile(p)).toEqual({ pid: 200, bootTime: 2, port: 4141 }) // 仍在
  // 若还属于自己（pid=100）→ 删
  writePidfile(p, { pid: 100, bootTime: 1, port: 4141 })
  removePidfileIfOwnedBySelf(p, { pid: 100, bootTime: 1 })
  expect(readPidfile(p)).toBeNull()
})

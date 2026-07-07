import {
  //
  afterEach,
  beforeEach,
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

import { ThinkingQuarantineStore } from "~/lib/anthropic/thinking-quarantine/store"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tsq-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
const key = { sessionId: "s1", agentId: "" }

test("record → isPoisoned true；未记录 false", () => {
  const s = new ThinkingQuarantineStore(join(dir, "q.db"), () => 72 * 3600_000)
  expect(s.isPoisoned(key)).toBe(false)
  s.record(key, "err sample")
  expect(s.isPoisoned(key)).toBe(true)
})

test("TTL 过期 → isPoisoned false；touch 滑动续期", () => {
  const ttl = 1000
  const s = new ThinkingQuarantineStore(join(dir, "q.db"), () => ttl)
  s.record(key, "e", 10_000)
  expect(s.isPoisoned(key, 10_500)).toBe(true) // 窗口内
  expect(s.isPoisoned(key, 11_001)).toBe(false) // 过期
  s.record(key, "e", 10_000)
  s.touch(key, 10_800) // 滑动
  expect(s.isPoisoned(key, 11_500)).toBe(true) // 续期后仍在
})

test("跨实例持久（重开同 db 水合）", () => {
  const p = join(dir, "q.db")
  new ThinkingQuarantineStore(p, () => 72 * 3600_000).record(key, "e", 5000)
  const s2 = new ThinkingQuarantineStore(p, () => 72 * 3600_000)
  expect(s2.isPoisoned(key, 6000)).toBe(true)
})

test("never-throw：坏路径不抛（只 warn），degraded 下内存仍服务", () => {
  const s = new ThinkingQuarantineStore("/proc/nonexistent/q.db", () => 1000)
  expect(() => s.record(key, "e")).not.toThrow()
  expect(s.isPoisoned(key)).toBe(true) // record 在 db try 前无条件 cache.set → degraded 下内存仍服务（复审 M4）
})

test("TTL 是活的 thunk：改 ttl 无需重建 store 即生效（复审 Task 10 captured-TTL 回归）", () => {
  let ttl = 1000
  const s = new ThinkingQuarantineStore(join(dir, "q.db"), () => ttl)
  s.record(key, "e", 0)
  expect(s.isPoisoned(key, 500)).toBe(true) // ttl=1000，t=500 距 record 500ms → 窗口内
  ttl = 100 // 缩短 TTL：thunk 每次 isPoisoned 调用时重新求值，无需重建 store
  expect(s.isPoisoned(key, 500)).toBe(false) // 缩短后的 ttl 立即生效 → 同一 t=500 已过期
})

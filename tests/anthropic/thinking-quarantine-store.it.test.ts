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

// A2 / spec §3.3：懒清除 —— record 新键时顺带删除已过期的旧键（DB + cache）。
// 独立 oracle：重开 store 用「巨大 TTL」水合。若 old 仍在 DB 会被水合并读 true；
// 读 false 即证明 DB 行确已删除（而非仅被 TTL 门控掩盖）。
test("record 新键时懒清除已过期旧键（DB 真删，非仅 TTL 门控）", () => {
  const p = join(dir, "q.db")
  const s = new ThinkingQuarantineStore(p, () => 1000)
  s.record({ sessionId: "old", agentId: "" }, "e", 0) // last_seen=0
  s.record({ sessionId: "fresh", agentId: "" }, "e", 5000) // old 距今 5000 > ttl 1000 → 过期被清
  expect(s.isPoisoned({ sessionId: "old", agentId: "" }, 5000)).toBe(false) // cache 已清
  expect(s.isPoisoned({ sessionId: "fresh", agentId: "" }, 5000)).toBe(true)
  // 重开用巨大 TTL：old 若仍在 DB 会水合并读 true → 读 false 证明 DB 已删
  const s2 = new ThinkingQuarantineStore(p, () => 1e12)
  expect(s2.isPoisoned({ sessionId: "old", agentId: "" }, 5000)).toBe(false) // DB 未水合 old → 已删
  expect(s2.isPoisoned({ sessionId: "fresh", agentId: "" }, 5000)).toBe(true) // 新键保留
})

// A2 / spec §3.3：安全上限 —— 超过 maxRows 时按 last_seen_at 淘汰最旧。maxRows 经
// 构造器注入（默认 1000），故可用小 cap 断言而无需写满 1000 行。
test("安全上限：超过 maxRows 按 last_seen_at 淘汰最旧，cache + DB 同步", () => {
  const p = join(dir, "q.db")
  const s = new ThinkingQuarantineStore(p, () => 72 * 3600_000, 3) // maxRows=3，巨大 TTL 排除过期干扰
  s.record({ sessionId: "a", agentId: "" }, "e", 1000)
  s.record({ sessionId: "b", agentId: "" }, "e", 2000)
  s.record({ sessionId: "c", agentId: "" }, "e", 3000)
  s.record({ sessionId: "d", agentId: "" }, "e", 4000) // 第 4 条 → 淘汰最旧的 a
  const now = 4000
  expect(s.isPoisoned({ sessionId: "a", agentId: "" }, now)).toBe(false) // 最旧被逐出（非 TTL，仍在窗口内）
  expect(s.isPoisoned({ sessionId: "b", agentId: "" }, now)).toBe(true)
  expect(s.isPoisoned({ sessionId: "c", agentId: "" }, now)).toBe(true)
  expect(s.isPoisoned({ sessionId: "d", agentId: "" }, now)).toBe(true)
  // 重开确认 a 也从 DB 逐出（未水合），d 保留
  const s2 = new ThinkingQuarantineStore(p, () => 72 * 3600_000, 3)
  expect(s2.isPoisoned({ sessionId: "a", agentId: "" }, now)).toBe(false)
  expect(s2.isPoisoned({ sessionId: "d", agentId: "" }, now)).toBe(true)
})

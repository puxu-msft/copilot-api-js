/**
 * 重试链**放弃**计数器（`retry-strategy-fires` 的对偶）。
 *
 * fire 计数回答「哪条策略救了这一轮」，本计数器回答「哪些轮次没人救」——其中 `unclaimed`
 * （没有任何策略的 `canHandle` 命中）是最该报警的一种：它意味着我方 matcher 与上游实际措辞
 * 已经漂移，客户端正在原样吃到那个错误。两起非法布局事故（2026-07-26 C2 / 2026-07-27 C3）
 * 都是在这条静默路径上发生、靠人肉贴报错才被发现的。
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"

import {
  //
  getRetryGiveUpCounts,
  recordRetryGiveUp,
  resetRetryGiveUpsForTests,
} from "~/lib/observability/retry-giveups"

describe("retry give-up counter", () => {
  beforeEach(() => {
    resetRetryGiveUpsForTests()
  })
  afterEach(() => {
    resetRetryGiveUpsForTests()
  })

  test("starts empty", () => {
    expect(getRetryGiveUpCounts()).toEqual([])
  })

  test("按 (reason, errorType) 二元组分别累加", () => {
    recordRetryGiveUp("unclaimed", "bad_request")
    recordRetryGiveUp("unclaimed", "bad_request")
    recordRetryGiveUp("unclaimed", "server_error")
    recordRetryGiveUp("strategy-abort", "bad_request")

    expect([...getRetryGiveUpCounts()].sort((a, b) => `${a.reason}${a.errorType}`.localeCompare(`${b.reason}${b.errorType}`))).toEqual([
      { reason: "strategy-abort", errorType: "bad_request", count: 1 },
      { reason: "unclaimed", errorType: "bad_request", count: 2 },
      { reason: "unclaimed", errorType: "server_error", count: 1 },
    ])
  })

  test("errorType 缺失时退化为 unknown，而不是把两类合并", () => {
    recordRetryGiveUp("unclaimed", undefined)
    recordRetryGiveUp("unclaimed", "bad_request")
    const rows = getRetryGiveUpCounts()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.errorType === "unknown")?.count).toBe(1)
  })

  // 二元组用 NUL 拼 key 再拆回来。若哪天换成可打印分隔符（如 ":"），一个含该字符的
  // errorType 就会把 key 拆错位——这里用带分隔符字面量的 errorType 钉住往返正确性。
  test("errorType 含冒号/空格也能原样往返（key 拼接不串位）", () => {
    recordRetryGiveUp("budget-exhausted", "weird:type with space")
    expect(getRetryGiveUpCounts()).toEqual([{ reason: "budget-exhausted", errorType: "weird:type with space", count: 1 }])
  })

  test("快照是副本：改它不影响活计数器", () => {
    recordRetryGiveUp("strategy-threw", "bad_request")
    const snapshot = getRetryGiveUpCounts() as unknown as Array<{ count: number }>
    snapshot[0].count = 999
    expect(getRetryGiveUpCounts()[0].count).toBe(1)
  })

  test("resetRetryGiveUpsForTests 清空全部计数", () => {
    recordRetryGiveUp("unclaimed", "bad_request")
    resetRetryGiveUpsForTests()
    expect(getRetryGiveUpCounts()).toEqual([])
  })
})

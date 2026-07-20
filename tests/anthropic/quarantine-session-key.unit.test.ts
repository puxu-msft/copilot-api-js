import {
  //
  expect,
  test,
} from "bun:test"

import {
  //
  keyString,
  toQuarantineKey,
} from "~/lib/anthropic/thinking-quarantine/session-key"

test("主 agent（agentId undefined）→ 归一空串", () => {
  expect(toQuarantineKey("sess-1", undefined)).toEqual({ sessionId: "sess-1", agentId: "" })
})
test("子 agent 保留 id", () => {
  expect(toQuarantineKey("sess-1", "agent-9")).toEqual({ sessionId: "sess-1", agentId: "agent-9" })
})
test("无 sessionId → null（不可 durable 隔离）", () => {
  expect(toQuarantineKey(undefined, "agent-9")).toBeNull()
})
test("keyString 稳定唯一", () => {
  expect(keyString({ sessionId: "s", agentId: "" })).toBe(`["s",""]`)
  expect(keyString({ sessionId: "s", agentId: "a" })).toBe(`["s","a"]`)
  // 抗碰撞：含分隔符的字段不会串位（空格 join 会碰撞成 "a b c"，JSON 编码不会）
  expect(keyString({ sessionId: "a b", agentId: "c" })).not.toBe(keyString({ sessionId: "a", agentId: "b c" }))
})

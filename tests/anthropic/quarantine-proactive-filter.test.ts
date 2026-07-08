/**
 * L3 proactive strip-all filter — the CONSUMER of the durable quarantine store
 * (the producer is the strip-all retry's `onResolved` commit, Task 10).
 *
 * Before a request goes upstream, if its `(session, agent)` conversation is a
 * known-poisoned one still within TTL, this env-aware `RequestRewrite` strips ALL
 * thinking proactively + slides the TTL, so the turn never re-hits GHC's
 * "thinking cannot be modified" 400 (which would otherwise force the reactive L2
 * strip-all retry round-trip on every turn).
 *
 * `order: 250` is load-bearing: strictly BELOW `ORDER_SANITIZE` (300, the L1
 * de-stack sanitize). Execution order is by the sorted `.order` key, NOT array
 * position — running strip-all BEFORE de-stack means a quarantined turn has no
 * thinking left, so de-stack is a no-op and leaves no orphan synthetic markers.
 *
 * Oracle: a REAL `ThinkingQuarantineStore` pointed at a temp dir (DI — never the
 * real `~/.local/share`), pre-recorded via its OWN write path, read back via its
 * OWN `isPoisoned`. A spy on `touch` proves slide-on-hit INDEPENDENTLY of the
 * 72h `isPoisoned` window (which would read true regardless), and its absence
 * proves the no-op branches never slid a non-hit.
 */

import {
  //
  afterEach,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test"
import {
  //
  mkdtempSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type {
  //
  MessageParam,
  MessagesPayload,
} from "~/types/api/anthropic"

import { createQuarantineProactiveFilter } from "~/lib/anthropic/thinking-quarantine/proactive-filter"
import { ThinkingQuarantineStore } from "~/lib/anthropic/thinking-quarantine/store"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

// Content-block factories (mirror strip-all-thinking.test.ts).
const think = (sig: string) => ({ type: "thinking", thinking: "", signature: sig })
const text = (t: string) => ({ type: "text", text: t })

let dir: string
let store: ThinkingQuarantineStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tsq-proactive-"))
  store = new ThinkingQuarantineStore(join(dir, "q.db"), () => 72 * 3600_000)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * Minimal envelope exercising exactly the surface `apply` reads: `clientFormat`,
 * `ctx.{sessionId,agentId}`, `body.messages`, and a functional `with({ body })`
 * (shallow copy + patch via a closure over `env`, mirroring the codec's real
 * `makeEnvelope` contract — the `changed:true` branch must derive a NEW env).
 */
function makeEnv(opts: { sessionId?: string; agentId?: string; messages: Array<unknown> }): RequestEnvelope {
  const body = { model: "claude-x", max_tokens: 8, messages: opts.messages } as unknown as MessagesPayload
  const env = {
    clientFormat: "anthropic" as const,
    ctx: { sessionId: opts.sessionId, agentId: opts.agentId },
    body,
    with(patch: { body?: unknown }) {
      return { ...env, ...patch } as unknown as RequestEnvelope
    },
  }
  return env as unknown as RequestEnvelope
}

/** Independent oracle: collect every residual thinking/redacted_thinking block type. */
function thinkingTypesIn(messages: Array<MessageParam>): Array<string> {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string }>) : []))
    .map((b) => b.type)
    .filter((t) => t === "thinking" || t === "redacted_thinking")
}

test("order 250 (< ORDER_SANITIZE 300) — runs before L1 de-stack", () => {
  const filter = createQuarantineProactiveFilter({ store })
  expect(filter.order).toBe(250)
  expect(filter.order).toBeLessThan(300)
})

test("appliesTo gates on anthropic clientFormat", () => {
  const filter = createQuarantineProactiveFilter({ store })
  expect(filter.appliesTo({ clientFormat: "anthropic" } as unknown as RequestEnvelope)).toBe(true)
  expect(filter.appliesTo({ clientFormat: "openai-cc" } as unknown as RequestEnvelope)).toBe(false)
})

test("中毒会话 → strip 全部 thinking + touch 续期，changed=true", () => {
  setStateForTests({ poisonedThinkingQuarantine: true })
  store.record({ sessionId: "s1", agentId: "" }, "thinking cannot be modified")
  const touchSpy = spyOn(store, "touch")

  const filter = createQuarantineProactiveFilter({ store })
  // ctx.sessionId="s1", agentId undefined → toQuarantineKey 归一为 "" → 命中已记录键。
  const env = makeEnv({ sessionId: "s1", messages: [{ role: "assistant", content: [think("sig"), text("hi")] }] })
  const result = filter.apply(env)

  expect(result.changed).toBe(true)
  const outMessages = (result.env.body as MessagesPayload).messages
  expect(thinkingTypesIn(outMessages)).toEqual([]) // 无 thinking 残留
  expect((outMessages[0].content as Array<{ type: string }>).map((b) => b.type)).toEqual(["text"])
  expect(touchSpy).toHaveBeenCalledTimes(1) // slide-on-hit（独立 oracle，不靠 72h 窗口）
  expect(store.isPoisoned({ sessionId: "s1", agentId: "" })).toBe(true) // 续期后仍中毒
})

test("非中毒会话（store 空）→ changed=false，body 原样同引用不动", () => {
  setStateForTests({ poisonedThinkingQuarantine: true })
  const touchSpy = spyOn(store, "touch")
  const filter = createQuarantineProactiveFilter({ store })
  const env = makeEnv({ sessionId: "s1", messages: [{ role: "assistant", content: [think("sig"), text("hi")] }] })
  const before = env.body

  const result = filter.apply(env)

  expect(result.changed).toBe(false)
  expect(result.env.body).toBe(before) // 未走 env.with()，返回原 env
  expect(touchSpy).not.toHaveBeenCalled()
})

test("state.poisonedThinkingQuarantine=false → no-op（总开关关闭，即便已中毒）", () => {
  setStateForTests({ poisonedThinkingQuarantine: false })
  store.record({ sessionId: "s1", agentId: "" }, "e") // 已中毒，但开关关闭 → 仍不动
  const touchSpy = spyOn(store, "touch")
  const filter = createQuarantineProactiveFilter({ store })
  const env = makeEnv({ sessionId: "s1", messages: [{ role: "assistant", content: [think("sig"), text("hi")] }] })
  const before = env.body

  const result = filter.apply(env)

  expect(result.changed).toBe(false)
  expect(result.env.body).toBe(before)
  expect(touchSpy).not.toHaveBeenCalled()
})

test("无 sessionId → no-op（无法跨轮量化，toQuarantineKey 返回 null 直接短路）", () => {
  setStateForTests({ poisonedThinkingQuarantine: true })
  const touchSpy = spyOn(store, "touch")
  const filter = createQuarantineProactiveFilter({ store })
  const env = makeEnv({ messages: [{ role: "assistant", content: [think("sig"), text("hi")] }] }) // 无 sessionId
  const before = env.body

  const result = filter.apply(env)

  expect(result.changed).toBe(false)
  expect(result.env.body).toBe(before)
  expect(touchSpy).not.toHaveBeenCalled()
})

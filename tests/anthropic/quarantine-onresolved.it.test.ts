/**
 * L3 commit — `onResolved` durably quarantines the poisoned `(session, agent)`
 * conversation when THIS strategy's strip-all retry ultimately succeeded (Task 10).
 *
 * The driver calls `onResolved(env, meta)` ONLY when a retry produced by this
 * strategy resolved the turn, threading that retry's `meta`. onResolved reads
 * `env.ctx.{sessionId,agentId}` and records to the DURABLE store, gated on THREE
 * conditions:
 *   1. `state.poisonedThinkingQuarantine` (the L3 master switch), AND
 *   2. `meta.strippedThinkingOnReject` present (OUR strip-all caused the success —
 *      not some other strategy's retry that happened to succeed later), AND
 *   3. a resolvable key (`sessionId` present — no session id → cannot durably
 *      quarantine across turns, so degrade to no-op).
 *
 * Oracle: assert via the store's OWN read path (`isPoisoned`), an oracle
 * independent of onResolved's internals, on a real `ThinkingQuarantineStore`
 * pointed at a temp dir (DI — never touch the real `~/.local/share`). A fresh
 * store per test means `isPoisoned === false` proves NOTHING was recorded.
 */

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

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import { ThinkingQuarantineStore } from "~/lib/anthropic/thinking-quarantine/store"
import { createPoisonedThinkingRetryStrategy } from "~/lib/codec/anthropic/poisoned-thinking-retry"
import { setStateForTests } from "~/lib/state"

import { autoRestoreState } from "../helpers/state-fixture"

autoRestoreState()

let dir: string
let store: ThinkingQuarantineStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tsq-onresolved-"))
  store = new ThinkingQuarantineStore(join(dir, "q.db"), () => 72 * 3600_000)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// onResolved reads ONLY `env.ctx.{sessionId,agentId}`; a minimal object typed as
// the envelope (per the Task 10 brief) exercises exactly that surface without
// standing up a full parse pipeline.
function envWith(sessionId: string | undefined, agentId: string | undefined): RequestEnvelope {
  return { ctx: { sessionId, agentId } } as unknown as RequestEnvelope
}

test('strip-all 成功 → 从 env.ctx 落库（agentId undefined 归一为 ""）', () => {
  setStateForTests({ poisonedThinkingQuarantine: true })
  const strategy = createPoisonedThinkingRetryStrategy({ store })
  strategy.onResolved?.(envWith("s1", undefined), { strippedThinkingOnReject: 2 })
  expect(store.isPoisoned({ sessionId: "s1", agentId: "" })).toBe(true)
})

test("无 sessionId → 不落库（无法跨轮持久量化 → 降级 no-op）", () => {
  setStateForTests({ poisonedThinkingQuarantine: true })
  const strategy = createPoisonedThinkingRetryStrategy({ store })
  strategy.onResolved?.(envWith(undefined, undefined), { strippedThinkingOnReject: 2 })
  // 独立 oracle：null-key 降级后 store 从未 record，退化的空键也不 poisoned。
  expect(store.isPoisoned({ sessionId: "", agentId: "" })).toBe(false)
})

test("state.poisonedThinkingQuarantine=false → 不落库（L3 总开关关闭）", () => {
  setStateForTests({ poisonedThinkingQuarantine: false })
  const strategy = createPoisonedThinkingRetryStrategy({ store })
  strategy.onResolved?.(envWith("s1", undefined), { strippedThinkingOnReject: 2 })
  expect(store.isPoisoned({ sessionId: "s1", agentId: "" })).toBe(false)
})

test("meta 缺 strippedThinkingOnReject → 不落库（非本策略 strip-all 促成的成功）", () => {
  setStateForTests({ poisonedThinkingQuarantine: true })
  const strategy = createPoisonedThinkingRetryStrategy({ store })
  strategy.onResolved?.(envWith("s1", undefined), {})
  expect(store.isPoisoned({ sessionId: "s1", agentId: "" })).toBe(false)
})

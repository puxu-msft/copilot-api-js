/**
 * The per-vendor resolvers read LIVE state, not a snapshot taken at import time.
 *
 * S3 moved these four functions out of `state.ts` into the config layer
 * (docs/plan/2026-07-28-state-to-foundation/HANDOVER.md). The one way that move could have gone
 * silently wrong is by turning a live read into a captured one — accept the values as parameters at
 * a call site that resolves once, or hoist a `const shared = state.x` to module scope. Everything
 * else about the migration is mechanical and typecheck catches it; this is not, and nothing else in
 * the suite would notice: config is hot-reloadable, so the damage only appears after a reload, in
 * production, as "the operator changed the config and nothing happened".
 *
 * Each test therefore resolves, mutates state, and resolves AGAIN through the same binding.
 */

import {
  //
  expect,
  test,
} from "bun:test"

import {
  //
  resolveBufferedCaps,
  resolveContinuation,
  resolveEffectiveMaxTokensContinuation,
  resolveMaxTokensContinuation,
} from "~/lib/config/model-overrides"
import {
  //
  setBufferedRetryContinuationShared,
  setBufferedRetryShared,
  setMaxTokensContinuationShared,
} from "~/lib/state"

import { useIsolatedRuntime } from "../helpers/isolated-fixture"

useIsolatedRuntime()

test("resolveBufferedCaps 跟着 state 走，而不是解析一次就冻住", () => {
  const before = resolveBufferedCaps("anthropic")
  setBufferedRetryShared({ ...before, maxRetries: before.maxRetries + 7 })
  expect(resolveBufferedCaps("anthropic").maxRetries).toBe(before.maxRetries + 7)
})

test("resolveContinuation 跟着 state 走", () => {
  const before = resolveContinuation("anthropic")
  setBufferedRetryContinuationShared({ ...before, message: "changed after first resolve" })
  expect(resolveContinuation("anthropic").message).toBe("changed after first resolve")
})

test("resolveMaxTokensContinuation 与 resolveEffectiveMaxTokensContinuation 都跟着 state 走", () => {
  const before = resolveMaxTokensContinuation("anthropic")
  setMaxTokensContinuationShared({ ...before, maxRounds: before.maxRounds + 3 })

  expect(resolveMaxTokensContinuation("anthropic").maxRounds).toBe(before.maxRounds + 3)
  // Effective 是在 resolve 之上再套一层约束，所以它也必须重新读，而不是复用上一次的结果。
  expect(resolveEffectiveMaxTokensContinuation("anthropic").maxRounds).toBe(before.maxRounds + 3)
})

test("passthrough 约束仍然生效：拼接类动作被降级、并留下诊断标记", () => {
  const before = resolveMaxTokensContinuation("anthropic")
  setMaxTokensContinuationShared({
    ...before,
    visibility: "passthrough",
    classes: { text: "continue", toolUse: "passthrough", thinking: "passthrough" },
  })

  const effective = resolveEffectiveMaxTokensContinuation("anthropic")
  expect(effective.classes).toEqual({ text: "passthrough", toolUse: "passthrough", thinking: "passthrough" })
  expect(effective.diagnostics).toEqual(["strategy-prevented-stitch"])
})

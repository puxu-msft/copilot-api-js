/**
 * Task 2 (Commit 2) — unit tests for the declarative retry-strategy registry + assembler.
 *
 * Pure addition, zero production consumers yet (Task 3 wires the three `buildXxxStrategies` to
 * `assembleRetryStrategies`). Covers: filter(appliesTo ∧ enabled) → sort(order) → payload/env
 * instantiation branches — and cross-checks the 16-name @messages order against the Task 1 golden
 * (`tests/pipeline/retry-strategy-assembly.golden.it.test.ts`).
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  RetryStrategyContext,
  RetryStrategyDeps,
} from "~/lib/request/retry-registry"
import type { SanitizeResult } from "~/lib/request/retry-types"
import type { MessagesPayload } from "~/types/api/anthropic"

import { createBetaProbe } from "~/lib/anthropic/pipeline"
import { ENDPOINT } from "~/lib/models/endpoint"
import {
  //
  assembleRetryStrategies,
  isStrategyEnabled,
  RETRY_STRATEGY_ORDER,
  RETRY_STRATEGY_REGISTRY,
} from "~/lib/request/retry-registry"

/** The frozen 16-name @messages order (mirrors the Task 1 golden's `ANTHROPIC_16_NAMES` — both must
 *  agree, since Task 3's assembler swap must reproduce it byte-for-byte). */
const ANTHROPIC_16_NAMES = [
  "network-retry",
  "server-error-retry",
  "token-refresh",
  "effort-learning",
  "tool-field-rejection-retry",
  "body-field-rejection-retry",
  "cache-control-subfield-rejection-retry",
  "legacy-thinking-retry",
  "adaptive-thinking-rejection-retry",
  "poisoned-thinking-retry",
  "unsupported-beta-retry",
  "server-tool-rejection-retry",
  "structured-outputs-rejection-retry",
  "system-reject-retry",
  "web-search-not-found-retry",
  "deferred-tool-retry",
]

const SHARED_3_NAMES = ["network-retry", "server-error-retry", "token-refresh"]

const anthropicBaseline = { model: "claude-sonnet-4", messages: [], max_tokens: 100 } as unknown as MessagesPayload
const stubResanitize = (p: MessagesPayload): SanitizeResult<MessagesPayload> => ({ payload: p, blocksRemoved: 0, systemReminderRemovals: 0 })

function stubDeps(): RetryStrategyDeps {
  return {
    attemptRef: { value: 0 },
    originalPayload: anthropicBaseline,
    model: undefined,
    maxRetries: 5,
    betaProbe: createBetaProbe(undefined),
    resanitize: stubResanitize,
    label: "test",
  }
}

const messagesCtx: RetryStrategyContext = { clientFormat: "anthropic", targetEndpoint: ENDPOINT.MESSAGES }
const ccDirectCtx: RetryStrategyContext = { clientFormat: "openai-cc", targetEndpoint: ENDPOINT.CHAT_COMPLETIONS }

describe("RETRY_STRATEGY_REGISTRY declaration", () => {
  test("has exactly 16 entries, one per RETRY_STRATEGY_ORDER key", () => {
    expect(RETRY_STRATEGY_REGISTRY).toHaveLength(16)
    expect(Object.keys(RETRY_STRATEGY_ORDER)).toHaveLength(16)
  })

  test("every declared order is unique (sort stability isn't masking a collision)", () => {
    const orders = RETRY_STRATEGY_REGISTRY.map((e) => e.order)
    expect(new Set(orders).size).toBe(orders.length)
  })

  test("410/420/430 defense-in-depth gap encodes tool-field < body-field < cache-control", () => {
    expect(RETRY_STRATEGY_ORDER.toolFieldRejection).toBeLessThan(RETRY_STRATEGY_ORDER.bodyFieldRejection)
    expect(RETRY_STRATEGY_ORDER.bodyFieldRejection).toBeLessThan(RETRY_STRATEGY_ORDER.cacheControlSubfield)
  })
})

describe("assembleRetryStrategies", () => {
  test("MESSAGES ctx → all 16 strategies in declared order", () => {
    const names = assembleRetryStrategies(messagesCtx, stubDeps(), {}).map((s) => s.name)
    expect(names).toEqual(ANTHROPIC_16_NAMES)
  })

  test("非 MESSAGES ctx（cc direct）→ 仅 3 个 shared 策略", () => {
    const names = assembleRetryStrategies(ccDirectCtx, stubDeps(), {}).map((s) => s.name)
    expect(names).toEqual(SHARED_3_NAMES)
  })

  test("undefined config（未配置）→ 默认全开，与 {} 等价（RFC §3.4 缺省=保现状）", () => {
    const names = assembleRetryStrategies(messagesCtx, stubDeps(), undefined).map((s) => s.name)
    expect(names).toEqual(ANTHROPIC_16_NAMES)
  })

  test("config 禁用 server-tool-rejection → 组装集少它、其余 15 个顺序不变", () => {
    const names = assembleRetryStrategies(messagesCtx, stubDeps(), { serverToolRejection: { enabled: false } }).map((s) => s.name)
    expect(names).not.toContain("server-tool-rejection-retry")
    expect(names).toEqual(ANTHROPIC_16_NAMES.filter((n) => n !== "server-tool-rejection-retry"))
  })

  test("config 禁用一个 shared 策略（network）→ 该 leg 也少它（跨 leg 生效）", () => {
    const names = assembleRetryStrategies(ccDirectCtx, stubDeps(), { network: { enabled: false } }).map((s) => s.name)
    expect(names).toEqual(["server-error-retry", "token-refresh"])
  })

  test("config { enabled: true } 显式开启 → 等价于未配置", () => {
    const names = assembleRetryStrategies(messagesCtx, stubDeps(), { deferredTool: { enabled: true } }).map((s) => s.name)
    expect(names).toEqual(ANTHROPIC_16_NAMES)
  })

  test('poisoned-thinking 走 kind:"env" 分支、不经 adaptPayloadStrategy（name 仍保留、canHandle/handle 可直接调用 env 签名）', () => {
    const entry = RETRY_STRATEGY_REGISTRY.find((e) => e.name === "poisoned-thinking-retry")
    expect(entry).toBeDefined()
    expect(entry?.kind).toBe("env")

    const strategies = assembleRetryStrategies(messagesCtx, stubDeps(), {})
    const poisoned = strategies.find((s) => s.name === "poisoned-thinking-retry")
    expect(poisoned).toBeDefined()
    // A native env strategy's canHandle takes just (error) — adaptPayloadStrategy's wrapper has the
    // exact same signature shape, so the real signal is that create() bypassed the adapt() call
    // entirely (asserted at the registry-declaration level above); here we just confirm it made it
    // into the assembled stack with the right name + at the declared order position.
    const orderedNames = strategies.map((s) => s.name)
    expect(orderedNames.indexOf("poisoned-thinking-retry")).toBe(orderedNames.indexOf("adaptive-thinking-rejection-retry") + 1)
  })

  test("unsupported-beta / system-reject / web-search-not-found 均要求 betaProbe/resanitize（appliesTo 都门到 MESSAGES）", () => {
    // Confirms the throwMissing invariant's PRECONDITION: every entry needing betaProbe/resanitize is
    // gated targetEndpoint===MESSAGES (never reachable from a non-MESSAGES ctx where deps lack them).
    const needsBetaProbe = ["unsupported-beta-retry"]
    const needsResanitize = ["system-reject-retry", "web-search-not-found-retry"]
    for (const name of [...needsBetaProbe, ...needsResanitize]) {
      const entry = RETRY_STRATEGY_REGISTRY.find((e) => e.name === name)
      expect(entry).toBeDefined()
      expect(entry?.appliesTo(messagesCtx)).toBe(true)
      expect(entry?.appliesTo(ccDirectCtx)).toBe(false)
    }
  })

  test("betaProbe 缺失时 unsupported-beta 的 getProbeCandidates 显式 throw（惰性闭包，触发点=handle laconic 分支，非静默 ?? [] 兜底）", async () => {
    // RFC §3.1 pseudocode / kick-off prompt 逐字：`getProbeCandidates: () => (d.betaProbe ?? throwMissing("betaProbe")).getCandidates()`
    // 是惰性闭包——assembleRetryStrategies 本身不会因 betaProbe 缺失而抛（create() 只是构造闭包，不调用它），
    // 真实触发点是 unsupported-beta 的 laconic 路径调 `opts.getProbeCandidates()`（handle() 内部）。
    const deps: RetryStrategyDeps = { ...stubDeps(), betaProbe: undefined }
    const strategies = assembleRetryStrategies(messagesCtx, deps, {})
    const unsupportedBeta = strategies.find((s) => s.name === "unsupported-beta-retry")
    expect(unsupportedBeta).toBeDefined()
    const laconicError = { type: "bad_request" as const, status: 400, message: "invalid beta flag", raw: undefined }
    await expect(unsupportedBeta!.handle(laconicError, {} as never)).rejects.toThrow(/betaProbe/)
  })

  test("resanitize 缺失时 system-reject 的 create 显式 throw（非静默 ?? [] 兜底）", () => {
    const deps: RetryStrategyDeps = { ...stubDeps(), resanitize: undefined }
    expect(() => assembleRetryStrategies(messagesCtx, deps, {})).toThrow(/resanitize/)
  })
})

describe("isStrategyEnabled", () => {
  test("缺省（config=undefined）→ true", () => {
    expect(isStrategyEnabled(undefined, "network")).toBe(true)
  })

  test("键缺失（config={}）→ true", () => {
    expect(isStrategyEnabled({}, "network")).toBe(true)
  })

  test("enabled:false → false", () => {
    expect(isStrategyEnabled({ network: { enabled: false } }, "network")).toBe(false)
  })

  test("enabled:true → true", () => {
    expect(isStrategyEnabled({ network: { enabled: true } }, "network")).toBe(true)
  })

  test("enabled 省略（{}）→ true（只有显式 false 才禁用）", () => {
    expect(isStrategyEnabled({ network: {} }, "network")).toBe(true)
  })
})

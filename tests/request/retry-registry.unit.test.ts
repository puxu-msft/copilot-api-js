/**
 * Task 2 (Commit 2) — unit tests for the declarative retry-strategy registry + assembler.
 *
 * Pure addition, zero production consumers yet (Task 3 wires the three `buildXxxStrategies` to
 * `assembleRetryStrategies`). Covers: filter(appliesTo ∧ enabled) → sort(order) → payload/env
 * instantiation branches — and cross-checks the 16-name @messages order against the Task 1 golden
 * (`tests/pipeline/retry-strategy-assembly.golden.it.test.ts`).
 *
 * Task 4 addendum (Commit 4, reviewer suggestion 2 from the Task 3 review): a behavioral regression test
 * for the shared `attemptRef` — `assembleRetryStrategies` constructs ONE `{ value: 0 }` ref per call site
 * (the three `buildXxxStrategies`, RFC §3.1/§6 "per-request deps + declarative create") and every payload
 * entry it assembles is adapted with THAT SAME ref (`adaptPayloadStrategy`'s `deps.attemptRef`). This test
 * fixes the Task 3 reviewer's manual probe into a permanent regression test guarding against a future
 * refactor silently giving each entry its own fresh `{ value: 0 }` (which would desync the shared 0-based
 * execution index every payload strategy's log lines / `RetryContext.attempt` depend on).
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"
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
  getRetryStrategyRegistryDiagnostics,
  isStrategyEnabled,
  RETRY_STRATEGY_ORDER,
  RETRY_STRATEGY_REGISTRY,
} from "~/lib/request/retry-registry"

import {
  //
  ANTHROPIC_16_NAMES,
  SHARED_3_NAMES,
} from "../helpers/retry-strategy-names"

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
  }
}

const messagesCtx: RetryStrategyContext = { clientFormat: "anthropic", targetEndpoint: ENDPOINT.MESSAGES }
const ccDirectCtx: RetryStrategyContext = { clientFormat: "openai-cc", targetEndpoint: ENDPOINT.CHAT_COMPLETIONS }

describe("RETRY_STRATEGY_REGISTRY declaration", () => {
  test("has exactly 16 entries, one per RETRY_STRATEGY_ORDER key", () => {
    expect(RETRY_STRATEGY_REGISTRY).toHaveLength(16)
    expect(Object.keys(RETRY_STRATEGY_ORDER)).toHaveLength(16)
  })

  test("every entry.configKey is EXACTLY one RETRY_STRATEGY_ORDER key — full-set parity (drift-guard 3rd leg, whole-branch review)", () => {
    // Closes the third leg of the parity triangle (schema↔ORDER and config.ts SHARED-set↔registry are already
    // guarded). Without this, a typo'd `configKey: "adaptiveThinkingRejction"` still compiles (its `order:`
    // references the ORDER object, not the string) but silently no-ops the `retry.strategies.<key>.enabled`
    // switch via isStrategyEnabled AND reports a stale key in diagnostics — with no test to catch it.
    expect(new Set(RETRY_STRATEGY_REGISTRY.map((e) => e.configKey))).toEqual(new Set(Object.keys(RETRY_STRATEGY_ORDER)))
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

// ============================================================================
// Registry diagnostics projection (Task 5 / RFC §3.5 — GET /api/config exposure)
// ============================================================================

describe("getRetryStrategyRegistryDiagnostics", () => {
  test("returns exactly 16 entries, one per RETRY_STRATEGY_REGISTRY entry", () => {
    const diag = getRetryStrategyRegistryDiagnostics(undefined)
    expect(diag).toHaveLength(16)
    expect(new Set(diag.map((d) => d.name))).toEqual(new Set(RETRY_STRATEGY_REGISTRY.map((e) => e.name)))
  })

  test("each entry projects name/configKey/order + a scope derived from appliesTo (not hardcoded)", () => {
    const diag = getRetryStrategyRegistryDiagnostics(undefined)
    const network = diag.find((d) => d.name === "network-retry")
    expect(network).toEqual({ name: "network-retry", configKey: "network", order: RETRY_STRATEGY_ORDER.network, scope: "shared", enabled: true })

    const serverToolRejection = diag.find((d) => d.name === "server-tool-rejection-retry")
    expect(serverToolRejection).toEqual({
      name: "server-tool-rejection-retry",
      configKey: "serverToolRejection",
      order: RETRY_STRATEGY_ORDER.serverToolRejection,
      scope: "messages-only",
      enabled: true,
    })
  })

  test("scope is probed via appliesTo against representative contexts (messages vs cc-direct), not a hardcoded list — every anthropic-only entry reports messages-only, every shared entry reports shared", () => {
    const diag = getRetryStrategyRegistryDiagnostics(undefined)
    const sharedNames = new Set(["network-retry", "server-error-retry", "token-refresh"])
    for (const entry of diag) {
      if (sharedNames.has(entry.name)) expect(entry.scope).toBe("shared")
      else expect(entry.scope).toBe("messages-only")
    }
  })

  test("undefined config → every entry reports enabled:true (RFC §3.4 default-all-on)", () => {
    const diag = getRetryStrategyRegistryDiagnostics(undefined)
    expect(diag.every((d) => d.enabled)).toBe(true)
  })

  test("a disabled configKey reports enabled:false on that entry only", () => {
    const diag = getRetryStrategyRegistryDiagnostics({ serverToolRejection: { enabled: false } })
    const disabled = diag.find((d) => d.name === "server-tool-rejection-retry")
    expect(disabled?.enabled).toBe(false)
    expect(diag.filter((d) => !d.enabled)).toHaveLength(1)
  })

  test("results are ordered by declared assembly order (matches assembleRetryStrategies' sort)", () => {
    const diag = getRetryStrategyRegistryDiagnostics(undefined)
    const orders = diag.map((d) => d.order)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })
})

// ============================================================================
// attemptRef sharing regression (Task 4, Task 3 reviewer suggestion 2)
// ============================================================================

/** Minimal fake `RequestEnvelope` — the shared-3 payload strategies only read `env.body`
 *  (via the adapter's `env.body as TPayload`) and return `env.with(patch)`. */
function makeFakeEnv(body: unknown): RequestEnvelope {
  return {
    body,
    prepareHints: {},
    with(patch: Partial<RequestEnvelope>): RequestEnvelope {
      return { ...this, ...patch } as RequestEnvelope
    },
  } as unknown as RequestEnvelope
}

describe("attemptRef sharing across assembled payload strategies (behavioral regression)", () => {
  let infoSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    const noop = Object.assign(() => undefined, { raw: () => undefined })
    infoSpy = spyOn(consola, "info").mockImplementation(noop)
  })

  afterEach(() => {
    infoSpy.mockRestore()
  })

  /** Extract the "Attempt N/M" number logged by network-retry / server-error-retry / token-refresh. */
  function loggedAttemptNumbers(): Array<number> {
    return (infoSpy.mock.calls as Array<Array<unknown>>)
      .map((args) => String(args[0]))
      .flatMap((line: string) => {
        const m = /Attempt (\d+)\//.exec(line)
        return m ? [Number(m[1])] : []
      })
  }

  test("one assembleRetryStrategies() call shares ONE attemptRef across ALL assembled entries — driving network-retry's handle() advances the SAME counter server-error-retry observes next", async () => {
    // A single assembleRetryStrategies() call (mirrors ONE call site inside a `buildXxxStrategies`, which
    // constructs exactly one `{ value: 0 }` and passes it in `deps` — see anthropic/strategies.ts:88,
    // openai-cc/strategies.ts:48, openai-responses/strategies.ts:47). ccDirectCtx assembles the 3 SHARED
    // payload strategies (network / server-error / token-refresh), all adapted with the SAME attemptRef
    // instance constructed for THIS call.
    const strategies = assembleRetryStrategies(ccDirectCtx, stubDeps(), {})
    const network = strategies.find((s) => s.name === "network-retry")
    const serverError = strategies.find((s) => s.name === "server-error-retry")
    expect(network).toBeDefined()
    expect(serverError).toBeDefined()

    // Attempt 1: drive network-retry's handle() — its adapter reads attemptRef.value (0), logs
    // "Attempt 1/...", then increments attemptRef.value to 1 (payload-strategy-adapter.ts:79).
    const networkError = { type: "network_error" as const, status: 0, message: "ECONNRESET", raw: undefined }
    await network!.handle(networkError, makeFakeEnv({ v: 1 }))

    // Attempt 2: drive server-error-retry's handle() on the SAME assembled stack — if attemptRef were NOT
    // shared (e.g. a future refactor gives each entry its own fresh `{ value: 0 }`), this would observe
    // attempt=0 and log "Attempt 1/...", identical to network-retry's own first attempt — the regression
    // this test exists to catch.
    const serverErr = { type: "server_error" as const, status: 502, message: "Bad Gateway", raw: undefined }
    await serverError!.handle(serverErr, makeFakeEnv({ v: 1 }))

    const attempts = loggedAttemptNumbers()
    expect(attempts).toEqual([1, 2]) // network-retry saw attempt=0 (logs "1"), server-error-retry saw attempt=1 (logs "2") — SAME shared counter, advanced by the first handle()
  })

  test("two SEPARATE assembleRetryStrategies() calls each get their OWN fresh attemptRef (no cross-request leakage)", async () => {
    const requestA = assembleRetryStrategies(ccDirectCtx, stubDeps(), {})
    const requestB = assembleRetryStrategies(ccDirectCtx, stubDeps(), {})

    const networkA = requestA.find((s) => s.name === "network-retry")!
    const networkB = requestB.find((s) => s.name === "network-retry")!
    const networkError = { type: "network_error" as const, status: 0, message: "ECONNRESET", raw: undefined }

    // Advance request A's shared attemptRef twice (network-retry only handles once due to its own
    // `hasRetried` one-shot guard, so use it once, then drive it again via a fresh assembly to prove
    // independence — the key assertion is request B's counter starts back at 0 regardless of A's state).
    await networkA.handle(networkError, makeFakeEnv({ v: 1 }))
    await networkB.handle(networkError, makeFakeEnv({ v: 1 }))

    const attempts = loggedAttemptNumbers()
    // Both requests' network-retry independently observed attempt=0 on their FIRST handle (both log "1")
    // — proving request B's attemptRef was NOT advanced by request A's prior handle().
    expect(attempts).toEqual([1, 1])
  })
})

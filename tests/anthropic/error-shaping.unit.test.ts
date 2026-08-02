/**
 * Unit tests for the error-shaping decision engine (`src/lib/anthropic/error-shaping.ts`).
 *
 * Pure functions — no runtime, no I/O. Locks:
 *  - the 11-type × commitPhase × config decision truth table (task 1.1)
 *  - `buildCanonicalErrorFrame` + the absorbed `anthropicStreamErrorType` mapping (task 1.2, G-3)
 *  - the `SyntheticOriginKind` extension (task 1.3)
 *  - `renderAuqQuestion` two-pass semantics + B-class `questions` content (task 1.4)
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  ApiError,
  ApiErrorType,
} from "~/lib/error"

import {
  //
  buildCanonicalErrorFrame,
  classifyStreamErrorType,
  decide,
  DEFAULT_AUQ_TEMPLATE,
  renderAuqQuestion,
  streamErrorKindToAnthropicErrorType,
  type ErrorShapingConfig,
} from "~/lib/anthropic/error-shaping"
import {
  //
  readSyntheticKind,
  tagFrameSynthetic,
} from "~/lib/pipeline/frame-origin"
import {
  //
  classifyStreamError,
  StreamClientAbortError,
  StreamDispatchCancelError,
  type StreamErrorKind,
  StreamIdleTimeoutError,
  StreamReaperCancelError,
  StreamRequestCancelError,
  StreamRequestDeadlineError,
  StreamShutdownError,
  StreamUnknownCancelError,
} from "~/lib/stream"

const baseConfig: ErrorShapingConfig = { enabled: true, askUserQuestion: false, auqTemplate: "", selfhealDelegate: {} }
const mk = (type: ApiErrorType, status: number, extra: Partial<ApiError> = {}): ApiError => ({ type, status, message: "boom", raw: null, ...extra })

describe("decide() — pre-commit truth table", () => {
  test.each([
    ["rate_limited", 429],
    ["server_error", 500],
    ["upstream_rate_limited", 503],
    ["network_error", 0],
  ] as const)("A类可重试(%s) pre-commit → retry-signal", (type, status) => {
    const d = decide({ error: mk(type, status, { retryAfter: 30 }), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
    expect(d.kind).toBe("retry-signal")
    if (d.kind === "retry-signal") expect(d.retryAfterSec).toBe(30)
  })

  test("quota_exceeded(402) pre-commit, askUserQuestion=false → canonical-error（非目标：402 从不算 A 类）", () => {
    const d = decide({ error: mk("quota_exceeded", 402, { retryAfter: 3600 }), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
    expect(d.kind).toBe("canonical-error")
  })

  test("quota_exceeded(402) pre-commit, askUserQuestion=true → ask-user-question", () => {
    const d = decide({
      error: mk("quota_exceeded", 402),
      commitPhase: "pre-commit",
      clientVisibleStopEmitted: false,
      config: { ...baseConfig, askUserQuestion: true },
    })
    expect(d.kind).toBe("ask-user-question")
  })

  test("content_filtered(422) pre-commit, askUserQuestion=true → ask-user-question", () => {
    const d = decide({
      error: mk("content_filtered", 422),
      commitPhase: "pre-commit",
      clientVisibleStopEmitted: false,
      config: { ...baseConfig, askUserQuestion: true },
    })
    expect(d.kind).toBe("ask-user-question")
  })

  test.each([401, 403])(
    "auth_expired(%i) pre-commit, askUserQuestion=true → ask-user-question（token-refresh 已在更早的 RetryStrategy 层耗尽才会走到这里，decide() 不区分 401/403）",
    (status) => {
      const d = decide({
        error: mk("auth_expired", status),
        commitPhase: "pre-commit",
        clientVisibleStopEmitted: false,
        config: { ...baseConfig, askUserQuestion: true },
      })
      expect(d.kind).toBe("ask-user-question")
    },
  )

  test.each(["token_limit", "payload_too_large", "bad_request"] as const)("C类(%s) pre-commit → canonical-error 且 askUserQuestion 开关不影响结果", (type) => {
    const d1 = decide({ error: mk(type, 400), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })
    const d2 = decide({ error: mk(type, 400), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: { ...baseConfig, askUserQuestion: true } })
    expect(d1.kind).toBe("canonical-error")
    expect(d2.kind).toBe("canonical-error")
  })

  test("aborted 从不应调用 decide()（非目标）— 传入抛出，作为误用护栏", () => {
    expect(() => decide({ error: mk("aborted", 0), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: baseConfig })).toThrow(/aborted/i)
  })
})

describe("decide() — post-commit：status 已锁定，A类不再有 retry-signal 选项", () => {
  test.each(["rate_limited", "server_error", "upstream_rate_limited", "network_error"] as const)(
    "A类(%s) post-commit → canonical-error（不是 retry-signal，也不是 defer-to-block-level——这两者只属于非 ApiError 的截断/RST 分支，见 Phase 3 说明）",
    (type) => {
      const d = decide({ error: mk(type, 500), commitPhase: "post-commit", clientVisibleStopEmitted: false, config: baseConfig })
      expect(d.kind).toBe("canonical-error")
    },
  )

  test("quota_exceeded(402) post-commit — 无论 askUserQuestion 开关，恒 canonical-error（AUQ 是 pre-commit 整段合成，post-commit 状态已锁定无法整段替换）", () => {
    const d = decide({
      error: mk("quota_exceeded", 402),
      commitPhase: "post-commit",
      clientVisibleStopEmitted: false,
      config: { ...baseConfig, askUserQuestion: true },
    })
    expect(d.kind).toBe("canonical-error")
  })

  test.each([true, false])(
    "clientVisibleStopEmitted=%s 对 post-commit ApiError 真值表结果无影响（当前不变量；Phase 6 的 defer-to-block-level 子决策不经过这张真值表，见本文档说明）",
    (stop) => {
      const d = decide({ error: mk("server_error", 500), commitPhase: "post-commit", clientVisibleStopEmitted: stop, config: baseConfig })
      expect(d.kind).toBe("canonical-error")
    },
  )
})

// ============================================================================
// Task 1.2 — buildCanonicalErrorFrame + classifyStreamErrorType (G-3)
// ============================================================================

describe("buildCanonicalErrorFrame", () => {
  test("canonical-error decision → Anthropic event:error frame, retry_after preserved", () => {
    const frame = buildCanonicalErrorFrame({ kind: "canonical-error", errorType: "rate_limit_error", message: "slow down", retryAfterSec: 30 })
    expect(frame.event).toBe("error")
    const data = JSON.parse(frame.data ?? "{}") as unknown
    expect(data).toEqual({ type: "error", error: { type: "rate_limit_error", message: "slow down", retry_after: 30 } })
  })

  test("no retryAfterSec → retry_after field omitted (not null/undefined literal)", () => {
    const frame = buildCanonicalErrorFrame({ kind: "canonical-error", errorType: "api_error", message: "boom" })
    const data = JSON.parse(frame.data ?? "{}") as { error: Record<string, unknown> }
    expect(data.error).toEqual({ type: "api_error", message: "boom" })
    expect(data.error).not.toHaveProperty("retry_after")
  })
})

describe("classifyStreamErrorType — 收编 streaming-pump.ts:anthropicStreamErrorType 的逻辑", () => {
  // Every clock WE run out reports as a timeout — the frame-idle watchdog, the hard
  // request deadline, and the stale-request reaper (`stale_request_max_age` expiring IS
  // a deadline). Grouping them is what stopped a hard deadline from reaching the client
  // as a generic `api_error` on the live path while the codec's private copy said otherwise.
  test.each([
    [new StreamIdleTimeoutError(300_000), "idle-timeout"],
    [new StreamRequestDeadlineError(), "request-deadline"],
    [new StreamReaperCancelError(), "reaper-cancel"],
  ])("our own clock running out → timeout_error (%s)", (err) => {
    expect(classifyStreamErrorType(err)).toBe("timeout_error")
  })

  test("shutdown → overloaded_error (the one genuinely retry-now condition)", () => {
    expect(classifyStreamErrorType(new StreamShutdownError())).toBe("overloaded_error")
  })

  // Anthropic's wire has no cancellation literal, so the cancel kinds honestly degrade to
  // the generic bucket rather than borrowing an unrelated one.
  test.each([new StreamUnknownCancelError(), new StreamRequestCancelError(), new Error("transport reset"), "not an error", null])(
    "no matching Anthropic literal → api_error (%p)",
    (err) => {
      expect(classifyStreamErrorType(err)).toBe("api_error")
    },
  )

  test("the live mapper and the v4 codec agree on every kind (they used to drift)", () => {
    // The codec's `formatError` imports `streamErrorKindToAnthropicErrorType`; this asserts
    // the wrapper the handler calls resolves to the same table for each kind. A private copy
    // in either place is what let a "landed" deadline mapping never reach the wire.
    const cases: Array<[Error, StreamErrorKind]> = [
      [new StreamIdleTimeoutError(1000), "idle-timeout"],
      [new StreamShutdownError(), "shutdown"],
      [new StreamClientAbortError(), "client-abort"],
      [new StreamReaperCancelError(), "reaper-cancel"],
      [new StreamRequestDeadlineError(), "request-deadline"],
      [new StreamRequestCancelError(), "request-cancel"],
      [new StreamDispatchCancelError(), "dispatch-cancel"],
      [new StreamUnknownCancelError(), "unknown-cancel"],
      [new Error("boom"), "other"],
    ]
    for (const [error, kind] of cases) {
      expect(classifyStreamError(error)).toBe(kind)
      expect(classifyStreamErrorType(error)).toBe(streamErrorKindToAnthropicErrorType(kind))
    }
  })
})

// ============================================================================
// Task 1.3 — SyntheticOriginKind extension
// ============================================================================

describe("SyntheticOriginKind — error-shaping members", () => {
  test.each(["error-shaping-auq", "error-shaping-canonical"] as const)("accepts %s", (kind) => {
    const f = tagFrameSynthetic({ event: "error", data: "{}" }, kind)
    expect(readSyntheticKind(f)).toBe(kind)
  })
})

// ============================================================================
// Task 1.4 — renderAuqQuestion two-pass render + B-class questions content
// ============================================================================

describe("renderAuqQuestion — 两遍渲染语义", () => {
  test("只传 error_type/status → {model}/{request_id} 原样保留未渲染", () => {
    const text = renderAuqQuestion("model={model} req={request_id} type={error_type} status={status}", { error_type: "quota_exceeded", status: "402" })
    expect(text).toBe("model={model} req={request_id} type=quota_exceeded status=402")
  })

  test("第二遍只传 model/request_id → 补全剩余占位符，得到完全渲染结果", () => {
    const pass1 = renderAuqQuestion("model={model} req={request_id} type={error_type} status={status}", { error_type: "quota_exceeded", status: "402" })
    const pass2 = renderAuqQuestion(pass1, { model: "claude-3-5-sonnet-latest", request_id: "req_test" })
    expect(pass2).toBe("model=claude-3-5-sonnet-latest req=req_test type=quota_exceeded status=402")
  })

  test("不存在 {message} 占位符——DEFAULT_AUQ_TEMPLATE 只使用 spec 给定的 4 个占位符", () => {
    expect(DEFAULT_AUQ_TEMPLATE).not.toContain("{message}")
    expect(DEFAULT_AUQ_TEMPLATE).not.toContain("{{message}}")
  })
})

describe("decide() B 类分支 — questions 内容构造", () => {
  const auqConfig: ErrorShapingConfig = { enabled: true, askUserQuestion: true, auqTemplate: "", selfhealDelegate: {} }
  const mkErr = (type: ApiErrorType, status: number): ApiError => ({ type, status, message: "boom", raw: null })

  test("quota_exceeded(402) → questions 长度 1，header/options 按 errorType 分派，question 文本含未渲染的 {model}/{request_id}", () => {
    const d = decide({ error: mkErr("quota_exceeded", 402), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: auqConfig })
    if (d.kind !== "ask-user-question") throw new Error("expected ask-user-question")
    expect(d.questions).toHaveLength(1)
    const q = d.questions[0]
    expect(q.question).toContain("{model}")
    expect(q.question).toContain("{request_id}")
    expect(q.question).not.toContain("{error_type}") // 已被第一遍渲染替换
    expect(q.question).not.toContain("{status}")
    expect(q.multiSelect).toBe(false)
    expect(q.options.length).toBeGreaterThan(0)
    // FIX-A: options are CC-schema {label, description} objects (NOT plain strings) — the shape real
    // Claude Code validates (see tests/infra/debug-dry-run-pipeline.http.test.ts:108 real traffic).
    for (const opt of q.options) {
      expect(typeof opt.label).toBe("string")
      expect(typeof opt.description).toBe("string")
    }
  })

  test("content_filtered(422) 与 auth_expired(401/403) 的 options 各自不同（errorType 分派，非同一份文案）", () => {
    const d1 = decide({ error: mkErr("content_filtered", 422), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: auqConfig })
    const d2 = decide({ error: mkErr("auth_expired", 401), commitPhase: "pre-commit", clientVisibleStopEmitted: false, config: auqConfig })
    if (d1.kind !== "ask-user-question" || d2.kind !== "ask-user-question") throw new Error("expected ask-user-question")
    expect(d1.questions[0]?.options).not.toEqual(d2.questions[0]?.options)
  })

  test("config.auqTemplate 非空时覆盖 DEFAULT_AUQ_TEMPLATE", () => {
    const d = decide({
      error: mkErr("quota_exceeded", 402),
      commitPhase: "pre-commit",
      clientVisibleStopEmitted: false,
      config: { ...auqConfig, auqTemplate: "自定义：{error_type}/{status}，{model}/{request_id}" },
    })
    if (d.kind !== "ask-user-question") throw new Error("expected ask-user-question")
    expect(d.questions[0]?.question).toBe("自定义：quota_exceeded/402，{model}/{request_id}")
  })
})

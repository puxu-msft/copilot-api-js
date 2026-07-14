/**
 * 终端汇总行 `[ OK ]` / `[FAIL]`（onTerminal）的重试时长展示：
 * 有重试时 duration 字段展开为 `last/total(N)`，无重试时保持单值。
 *
 * 我们驱动真实 bus → TerminalUi 路径，捕获 stdout 汇总行（strip ANSI）。
 * 本项目 picocolors 在 bun test 下塌缩成恒等，颜色不影响文本断言，故只断言文本。
 * Task 6 会复用本文件。
 */

import {
  //
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
  test,
} from "bun:test"
import consola from "consola"

import type { RequestContextSnapshot } from "~/lib/observability"

import { createBus } from "~/lib/observability"
import { attachTerminalUi } from "~/lib/tui"
import { buildActiveFooter } from "~/lib/tui/render/footer"

const NOW = 1_700_000_000_000
// eslint-disable-next-line no-control-regex -- intentional ANSI escape range
const stripAnsi = (s: string): string => s.replaceAll(/\x1b\[[0-9;]*m/g, "")

function makeCapture() {
  const chunks: Array<string> = []
  const stdout = { write: (s: string) => (chunks.push(s), true), isTTY: true } as unknown as NodeJS.WritableStream
  return { stdout, text: () => stripAnsi(chunks.join("")) }
}

beforeEach(() => setSystemTime(new Date(NOW)))
afterEach(() => setSystemTime())

/**
 * 驱动一个终态事件到 TerminalUi，返回捕获的全部 stdout 文本。
 * `startTime` 决定 total = NOW - startTime；`entry` 提供 attempts；
 * `kind` 选 completed（[ OK ]）或 failed（[FAIL]，statusCode 500）。
 */
function drive(opts: { entry: unknown; startTime: number; kind: "completed" | "failed"; path?: string }): string {
  const cap = makeCapture()
  const bus = createBus()
  const prevLevel = consola.level
  consola.level = 5
  const detach = attachTerminalUi(bus, { stdout: cap.stdout, isTTY: true, columns: 200 })
  const ctx = {
    id: "a",
    endpoint: "anthropic-messages",
    method: "POST",
    path: opts.path ?? "/v1/messages",
    resolvedModel: "claude-opus-4-8",
    state: "streaming",
    startTime: opts.startTime,
    queueWaitMs: 0,
  } satisfies RequestContextSnapshot
  const req = bus.scope("request")
  req.publish({ kind: "request.created", ctx })
  if (opts.kind === "completed") {
    req.publish({ kind: "request.completed", ctx, entry: opts.entry } as never)
  } else {
    req.publish({ kind: "request.failed", ctx, statusCode: 500, error: "boom", entry: opts.entry } as never)
  }
  detach()
  consola.level = prevLevel
  return cap.text()
}

/**
 * 驱动一个 attempt_failed 事件到 TerminalUi，返回捕获的全部 stdout 文本。
 * `startTime` 决定 total = NOW - startTime；`attemptIndex` 0-based（首次重试为 0）；
 * `lastMs` 作为本次 attempt 自身耗时（AttemptSnapshot.durationMs）。
 */
function driveAttemptFailed(opts: { attemptIndex: number; lastMs: number; startTime: number }): string {
  const cap = makeCapture()
  const bus = createBus()
  const prevLevel = consola.level
  consola.level = 5
  const detach = attachTerminalUi(bus, { stdout: cap.stdout, isTTY: true, columns: 200 })
  const ctx = {
    id: "a",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    resolvedModel: "claude-opus-4-8",
    state: "streaming",
    startTime: opts.startTime,
    queueWaitMs: 0,
  } satisfies RequestContextSnapshot
  const req = bus.scope("request")
  req.publish({ kind: "request.created", ctx })
  req.publish({
    kind: "request.attempt_failed",
    ctx,
    attempt: {
      attemptIndex: opts.attemptIndex,
      durationMs: opts.lastMs,
      strategy: "backoff",
      error: { status: 500, message: "boom", type: "upstream_error" },
    },
    willRetry: true,
    nextStrategy: "backoff",
  } as never)
  detach()
  consola.level = prevLevel
  return cap.text()
}

describe("onAttemptFailed [RETRY] 行", () => {
  test("前缀 [RETRY]（无 -N）+ 1-based (N) + 本次/累计", () => {
    const out = driveAttemptFailed({ attemptIndex: 1, lastMs: 120_000, startTime: NOW - 300_000 })
    const retry = out.split("\n").find((l) => l.includes("[RETRY]"))
    expect(retry).toBeDefined()
    expect(retry).not.toContain("[RETRY-") // 前缀去序号
    expect(retry).toContain("120.0s/300.0s(2)") // attemptIndex+1 = 2
  })

  test("首次重试（attemptIndex=0）→ (1)，不出现 (0)", () => {
    const out = driveAttemptFailed({ attemptIndex: 0, lastMs: 60_000, startTime: NOW - 60_000 })
    const retry = out.split("\n").find((l) => l.includes("[RETRY]"))
    expect(retry).toBeDefined()
    expect(retry).toContain("(1)")
    expect(retry).not.toContain("(0)")
  })
})

describe("onTerminal 汇总行 last/total(N)", () => {
  test("有重试（3 attempts）→ 汇总显示 last/total(2)", () => {
    const out = drive({
      kind: "completed",
      startTime: NOW - 621_900, // total ≈ 621.9s
      entry: {
        id: "a",
        endpoint: "anthropic-messages",
        state: "completed",
        attempts: [
          { index: 0, durationMs: 100_000 },
          { index: 1, durationMs: 120_000 },
          { index: 2, durationMs: 45_200 },
        ],
      },
    })
    const ok = out.split("\n").find((l) => l.includes("[ OK ]"))
    expect(ok).toBeDefined()
    expect(ok).toContain("45.2s/621.9s(2)")
  })

  test("无重试（1 attempt）→ 单值，零回归（无 duration 斜杠）", () => {
    const out = drive({
      kind: "completed",
      startTime: NOW - 1200, // total ≈ 1.2s
      entry: {
        id: "a",
        endpoint: "anthropic-messages",
        state: "completed",
        attempts: [{ index: 0, durationMs: 1200 }],
      },
    })
    const ok = out.split("\n").find((l) => l.includes("[ OK ]"))
    expect(ok).toBeDefined()
    expect(ok).toMatch(/\b\d+\.\ds\b/) // 单值形态
    // 无 last/total triplet 斜杠。success 行的 `anthropic/model` 紧凑段本身含一个 `/`，
    // 故只针对 duration 三元组的 `<num>s/<num>s` 斜杠断言，而非整行 not.toContain("/")。
    expect(ok).not.toMatch(/\ds\/\d/)
  })

  test("零 attempt 终态（attempts undefined）→ 不崩、单值", () => {
    const out = drive({
      kind: "failed",
      startTime: NOW - 1200,
      path: "messages",
      entry: { id: "a", endpoint: "anthropic-messages", state: "failed" },
    })
    const fail = out.split("\n").find((l) => l.includes("[FAIL]"))
    expect(fail).toBeDefined()
    expect(fail).toMatch(/\b\d+\.\ds\b/) // 单值形态
    expect(fail).not.toContain("/") // 无 triplet 斜杠
  })
})

/**
 * 合并态一致性守卫：驱动**同一请求**连续 attempt_failed×N → completed，
 * 断言末条 `[RETRY]` 行的 `(N)` 与终端汇总行 `[ OK ]` 的 `(N)` 数值对齐。
 * 不变量：末次失败 attempt 的 attemptIndex = length-2，其 `[RETRY]` N = attemptIndex+1 = length-1；
 * 汇总 N = attempts.length-1。两者恒等。此测把「跨面 N 终态对齐」从结构推理固化为回归守卫。
 */
function driveSequence(opts: { startTime: number; failed: Array<{ attemptIndex: number; lastMs: number }>; entry: unknown }): string {
  const cap = makeCapture()
  const bus = createBus()
  const prevLevel = consola.level
  consola.level = 5
  const detach = attachTerminalUi(bus, { stdout: cap.stdout, isTTY: true, columns: 200 })
  const ctx = {
    id: "seq",
    endpoint: "anthropic-messages",
    method: "POST",
    path: "/v1/messages",
    resolvedModel: "claude-opus-4-8",
    state: "streaming",
    startTime: opts.startTime,
    queueWaitMs: 0,
  } satisfies RequestContextSnapshot
  const req = bus.scope("request")
  req.publish({ kind: "request.created", ctx })
  for (const f of opts.failed) {
    req.publish({
      kind: "request.attempt_failed",
      ctx,
      attempt: { attemptIndex: f.attemptIndex, durationMs: f.lastMs, strategy: "backoff", error: { status: 500, message: "boom", type: "upstream_error" } },
      willRetry: true,
      nextStrategy: "backoff",
    } as never)
  }
  req.publish({ kind: "request.completed", ctx, entry: opts.entry } as never)
  detach()
  consola.level = prevLevel
  return cap.text()
}

/** 从形如 `...(N)` 的行尾三元组提取 N；无则 undefined。 */
function parseParenN(line: string | undefined): number | undefined {
  const m = line?.match(/\((\d+)\)/)
  return m ? Number(m[1]) : undefined
}

describe("合并态一致：末 [RETRY] 的 N == 汇总 N", () => {
  test("3 attempts（2 失败 + 1 成功）→ 末 [RETRY](2) 与 [ OK ](2) 对齐", () => {
    const startTime = NOW - 300_000 // total 冻结在 300.0s
    const out = driveSequence({
      startTime,
      failed: [
        { attemptIndex: 0, lastMs: 100_000 }, // [RETRY] (1)
        { attemptIndex: 1, lastMs: 120_000 }, // [RETRY] (2) —— 末条
      ],
      entry: {
        id: "seq",
        endpoint: "anthropic-messages",
        state: "completed",
        attempts: [
          { index: 0, durationMs: 100_000 },
          { index: 1, durationMs: 120_000 },
          { index: 2, durationMs: 45_200 },
        ],
      },
    })
    const lines = out.split("\n")
    const retryLines = lines.filter((l) => l.includes("[RETRY]"))
    const okLine = lines.find((l) => l.includes("[ OK ]"))

    expect(retryLines).toHaveLength(2) // 两次失败各一条 [RETRY]
    expect(okLine).toBeDefined()

    const lastRetryN = parseParenN(retryLines.at(-1))
    const summaryN = parseParenN(okLine)

    // 核心不变量：末 [RETRY] 的 N == 汇总 N == attempts.length - 1 == 2
    expect(lastRetryN).toBe(2)
    expect(summaryN).toBe(2)
    expect(lastRetryN).toBe(summaryN)

    // 顺带确认末条 [RETRY] 与汇总的具体形态
    expect(retryLines.at(-1)).toContain("120.0s/300.0s(2)")
    expect(okLine).toContain("45.2s/300.0s(2)")
  })
})

describe("footer 单请求 triplet（纯文本）", () => {
  it("有重试 → last/total(N)，无 ANSI", () => {
    const now = 1_000_000
    const active = [
      {
        ctx: {
          method: "POST",
          path: "/v1/messages",
          resolvedModel: "claude-opus-4.8",
          startTime: now - 400_000,
          currentAttemptStartedAt: now - 45_200,
          attemptCount: 3,
        },
      },
    ] as never
    const out = buildActiveFooter({ active, now, columns: 200 })
    expect(out).toContain("45.2s/400.0s(2)")
  })

  it("无 currentAttemptStartedAt → 兜底单值 total", () => {
    const now = 1_000_000
    // slashless path 使 not.toContain("/") 只针对 duration 字段有意义（对齐上方 onTerminal 用法）。
    const active = [{ ctx: { method: "POST", path: "messages", resolvedModel: "m", startTime: now - 400_000, attemptCount: 1 } }] as never
    const out = buildActiveFooter({ active, now, columns: 200 })
    expect(out).toContain("400.0s")
    expect(out).not.toContain("/")
  })
})

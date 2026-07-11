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
  setSystemTime,
  test,
} from "bun:test"
import consola from "consola"

import type { RequestContextSnapshot } from "~/lib/observability"

import { createBus } from "~/lib/observability"
import { attachTerminalUi } from "~/lib/tui"

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

  test("无重试（1 attempt）→ 单值，零回归（无斜杠）", () => {
    const out = drive({
      kind: "completed",
      startTime: NOW - 1200, // total ≈ 1.2s
      path: "messages", // slashless path 使 not.toContain("/") 只针对 duration 字段有意义
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
    expect(ok).not.toContain("/") // 无 triplet 斜杠
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

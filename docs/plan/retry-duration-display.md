# 重试时长显示 `last/total(N)` 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 有重试时把终端 duration 字段从单一 `total` 扩展为 `last/total(N)`，覆盖终端汇总行 / `[RETRY]` 行 / footer-panel 三面。

**Architecture:** 新增一个纯格式化器 `formatDurationField`（SSOT，三面共用）；补 3 处数据管线字段（`AttemptSnapshot.durationMs`、`RequestActivitySnapshot.currentAttemptStartedAt`、L2 缓冲重试也发 `attempt_failed`）；三处渲染点改调格式化器。`log-line.ts` 纯格式化器不改——调用方把 triplet 作为 `duration` 字符串、`durationMs` 传 `colorMs` 驱动既有 `durationColor`。

**Tech Stack:** TypeScript, Bun test（`bun test`），picocolors，项目自有 observability/pipeline/tui 分层。

**Spec:** `docs/spec/retry-duration-display.md`

## Global Constraints

- 中文句子标点用全宽 `，。：；（）`，代码/英文段用半角（项目 CLAUDE.md 文本风格）。
- 提交一律显式 pathspec（`git add -- <路径>`、`git commit -F <msgfile> -- <路径>`），conventional commits，无模型署名。
- 不运行 `bun run dev`/`start` 或任何启动服务器命令，不用 `kill`/`pkill`；可跑 `bun test` / `bun run typecheck` / `bunx eslint <path>`。
- 同目录文件互相导入用相对路径 `./foo`，非 `~/lib/...`。
- **首要回归不变量**：`N=0`（无重试）时三面**文本与颜色均**严格保持今天的单值——`formatDurationField(retries=0)` 返回 `formatDuration(totalMs)`，着色仍按 `totalMs`。
- `lastMs` 有效判据统一为 `!== undefined && > 0 && <= totalMs`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/lib/observability/projections/format.ts` | 新增 `formatDurationField` + `resolveDurationColorMs` | Modify |
| `src/lib/observability/events.ts` | `AttemptSnapshot` 加 `durationMs?` | Modify |
| `src/lib/context/request.ts` | `recordAttemptFailure` 透传 `durationMs`；新增 `finalizeCurrentAttemptDuration()` | Modify |
| `src/lib/context/activity-summary.ts` | `RequestActivitySnapshot` 加 `currentAttemptStartedAt?` | Modify |
| `src/lib/pipeline/driver.ts` | buffered 循环失败分支 finalize duration + 发 `attempt_failed`（L2 也打 `[RETRY]`） | Modify |
| `src/lib/tui/terminal-ui.ts` | `onTerminal` + `onAttemptFailed`（`[RETRY]` 前缀 + 1-based + triplet + colorMs） | Modify |
| `src/lib/tui/render/footer.ts` | 单请求行改 triplet（纯文本）；聚合行不动 | Modify |
| `src/lib/tui/render/panel.ts` | 详情 elapsed 行改 triplet（纯文本） | Modify |
| `tests/observability/format-duration-field.unit.test.ts` | `formatDurationField` 单测 | Create |
| `tests/context/attempt-snapshot-duration.unit.test.ts` | `recordAttemptFailure` 透传 durationMs 单测 | Create |
| `tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts` | L2 发 attempt_failed + durationMs 非 0 | Create |
| `tests/observability/activity-current-attempt.unit.test.ts` | `currentAttemptStartedAt` 单测 | Create |
| `tests/tui/retry-duration-display.unit.test.ts` | 三面渲染 golden（含 N=0 回归） | Create |

---

## Task 1: `formatDurationField` 纯格式化器（SSOT）

**Files:**
- Modify: `src/lib/observability/projections/format.ts`（在 `durationColor` 之后追加）
- Test: `tests/observability/format-duration-field.unit.test.ts`

**Interfaces:**
- Consumes: 既有 `formatDuration(ms: number): string`。
- Produces:
  - `formatDurationField(args: { lastMs: number | undefined; totalMs: number; retries: number }): string`
  - `resolveDurationColorMs(args: { lastMs: number | undefined; totalMs: number; retries: number }): number`

- [ ] **Step 1: 写失败测试**

创建 `tests/observability/format-duration-field.unit.test.ts`：

```ts
import { describe, expect, it } from "bun:test"

import { formatDurationField, resolveDurationColorMs } from "~/lib/observability/projections/format"

describe("formatDurationField", () => {
  it("retries=0 → 单值 total，与 formatDuration 一致（零回归）", () => {
    expect(formatDurationField({ lastMs: 45_200, totalMs: 621_900, retries: 0 })).toBe("621.9s")
    // lastMs 即便给了也忽略
    expect(formatDurationField({ lastMs: undefined, totalMs: 621_900, retries: 0 })).toBe("621.9s")
  })

  it("retries>=1 且 lastMs 有效 → last/total(N)", () => {
    expect(formatDurationField({ lastMs: 45_200, totalMs: 621_900, retries: 2 })).toBe("45.2s/621.9s(2)")
  })

  it("retries>=1 但 lastMs 无效（undefined/0/>total）→ 兜底 total(N)，不崩", () => {
    expect(formatDurationField({ lastMs: undefined, totalMs: 621_900, retries: 2 })).toBe("621.9s(2)")
    expect(formatDurationField({ lastMs: 0, totalMs: 621_900, retries: 2 })).toBe("621.9s(2)")
    expect(formatDurationField({ lastMs: 700_000, totalMs: 621_900, retries: 2 })).toBe("621.9s(2)")
  })
})

describe("resolveDurationColorMs", () => {
  it("retries=0 → totalMs（着色零回归）", () => {
    expect(resolveDurationColorMs({ lastMs: 45_200, totalMs: 621_900, retries: 0 })).toBe(621_900)
  })

  it("retries>=1 且 lastMs 有效 → lastMs（按 last 着色）", () => {
    expect(resolveDurationColorMs({ lastMs: 45_200, totalMs: 621_900, retries: 2 })).toBe(45_200)
  })

  it("retries>=1 但 lastMs 无效 → totalMs 兜底", () => {
    expect(resolveDurationColorMs({ lastMs: undefined, totalMs: 621_900, retries: 2 })).toBe(621_900)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/observability/format-duration-field.unit.test.ts`
Expected: FAIL（`formatDurationField is not a function`）。

- [ ] **Step 3: 最小实现**

在 `src/lib/observability/projections/format.ts` 的 `durationColor` 函数之后追加：

```ts
/**
 * 判定 `lastMs`（最后一次 attempt 自身耗时）是否可用于 last/total 展示。
 * 无效：undefined / 非正 / 超过整请求墙钟（脏数据或未定稿的 0 初值）。
 */
function isValidLastMs(lastMs: number | undefined, totalMs: number): lastMs is number {
  return lastMs !== undefined && lastMs > 0 && lastMs <= totalMs
}

/**
 * 重试时长字段：无重试时与 {@link formatDuration} 逐字节一致（`total` 单值）；
 * 有重试时展开为 `last/total(N)`；`lastMs` 无效时兜底 `total(N)`，绝不抛。
 * 纯函数、不含颜色——着色由调用方按 {@link resolveDurationColorMs} 决定。
 */
export function formatDurationField(args: { lastMs: number | undefined; totalMs: number; retries: number }): string {
  const { lastMs, totalMs, retries } = args
  if (retries <= 0) return formatDuration(totalMs)
  if (isValidLastMs(lastMs, totalMs)) return `${formatDuration(lastMs)}/${formatDuration(totalMs)}(${retries})`
  return `${formatDuration(totalMs)}(${retries})`
}

/**
 * 着色驱动值：整个 duration 字段按「实际显示的头部值」的 severity 着色。
 * 有重试且 lastMs 有效 → 按 last（贴合「这次尝试多慢」）；否则按 total（N=0 零回归）。
 */
export function resolveDurationColorMs(args: { lastMs: number | undefined; totalMs: number; retries: number }): number {
  const { lastMs, totalMs, retries } = args
  return retries >= 1 && isValidLastMs(lastMs, totalMs) ? lastMs : totalMs
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/observability/format-duration-field.unit.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint src/lib/observability/projections/format.ts tests/observability/format-duration-field.unit.test.ts
git add -- src/lib/observability/projections/format.ts tests/observability/format-duration-field.unit.test.ts
git commit -m "feat(observability): add formatDurationField last/total(N) formatter"
```

---

## Task 2: `AttemptSnapshot.durationMs` 透传

**Files:**
- Modify: `src/lib/observability/events.ts:106`（`AttemptSnapshot` 接口）
- Modify: `src/lib/context/request.ts:936`（`recordAttemptFailure` 构造 snapshot）
- Test: `tests/context/attempt-snapshot-duration.unit.test.ts`

**Interfaces:**
- Produces: `AttemptSnapshot` 多一个可选字段 `durationMs?: number`——由 `recordAttemptFailure` 从 `ctx.currentAttempt.durationMs` 透传。Task 6 的 `[RETRY]` 行消费它作为 `lastMs`。

- [ ] **Step 1: 写失败测试**

创建 `tests/context/attempt-snapshot-duration.unit.test.ts`。参照 `tests/pipeline/buffered-sink.unit.test.ts:92` 的真实 `createRequestContext` 用法（driver.unit.test.ts 用的是 mock ctx、无 `finalizeCurrentAttemptDuration` 等方法，勿参照）：

```ts
import { describe, expect, it } from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability/events"
import type { ObservabilityEvent } from "~/lib/observability/events"
import { createRequestContext } from "~/lib/context/request"

describe("recordAttemptFailure 透传 durationMs", () => {
  it("attempt_failed 事件的 AttemptSnapshot 携带已定稿的 durationMs", () => {
    const events: Array<ObservabilityEvent> = []
    const ctx = createRequestContext({
      // 用工厂所需的最小参数（实现时对齐真实签名）
      publisher: { publish: (e: ObservabilityEvent) => void events.push(e) },
    } as never)

    ctx.beginAttempt({})
    // 定稿本次 attempt 的 durationMs（模拟 setAttemptError 的效果）
    ctx.setAttemptError({ status: 502, message: "boom", type: "api_error" } as never)
    ctx.recordAttemptFailure({ willRetry: true })

    const failed = events.find((e) => e.kind === "request.attempt_failed")
    expect(failed).toBeDefined()
    // durationMs 已定稿（>=0，非 undefined）
    expect((failed as Extract<ObservabilityEvent, { kind: "request.attempt_failed" }>).attempt.durationMs).toBeGreaterThanOrEqual(0)
    expect((failed as Extract<ObservabilityEvent, { kind: "request.attempt_failed" }>).attempt.durationMs).not.toBeUndefined()
  })
})
```

> 注：实现者先读 `tests/pipeline/buffered-sink.unit.test.ts:92` 的真实 `createRequestContext` 签名，把上面的构造改成可编译的最小形态；断言逻辑不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/context/attempt-snapshot-duration.unit.test.ts`
Expected: FAIL（`attempt.durationMs` 为 `undefined`——尚未透传）。

- [ ] **Step 3: 加类型字段**

`src/lib/observability/events.ts` 的 `AttemptSnapshot` 接口（约 :106），在 `attemptIndex` 之后加：

```ts
export interface AttemptSnapshot {
  attemptIndex: number
  /** 本次 attempt 自身的墙钟耗时（ms）——由 setAttemptError/setAttemptResponse 或 finalizeCurrentAttemptDuration 定稿。供 [RETRY] 行作 lastMs。 */
  durationMs?: number
  strategy?: string
  // ...（其余不变）
```

- [ ] **Step 4: 透传字段**

`src/lib/context/request.ts` 的 `recordAttemptFailure`（约 :936），在 `const snap: AttemptSnapshot = { attemptIndex: a?.index ?? 0,` 之后加一行（`a` 是 `ctx.currentAttempt`）：

```ts
      const snap: AttemptSnapshot = {
        attemptIndex: a?.index ?? 0,
        ...(a?.durationMs !== undefined && { durationMs: a.durationMs }),
        ...(a?.strategy !== undefined && { strategy: a.strategy }),
        // ...（其余不变）
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test tests/context/attempt-snapshot-duration.unit.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint src/lib/observability/events.ts src/lib/context/request.ts tests/context/attempt-snapshot-duration.unit.test.ts
git add -- src/lib/observability/events.ts src/lib/context/request.ts tests/context/attempt-snapshot-duration.unit.test.ts
git commit -m "feat(observability): carry per-attempt durationMs on AttemptSnapshot"
```

---

## Task 3: L2 缓冲重试也发 `attempt_failed`（BLOCK-1）

**Files:**
- Modify: `src/lib/context/request.ts`（新增 `finalizeCurrentAttemptDuration()`；接口在 `src/lib/context/types.ts` 补声明）
- Modify: `src/lib/pipeline/driver.ts:702-709`（buffered 循环 retry 分支：`if (retryable && attempt < cap)` @:702、`commitAttemptSseEvents()` @:708、`onAttemptReset()` @:709）
- Test: `tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts`

**Interfaces:**
- Consumes: `ctx.recordAttemptFailure`（既有）、`ctx.commitAttemptSseEvents`（既有）。
- Produces: `ctx.finalizeCurrentAttemptDuration(): void`——把 `currentAttempt.durationMs` 定稿为 `Date.now() - startTime`（仅当当前为 0，即既未 setAttemptError 也未 setAttemptResponse 的截断路径）。

- [ ] **Step 1: 写失败测试**

创建 `tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts`。参照 `tests/pipeline/buffered-sink.unit.test.ts` 现有的 buffered-sink 驱动方式（它用真实 `createRequestContext({ endpoint: "anthropic-messages" })` + `env.ctx.beginAttempt({})`；driver.unit.test.ts 是 mock ctx、不驱动 `runResponseBufferedSink`，勿参照），构造一个「首个 attempt 截断（无 message_stop）、第二个 attempt 成功」的场景，断言中途发了一条 `attempt_failed`：

```ts
import { describe, expect, it } from "bun:test"

import type { ObservabilityEvent } from "~/lib/observability/events"
// 复用 buffered-sink.unit.test.ts 的 harness：真实 createRequestContext + mock transport（截断 then 完整两次交换）

describe("L2 缓冲重试发 attempt_failed", () => {
  it("首个 attempt 截断→重试成功：中途一条 attempt_failed，durationMs 非 0，strategy=buffered-retry", async () => {
    const events: Array<ObservabilityEvent> = []
    // ... 构造 ctx（publisher 收集 events）+ deps（第一次上游流截断、第二次完整）
    // await runResponseBufferedSink(upstream, env, sink, { retryCap: 2, ...telemetryHooks })

    const failed = events.filter((e) => e.kind === "request.attempt_failed")
    expect(failed.length).toBe(1)
    const snap = (failed[0] as Extract<ObservabilityEvent, { kind: "request.attempt_failed" }>).attempt
    expect(snap.durationMs).toBeGreaterThan(0)
    expect(snap.strategy === "buffered-retry" || (failed[0] as never as { nextStrategy?: string }).nextStrategy === "buffered-retry").toBe(true)
  })
})
```

> 注：实现者先读 `tests/pipeline/buffered-sink.unit.test.ts`，复用其真实 ctx + mock transport 工厂来造「截断 then 完整」两次交换；断言逻辑不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts`
Expected: FAIL（`failed.length` 为 0——L2 今天不发 attempt_failed）。

- [ ] **Step 3: 加 `finalizeCurrentAttemptDuration` 方法**

`src/lib/context/request.ts`，在 `commitAttemptSseEvents`（约 :555）附近加：

```ts
    /**
     * L2 截断重试路径既不走 setAttemptResponse 也不走 setAttemptError，
     * durationMs 停在 beginAttempt 初值 0。发 attempt_failed 前调此定稿，
     * 使 [RETRY] 行的 lastMs 有真值。已定稿（>0）则不覆盖。
     */
    finalizeCurrentAttemptDuration() {
      const attempt = ctx.currentAttempt
      if (attempt && attempt.durationMs === 0) {
        attempt.durationMs = Date.now() - attempt.startTime
      }
    },
```

在 `src/lib/context/types.ts` 的 RequestContext 接口（约 :480，`beginAttempt` 声明附近）补：

```ts
  /** 定稿当前 attempt 的 durationMs（截断路径无 error/response setter 时用）。见 request.ts。 */
  finalizeCurrentAttemptDuration(): void
```

- [ ] **Step 4: buffered 循环发 attempt_failed**

`src/lib/pipeline/driver.ts` 的 retry 分支（:702-709），在 `commitAttemptSseEvents()`（:708）与 `onAttemptReset()`（:709）之间插入 finalize + 发事件：

```ts
      if (retryable && attempt < cap) {
        attempt++
        currentEnv.ctx.commitAttemptSseEvents()
        // BLOCK-1: L2 缓冲重试也发 attempt_failed → 打 [RETRY] 行，与 L1 一致可见。
        // 先定稿本次（截断/transport-close）attempt 的 durationMs（截断路径无 error/response setter）。
        currentEnv.ctx.finalizeCurrentAttemptDuration()
        currentEnv.ctx.recordAttemptFailure({ willRetry: true, nextStrategy: "buffered-retry" })
        opts.onAttemptReset?.()
        currentEnv.ctx.resetSseEvents()
        if (opts.escalate) currentEnv = opts.escalate(currentEnv, attempt)
        const re = await runExchange(deps, currentEnv, strategies)
        current = re.upstream
        currentEnv = re.env
        continue
      }
```

并在**穷尽/非重试返回前**（driver.ts:725 `await closeAnchorIfOpen()` 之前）也 finalize 一次，使 L2-截断-穷尽请求的终端汇总行 `last` 完整（否则末 attempt durationMs 停在 0，汇总退化为 `total(N)`——建议-1）：

```ts
      // 穷尽/非重试：最终失败 attempt 也 finalize duration，供汇总行 last（截断路径无 setter）。
      currentEnv.ctx.finalizeCurrentAttemptDuration()
      await closeAnchorIfOpen()
      opts.onBufferedResolve?.("exhausted", attempt)
```

- [ ] **Step 5: 跑测试确认通过 + 回归 driver 既有测试**

Run: `bun test tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts tests/pipeline/buffered-sink.unit.test.ts tests/pipeline/driver.unit.test.ts`
Expected: 新测 PASS；buffered-sink 与 driver.unit 全绿（确认没打破既有 buffered/telemetry 行为，尤其 `onBufferedResolve` 计数不受影响——`attempt_failed` 与 `protect_streaming` 计数是两条独立通道）。

- [ ] **Step 6: 验证 ws sink 消费者不回归**

Run: `bun test tests/ --rerun-each 1 2>&1 | tail -20`（跑全 backend，重点看 observability/sinks 相关；实现者若时间紧可 `bun test tests/observability tests/pipeline`）
Expected: 全绿。若 ws sink 有断言「attempt_failed ⟹ 有 error 字段」而 L2 截断无 error，则按需在断言处放宽或给截断路径合成 reason（记为该 task 的收尾修正）。

- [ ] **Step 7: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint src/lib/context/request.ts src/lib/context/types.ts src/lib/pipeline/driver.ts tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts
git add -- src/lib/context/request.ts src/lib/context/types.ts src/lib/pipeline/driver.ts tests/pipeline/l2-buffered-retry-attempt-failed.unit.test.ts
git commit -m "feat(pipeline): L2 buffered retry emits attempt_failed for [RETRY] visibility"
```

---

## Task 4: 暴露 current-attempt 计时（顶层标量 + summary）

> **BLOCK-1 修正（计划技术审查）**：footer/panel 的 `entry.ctx` 被高频 `stream_progress` 的**无 `summary`** 轻量 `snapshot()`（request.ts:281）覆盖，故**不能**读 `.summary`。本 task 给**轻量 `RequestContextSnapshot` 顶层**加两个廉价标量（footer/panel 用），并**同时**给 `RequestActivitySnapshot`（summary）加 `currentAttemptStartedAt`（前端 WS 路径用）。

**Files:**
- Modify: `src/lib/observability/events.ts:72`（`RequestContextSnapshot` 顶层）
- Modify: `src/lib/context/request.ts:281`（`snapshot()` 填充顶层标量）
- Modify: `src/lib/context/activity-summary.ts:27`（接口）+ `:57`（`summarizeRequestContext`）
- Test: `tests/observability/activity-current-attempt.unit.test.ts`

**Interfaces:**
- Produces:
  - `RequestContextSnapshot.currentAttemptStartedAt?: number` + `RequestContextSnapshot.attemptCount?: number`（顶层，`snapshot()` 每事件填充）——Task 7 的 footer/panel 消费。
  - `RequestActivitySnapshot.currentAttemptStartedAt?: number`（summary，前端 WS 路径）。

- [ ] **Step 1: 写失败测试**

创建 `tests/observability/activity-current-attempt.unit.test.ts`：

```ts
import { describe, expect, it } from "bun:test"

import { summarizeRequestContext } from "~/lib/context/activity-summary"

describe("summarizeRequestContext.currentAttemptStartedAt", () => {
  it("有 currentAttempt 时暴露其 startTime", () => {
    const startTime = 1_700_000_000_000
    const ctx = { id: "r1", endpoint: "messages", state: "executing", startTime: 1, queueWaitMs: 0, attempts: [{ startTime }], currentAttempt: { startTime } } as never
    expect(summarizeRequestContext(ctx).currentAttemptStartedAt).toBe(startTime)
  })

  it("无 currentAttempt 时为 undefined（不崩）", () => {
    const ctx = { id: "r1", endpoint: "messages", state: "pending", startTime: 1, queueWaitMs: 0 } as never
    expect(summarizeRequestContext(ctx).currentAttemptStartedAt).toBeUndefined()
  })
})
```

> 顶层 `snapshot()` 标量的真实-bus 验证放在 Task 7 的集成测试（驱动 stream_progress 后读 footer）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/observability/activity-current-attempt.unit.test.ts`
Expected: FAIL（字段不存在）。

- [ ] **Step 3: 加 summary 字段**

`src/lib/context/activity-summary.ts` 接口（:27 `attemptCount` 附近）加：

```ts
  attemptCount: number
  /** 当前在途 attempt 的 startTime（无则 undefined）——footer/panel 算本次 attempt 已耗时。 */
  currentAttemptStartedAt?: number
```

`summarizeRequestContext` 返回对象（:57 `attemptCount` 附近）加：

```ts
    attemptCount: context.attempts?.length ?? 0,
    ...(context.currentAttempt?.startTime !== undefined ? { currentAttemptStartedAt: context.currentAttempt.startTime } : {}),
```

- [ ] **Step 4: 加顶层标量到 RequestContextSnapshot + snapshot()**

`src/lib/observability/events.ts` 的 `RequestContextSnapshot`（:72），在 `multiplier?: number` 之后、`summary?` 之前加：

```ts
  multiplier?: number
  /** 当前在途 attempt 的 startTime（footer/panel 用；轻量 snapshot() 每事件填充，故高频 stream_progress 也带）。 */
  currentAttemptStartedAt?: number
  /** 已发生的 attempt 数（_attempts.length）；footer/panel 算 retries=attemptCount-1。 */
  attemptCount?: number
  summary?: RequestActivitySnapshot
```

`src/lib/context/request.ts` 的 `snapshot()`（:281-299），在 return 对象里 `multiplier` 之后加（`_attempts` 是内部 attempts 数组、`currentAttempt` getter 已存在——实现时确认 `snapshot()` 闭包内可见 `_attempts`；若不可见用 `ctx.currentAttempt`/`_attempts.length`）：

```ts
      ...(billing?.multiplier !== undefined && { multiplier: billing.multiplier }),
      ...(_attempts.at(-1)?.startTime !== undefined && { currentAttemptStartedAt: _attempts.at(-1)!.startTime }),
      ...(_attempts.length > 0 && { attemptCount: _attempts.length }),
```

- [ ] **Step 5: 跑测试确认通过 + 回归 snapshot 消费者**

Run: `bun test tests/observability/activity-current-attempt.unit.test.ts tests/observability`
Expected: PASS；observability 套件全绿（新增可选顶层字段不破坏既有 snapshot 断言）。

- [ ] **Step 6: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint src/lib/observability/events.ts src/lib/context/request.ts src/lib/context/activity-summary.ts tests/observability/activity-current-attempt.unit.test.ts
git add -- src/lib/observability/events.ts src/lib/context/request.ts src/lib/context/activity-summary.ts tests/observability/activity-current-attempt.unit.test.ts
git commit -m "feat(observability): expose current-attempt start + count on snapshot"
```

---

## Task 5: 终端汇总行 `onTerminal` 用 triplet

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts:499-537`（`onTerminal`）
- Test: `tests/tui/retry-duration-display.unit.test.ts`（本 task 建，Task 6 复用）

**Interfaces:**
- Consumes: `formatDurationField` / `resolveDurationColorMs`（Task 1），`historyEntry.attempts`（既有）。

- [ ] **Step 1: 写失败测试**

创建 `tests/tui/retry-duration-display.unit.test.ts`。参照 `tests/tui/terminal-ui-usage.unit.test.ts` 的 TerminalUi 构造与事件注入方式（先读它）。核心断言用 `FORCE_COLOR=0` 或 picocolors 塌缩下的纯文本（本项目 picocolors 在 bun test 塌缩成恒等，见记忆 `picocolors-collapses`），断言输出**文本**含 triplet：

```ts
import { describe, expect, it } from "bun:test"
// 复用 terminal-ui-usage.unit.test.ts 的 harness：makeTerminalUi(captureLines) + emit helpers

describe("onTerminal 汇总行 last/total(N)", () => {
  it("有重试（3 attempts）→ 汇总显示 last/total(2)", () => {
    const lines: Array<string> = []
    // 构造 TerminalUi(silent=false 但用 stub printLog 收集 lines)；emit terminal completed
    // historyEntry.attempts = [{durationMs:100_000},{durationMs:120_000},{durationMs:45_200}]
    // ctx.startTime 使 total≈621_900
    // ... emit ...
    const ok = lines.find((l) => l.includes("[ OK ]"))
    expect(ok).toContain("45.2s/621.9s(2)")
  })

  it("无重试（1 attempt）→ 单值，零回归", () => {
    const lines: Array<string> = []
    // historyEntry.attempts = [{durationMs:...}]（length=1 → retries=0）
    const ok = lines.find((l) => l.includes("[ OK ]"))
    expect(ok).toMatch(/\b\d+\.\ds\b/) // 单值形态
    expect(ok).not.toContain("/")       // 无 triplet 斜杠
  })

  it("零 attempt 终态（attempts undefined）→ 不崩、单值", () => {
    const lines: Array<string> = []
    // historyEntry.attempts = undefined
    // emit failed 终态；断言不抛且为单值
    expect(lines.some((l) => l.includes("[FAIL]"))).toBe(true)
  })
})
```

> 注：实现者读 `tests/tui/terminal-ui-usage.unit.test.ts` 复用其 TerminalUi 构造 + printLog 捕获；如无现成 helper，用 `new TerminalUi({ silent: true })` 并 spy `printLog`（或断言 `onTerminal` 内 `formatLogLine` 的输出——按现有测试同款手法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/retry-duration-display.unit.test.ts`
Expected: FAIL（当前是单值 `formatDuration(durationMs)`，无 triplet）。

- [ ] **Step 3: 改 onTerminal**

`src/lib/tui/terminal-ui.ts` 的 `onTerminal`（:500-537）。在 `const durationMs = Date.now() - ctx.startTime` 之后、`formatLogLine` 调用之前，计算 triplet 与 colorMs：

```ts
    const durationMs = Date.now() - ctx.startTime
    const attempts = historyEntry?.attempts
    const retries = (attempts?.length ?? 1) - 1
    const lastMs = attempts?.at(-1)?.durationMs
    const durationField = formatDurationField({ lastMs, totalMs: durationMs, retries })
    const colorMs = resolveDurationColorMs({ lastMs, totalMs: durationMs, retries })
```

然后把 `formatLogLine` 里两处改为：

```ts
      duration: durationField,   // 原 formatDuration(durationMs)
      durationMs: colorMs,       // 原 durationMs —— 现驱动 durationColor 按头部值
```

在文件顶部 import 补 `formatDurationField, resolveDurationColorMs`（与既有 `formatDuration` 同一 import 来源 `./format` 或 `~/lib/observability/projections/format`——对齐现有 import 路径）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/tui/retry-duration-display.unit.test.ts`
Expected: 本 task 的 3 个用例 PASS。

- [ ] **Step 5: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint src/lib/tui/terminal-ui.ts tests/tui/retry-duration-display.unit.test.ts
git add -- src/lib/tui/terminal-ui.ts tests/tui/retry-duration-display.unit.test.ts
git commit -m "feat(tui): terminal summary line shows last/total(N) on retries"
```

---

## Task 6: `[RETRY]` 行前缀 + 1-based triplet（含 L2）

**Files:**
- Modify: `src/lib/tui/terminal-ui.ts:437-470`（`onAttemptFailed`）
- Test: `tests/tui/retry-duration-display.unit.test.ts`（追加）

**Interfaces:**
- Consumes: `formatDurationField` / `resolveDurationColorMs`（Task 1）、`event.attempt.durationMs`（Task 2）、L2 的 attempt_failed（Task 3）。

- [ ] **Step 1: 追加失败测试**

在 `tests/tui/retry-duration-display.unit.test.ts` 追加：

```ts
describe("onAttemptFailed [RETRY] 行", () => {
  it("前缀 [RETRY]（无 -N）+ 1-based (N) + 本次/累计", () => {
    const lines: Array<string> = []
    // emit attempt_failed: attemptIndex=1, attempt.durationMs=120_000, ctx.startTime 使 total≈300_000
    // ... emit ...
    const retry = lines.find((l) => l.includes("[RETRY]"))
    expect(retry).toBeDefined()
    expect(retry).not.toContain("[RETRY-") // 前缀去序号
    expect(retry).toContain("120.0s/300.0s(2)") // attemptIndex+1 = 2
  })

  it("首次重试（attemptIndex=0）→ (1)，不出现 (0)", () => {
    const lines: Array<string> = []
    // emit attempt_failed: attemptIndex=0, attempt.durationMs=60_000, total≈60_000
    const retry = lines.find((l) => l.includes("[RETRY]"))
    expect(retry).toContain("(1)")
    expect(retry).not.toContain("(0)")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/retry-duration-display.unit.test.ts`
Expected: 新 2 例 FAIL（当前前缀是 `[RETRY-N]`、duration 是累计单值）。

- [ ] **Step 3: 改 onAttemptFailed**

`src/lib/tui/terminal-ui.ts` 的 `onAttemptFailed`（:437-470）：

```ts
    const attemptN = event.attempt.attemptIndex + 1
    entry.attemptCount = Math.max(entry.attemptCount, attemptN)

    // ...（retryableMeta 不变）...

    const elapsedMs = Date.now() - event.ctx.startTime
    const lastMs = event.attempt.durationMs
    const retries = event.attempt.attemptIndex + 1 // 1-based：这是第 N 次重试
    const durationField = formatDurationField({ lastMs, totalMs: elapsedMs, retries })
    const colorMs = resolveDurationColorMs({ lastMs, totalMs: elapsedMs, retries })
    const errMsg = event.attempt.error?.message
    const extra = errMsg ? `: ${errMsg}` : undefined

    const message = formatLogLine({
      prefix: `[RETRY]`,          // 原 `[RETRY-${attemptN}]`
      time: formatTime(),
      method: event.ctx.method,
      path: event.ctx.path,
      model: event.ctx.resolvedModel,
      clientModel: event.ctx.clientModel,
      multiplier: event.ctx.multiplier,
      status: event.attempt.error?.status,
      duration: durationField,    // 原 elapsed
      durationMs: colorMs,        // 原 elapsedMs
      requestBodySize: event.ctx.requestBodySize,
      responseBodySize: entry.streamBytesIn,
      extra,
      retryableMeta,
      isRetry: true,
    })
    this.printLog(message)
```

> `attemptN` 仍用于 `entry.attemptCount` 累计，保留；仅 prefix 不再用它。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test tests/tui/retry-duration-display.unit.test.ts`
Expected: 全 PASS（Task 5 + Task 6 的用例）。

- [ ] **Step 5: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint src/lib/tui/terminal-ui.ts tests/tui/retry-duration-display.unit.test.ts
git add -- src/lib/tui/terminal-ui.ts tests/tui/retry-duration-display.unit.test.ts
git commit -m "feat(tui): [RETRY] prefix + 1-based last/total(N)"
```

---

## Task 7: footer / panel 实时 triplet（纯文本）

**Files:**
- Modify: `src/lib/tui/render/footer.ts:54-64`（单请求分支；聚合行 `buildModelGroupSegments` **不动**）
- Modify: `src/lib/tui/render/panel.ts:195`（`formatPanelRow` 的 elapsed）+ `:220`（`buildDetailLines` 的 elapsed 明细行）
- Test: `tests/tui/retry-duration-display.unit.test.ts`（追加）
- Test: `tests/tui/footer-live-attempt.integration.test.ts`（新建——驱动真实 bus + stream_progress，BLOCK-1 守卫）

**Interfaces:**
- Consumes: `formatDurationField`（Task 1），`entry.ctx.currentAttemptStartedAt` / `entry.ctx.attemptCount`（Task 4 **顶层标量**，非 `.summary`）。**不着色**（`truncateToWidth` 只接受纯文本）。

- [ ] **Step 1: 追加失败测试**

在 `tests/tui/retry-duration-display.unit.test.ts` 追加（用 `buildActiveFooter` 直接测，纯函数好测）：

```ts
import { buildActiveFooter } from "~/lib/tui/render/footer"

describe("footer 单请求 triplet（纯文本）", () => {
  it("有重试 → last/total(N)，无 ANSI", () => {
    const now = 1_000_000
    const active = [{
      ctx: {
        method: "POST", path: "/v1/messages", resolvedModel: "claude-opus-4.8", startTime: now - 400_000,
        currentAttemptStartedAt: now - 45_200, attemptCount: 3,
      },
    }] as never
    const out = buildActiveFooter({ active, now, columns: 200 })
    expect(out).toContain("45.2s/400.0s(2)")
  })

  it("无 currentAttemptStartedAt → 兜底单值 total", () => {
    const now = 1_000_000
    const active = [{ ctx: { method: "POST", path: "/v1/messages", resolvedModel: "m", startTime: now - 400_000, attemptCount: 1 } }] as never
    const out = buildActiveFooter({ active, now, columns: 200 })
    expect(out).toContain("400.0s")
    expect(out).not.toContain("/")
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/retry-duration-display.unit.test.ts`
Expected: 新 2 例 FAIL。

- [ ] **Step 3: 改 footer 单请求分支**

`src/lib/tui/render/footer.ts` 的 `count === 1` 分支（:54-64）：

```ts
  if (count === 1) {
    const entry = active[0]
    const totalMs = now - entry.ctx.startTime
    const retries = (entry.ctx.attemptCount ?? 1) - 1
    const lastMs = entry.ctx.currentAttemptStartedAt !== undefined ? now - entry.ctx.currentAttemptStartedAt : undefined
    const elapsed = formatDurationField({ lastMs, totalMs, retries }) // 原 formatDuration(now - entry.ctx.startTime)
    const model = entry.ctx.resolvedModel ? ` ${entry.ctx.resolvedModel}` : ""
    const streamInfo = formatStreamInfo({ bytesIn: entry.streamBytesIn, eventsIn: entry.streamEventsIn, blockType: entry.streamBlockType })
    return finalizeFooter(`[<-->] ${entry.ctx.method} ${entry.ctx.path}${model} ${elapsed}${streamInfo}`, columns)
  }
```

顶部 import 从 `~/lib/observability/projections/format` 补 `formatDurationField`（对齐既有 `formatDuration` import）。

- [ ] **Step 4: 改 panel elapsed 行**

`src/lib/tui/render/panel.ts`。先读 `:190-225` 定位 `formatPanelRow`（:195 附近）与 `buildDetailLines`（:220 附近）的 `formatDuration(now - ctx.startTime)`。两处均替换（`ctx` 是 `RequestContextSnapshot`，顶层标量已由 Task 4 保证）：

```ts
  const pRetries = (ctx.attemptCount ?? 1) - 1
  const pLastMs = ctx.currentAttemptStartedAt !== undefined ? now - ctx.currentAttemptStartedAt : undefined
  const elapsed = formatDurationField({ lastMs: pLastMs, totalMs: now - ctx.startTime, retries: pRetries })
```

:220 的 `buildDetailLines` elapsed 明细行同样替换（复用上面的 `pRetries/pLastMs`）。import 补 `formatDurationField`。

- [ ] **Step 5: 新建真实-bus 集成测试（BLOCK-1 防回归）**

创建 `tests/tui/footer-live-attempt.integration.test.ts`。**这是 BLOCK-1 的关键守卫**——单测注入 ctx 标量会假绿（真实路径 `entry.ctx` 被 `stream_progress` 的无 summary 轻量 snapshot 覆盖）。本测驱动真实 `RequestContext` → bus，证明 `stream_progress` 的轻量 snapshot 顶层携带 `currentAttemptStartedAt`。参照 `tests/pipeline/buffered-sink.unit.test.ts:92` 的 `createRequestContext` 用法：

```ts
import { describe, expect, it } from "bun:test"

import { createRequestContext } from "~/lib/context/request"

describe("BLOCK-1 回归：stream_progress 后轻量 snapshot 仍带 currentAttemptStartedAt", () => {
  it("真实 ctx beginAttempt + recordStreamProgress → stream_progress 顶层带 attempt 计时", () => {
    const events: Array<unknown> = []
    const ctx = createRequestContext({ endpoint: "anthropic-messages", publisher: { publish: (e: never) => void events.push(e) } } as never)
    ctx.beginAttempt({})
    ctx.recordStreamProgress({ bytesIn: 10, eventsIn: 1 })
    const progress = events.find((e) => (e as { kind?: string }).kind === "request.stream_progress") as { ctx: { currentAttemptStartedAt?: number; attemptCount?: number } }
    expect(progress.ctx.currentAttemptStartedAt).toBeGreaterThan(0)
    expect(progress.ctx.attemptCount).toBe(1)
  })
})
```

> 实现者对齐 `createRequestContext` 真实签名（`buffered-sink.unit.test.ts:92`）。断言逻辑不变：证明**轻量 snapshot 路径**携带顶层标量（BLOCK-1 根因修复点）。

- [ ] **Step 6: 跑测试确认通过**

Run: `bun test tests/tui/retry-duration-display.unit.test.ts tests/tui/footer-live-attempt.integration.test.ts`
Expected: 全 PASS。

- [ ] **Step 7: typecheck + lint + 提交**

```bash
bun run typecheck
bunx eslint src/lib/tui/render/footer.ts src/lib/tui/render/panel.ts tests/tui/retry-duration-display.unit.test.ts tests/tui/footer-live-attempt.integration.test.ts
git add -- src/lib/tui/render/footer.ts src/lib/tui/render/panel.ts tests/tui/retry-duration-display.unit.test.ts tests/tui/footer-live-attempt.integration.test.ts
git commit -m "feat(tui): footer/panel show last/total(N) plain-text on retries"
```

---

## Task 8: 回归清扫 + 合并态验证

**Files:**
- Modify: 既有涉及 `[RETRY-N]` / duration 形态的快照或断言（实现者 grep 定位）
- Test: 全 backend 套件

- [ ] **Step 1: 定位受影响的既有测试**

Run:
```bash
grep -rn "\[RETRY-" tests/ src/
grep -rln "attempt_failed\|onAttemptFailed\|STREAM DISCONNECT\|buildActiveFooter\|formatDuration(" tests/tui tests/pipeline tests/observability
```
Expected: 列出所有断言旧 `[RETRY-N]` 前缀、或依赖 footer/panel/terminal duration 形态的测试。

- [ ] **Step 2: 逐个更新到新形态**

对每个命中：把 `[RETRY-N]` 断言改为 `[RETRY]` + `(N)`；把依赖单值 duration 的 footer/panel 断言按 triplet 更新（无重试场景保持单值——应无需改）。逐文件读、逐处改（不要 sed 全局替换，避免误伤——见记忆 `sed-touched-files`）。

- [ ] **Step 3: 跑全 backend 套件**

Run: `bun test`
Expected: 全绿。若有 flaky/时序相关（duration 依赖 `Date.now()`），把测试改为注入固定 `now`/mock timer，而非放宽断言。

- [ ] **Step 4: 合并态 golden 核对**

Run: `bun test tests/tui tests/pipeline tests/observability`
手工核对一条有重试的完整序列输出：`[RETRY](1)` → `[RETRY](2)` → `[ OK ] last/total(2)`，确认末条 `[RETRY]` 的 `(N)` 与汇总 `(N)` 数值对齐（终态一致不变量）。

- [ ] **Step 5: typecheck 全量 + lint:all + 提交**

```bash
bun run typecheck
bun run lint:all
git add -- <本 task 改动的测试文件精确路径>
git commit -m "test: update snapshots for [RETRY] prefix + last/total(N)"
```

---

## Self-Review 记录

- **Spec coverage**：`formatDurationField`(T1) / `AttemptSnapshot.durationMs`(T2) / L2 attempt_failed BLOCK-1(T3) / `currentAttemptStartedAt`(T4) / onTerminal(T5) / onAttemptFailed+`[RETRY]`(T6) / footer+panel(T7) / 回归(T8) —— 覆盖 spec 全部 §设计 + 3 处管线 + 3 处渲染 + 边界（N=0、零-attempt、lastMs 无效兜底、footer 聚合行不动）。
- **着色**：`resolveDurationColorMs` 实现 spec 决策 6（按头部值），N=0 严格按 total。
- **1-based**：T6 `retries = attemptIndex + 1`，实现 spec 决策 5，测试显式断言无 `(0)`。
- **类型一致**：`formatDurationField` / `resolveDurationColorMs` / `finalizeCurrentAttemptDuration` 三个新符号跨 T1/T3/T5/T6/T7 命名一致。
- **未纳入（spec 明列）**：footer 聚合行 total-only、log-line 纯格式化器不改、footer/panel 不着色——计划中显式保持不动。

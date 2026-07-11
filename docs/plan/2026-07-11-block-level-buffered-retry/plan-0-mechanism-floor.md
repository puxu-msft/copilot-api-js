# P0 机制地基 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> 权威 spec：[`../../spec/2026-07-11-block-level-buffered-retry.md`](../../spec/2026-07-11-block-level-buffered-retry.md) §3.1/§6/§9.2。总览：[`README.md`](README.md)。

**Goal:** 铺设 block 级缓冲重试的 vendor-agnostic 地基——`commitBoundaries` 谓词接口 + driver 块级提交骨架（`!committedAny` 门 + `partial-degrade` 分类）+ vendor 中立共享配置键 + telemetry vendor 维度/新终局分类——**全部行为中性**（`commitBoundaries===undefined` 时逐字复现现整响应行为，默认仍关）。

**Architecture:** 在 `runResponseBufferedSink`（`driver.ts`）把提交点从「drain 后一次」推广为「消费 `commitBoundaries(frame)` 在循环内每边界提交」；谓词缺省 = terminal-only（= 现整响应，golden-fixture 验等价）。配置抽 `buffered_retry.*` 共享键 + per-vendor 覆盖 + 旧键一次性迁移。telemetry 加 `partial-degrade` 终局 + vendor 维度。

**Tech Stack:** TypeScript / Bun（`bun test`）/ Hono / consola。测试隔离见 skill `test-isolation`（新 module-global 单例登记 RESETTERS）。

## Global Constraints（每任务隐含，逐字自 README）

- **无向后兼容负担**：旧键 `protect_streaming_max_retries`/`_buffer_cap_bytes`/`_heartbeat` 一次性迁移到 `buffered_retry.*`，允许短期报错，不留双轨。
- **命名铁律**：mode-switch = `<vendor>.buffered_retry.enabled`（`buffered_retry` 恒为 map）；覆盖键 `<vendor>.buffered_retry.{max_retries,buffer_cap_bytes,heartbeat_sec}`；Anthropic 例外 = 三态 `protect_streaming_generation` + `anthropic.buffered_retry.*`。优先级 per-vendor 覆盖 > 共享 `buffered_retry.*` > 内置默认（3 / 16777216 / 15）。
- **红线 R1**：P0 落地后默认行为**逐字不变**（`commitBoundaries===undefined` = terminal-only = 现行为，golden-fixture 回放等价）。
- **no-auto-server**：不跑服务器；可 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit、conventional commits、无模型署名。

---

### Task 1: `commitBoundaries` 谓词字段 + driver 块级提交骨架（行为中性）

**Files:**
- Modify: `src/lib/pipeline/types.ts`（`RunBufferedOpts` 加 `commitBoundaries?` **+ `telemetryVendor?: string`** —— 二者均本 Task 加，见冻结契约）
- Modify: `src/lib/pipeline/driver.ts:580-720`（`runResponseBufferedSink` 提交循环）
- Test: `tests/pipeline/buffered-block-level.test.ts`（新建）

**Interfaces:**
- Produces（P1-P4 消费，逐字见 README「冻结契约」）：
  - `RunBufferedOpts.commitBoundaries?: (frame: ClientFrame) => boolean` —— 缺省（undefined）= terminal-only = 现整响应行为。
  - `RunBufferedOpts.telemetryVendor?: string` —— driver 注入进 `onBufferedResolve` 的 `meta.vendor`（H1：本 Task 显式加，非「见别处」）。
  - driver 内部：`committedAny: boolean`；重试判据升级为 `retryable && !committedAny && !retreated`。
  - `onBufferedResolve` 新增终局 `"partial-degrade"`（Task 2）。
  - **drained 语义重定义（spec §3.2 / 审查 M1）**：`commitBoundaries` 提供时，终止帧（message_stop/error）走**循环内** flush；循环后终止块**仅做分类**（读 `committedAny`+`sawMessageStop`）**不再二次 flush**——避免终止帧既被循环内边界 flush、又被循环后块重复 flush。`commitBoundaries===undefined` 时维持现「循环后一次 flush」（行为中性）。

- [ ] **Step 1: 写失败测试 — 块级谓词多次提交 + 首块后截断走 partial-degrade**

```typescript
// tests/pipeline/buffered-block-level.test.ts
import { describe, expect, test } from "bun:test"
import { runResponseBufferedSink } from "~/lib/pipeline/driver"
import { makeArraySink } from "~/lib/pipeline/client-sink"
import { makeBufferedHarness } from "./helpers/buffered-harness" // 见 Step 3 建 helper

describe("block-level commit", () => {
  test("commitBoundaries → flush at each boundary; first-block-then-truncate → partial-degrade, no retry", async () => {
    const frames = [
      { data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }) },
      { data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }) },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) }, // boundary → commit block 0
      { data: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text" } }) },
      // upstream truncates here (no message_stop) AFTER block 0 already committed
    ]
    const h = makeBufferedHarness(frames, { sawMessageStop: false })
    const sink = makeArraySink()
    const outcomes: Array<string> = []
    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      commitBoundaries: (f) => {
        try { return (JSON.parse(f.data ?? "{}") as { type?: string }).type === "content_block_stop" }
        catch { return false }
      },
      sawMessageStop: () => false,
      onBufferedResolve: (o) => outcomes.push(o),
    })
    expect(outcome.kind).toBe("stream-error")
    expect(outcomes).toEqual(["partial-degrade"]) // NOT "exhausted": committed block 0 → no retry
    expect(sink.frames.some((f) => (f.data ?? "").includes("content_block_stop"))).toBe(true) // block 0 was flushed
  })

  test("commitBoundaries undefined → behaviour identical to whole-response (R1)", async () => {
    const frames = [
      { data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }) },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
      { data: JSON.stringify({ type: "message_stop" }) },
    ]
    const h = makeBufferedHarness(frames, { sawMessageStop: true })
    const sink = makeArraySink()
    const outcome = await runResponseBufferedSink(h.deps, h.upstream, h.env, sink, {
      ...h.opts,
      sawMessageStop: () => true,
      // no commitBoundaries → terminal-only
    })
    expect(outcome.kind).toBe("complete")
    expect(sink.frames.length).toBe(3) // all flushed once at terminal
  })
})
```

- [ ] **Step 2: 跑测试证失败**

Run: `bun test tests/pipeline/buffered-block-level.test.ts`
Expected: FAIL —— `commitBoundaries` 未定义 / `partial-degrade` 未支持 / helper 缺失。

- [ ] **Step 3: 建测试 harness helper**

```typescript
// tests/pipeline/helpers/buffered-harness.ts
import type { ClientFrame } from "~/lib/pipeline/types"
// 最小 harness：把一个帧数组包成 driver 可消费的 upstream + env + opts。
// 复用现有 buffered 测试的构造（参照 tests/pipeline/ 里现存 buffered sink 测试的 setup）。
export function makeBufferedHarness(
  frames: Array<ClientFrame>,
  cfg: { sawMessageStop: boolean },
): { deps: any; upstream: any; env: any; opts: any } {
  // 见现有 tests/pipeline/*buffered* 的 harness 模式：runResponse 被 mock 成 yield frames；
  // env.ctx 提供 commitAttemptSseEvents/resetSseEvents/setForwardedResponse no-op。
  // 具体实现照现存 buffered 测试文件复制（DRY：若已有共享 harness 直接 import）。
  throw new Error("implement per existing tests/pipeline buffered harness pattern")
}
```

> 实施注：先 `grep -rl "runResponseBufferedSink" tests/` 找现有 buffered 测试，复用其 harness；若无共享 helper 则从最近似的测试文件提取。**不新造 mock 契约**（skill `debugging-test-pollution`：改共享 mock 会打爆 sibling）。

- [ ] **Step 4: 实现 driver 块级骨架（行为中性）**

在 `driver.ts` 的 `runResponseBufferedSink` 缓冲循环里改造（保持 undefined 路径逐字不变）：

```typescript
// driver.ts — runResponseBufferedSink 内，替换现有「COMMIT on clean drain that reached terminal」块。
// 新增：committedAny 追踪 + 循环内边界提交。
let committedAny = false

// ——在 for-await 缓冲循环内，push 帧之后，插入边界提交判定——
// （仅当提供 commitBoundaries；否则维持原「drain 后一次提交」路径完全不变）
if (opts.commitBoundaries && !retreated && opts.commitBoundaries(toWrite)) {
  // flush 截至该边界（含）的缓冲帧。anchor remap/dedup 逻辑复用现终止提交块（抽成 flushBufferedBlock 内联函数）。
  await flushBufferedBlock(buffer, { anchorState, anchor, sink, first: !committedAny })
  buffer.length = 0
  committedAny = true
}
// ——循环结束后——
// 现有终止提交块：改为「若 commitBoundaries 提供，则终止边界也经上面的循环内判定已提交；
// 这里只处理 terminal flush 尾块 + 分类」。当 commitBoundaries===undefined，走原整响应终止提交（不变）。

// 重试判据（原 :691）：
const retryable = (thrown ? classifyStreamError(thrown) === "other" : true) && !committedAny && !retreated
if (retryable && attempt < cap) { /* …原重试… */ }

// 首块已提交后的截断（committedAny && !可重试）→ partial-degrade（新终局）
if (committedAny) {
  await closeAnchorIfOpen()
  opts.onBufferedResolve?.("partial-degrade", attempt, { vendor: opts.telemetryVendor ?? "unknown" })
  return { kind: "stream-error", error: thrown ?? new Error("upstream stream truncated after partial commit") }
}
```

> 关键：`commitBoundaries===undefined` 时上面循环内的 `if (opts.commitBoundaries && …)` 整块被跳过，`committedAny` 恒 false，重试判据 `!committedAny` 恒真 = 与现行为逐字一致（R1）。`flushBufferedBlock` 从现终止提交块（`freezeHeartbeat`/anchor close-off/remap/H1 dedup）抽取，供循环内与终止共用；`first` 参数控制 anchor close-off 只在首块做（P1 会重写 anchor 部分，P0 先保持 terminal-only 下等价）。
>
> **M1 终止去重（drained 重定义）**：当 `commitBoundaries` 提供且终止帧（message_stop/error）本身命中边界 → 它在**循环内**已 flush。循环后的终止块须改为：`commitBoundaries` 提供时**只分类不再 flush**（`if (committedAny || opts.commitBoundaries) { /* 已在循环内 flush，仅 onBufferedResolve 分类 */ } else { /* 现整响应路径：循环后一次 flush */ }`）。补回归断言「终止帧只 flush 一次」（Step 1 加一测：commitBoundaries 提供 + message_stop 是最后帧 → sink 里 message_stop 只出现一次）。
>
> **L1 四调用点补 meta**：现 driver 的 `onBufferedResolve?.("retreated"/"success"/"exhausted", attempt)`（driver.ts:625/681/684/716）全部补 `, { vendor: opts.telemetryVendor ?? "unknown" }`，否则新签名 typecheck 不过。

- [ ] **Step 5: 跑测试证通过 + 回归**

Run: `bun test tests/pipeline/buffered-block-level.test.ts && bun test tests/pipeline/`
Expected: PASS（新测试 + 所有现有 buffered 测试绿 = R1 行为中性）。

- [ ] **Step 6: 提交**

```bash
git add tests/pipeline/buffered-block-level.test.ts tests/pipeline/helpers/buffered-harness.ts src/lib/pipeline/types.ts src/lib/pipeline/driver.ts
git commit -m "feat(pipeline): commitBoundaries predicate + block-level commit skeleton (behaviour-neutral)"
```

---

### Task 2: telemetry `partial-degrade` 终局 + vendor 维度

**Files:**
- Modify: `src/lib/anthropic/protect-streaming-stats.ts`
- Modify: `src/lib/pipeline/types.ts`（`onBufferedResolve` 签名）
- Modify: `src/routes/status/route.ts`（**M4**：`/api/status` 的 protect_streaming 聚合点——`getProtectStreamingStats()` 返回类型由单对象 → `Record<vendor, Stats>` 是 **breaking change**，须同步改聚合遍历 vendor 分桶 + 各 vendor hit-rate；无向后兼容负担，显式记）
- Test: `tests/observability/protect-streaming-stats.test.ts`（新建或扩现有）

**Interfaces:**
- Produces：
  - `type ProtectStreamingOutcome = "success" | "exhausted" | "retreated" | "partial-degrade"`
  - `interface ProtectStreamingStats { success; exhausted; retreated; partialDegrade; totalRetries; retriesBeforeDegrade }`（per-vendor 分桶：`Record<string, ProtectStreamingStats>`）
  - `recordProtectStreamingOutcome(outcome, retries, meta: { vendor: string }): void`
  - `onBufferedResolve?: (outcome: ProtectStreamingOutcome, retries: number, meta: { vendor: string }) => void`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/observability/protect-streaming-stats.test.ts
import { afterEach, expect, test } from "bun:test"
import { getProtectStreamingStats, recordProtectStreamingOutcome, resetProtectStreamingStatsForTests } from "~/lib/anthropic/protect-streaming-stats"

afterEach(() => resetProtectStreamingStatsForTests())

test("partial-degrade + vendor dimension counted per-vendor", () => {
  recordProtectStreamingOutcome("success", 1, { vendor: "anthropic" })
  recordProtectStreamingOutcome("partial-degrade", 2, { vendor: "responses" })
  const s = getProtectStreamingStats()
  expect(s.anthropic.success).toBe(1)
  expect(s.responses.partialDegrade).toBe(1)
  expect(s.responses.retriesBeforeDegrade).toBe(2) // retries consumed before the degrade
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/observability/protect-streaming-stats.test.ts`
Expected: FAIL —— `partial-degrade` 非法 outcome / 无 vendor 分桶 / `retriesBeforeDegrade` 缺失。

- [ ] **Step 3: 实现**

```typescript
// protect-streaming-stats.ts
export type ProtectStreamingOutcome = "success" | "exhausted" | "retreated" | "partial-degrade"

export interface ProtectStreamingStats {
  success: number
  exhausted: number
  retreated: number
  /** 首块已提交后截断、优雅降级不重试（块级新终局）。 */
  partialDegrade: number
  totalRetries: number
  /** partial-degrade 前已消耗的重试数——不丢「重试引擎生效」信号（spec §9.2 M-1）。 */
  retriesBeforeDegrade: number
}

const emptyStats = (): ProtectStreamingStats => ({ success: 0, exhausted: 0, retreated: 0, partialDegrade: 0, totalRetries: 0, retriesBeforeDegrade: 0 })
const byVendor: Record<string, ProtectStreamingStats> = {}
const keyOf = (o: ProtectStreamingOutcome): keyof ProtectStreamingStats =>
  o === "partial-degrade" ? "partialDegrade" : o

export function recordProtectStreamingOutcome(outcome: ProtectStreamingOutcome, retries: number, meta: { vendor: string }): void {
  const s = (byVendor[meta.vendor] ??= emptyStats())
  s[keyOf(outcome)] += 1
  s.totalRetries += retries
  if (outcome === "partial-degrade") s.retriesBeforeDegrade += retries
}

/** Snapshot per-vendor（for /api/status）。 */
export function getProtectStreamingStats(): Record<string, ProtectStreamingStats> {
  return Object.fromEntries(Object.entries(byVendor).map(([v, s]) => [v, { ...s }]))
}

export function resetProtectStreamingStatsForTests(): void {
  for (const k of Object.keys(byVendor)) delete byVendor[k]
}
```

> hit-rate（spec §9.2）：`success / (success + exhausted + partialDegrade)`——分母纳入 partial-degrade（部分成功）。`/api/status` 聚合按 vendor 输出 + 计算各 vendor hit-rate。

- [ ] **Step 4: 更新 `onBufferedResolve` 签名 + /api/status 聚合 + 现有调用点**

`types.ts` 改签名；`route.ts` 的 protect_streaming 聚合改为遍历 vendor 分桶；driver 的 `onBufferedResolve?.("...", attempt)` 调用点补 `, { vendor: opts.telemetryVendor ?? "unknown" }`（`telemetryVendor` 见 Task 1 已加入 RunBufferedOpts，或此 Task 补）。现有 Anthropic（`messages/handler-v4.ts`）+ Responses（`responses/handler-v4.ts`）的 `recordProtectStreamingOutcome(o, retries)` 调用点补 `, { vendor: "anthropic" }` / `, { vendor: "responses" }`。

- [ ] **Step 5: 跑证通过 + 登记 RESETTER**

Run: `bun test tests/observability/protect-streaming-stats.test.ts && bun test tests/`
在 `tests/helpers/`（或 bunfig preload 的 RESETTERS）登记 `resetProtectStreamingStatsForTests`（module-global 单例，skill `test-isolation`）。
Expected: PASS，全套件绿。

- [ ] **Step 6: 提交**

```bash
git add src/lib/anthropic/protect-streaming-stats.ts src/lib/pipeline/types.ts src/routes/status/route.ts src/routes/messages/handler-v4.ts src/routes/responses/handler-v4.ts tests/observability/protect-streaming-stats.test.ts
git commit -m "feat(telemetry): partial-degrade outcome + per-vendor protect-streaming stats"
```

---

### Task 3: 共享配置键 `buffered_retry.*` + per-vendor 覆盖 + 旧键一次性迁移

**Files:**
- Modify: `src/lib/config/schema.ts:526-586`（加 `buffered_retry` 共享 section + `<vendor>.buffered_retry` map；**H3**：新建 `chat_completions` 配置节 + `chat_completions.buffered_retry`；`anthropic.protect_streaming_generation` 保留）
- Modify: `src/lib/config/config.ts:503-509`（读取 + 迁移旧键 + **H3** 读 `chat_completions.buffered_retry`）
- Modify: `src/lib/state.ts`（CONFIG_MANAGED_DEFAULTS 三处 :1354/:1487/:1633 + 解析器 + **H3** `chatCompletionsBufferedRetry: false` 三处默认）
- Modify: `src/lib/config/validation.ts:53-68`（告警文案改新键名）
- **H2 既有 caps 消费者一并迁移（否则违反 R1 或留双轨）**：`src/routes/messages/handler-v4.ts:1136-1137`（`state.protectStreamingMaxRetries`/`protectStreamingBufferCapBytes` → `resolveBufferedCaps("anthropic")`）、`src/routes/responses/handler-v4.ts:379-380`（→ `resolveBufferedCaps("responses")`）、`src/routes/responses/buffered-config.ts`（heartbeat 读取 → `resolveBufferedCaps("responses").heartbeatSec`）
- Modify: `config.yaml:549-561`、`config.example.yaml`
- Test: `tests/config/buffered-retry-keys.test.ts`（新建）

**Interfaces:**
- Produces（P1-P4 消费，见 README 冻结契约）：`resolveBufferedCaps(vendor)`（优先级 per-vendor 覆盖 > 共享 > 内置默认 3/16777216/15）；`state.chatCompletionsBufferedRetry: boolean`（默认 false，P3 消费）；`anthropic.protect_streaming_generation` 三态不变；`<vendor>.buffered_retry.enabled` 布尔（responses/chat_completions）。**H2：迁移后旧 `state.protectStreamingMaxRetries/Heartbeat/BufferCapBytes` 独立字段删除，两个 handler + buffered-config 全部改读 `resolveBufferedCaps`，无双轨（R1 由「resolveBufferedCaps 对 anthropic 返回值 === 旧字段值」的等价测试守）。**

- [ ] **Step 1: 写失败测试（优先级 + 迁移）**

```typescript
// tests/config/buffered-retry-keys.test.ts
import { expect, test } from "bun:test"
import { resolveBufferedCaps } from "~/lib/state"
import { applyConfig } from "~/lib/config/config"

test("per-vendor override > shared > builtin default", () => {
  applyConfig({ buffered_retry: { max_retries: 5 }, anthropic: { buffered_retry: { max_retries: 9 } } } as any)
  expect(resolveBufferedCaps("anthropic").maxRetries).toBe(9)   // per-vendor override
  expect(resolveBufferedCaps("responses").maxRetries).toBe(5)   // shared
  expect(resolveBufferedCaps("chat_completions").bufferCapBytes).toBe(16_777_216) // builtin default
})

test("legacy protect_streaming_max_retries migrates to shared buffered_retry.max_retries", () => {
  applyConfig({ anthropic: { protect_streaming_max_retries: 7 } } as any)
  expect(resolveBufferedCaps("anthropic").maxRetries).toBe(7) // migrated
})
```

- [ ] **Step 2: 跑证失败**

Run: `bun test tests/config/buffered-retry-keys.test.ts`
Expected: FAIL —— `resolveBufferedCaps` / `buffered_retry` schema 缺失。

- [ ] **Step 3: schema + state 默认 + resolver**

```typescript
// schema.ts — 顶层加共享 section + 每 vendor 加 buffered_retry map
const bufferedRetryOverride = z.object({
  enabled: z.boolean().optional(),
  max_retries: nonnegativeInt().optional(),
  buffer_cap_bytes: nonnegativeInt().optional(),
  heartbeat_sec: nonnegativeInt().optional(),
}).optional()
// 顶层：buffered_retry: bufferedRetryOverride（共享，无 enabled 语义）
// anthropic.buffered_retry: bufferedRetryOverride（覆盖，无 enabled——Anthropic 用 protect_streaming_generation）
// openai_responses.buffered_retry 现为 boolean → 迁为 z.union([z.boolean(), bufferedRetryOverride])（boolean=enabled 简写）
// chat_completions.buffered_retry: z.union([z.boolean(), bufferedRetryOverride])
```

```typescript
// state.ts — CONFIG_MANAGED_DEFAULTS 三处新增（替换 protectStreamingMaxRetries/Heartbeat/BufferCapBytes 的独立字段为共享 + per-vendor 覆盖 map）
bufferedRetryShared: { maxRetries: 3, bufferCapBytes: 16_777_216, heartbeatSec: 15 },
bufferedRetryOverrides: {} as Record<string, Partial<{ maxRetries: number; bufferCapBytes: number; heartbeatSec: number }>>,
// resolver
export function resolveBufferedCaps(vendor: string): { maxRetries: number; bufferCapBytes: number; heartbeatSec: number } {
  const o = state.bufferedRetryOverrides[vendor] ?? {}
  const s = state.bufferedRetryShared
  return {
    maxRetries: o.maxRetries ?? s.maxRetries,
    bufferCapBytes: o.bufferCapBytes ?? s.bufferCapBytes,
    heartbeatSec: o.heartbeatSec ?? s.heartbeatSec,
  }
}
```

- [ ] **Step 4: config.ts 读取 + 旧键迁移**

```typescript
// config.ts — 替换现 :505-509 的 protect_streaming_{max_retries,heartbeat,buffer_cap_bytes} 读取
// 旧键 → 共享/anthropic 覆盖的一次性映射（读到即 setState + consola.warn "deprecated, migrate to buffered_retry.*"）
if (a.protect_streaming_max_retries !== undefined) setBufferedRetryOverride("anthropic", { maxRetries: a.protect_streaming_max_retries })
if (a.protect_streaming_heartbeat !== undefined) setBufferedRetryOverride("anthropic", { heartbeatSec: clampKeepaliveCadence(a.protect_streaming_heartbeat) })
if (a.protect_streaming_buffer_cap_bytes !== undefined) setBufferedRetryOverride("anthropic", { bufferCapBytes: a.protect_streaming_buffer_cap_bytes })
// 新：顶层 buffered_retry + 各 vendor.buffered_retry
if (config.buffered_retry) setBufferedRetryShared(config.buffered_retry)
if (a.buffered_retry) setBufferedRetryOverride("anthropic", mapCaps(a.buffered_retry))
// responses.buffered_retry: boolean|map → enabled + caps
// chat_completions.buffered_retry: 同上（P3 消费 enabled）
```

`protect_streaming_generation`（三态）保留不动。

- [ ] **Step 5: validation.ts 告警文案 + config.yaml/example 同步**

`validation.ts:53-68` 的 `protect_streaming_heartbeat`/`_generation` 引用改为新键名叙述。`config.yaml`/`config.example.yaml` 把 `protect_streaming_max_retries`/`_heartbeat`/`_buffer_cap_bytes` 三键替换为共享 `buffered_retry:` section（注释标旧键已迁移），`protect_streaming_generation` 保留。

- [ ] **Step 6: 跑证通过（含全套件 + typecheck）**

Run: `bun test tests/config/ && bun run typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/lib/config/schema.ts src/lib/config/config.ts src/lib/config/validation.ts src/lib/state.ts config.yaml config.example.yaml tests/config/buffered-retry-keys.test.ts
git commit -m "feat(config): shared buffered_retry.* keys + per-vendor overrides + legacy key migration"
```

---

## 自审

**spec 覆盖：** §3.1 commitBoundaries 接口 → Task 1；§6 共享配置键 + 迁移 → Task 3；§9.2 partial-degrade + vendor 维度 + hit-rate → Task 2。✅

**占位扫描：** Task 1 Step 3 harness 标注「照现有 buffered 测试模式提取」——实施者须先 grep 定位现有 harness，非凭空造（已注明 DRY + 不造 mock 契约）。driver Step 4 的 `flushBufferedBlock` 抽取是从现终止提交块提取（现码已在 driver.ts:642-680），非新逻辑。无 TBD。

**类型一致：** `commitBoundaries: (frame: ClientFrame) => boolean`、`onBufferedResolve(outcome, retries, meta:{vendor})`、`ProtectStreamingOutcome` 含 `partial-degrade`、`resolveBufferedCaps(vendor)` —— P1-P4 消费的签名在此锚定，与 README 契约一致。

**R1 行为中性验证：** Task 1 Step 1 第二测试 + Step 5 全套件回归 = `commitBoundaries===undefined` 逐字复现现整响应行为。**这是 P0 可 landing 的门。**

**遗留给 P1 的边界：** anchor close-off 在块级下的正确形状（P0 的 `flushBufferedBlock` 的 `first` 参数只在 terminal-only 下等价现状；P1 重写 anchor 协同——块栈 + 块间 text_delta@0）。P0 不翻任何默认（全部仍 false/现状）。

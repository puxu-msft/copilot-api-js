# P3 Chat Completions — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤用 `- [ ]` 跟踪。
>
> 权威 spec：[`../../spec/2026-07-11-block-level-buffered-retry.md`](../../spec/2026-07-11-block-level-buffered-retry.md) §3.1/§7.1/§9/§11。总览 [`README.md`](README.md)。**依赖 P0**（`commitBoundaries` 骨架 + `partial-degrade` + `resolveBufferedCaps` + telemetry vendor 维度）。

**Goal:** 给 `/v1/chat/completions` 流式**净新建**终止-only buffered 保护（CC 当前零 buffered 路径）——接 driver buffered 分支、`finish_reason` 作终止、`[DONE]` 合成纳入提交单元、首块前 forced keepalive（实现 backlog:316 CC 腿）+ M-2 实证门、默认翻 true。

**Architecture:** CC 无中途块边界（deltas 增量、终止是最后 chunk 的 `finish_reason`），故 `commitBoundaries` = 终止-only（退化态 = 整响应缓冲）。CC 当前 `makeSseSink` 无 heartbeat——新增 forced keepalive chunk。无 anchor（CC 非 Anthropic）。

**Tech Stack:** TypeScript / Bun / Hono SSE / openai chat SDK（keepalive oracle）。

## Global Constraints（逐字自 README）
- **命名铁律**：`chat_completions.buffered_retry.enabled` 布尔开关 + `chat_completions.buffered_retry.*` 覆盖 + 共享 `buffered_retry.*`。
- **红线 R4**：默认翻 true 的 commit 在 keepalive 实证门（M-2）通过后。
- **红线 R5**：landing 关 backlog:316 的 CC 腿（Gemini 腿保留）。
- **no-auto-server**：keepalive oracle「跑真实客户端」须用户执行。
- 细粒度显式 pathspec commit、conventional commits、无模型署名。

---

### Task 1: CC 终止-only commit 谓词 + resolve 选路

**Files:**
- Create: `src/routes/chat-completions/buffered-config.ts`（仿 `responses/buffered-config.ts`）
- Create: `src/lib/openai/cc-commit-boundaries.ts`
- Test: `tests/openai/cc-commit-boundaries.test.ts`

**Interfaces:**
- Consumes（P0）：`commitBoundaries?`、`resolveBufferedCaps("chat_completions")`。
- Produces：`ccCommitBoundaries(frame): boolean`（终止-only：CC 无独立终止帧，终止由 handler 侧 `acc.finishReason !== ""` 判定，故谓词只认上游 `error` 帧为帧级边界；真正的终止提交靠 handler 的 `sawMessageStop = () => acc.finishReason !== ""`）；`resolveCcBufferedAndHeartbeat(): { buffered: boolean; heartbeatSec: number }`。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/openai/cc-commit-boundaries.test.ts
import { expect, test } from "bun:test"
import { ccCommitBoundaries } from "~/lib/openai/cc-commit-boundaries"
const f = (o: unknown) => ({ data: JSON.stringify(o) })
test("CC terminal-only: only upstream error is a frame-level boundary; deltas are not", () => {
  expect(ccCommitBoundaries(f({ error: { message: "overloaded" } }))).toBe(true)
  expect(ccCommitBoundaries(f({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }))).toBe(false)
  // finish_reason 落在最后 chunk 上——由 handler 的 sawMessageStop 读 acc.finishReason 判定终止提交，非谓词。
  expect(ccCommitBoundaries({ data: "[DONE]" })).toBe(false) // driver 丢弃 [DONE]，handler post-loop 合成
})
```

- [ ] **Step 2: 跑证失败** — `bun test tests/openai/cc-commit-boundaries.test.ts`（FAIL：模块缺）。

- [ ] **Step 3: 实现谓词 + resolve**

```typescript
// src/lib/openai/cc-commit-boundaries.ts
import type { ClientFrame } from "~/lib/pipeline/types"
export function ccCommitBoundaries(frame: ClientFrame): boolean {
  if (frame.data === undefined || frame.data === "[DONE]") return false
  try {
    const p = JSON.parse(frame.data) as { error?: unknown }
    return p.error !== undefined // 上游终态 error 帧是 commit 边界（spec §5.3 M1）；deltas 非边界
  } catch { return false }
}
```

```typescript
// src/routes/chat-completions/buffered-config.ts （仿 responses/buffered-config.ts）
import { resolveBufferedCaps, state } from "~/lib/state"
export function resolveCcBufferedAndHeartbeat(): { buffered: boolean; heartbeatSec: number } {
  const buffered = state.chatCompletionsBufferedRetry // P0 加的 enabled 布尔
  const caps = resolveBufferedCaps("chat_completions")
  const forced = state.streamKeepalivePingSec > 0 ? state.streamKeepalivePingSec : caps.heartbeatSec
  return { buffered, heartbeatSec: buffered ? forced : state.streamKeepalivePingSec }
}
```

- [ ] **Step 4: 跑证通过 + 提交**

```bash
bun test tests/openai/cc-commit-boundaries.test.ts
git add src/lib/openai/cc-commit-boundaries.ts src/routes/chat-completions/buffered-config.ts tests/openai/cc-commit-boundaries.test.ts
git commit -m "feat(chat-completions): terminal-only commit predicate + buffered config resolver"
```

---

### Task 2: handler 接 driver buffered 分支 + `[DONE]` 纳入提交单元

**Files:**
- Modify: `src/routes/chat-completions/handler-v4.ts:370`（runResponseSink → 选路 buffered/live）
- Test: `tests/chat-completions/cc-buffered.integration.test.ts`

**Interfaces:**
- Consumes：Task 1 `ccCommitBoundaries`/`resolveCcBufferedAndHeartbeat`；P0 骨架 + `partial-degrade` + `telemetryVendor`。
- `sawMessageStop = () => acc.finishReason !== ""`（CC 终止信号，:402）；`[DONE]` 由 handler post-loop 合成（:416）——buffered 分支须在 commit 后仍追加合成 `[DONE]`（driver 丢弃上游 [DONE]，故 [DONE] 是 handler 侧合成、在 buffered 提交单元**之后**无害追加，客户端收 terminal chunk + [DONE]）。

- [ ] **Step 1: 写失败集成测试**

```typescript
// tests/chat-completions/cc-buffered.integration.test.ts
// buffered on：CC 流终止前截断（无 finish_reason）→ 重试 → 第二次带 finish_reason 收全 → 客户端拿完整 + [DONE]。
test("CC buffered: truncate before finish_reason → retried & recovered + synthesized [DONE]", async () => {
  // attempt1: [chunk(delta), <截断>] （acc.finishReason==="" → truncation → retry）
  // attempt2: [chunk(delta), chunk(finish_reason:"stop")] → commit → handler 合成 [DONE]
  // 断言：outcome complete；onBufferedResolve success retries≥1；末帧含 finish_reason；[DONE] 追加。
})
```

- [ ] **Step 2: 跑证失败** — FAIL（现仅 runResponseSink 无 buffered）。

- [ ] **Step 3: handler 选路**

```typescript
// chat-completions/handler-v4.ts 替换 :370 单一 runResponseSink
const { buffered, heartbeatSec } = resolveCcBufferedAndHeartbeat()
const outcome = buffered
  ? await driver.runResponseBufferedSink(upstream, env, makeSseSink(stream, { heartbeatSec }), {
      onRenderedFrame,
      commitBoundaries: ccCommitBoundaries,
      sawMessageStop: () => acc.finishReason !== "",
      sawUpstreamError: () => acc.streamError !== undefined,
      telemetryVendor: "chat_completions",
      retryCap: resolveBufferedCaps("chat_completions").maxRetries,
      bufferCapBytes: resolveBufferedCaps("chat_completions").bufferCapBytes,
      onBufferedResolve: (o, retries, meta) => { recordProtectStreamingOutcome(o, retries, meta); env.ctx.recordFeature("protect-streaming-retry", { outcome: o, retries }) },
      onAttemptReset: () => { /* reset CC acc */ },
    })
  : await driver.runResponseSink(upstream, env, sink, { onRenderedFrame })
// [DONE] 合成（:416）保留在 outcome 处理之后（buffered/live 皆追加）。
```

> **终止-only 下 partial-degrade 分析**：CC 无中途块边界 → `committedAny` 仅在终止提交（finish_reason）时置真 → 首块前截断永远走重试窗口；partial-degrade **几乎不触发**（仅当上游 error 帧提交后又有后续截断，罕见）。这是终止-only 退化态的预期——CC 的价值主要是「首 token 前透明重试」。

- [ ] **Step 4: 跑证通过 + 提交**（含全套件回归）

```bash
bun test tests/chat-completions/ && bun run typecheck
git add src/routes/chat-completions/handler-v4.ts tests/chat-completions/cc-buffered.integration.test.ts
git commit -m "feat(chat-completions): route through driver buffered sink (terminal-only, [DONE] appended post-commit)"
```

---

### Task 3: 首块前 forced keepalive（backlog:316 CC 腿）+ M-2 实证门

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts`（`makeSseSink` 现 CC 无 heartbeat → 复用 heartbeatSec 参数；确认 CC-shape keepalive chunk）
- Create: `exp/cc-keepalive-idle-oracle/{probe.ts,README.md}`

**Interfaces:** CC-shape keepalive chunk（`{choices:[{delta:{},index:0,finish_reason:null}]}` 或等价空 delta——须是「真实内容」形态能重置 CC 客户端 idle，非裸 SSE comment）。

- [ ] **Step 1: keepalive chunk 形态 + 单测**

CC buffered 分支的 `makeSseSink(stream, { heartbeatSec })` 心跳 tick 发 CC-shape 空 delta chunk（带 `synthetic:"keepalive"` 标记，richest-data-flow）。单测断言 tick 产出 CC-shape chunk。

- [ ] **Step 2: M-2 实证 oracle（须用户执行）**

```typescript
// exp/cc-keepalive-idle-oracle/probe.ts
// armPing：mock 上游静默 >CC客户端idle死线 后吐尾，buffered on 发 CC keepalive chunk @heartbeatSec；
//   真实 openai chat SDK / 目标 CC 客户端作 oracle，判据「无 idle 断连」。
// armSilent（对照）：heartbeat off → 复现 idle-out，反证保活承重。
```

> **⚠ 须用户执行**：Run `bun run exp/cc-keepalive-idle-oracle/probe.ts`。判据：armPing 无断连、armSilent 断连。**门未过 → 默认保持 false（Task 4 不翻）**。R4。

- [ ] **Step 3: 提交探针 + 结论**

```bash
git add exp/cc-keepalive-idle-oracle/ src/lib/pipeline/client-sink.ts tests/pipeline/
git commit -m "feat(chat-completions): forced keepalive chunk on buffered path + M-2 idle-reset oracle (backlog:316 CC leg)"
```

---

### Task 4: 默认翻 `chat_completions.buffered_retry` true（**complete 2026-07-14**——用户明确决策越过原定「M-2 门后」顺序直接翻转，`exp/cc-keepalive-idle-oracle` §4 降级为 merge-to-master 前置确认项，非本次分支翻转阻塞门；见 `.superpowers/sdd/progress.md` + `docs/todo/deferred-backlog.md`）

**Files:** `src/lib/state.ts`（CONFIG_MANAGED_DEFAULTS 三处 `chatCompletionsBufferedRetry: true`）、`config.yaml`/`config.example.yaml`（`chat_completions.buffered_retry.enabled: true`）、`docs/todo/deferred-backlog.md`（关 :316 CC 腿）。

- [x] **Step 1-2: 翻默认 + 关 backlog CC 腿 + 全套件回归 + typecheck** —— 完成于 2026-07-14；`buffered-retry-keys.test.ts`/`tests/responses,chat-completions,config/` 933 pass 0 fail、typecheck 绿

- [x] **Step 3: 提交**

```bash
git add src/lib/state.ts config.yaml config.example.yaml docs/todo/deferred-backlog.md
git commit -m "feat(chat-completions): default buffered_retry on (M-2 gate passed); close backlog:316 CC leg"
```

---

## 自审

**spec 覆盖：** §7.1 CC 净新建（谓词/选路/[DONE]/keepalive）→ T1/T2/T3；§3.1 终止-only 谓词→T1；M-2 实证门→T3；默认翻转→T4；终止-only partial-degrade 分析→T2 S3。✅
**占位扫描：** keepalive chunk 单测/集成测试须实施者照现有 CC handler 测试 harness 落真断言；探针命令 + 判据具体。无 TBD。
**类型一致：** `ccCommitBoundaries`/`resolveCcBufferedAndHeartbeat`/`chatCompletionsBufferedRetry`/`telemetryVendor:"chat_completions"`/`resolveBufferedCaps` 与 P0 契约一致。
**R4/R5：** T4 在 T3 门后；T4 关 backlog:316 CC 腿。✅

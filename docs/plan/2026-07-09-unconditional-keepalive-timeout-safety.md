# 无条件 keepalive timeout-safety 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现。步骤用 `- [ ]` 复选框追踪。**大型结构性重构**——同时遵循 skill `large-refactor`（commit invariants + 过渡态显式无害 + golden-fixture 预捕获）。

**Goal:** 让 keepalive 在安全模式下无条件重置 CC 的 300s no-real-content watchdog（含 live/delayed-commit 路径的纯 pre-response 静默），使客户端永不因超时报错。

**Architecture:** 把合成注入器从 driver 的 `bindInjector` 重定位到 **handler 层**（sink 构造时挂 `heartbeat.injectAnchor`，独立于 driver/pump，故 `await p` 挂起的 pre-response 窗口即生效）；`anchorState`（含 `capturedMessageStart`）hoist 到 handler streamSSE 回调、按引用共享给心跳注入器 + driver buffered opts + live 对账；无真实 message_start 时合成一个（`resolvedName`）；live pump（`buffered===false`）外围做实时对账（丢真实 message_start + content_block_* 索引 +1 + 首真实块前收口锚点）。

**Tech Stack:** TypeScript / Bun；Hono `streamSSE`；`@anthropic-ai/sdk` SSE 协议；vitest/bun:test；真实 Claude Code 作 oracle（`exp/cc-idle-280s/`）。

**权威来源：** spec [docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md](../spec/2026-07-08-buffered-keepalive-empty-text-anchor.md) §10（尤其 §10.1.5 架构重定位）+ ADR [docs/decisions/2026-07-09-unconditional-keepalive-timeout-safety.md](../decisions/2026-07-09-unconditional-keepalive-timeout-safety.md)。任务与 spec 冲突时**以 spec 为准**，并回写同步 spec。

## Global Constraints

- **运行时纪律（CLAUDE.md）**：**绝不**运行 `bun run dev`/`start` 或任何启动服务器的命令；**绝不** `kill`/`pkill`。可跑 `bun run typecheck` / `bunx eslint <path>`（单文件须无 `--cache`）/ `bun test <path>`。服务器行为验证交用户。
- **提交纪律**：每语义单元一提交，显式 pathspec（`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`），conventional commits，无模型署名。
- **合成帧不变量**：任何代理合成的 Anthropic SSE 帧**必须带 `event:` 行**（= 帧 JSON 的 `type`），否则 `@anthropic-ai/sdk` 的 `SSEDecoder` 静默丢帧——一律经 `anthropicSseFrame(payload)`（[src/lib/anthropic/sse-frame.ts](../../src/lib/anthropic/sse-frame.ts)）构造。
- **合成帧标记不变量（richest-data-flow ADR）**：所有合成帧在 forwarded 轨打 `SseEventRecord.synthetic` 标记；**上游轨 `upstreamResponse.sseEvents` 绝不含合成物**。keepalive=`"keepalive"`、结构锚点 start/stop=`"anchor"`、合成信封 message_start=`"synthetic-message-start"`（本计划新增）。
- **过渡态无害（large-refactor）**：每个 commit 的终态是一个不变量、中间态绝不半坏；新行为在完全接线前必须 inert（对现有 `empty_text` buffered 路径逐字节等价，直到 Phase 3 接线 live）。
- **retreat 明确排除**：上游 Anthropic 硬上限 `max_output_tokens 64000` + `max_thinking_budget 32000` ≈ 病态最坏 ~10.5 MiB < 16 MiB retreat cap → retreat 实际不可达（spec §10.3）。**不碰 retreat 分支**。
- **enveloped_ping**：留作未来实验钩子，现有证据（armP）判其撑不住 300s；实现其分支但**不作默认**、oracle 只加非门控确认臂。

---

## 文件结构（触及点总览）

| 文件 | 职责 | 阶段 |
|---|---|---|
| `src/lib/config/schema.ts` | enum `["ping","enveloped_ping","empty_text"]` | P0 |
| `src/lib/config/compat.ts` | `migrateValue` content_delta→empty_text | P0 |
| `src/lib/config/config.ts` | apply（已有，enum 值透传，确认 clamp 不涉及） | P0 |
| `src/lib/state.ts` | 类型 + 默认 `empty_text`（已是默认，改 union 成员） | P0 |
| `config.yaml` | 三模式注释 | P0 |
| `src/lib/history/types.ts` | `SseEventRecord.synthetic` 联合加 `"synthetic-message-start"` | P1 |
| `src/lib/anthropic/keepalive-anchor.ts` | `syntheticMessageStartFrame(model, reqId)` builder | P1 |
| `src/lib/pipeline/types.ts` | `AnchorHooks` 加 `syntheticMessageStart`；共享 `AnchorState` 类型；`RunBufferedOpts.anchorState` | P1/P2 |
| `src/lib/pipeline/driver.ts` | anchorState 改 opts 传入（hoist）；`bindInjector` 反转 | P2 |
| `src/routes/messages/handler-v4.ts` | handler-owned anchorState + 合成注入器挂 heartbeat + live 对账 + 终末收口 | P2-P5 |
| `src/lib/anthropic/live-reconcile.ts`（新 leaf） | live 路径对账变换（drop msg_start + remap + close） | P4 |
| `src/lib/anthropic/keepalive-frame.ts` | `resolveAnthropicKeepalive` 加 `enveloped_ping` 臂 | P6 |
| `exp/cc-idle-280s/` | oracle 新臂（live pre-response empty_text 存活 >300s） | P7 |
| `docs/DESIGN.md` | 活的架构现状行同步 | P8 |
| `tests/pipeline/`、`tests/anthropic/` | 回归测试 | 各阶段 |

## Commit Invariants（每阶段终态不变量）

- **P0 后**：config 加载不炸；旧 `empty_text` 行为逐字节不变；`content_delta` 配置加载后等价 `empty_text` + warn；`enveloped_ping` 可解析（分支未接，暂等价 `empty_text` 或 fallback，Phase 6 前不承诺其独特行为——见 P0 Task 0.2 说明）。
- **P1 后**：纯新增（builder + 标记 + 类型字段），零调用点，行为不变。
- **P2 后**：anchorState 从 driver 局部改为 handler 传入，**buffered empty_text 路径逐字节等价**（golden fixture 锁）。
- **P3 后**：live/delayed-commit + settled-within-window 的 pre-response 静默注入合成前奏；快响应逐字节等价。**核心 incident 修复点。**
- **P4 后**：合成前奏后真实上游帧对账正确（单 message_start、+1 remap、首真实块前收口）；非注入 live 路径逐字节等价。
- **P5 后**：注入后任何 live 失败分支在 error 帧前收口锚点。
- **P6 后**：`enveloped_ping` 发合成 message_start + 裸 ping。
- **P7 后**：oracle 证 live empty_text 存活 >300s；回归全绿。
- **P8 后**：DESIGN.md 与代码同步；记忆/backlog 维护。

---

## Phase 0 — config plumbing（enum + 迁移）

**Commit invariant：** config 加载不炸；`empty_text`/`ping` 不变；`content_delta`→`empty_text` + warn。

### Task 0.1：enum 改 + 默认确认

**Files:**
- Modify: `src/lib/config/schema.ts:511`
- Modify: `src/lib/state.ts:283`（类型 union）、`:1319`（默认，已是 `empty_text`，仅改 union 成员）
- Test: `tests/config/keepalive-mode.test.ts`（新建或就近既有 config 测试）

**Interfaces:**
- Produces: `stream_keepalive_mode` 合法值 = `"ping" | "enveloped_ping" | "empty_text"`；`state.streamKeepaliveMode` 同 union。

- [ ] **Step 1: 写失败测试** —— 断言 schema 接受 `enveloped_ping`、拒绝 `content_delta`（现为合法值，改后应经迁移，见 0.2；此处先断 raw schema）。

```ts
// tests/config/keepalive-mode.test.ts
import { describe, expect, test } from "bun:test"
import { configSchema } from "~/lib/config/schema" // 按实际导出名调整
test("stream_keepalive_mode accepts enveloped_ping", () => {
  const r = configSchema.safeParse({ anthropic: { stream_keepalive_mode: "enveloped_ping" } })
  expect(r.success).toBe(true)
})
test("stream_keepalive_mode rejects removed content_delta at raw schema", () => {
  const r = configSchema.safeParse({ anthropic: { stream_keepalive_mode: "content_delta" } })
  expect(r.success).toBe(false) // 迁移在 compat 层（0.2），raw schema 不再含该值
})
```

- [ ] **Step 2: 跑测试确认失败** —— `bunx eslint tests/config/keepalive-mode.test.ts && bun test tests/config/keepalive-mode.test.ts`，预期 FAIL（现 enum 无 `enveloped_ping`、仍含 `content_delta`）。
- [ ] **Step 3: 改 schema** —— `src/lib/config/schema.ts:511`：`nullableEnum(["ping", "enveloped_ping", "empty_text"] as const)`。更新该字段上方 JSDoc（现描述 content_delta，改述三模式：`ping`=裸 ping 逃生舱、`enveloped_ping`=合成信封+裸 ping（实验、预期超时）、`empty_text`=默认无条件安全）。
- [ ] **Step 4: 改 state union** —— `src/lib/state.ts:283` 类型注解 `readonly streamKeepaliveMode: "ping" | "enveloped_ping" | "empty_text"`；`:1319` 默认值断言里同步 union 文本（值仍 `"empty_text"`）；`:1594`/`:1450` 若有重复 union 断言一并改（grep `"ping" | "content_delta" | "empty_text"` 全改）。
- [ ] **Step 5: typecheck** —— `bun run typecheck`，修所有 `content_delta` 残留类型错（下游 `resolveAnthropicKeepalive` 参数类型等，Phase 6 才加分支，此处仅让类型编过：临时把 `enveloped_ping` 在 `resolveAnthropicKeepalive` 当 `empty_text` 同义处理或 `ping`——见 0.2 Task 说明，最终 Phase 6 修正）。
- [ ] **Step 6: 跑测试确认通过** —— `bun test tests/config/keepalive-mode.test.ts`，预期 PASS。
- [ ] **Step 7: commit** —— `git add -- src/lib/config/schema.ts src/lib/state.ts tests/config/keepalive-mode.test.ts && git commit -F <msg> -- <上述路径>`；msg：`feat(config): stream_keepalive_mode enum ping/enveloped_ping/empty_text`。

### Task 0.2：`content_delta` → `empty_text` 值迁移（migrateValue）

**Files:**
- Modify: `src/lib/config/compat.ts`（迁移数组末尾追加）
- Test: `tests/config/keepalive-mode.test.ts`（同文件加迁移用例）

**Interfaces:**
- Consumes: `migrateValue(oldPath, isLegacy, newValue, message)`（[compat.ts:137](../../src/lib/config/compat.ts#L137)，带值门控）。
- Produces: 加载含 `stream_keepalive_mode: content_delta` 的旧配置 → 迁移为 `empty_text` + warn。

- [ ] **Step 1: 写失败测试**

```ts
test("content_delta migrates to empty_text via migrateValue", () => {
  const migrated = applyConfigMigrations({ anthropic: { stream_keepalive_mode: "content_delta" } }) // 按 compat 实际入口名
  expect(migrated.anthropic.stream_keepalive_mode).toBe("empty_text")
})
```

- [ ] **Step 2: 确认失败** —— `bun test`，预期 FAIL。
- [ ] **Step 3: 加迁移** —— `src/lib/config/compat.ts` 迁移数组追加（参先例 `thinking_block_sanitize` @:215）：

```ts
migrateValue(
  "anthropic.stream_keepalive_mode",
  (v) => v === "content_delta",
  "empty_text",
  "anthropic.stream_keepalive_mode: content_delta 在无条件重置下已并入 empty_text（无 pre-response 门控差异），自动迁移",
),
```

- [ ] **Step 4: 确认通过** —— `bun test tests/config/keepalive-mode.test.ts` 全 PASS。
- [ ] **Step 5: 改 config.yaml 注释** —— `config.yaml:525` 附近 `stream_keepalive_mode` 三模式说明（中英）：`empty_text`（默认，无条件 timeout-safe）/ `ping`（legacy 裸 ping 逃生舱、可能超时）/ `enveloped_ping`（合成信封 + 裸 ping，实验、预期超时）。
- [ ] **Step 6: commit** —— msg：`feat(config): migrate content_delta keepalive mode to empty_text`。

---

## Phase 1 — 合成原语（纯新增，零调用点）

**Commit invariant：** 纯新增，行为不变。

### Task 1.1：`SseEventRecord.synthetic` 加标记值

**Files:**
- Modify: `src/lib/history/types.ts:158`
- Test: 类型层面（typecheck）+ 若有 SseEventRecord 单测就近加。

**Interfaces:**
- Produces: `SseEventRecord.synthetic?: "keepalive" | "anchor" | "synthetic-message-start"`。

- [ ] **Step 1: 改联合** —— `src/lib/history/types.ts:158` 把 `"keepalive" | "anchor"` 扩为 `"keepalive" | "anchor" | "synthetic-message-start"`；更新其 JSDoc 说明新值语义（伪造 message_start 信封，计费/显示分歧、比结构锚点性质更重）。
- [ ] **Step 2: typecheck** —— `bun run typecheck`，预期 PASS（纯加性联合）。
- [ ] **Step 3: 确认下游 exhaustive 消费点** —— grep `synthetic === "anchor"` / `synthetic === "keepalive"` 全仓（含 ui-v4 `~backend/*` 消费端）；若有 `switch`/穷尽映射需加 `"synthetic-message-start"` 分支（UI 显示：dim + 标注「合成信封」）。逐处补。
- [ ] **Step 4: commit** —— msg：`feat(history): add synthetic-message-start SseEventRecord marker`。

### Task 1.2：`syntheticMessageStartFrame(model, reqId)` builder

**Files:**
- Modify: `src/lib/anthropic/keepalive-anchor.ts`（追加导出）
- Test: `tests/anthropic/keepalive-anchor.test.ts`（新建或就近）

**Interfaces:**
- Consumes: `anthropicSseFrame(payload)`（[sse-frame.ts](../../src/lib/anthropic/sse-frame.ts)）。
- Produces: `syntheticMessageStartFrame(model: string, reqId: string): ServerSentEventMessage` —— 帧 `type:"message_start"`、带 `event:` 行。

- [ ] **Step 1: 写失败测试** —— 断言帧结构 + `event:` 行 + 合成 id/usage：

```ts
// tests/anthropic/keepalive-anchor.test.ts
import { syntheticMessageStartFrame } from "~/lib/anthropic/keepalive-anchor"
test("syntheticMessageStartFrame shape + event line", () => {
  const f = syntheticMessageStartFrame("claude-opus-4.8", "req_x")
  expect(f.event).toBe("message_start")          // event 行不变量
  const p = JSON.parse(f.data as string)
  expect(p.type).toBe("message_start")
  expect(p.message.id).toBe("msg_synthetic_req_x")
  expect(p.message.model).toBe("claude-opus-4.8")
  expect(p.message.role).toBe("assistant")
  expect(p.message.content).toEqual([])
  expect(p.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  expect(p.message.stop_reason).toBeNull()
})
```

- [ ] **Step 2: 确认失败** —— `bun test`，FAIL（未定义）。
- [ ] **Step 3: 实现**

```ts
// src/lib/anthropic/keepalive-anchor.ts （追加）
/**
 * 合成 message_start 信封（无真实可捕获时的兜底，spec §10.2）。`model` 取 resolvedName
 * （pre-response 窗口 env 尚未解构）。假 id + usage:0 是已接受的 wire 分歧（ADR §2）。
 * 打 `synthetic:"synthetic-message-start"` 由采样点负责，此处只造帧。
 */
export function syntheticMessageStartFrame(model: string, reqId: string): ServerSentEventMessage {
  return anthropicSseFrame({
    type: "message_start",
    message: {
      id: `msg_synthetic_${reqId}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
}
```

- [ ] **Step 4: 确认通过** —— `bun test tests/anthropic/keepalive-anchor.test.ts` PASS。
- [ ] **Step 5: commit** —— msg：`feat(anthropic): syntheticMessageStartFrame builder`。

### Task 1.3：`AnchorHooks` 加 `syntheticMessageStart`

**Files:**
- Modify: `src/lib/pipeline/types.ts:296`（AnchorHooks 接口）
- Modify: `src/routes/messages/handler-v4.ts:873`（`buildAnthropicAnchorWiring` 填该字段）

**Interfaces:**
- Produces: `AnchorHooks.syntheticMessageStart?: (model: string, reqId: string) => ClientFrame`。

- [ ] **Step 1: 加接口字段** —— `types.ts` AnchorHooks 追加 `syntheticMessageStart?: (model: string, reqId: string) => ClientFrame`（JSDoc：无真实 message_start 时兜底）。
- [ ] **Step 2: 填 wiring** —— `handler-v4.ts:873` `hooks` 对象加 `syntheticMessageStart: (model, reqId) => syntheticMessageStartFrame(model, reqId)`（import builder）。
- [ ] **Step 3: typecheck** —— PASS。
- [ ] **Step 4: commit** —— msg：`feat(pipeline): AnchorHooks.syntheticMessageStart hook`。

---

## Phase 2 — hoist anchorState 到 handler（H1，含 capturedMessageStart）

**Commit invariant：** buffered `empty_text` 路径**逐字节等价**（golden fixture 锁）。anchorState 只是从 driver 局部搬到 handler 传入。

### Task 2.0：golden-fixture 预捕获（large-refactor）

**Files:** Test: `tests/pipeline/buffered-anchor-golden.test.ts`（新建）

- [ ] **Step 1: 写 golden** —— 用现有 buffered empty_text 锚点路径（`protect_streaming_generation: on` + 上游 message_start→content_block_start(thinking)→静默→心跳注锚点→上游续帧→message_stop）跑一遍，快照 forwarded 轨（帧序列 + synthetic 标记 + index）。作为 P2-P5 的等价 oracle。
- [ ] **Step 2: 跑通** —— `bun test tests/pipeline/buffered-anchor-golden.test.ts` PASS（锁当前行为）。
- [ ] **Step 3: commit** —— msg：`test(pipeline): golden fixture for buffered empty_text anchor`。

### Task 2.1：`AnchorState` 类型 + `RunBufferedOpts.anchorState`

**Files:**
- Modify: `src/lib/pipeline/types.ts`（新增 `AnchorState` interface + `RunBufferedOpts.anchorState`）

**Interfaces:**
- Produces:

```ts
// src/lib/pipeline/types.ts
/** 跨 handler 注入器 / driver buffered / live 对账共享的锚点状态（spec §10.1.5 H1）。 */
export interface AnchorState {
  injected: boolean
  messageStartForwarded: boolean
  anchorClosed: boolean
  /** 首个真实 message_start（buffered 捕获；注入器据它「优先真实、无则合成」）。 */
  capturedMessageStart?: ClientFrame
}
```
`RunBufferedOpts` 加 `anchorState?: AnchorState`（handler 传入；省略时 driver 内部自建，保持旧调用点兼容——过渡态）。

- [ ] **Step 1: 加类型** —— 如上。typecheck PASS。
- [ ] **Step 2: commit** —— msg：`feat(pipeline): shared AnchorState type + RunBufferedOpts.anchorState`。

### Task 2.2：driver 用传入的 anchorState（替局部）

**Files:**
- Modify: `src/lib/pipeline/driver.ts:542-543`（局部 → `const anchorState = opts.anchorState ?? { injected:false, messageStartForwarded:false, anchorClosed:false }`）、`:565-568`（注入翻转）、`:591`（close）、`:620`（capturedMessageStart 捕获 → 写 `anchorState.capturedMessageStart`）、`:669`（commit snapshot）、`:677`（dedup）。
- Modify: `src/lib/pipeline/driver.ts:555` `injectAnchor` 闭包：读 `anchorState.capturedMessageStart`；无则用 `anchor.syntheticMessageStart?.(env model, reqId)` 合成（buffered 路径 env 已知——见注）。
- Test: golden（2.0）+ 新单测 `tests/pipeline/anchor-state-shared.test.ts`。

**Interfaces:**
- Consumes: `AnchorState`、`AnchorHooks.syntheticMessageStart`。
- Produces: driver 读写传入的 `anchorState`（含 capturedMessageStart）；`bindInjector` 仍回传闭包（P3 handler 侧改为不依赖它 wire live，但 buffered 仍用）。

- [ ] **Step 1: 改 driver** —— 局部 `anchorState`/`capturedMessageStart` 全部替换为读写 `opts.anchorState`（capturedMessageStart 成为 anchorState 的字段）。injectAnchor 里 `capturedMessageStart === undefined` 分支：改为「有则转发真实，无则若 `anchor.syntheticMessageStart` 存在则合成（buffered 极窄 pre-message_start 窗兜底，spec §10.2）」。
- [ ] **Step 2: golden 等价** —— `bun test tests/pipeline/buffered-anchor-golden.test.ts` 仍 PASS（buffered 有真实 message_start 时行为不变）。
- [ ] **Step 3: 新单测** —— buffered + 无真实 message_start（上游返 headers 但 message_start 未到心跳先触发）→ 合成兜底 → 断言单 message_start、重试不双发（spec §10.8 M2 测试）。
- [ ] **Step 4: typecheck + eslint** —— PASS。
- [ ] **Step 5: commit** —— msg：`refactor(pipeline): driver reads shared anchorState (hoist prep)`。

### Task 2.3：handler 持有 anchorState、传入 driver

**Files:**
- Modify: `src/routes/messages/handler-v4.ts:436-460`（settled-within-window）、`:509-598`（delayed-commit）—— 在两个 streamSSE 回调局部建 `const anchorState: AnchorState = { injected:false, messageStartForwarded:false, anchorClosed:false }`，经 `pumpAnthropicStreamingV4(... , anchorHooks, anchorState)` 传到 driver 的 `RunBufferedOpts.anchorState`。
- Modify: `pumpAnthropicStreamingV4` 签名 + 内部（把 anchorState 透传进 `runResponseBufferedSink` opts）。

- [ ] **Step 1: 建 + 透传** —— 两回调各建 anchorState；pump 签名加 `anchorState`；buffered 分支塞进 opts。
- [ ] **Step 2: golden 等价** —— PASS（值同来源、行为不变）。
- [ ] **Step 3: commit** —— msg：`refactor(anthropic): handler owns anchorState, passes to driver`。

---

## Phase 3 — handler 层合成注入器（C1，核心 incident 修复）

**Commit invariant：** live/delayed-commit + settled-within-window 的 pre-response 静默注入合成前奏；快响应逐字节等价。

### Task 3.1：handler 合成注入器闭包 + 挂 heartbeat.injectAnchor

**Files:**
- Modify: `src/routes/messages/handler-v4.ts`（两 streamSSE 回调：构造注入器闭包，赋给 `heartbeat.injectAnchor`）
- Test: `tests/anthropic/live-pre-response-anchor.test.ts`（新建）

**Interfaces:**
- Consumes: `anchorState`（2.3）、`sink.write`/`writeAnchor`/`writeKeepalive`（[client-sink.ts:272/329](../../src/lib/pipeline/client-sink.ts#L272)）、`anchor.startFrame`/`deltaFrame`/`syntheticMessageStart`、`resolvedName`（[handler-v4.ts:295](../../src/routes/messages/handler-v4.ts#L295)）、`reqId`。
- Produces: `heartbeat.injectAnchor` 在 `openBlock===undefined` 心跳 tick 被调（[client-sink.ts:296](../../src/lib/pipeline/client-sink.ts#L296)）→ 合成 message_start（无真实）+ 锚点 start(0) + 空 text_delta。

- [ ] **Step 1: 写失败测试（SDK oracle 风格）** —— 构造 live/delayed-commit sink（mock stream 采样 forwarded），上游 `p` 永不 settle（模拟 pre-response 静默），推进 fake timer 过一个心跳间隔 → 断言 forwarded 轨含 `[synthetic-message-start message_start, anchor content_block_start@0, keepalive text_delta@0]`（带 event 行 + 各自 synthetic 标记），**非裸 ping**。

```ts
// tests/anthropic/live-pre-response-anchor.test.ts （骨架，按既有 sink 测试 harness 补全）
test("live pre-response silence injects synthetic prelude, not bare ping", async () => {
  const forwarded: SseEventRecord[] = []
  const { sink, injector } = buildHandlerSinkUnderTest({ mode: "empty_text", resolvedName: "claude-opus-4.8", reqId: "req_x", onForwarded: (r) => forwarded.push(r) })
  await advanceHeartbeat(sink) // openBlock===undefined → injector fires
  const types = forwarded.map((f) => `${f.synthetic ?? "real"}:${f.type}`)
  expect(types).toEqual([
    "synthetic-message-start:message_start",
    "anchor:content_block_start",
    "keepalive:content_block_delta",
  ])
  await advanceHeartbeat(sink) // 后续 tick：openBlock={0,text} → 空 text_delta
  expect(forwarded.at(-1)).toMatchObject({ synthetic: "keepalive", type: "content_block_delta" })
})
```

- [ ] **Step 2: 确认失败** —— 现 heartbeat.injectAnchor 未挂 handler 注入器 → 退 ping → FAIL。
- [ ] **Step 3: 实现注入器闭包**（两回调共用一个工厂）：

```ts
// src/routes/messages/handler-v4.ts （在两 streamSSE 回调内，sink 构造后）
// 一个 `let sink` 自引用 holder：注入器在【调用时】读 sink（构造入参求值时 sink 尚未绑定）。
let sinkRef: ClientSink | undefined
const makeSyntheticInjector = (state: AnchorState) => async (): Promise<boolean> => {
  const s = sinkRef
  if (!s || state.injected) return false
  state.injected = true                 // 首个 await 前同步翻转（race-safe，同 driver.ts:557-568）
  state.messageStartForwarded = true
  const msgStart = state.capturedMessageStart
    ?? anchor.syntheticMessageStart!(resolvedName, reqId) // 无真实 → 合成
  await (s.writeKeepalive ?? s.write)(msgStart)   // synthetic-message-start 标记见 3.2
  await (s.writeAnchor ?? s.write)(anchor.startFrame)   // "anchor"；noteBlockState→openBlock={0,text}
  await (s.writeKeepalive ?? s.write)(anchor.deltaFrame) // "keepalive"：空 text_delta 重置 300s
  return true
}
const sink = makeSseSink(stream, {
  onForwarded, streamStartMs,
  ...(pingSec > 0 && state.streamKeepaliveMode === "empty_text" && {
    heartbeat: { intervalSec: pingSec, pingFrame: resolveAnthropicKeepalive(state.streamKeepaliveMode),
      clientAbortSignal: clientAbort.signal, injectAnchor: makeSyntheticInjector(anchorState) },
  }),
  ...(/* enveloped_ping / ping 分支见 Phase 6 */),
})
sinkRef = sink
```

> **注（synthetic-message-start 标记，衔接 3.2）**：合成 message_start 经 `writeKeepalive` 会打 `"keepalive"` 标记——不对。需一个能打 `"synthetic-message-start"` 的写法：Task 3.2 给 sink 加 `writeSyntheticEnvelope`（或让注入器经 `writeAnchor` 变体传标记）。本 step 先用占位写法让测试跑起来，3.2 修标记。

- [ ] **Step 4: 确认通过（帧序列）** —— `bun test tests/anthropic/live-pre-response-anchor.test.ts` 帧序列 PASS（标记在 3.2 修）。
- [ ] **Step 5: 快响应等价** —— 加测试：上游在首个心跳间隔内即出真实 message_start → injector 未 fire（`openBlock` 由真实帧点亮前，`anchorAttempted` 未触发）→ 无合成前奏、逐字节等价。
- [ ] **Step 6: commit** —— msg：`feat(anthropic): handler-level synthetic injector for live pre-response`。

### Task 3.2：合成 message_start 的 `synthetic-message-start` 标记

**Files:**
- Modify: `src/lib/pipeline/client-sink.ts`（加 `writeSyntheticEnvelope(frame)`：采样打 `"synthetic-message-start"`，同 `writeAnchor` 机制但标记不同）；`ClientSink` 类型加该方法。
- Modify: `handler-v4.ts` 注入器：合成分支用 `writeSyntheticEnvelope`，真实分支（capturedMessageStart）用 `write`（真实帧不打合成标记）。

- [ ] **Step 1: 加 sink 方法** —— `client-sink.ts` 仿 `writeAnchor`（[:237](../../src/lib/pipeline/client-sink.ts#L237)）加 `writeSyntheticEnvelope`，`sampleForwarded(frame, "synthetic-message-start")` + noteBlockState（message_start 不点亮 block，noteBlockState 对它 no-op）。返回结构 + `makeWsSink` 若需对称（WS 无此路径，可 no-op/omit）。
- [ ] **Step 2: 注入器分野** —— 合成 → `writeSyntheticEnvelope`；真实 capturedMessageStart → `write`（不打标记，真实帧）。
- [ ] **Step 3: 测试标记** —— 更新 3.1 测试断言合成 message_start 标记 `"synthetic-message-start"`、真实（另一用例，capturedMessageStart 存在）无 synthetic 标记。PASS。
- [ ] **Step 4: commit** —— msg：`feat(pipeline): writeSyntheticEnvelope marks synthetic message_start`。

---

## Phase 4 — live 路径对账（drop msg_start + remap +1 + close）

**Commit invariant：** 合成前奏后真实上游帧对账正确；非注入 live 路径逐字节等价。**仅 `buffered===false` 施加**（C2）。

### Task 4.1：`live-reconcile.ts` 变换

**Files:**
- Create: `src/lib/anthropic/live-reconcile.ts`
- Test: `tests/anthropic/live-reconcile.test.ts`

**Interfaces:**
- Consumes: `AnchorState`、`remapAnthropicBlockIndex`、`anchorStopFrame`、`AnchorHooks.isMessageStart`。
- Produces:

```ts
// src/lib/anthropic/live-reconcile.ts
/**
 * live 路径对账（spec §10.3）：注入合成前奏后，真实上游帧流经时——丢首个真实 message_start、
 * 首个真实 content_block_start 前收口锚点 stop(0)、所有真实 content_block_* 索引 +1。
 * 返回要写的帧序列（0/1/2 帧）；`null` 表示丢弃该帧。仅 live 路径（buffered===false）用。
 */
export function reconcileLiveFrame(
  frame: ClientFrame,
  state: AnchorState,
  hooks: Pick<AnchorHooks, "isMessageStart" | "stopFrame" | "remap">,
): ClientFrame[] {
  if (!state.injected) return [frame]                       // 未注入 → 透传（逐字节等价）
  if (hooks.isMessageStart(frame)) { state.messageStartForwarded = true; return [] } // 丢真实 message_start
  const isBlockStart = /* frame.type==="content_block_start" */ isContentBlockStart(frame)
  const out: ClientFrame[] = []
  if (isBlockStart && !state.anchorClosed) { state.anchorClosed = true; out.push(hooks.stopFrame) } // 首真实块前收口
  out.push(hooks.remap(frame, 1))                           // content_block_* +1；非块帧 remap 原样返回
  return out
}
```

- [ ] **Step 1: 写失败测试** —— 喂 `[message_start, content_block_start@0(thinking), thinking_delta@0, content_block_stop@0, message_delta, message_stop]` + injected state → 断言输出 `[（drop）, stop@0 + content_block_start@1, thinking_delta@1, content_block_stop@1, message_delta, message_stop]`；单 message_start（0 个真实透出）；无索引 0 碰撞。
- [ ] **Step 2: 确认失败** —— FAIL（未定义）。
- [ ] **Step 3: 实现** —— 如上 + `isContentBlockStart` 辅助（JSON parse type）。
- [ ] **Step 4: 确认通过 + 非注入等价** —— injected=false 时逐帧透传（`[frame]`）。PASS。
- [ ] **Step 5: commit** —— msg：`feat(anthropic): live-path anchor reconciliation transform`。

### Task 4.2：接线 live pump（buffered===false）

**Files:**
- Modify: `src/routes/messages/handler-v4.ts:598`（delayed-commit）、`:460`（settled-within-window）—— live 分支（`buffered===false`）把 pump 的 sink.write 经 `reconcileLiveFrame` 转换。

**接线方式（二选一，plan 定 A）：**
- **A（推荐）**：给 live pump 传一个 `onRenderedFrame`-like 的 reconcile transform（若 `runResponseSink` 已有 `onRenderedFrame` 钩子则复用：Anthropic 现走 `onUpstreamFrame`，需确认——若 live Anthropic 无 render-后钩子，则用 sink 装饰器仅包 live pump 的 sink，装饰 `write` 经 reconcileLiveFrame）。
- [ ] **Step 0: 调研接线点** —— 读 `pumpAnthropicStreamingV4` live 分支（`runResponseSink`）如何写帧，确认 transform 注入点（`onRenderedFrame` 或 sink 装饰）。**这是实现期第一个调研步**，据实选 A 的具体形态并回写本任务。
- [ ] **Step 1: 写 e2e 失败测试** —— live delayed-commit + 上游全静默过心跳（注前奏）+ 随后上游续帧 → 断言客户端收 `[synthetic message_start, anchor@0, keepalive×N, stop@0, real block@1...]` 单 message_start、无碰撞（复用 4.1 序列，端到端经真实 pump）。
- [ ] **Step 2: 确认失败** —— 现 live 无对账 → 真实 message_start 双发 + 索引碰撞 → FAIL。
- [ ] **Step 3: 接线** —— live 分支 write 经 reconcileLiveFrame（injected 时）。
- [ ] **Step 4: 确认通过 + golden** —— e2e PASS；非注入 live golden（快响应）逐字节等价。
- [ ] **Step 5: commit** —— msg：`feat(anthropic): wire live reconciliation on delayed-commit live pump`。

---

## Phase 5 — 终末失败收口（live POST-COMMIT）

**Commit invariant：** 注入后任何 live 失败分支在 error 帧前收口锚点 stop(0)。

### Task 5.1：live `closeAnchorIfOpen` + 全失败分支

**Files:**
- Modify: `src/routes/messages/handler-v4.ts:561-592`（POST-COMMIT 失败分支：reaper/timeout :566-572、HTTPError :574-580、unknown :581-583、reject :585-592）—— 每个发 error 帧的分支，若 `anchorState.injected && !anchorState.anchorClosed`，先 `sink.freezeHeartbeat?.()` + `await sink.writeAnchor?.(anchor.stopFrame)`（收口）再写 error 帧。client-abort（:561-564 不发帧）除外。

**Interfaces:**
- Consumes: `sink.freezeHeartbeat`（[client-sink.ts](../../src/lib/pipeline/client-sink.ts)）、`anchor.stopFrame`、`anchorState`。

- [ ] **Step 1: 抽 helper** —— handler 内 `const closeAnchorIfOpen = async () => { if (anchorState.injected && !anchorState.anchorClosed) { anchorState.anchorClosed = true; sink.freezeHeartbeat?.(); await sink.writeAnchor?.(anchor.stopFrame) } }`。
- [ ] **Step 2: 写失败测试** —— 注前奏后上游 4xx（HTTPError 分支）→ 断言 forwarded 轨 error 帧**前**有 `anchor:content_block_stop@0`、客户端无残留 open 块。
- [ ] **Step 3: 确认失败** —— 现无收口 → FAIL。
- [ ] **Step 4: 接线全分支** —— reaper/timeout、HTTPError、unknown、reject 四分支 error 帧前 `await closeAnchorIfOpen()`。
- [ ] **Step 5: 确认通过** —— 每分支各一用例 PASS。
- [ ] **Step 6: commit** —— msg：`feat(anthropic): close anchor before error frame on all live post-commit failures`。

---

## Phase 6 — `enveloped_ping` 模式

**Commit invariant：** `enveloped_ping` 发合成 message_start（无真实）+ 裸 ping；不造 content block、不 remap。

### Task 6.1：`resolveAnthropicKeepalive` + 注入器分野

**Files:**
- Modify: `src/lib/anthropic/keepalive-frame.ts`（`resolveAnthropicKeepalive` 加 `enveloped_ping` 臂：keepalive 恒 `ANTHROPIC_PING`）
- Modify: `handler-v4.ts`（heartbeat 挂载条件：`empty_text` → 合成锚点注入器；`enveloped_ping` → 注入器只发合成 message_start 一次、之后裸 ping、**不发锚点 start/delta、不 remap**；`ping` → 无注入器、纯裸 ping）
- Test: `tests/anthropic/enveloped-ping.test.ts`

- [ ] **Step 1: 写测试** —— `enveloped_ping` + pre-response 静默 → 断言 forwarded 首帧 `synthetic-message-start:message_start`、后续 `keepalive:ping`（裸 ping），**无 content_block_start/delta**、无 index remap。
- [ ] **Step 2: 确认失败** —— FAIL。
- [ ] **Step 3: 实现** —— `resolveAnthropicKeepalive("enveloped_ping")` 返回 `ANTHROPIC_PING`；handler 注入器变体（envelope-only：合成 message_start 后 `state.injected=true` 但不开锚点块，后续心跳退 ping）。live 对账对 enveloped_ping：只 drop 真实 message_start（无锚点块 → 无 remap、无收口）。
- [ ] **Step 4: 确认通过** —— PASS。
- [ ] **Step 5: commit** —— msg：`feat(anthropic): enveloped_ping mode (synthetic envelope + bare ping)`。

---

## Phase 7 — oracle 实测 + 回归

**Commit invariant：** oracle 证 live empty_text 存活 >300s；回归全绿。

### Task 7.1：oracle 新臂（exp/cc-idle-280s）

**Files:** Modify: `exp/cc-idle-280s/`（加臂 + REPORT.md）

- [ ] **Step 1: 加臂** —— live delayed-commit（`protect_streaming_generation:false`）+ mock 上游全静默（永不返 headers 过 320s）+ `empty_text` → 真实 CC（headless，`claude -p --settings`）驱动 → 断言 `is_error=false` 存活 >300s（对照 `ping` 臂仍 320s 断）。**须用户启动 mock/驱动**（no-auto-server：agent 写 harness + 指令，用户跑，回贴 duration_ms）。
- [ ] **Step 2: enveloped_ping 确认臂（非门控）** —— 加臂测 `enveloped_ping`（预期 300s 断），记入 REPORT。
- [ ] **Step 3: 写结论** —— REPORT.md 记四臂结果 + 结论（empty_text live GO / enveloped_ping 预期超时确认）。
- [ ] **Step 4: commit** —— msg：`test(exp): oracle arm — live empty_text survives >300s`。

### Task 7.2：回归套件

**Files:** `tests/pipeline/`、`tests/anthropic/`

- [ ] **Step 1: 全套件** —— `bun test tests/pipeline tests/anthropic`（flaky/时序测试连跑 10–25 次确认确定性，fake timers）。
- [ ] **Step 2: golden 全绿** —— 2.0 buffered golden + 各 live golden 逐字节等价。
- [ ] **Step 3: lint 全量** —— `bun run lint:all`（无 --cache 权威）。
- [ ] **Step 4: commit（若有测试增补）** —— msg：`test(anthropic): regression suite for unconditional keepalive`。

---

## Phase 8 — DESIGN.md 同步 + 收尾（session-closeout）

**Commit invariant：** 活文档与代码同步。

### Task 8.1：DESIGN.md 行同步

**Files:** Modify: `docs/DESIGN.md` 行 72/75/341/342/343/345。

- [ ] **Step 1: 改行** —— 342 `streamKeepaliveMode` 类型 → `"ping"|"enveloped_ping"|"empty_text"`、删「live 退化为 content_delta」、改述无条件 timeout-safe + 三模式；72/75/341 述及 buffered-only/content_delta 处同步；web_search 暂缓注保留（不在本 scope）。
- [ ] **Step 2: 跨文档 grep 验证** —— grep `content_delta` 全仓确认无残留有效引用（除 compat 迁移 + 历史叙事）。
- [ ] **Step 3: commit** —— msg：`docs(design): sync live-architecture keepalive rows to unconditional timeout-safety`。

### Task 8.2：收尾（session-closeout skill）

- [ ] **Step 1: plan 状态注解** —— 本 plan 头部加实施状态（已落地阶段）。
- [ ] **Step 2: 记忆维护** —— MEMORY.md 加/更 stub（keepalive 无条件 timeout-safe 已落地 → 指向 ADR + spec §10）。
- [ ] **Step 3: backlog** —— deferred-backlog retreat 条已含「不可达」理由（保留）；enveloped_ping 若 oracle 确认超时，记「未来实验」条。
- [ ] **Step 4: subagent 交付前审计** —— 派 code-reviewer 独立核验（裁判轴：长远正确 + 完整）。
- [ ] **Step 5: 最终提交** —— 细粒度阶段提交完毕。

---

## Self-Review（spec 覆盖核对）

- §10.1.5 C1（handler 注入器）→ P3；C2（remap 互斥、仅 live）→ P4 Task 4.2 `buffered===false` gate；H1（anchorState hoist + capturedMessageStart）→ P2；H2（resolvedName）→ P3 Task 3.1。
- §10.2（合成前奏）→ P1 + P3；§10.3（live 对账 + retreat 排除）→ P4；§10.4（mode taxonomy + migrateValue）→ P0；§10.5（无条件不变量）→ P3；§10.6（enveloped_ping）→ P6；§10.7（触及文件）→ 全阶段；§10.8（测试）→ 各阶段 + P7；§10.9（边界）→ redacted_thinking 退 ping 属既有 fallback（P3 注入器只在 empty_text + openBlock===undefined 触发，redacted_thinking open block 走 provider ping，无需特处）。
- ADR §2 降级清单 → P1 builder（usage:0 + 假 id）+ P4 drop 真实 message_start（丢 model/cache tokens/message.id）。
- **retreat 排除** → 全程不碰 driver retreat 分支（Global Constraints）。

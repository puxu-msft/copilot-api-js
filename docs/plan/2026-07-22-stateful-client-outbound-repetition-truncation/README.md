# 有状态 client.outbound + 重复截断 — 实施计划总览（README）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec:** [`docs/spec/2026-07-22-stateful-client-outbound-repetition-truncation.md`](../../spec/2026-07-22-stateful-client-outbound-repetition-truncation.md)（已获批 2026-07-22，四轮异模型审查 0 blocker）。本目录是其实施计划；spec 是「什么/为何」的单一事实源，计划是「怎么做」，冲突以 spec 为准。

**Goal:** 把 GHC 退化重复输出（实证 `req_1784742426806_1482`：text 块 `card\n\n（专注。）\n\n` ×204 被逐字节转发）折叠到 `keep_copies` 份（默认 1）+ 可辨识 marker；机制上把 `client.outbound` hook 升级为有状态 buffer/emit/flush 转换器（RFC §9a）并下沉到 delivery-layer sink-egress choke point（§9b，byte-critical），重复截断作首个 first-party 消费者。

**Architecture:** 三层——(A) 机制：`client.outbound` leaf 从单帧 `(frame)=>frame|undefined` 升级为 `createState/transform(→FrameAction)/flush`（同构 `ResponseRewrite`），挂载点从 candidate-local `postRender` 下沉到 `delivery/session.ts` 仲裁后串行写点；(B) idle 保活：eager 转发 `content_block_start`、只缓冲 `text_delta`、block-aware keepalive 发空 delta 重置 300s 死线（anchor scaffold 被 latch 门控到首块前窗口、救不了块内 idle）；(C) 特性：新建 `text-repetition/` 纯核（whole-text 累积 + KMP）产 `{collapsedText, truncatedCount}`，Anthropic 精确一份、CC/Responses/WS 近似（命中即停）待 M-2 门升级。

**Tech Stack:** TypeScript / Bun（`bun test`）+ Hono SSE / undici WS / node:http2 上游 / zstd History / consola。测试 = `bun run test`（fast=unit+http）/ `test:backend`（全后端，交付前）；后端单例隔离见 skill `test-isolation`；idle 回归用 PTY / 客户端 e2e（skill `pty-terminal-ui-testing` / `client-proxy-e2e-testing`）；golden 字节等价预捕见 skill `large-refactor`。

---

## Global Constraints（每个任务隐含包含，逐字来自 spec）

- **无向后兼容负担**：§9a leaf 契约破坏性升级，用户 hook 统一迁到有状态契约（不留单帧/有状态双档）；允许短期报错，不留双轨。
- **默认 opt-in**：`repetition_truncation.enabled` 默认 `false`；关闭时全端点**逐字节等价**（golden 锁）。
- **richest-data-flow（ADR）**：截断只作用 **forwarded 轨**；upstream-original 轨（`response-processor.ts:149-155` pre-render 采样）**永远保全部 204 份**。被 drop 的份**不进** forwarded 轨；仅 marker 帧是合成帧、**必打可辨识标记**（`DeliverySyntheticKind` 新值 `"repetition-truncated"`，走 delivery `writeToSink` dedicated 通道，非 frame-tag）。
- **截断阈值与告警阈值解耦**：新建 `text-repetition/` 纯核（**非**复用 `repetition-detector.ts` 的有损滑窗）；触发用独立 `truncation_min_repetitions`（默认 8、远高于告警 3），保留观察-only detector 的 warn 不动。
- **命名**：顶层 vendor 中立 `repetition_truncation.{enabled,min_pattern_length,truncation_min_repetitions,keep_copies,marker_template}`；经 `applyConfigToState` 传播、热重载、配置不因重命名杀进程。
- **no-auto-server**：不跑 `bun run dev`/`start`（4141 主服务器绝不碰）；服务器行为由用户或**非 4141 端口**测试实例验证。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -F <msg> -- <精确路径>`），conventional commits，无模型署名。

## Produces / 冻结契约（跨相位共用符号——单一事实源，实施时以此为准）

新增/改动的**跨任务接口**（后续任务只看自己那块，靠此表学邻居符号名与类型）：

```ts
// —— 机制层（P1 §9a 产出，P2-P5 消费）——
// src/lib/pipeline/hooks/types.ts —— client.outbound leaf 新契约（破坏性）
interface StatefulClientOutbound<S = unknown> {
  createState(env: RequestEnvelope): S
  transform(frame: ClientFrame, state: S): FrameAction          // { kind:"buffer" } | { kind:"emit", frames } | { kind:"suppress" }
  flush(state: S, reason: FlushReason): Array<ClientFrame>
}
type FlushReason = "commit-boundary" | "natural-drain" | "client-aborted" | "upstream-truncated"
// FrameAction 复用 rewrite-registry:76 现有 union（值 = "emit"|"suppress"|"buffer"，注意是 "suppress" 非 "drop"）；
// 其 emit.frames 现类型是 Array<UpstreamFrame>，client.outbound 用 ClientFrame——P1 定稿时确认是否需 ClientFrame 变体或泛型化。
// P3 新增 delivery 公开方法 flushOutbound(reason)：上游截断分支（handler-v4 现直调 sink.writeSynthetic、绕开 delivery terminate()）经此统一触发 hook flush（见 plan-3 Task 4，需审查确认）。

// —— 特性纯核（P0 产出，P2-P5 消费）——
// src/lib/text-repetition/collapse.ts
interface CollapseConfig { minPatternLength: number; minRepetitions: number; keepCopies: number }
interface CollapseResult { collapsed: string; truncatedCount: number; unitLength: number; matched: boolean }
function collapseRepetition(fullText: string, cfg: CollapseConfig): CollapseResult

// —— 配置 state（P0 产出）——
// src/lib/state.ts —— state.repetitionTruncation
interface RepetitionTruncationState {
  enabled: boolean; minPatternLength: number; truncationMinRepetitions: number
  keepCopies: number; markerTemplate: string   // "<num>" 占位
}

// —— provenance（P0 产出，P3 消费）——
// src/lib/pipeline/delivery/types.ts —— DeliverySyntheticKind 加值 "repetition-truncated"

// —— 可观测（P0 产出，各相位写入）——
// pipelineInfo.repetitionTruncation: Array<{ blockIndex:number; truncatedCount:number; forwardedBeforeDetection:number; unitLength:number }>
```

## 相位 DAG（依赖 + 顺序）

```
P0 地基（纯新增，默认关，字节等价）
   text-repetition/ 纯核 · 配置键+state · DeliverySyntheticKind 新值 · pipelineInfo 字段 · telemetry 维度 · golden 四格式预捕
   │
   ▼
P1 §9a 有状态契约（leaf 升级 + 用户 hook 迁移 + /api/hooks）——默认无消费者→字节等价
   │
   ▼
P2 C1 eager-start idle 保活 + Anthropic 精确截断（首个消费者，仍挂现 postRender 层）
   │   TDD：204× 流→精确一份+marker；长非重复块→不 idle-out（PTY/e2e）
   ▼
P3 §9b sink-egress 下沉（byte-critical）——挂载迁 delivery/session.ts，拆 postRender 职责，统一 provenance
   │   commit invariant：disabled 时 delivery 逐字节等价（Gemini/heartbeat/anchor 帧序）
   ├───────────────┬───────────────┐
   ▼               ▼               ▼
P4 三端近似 + 非流式（CC/Responses 命中即停 · 三端 transformWhole 折叠 · 双缓冲时序）
   │
   ▼
P5 M-2 实证门 + 收尾（CC/Responses/WS keepalive 实证 harness · 过门升级精确 · doc-sync · 记忆）
```

- **P0 必须先落**（定义 P1-P5 共用的纯核 + 配置 + provenance + 观测字段）。
- **P1 → P2 → P3 严格串行**（契约升级 → 首消费者验证 → byte-critical 下沉；P2 先在旧 postRender 层跑通截断逻辑再于 P3 迁层，隔离「逻辑错」与「迁移错」两类失败）。
- **P4 依赖 P3**（下沉后的统一层才谈三端 + 非流式）。**P5 依赖 P4**。

## 红线（commit invariants — 每 commit 终态不变量，中间态绝不半坏）

- **R1** P0/P1 落地后 `enabled:false` 默认行为**逐字不变**——golden 四格式预捕，每 commit 后回放等价。
- **R2** eager-start 的「eager 转发 content_block_start」与「块内缓冲 delta + block-aware keepalive 发空 delta」必须**同一 commit**（R3-类）——否则出现「块已开缓冲中但心跳裸 ping」的 C1 复发窗口。P2 断言「长非重复块不 idle-out」的测试必须与 eager-start 同 commit 绿。
- **R3** P3 挂载点迁移的**任一 commit** 都不得让 `boundary.observe`（hedge/candidate-race 依据）随 hook 一起搬走——classifier 留 postRender、仅有状态 transform 下沉，同一 commit 落地，不留「hook 已迁但 classifier 也被误搬」的半坏态。
- **R4** marker 帧的 provenance 标记（`DeliverySyntheticKind` 新值 + `writeToSink` 分支 + `syntheticKind()` 映射 + history 投影）必须**同一 commit**全站点落地（对齐记忆 `methodology-full-primitive-not-partial-else-silent-field-drop`）——绝不留「新值已加但某 switch 分支漏」的静默丢字段态。
- **R5** 端点默认升级（P5，CC/Responses/WS 从近似→精确）必须在该端点 M-2 keepalive 实证门通过**之后**的 commit——绝不先升级语义再验证 idle。
- **R6** 每阶段 landing 关对应 backlog/doc：P3→deferred-backlog §9（client.outbound 全 sink-egress 统一化，本计划实现之）；P5→backlog 新增 Gemini 排除条 + DESIGN.md 活架构行 + streaming.md 行为表。

## 相位文件

- [`plan-0-foundation.md`](plan-0-foundation.md) —— P0 纯核 + 配置 + provenance + 观测 + golden 预捕
- [`plan-1-stateful-contract.md`](plan-1-stateful-contract.md) —— P1 §9a leaf 升级 + hook 迁移
- [`plan-2-eager-start-anthropic.md`](plan-2-eager-start-anthropic.md) —— P2 C1 保活 + Anthropic 精确截断
- [`plan-3-sink-egress-descent.md`](plan-3-sink-egress-descent.md) —— P3 §9b byte-critical 下沉
- [`plan-4-endpoints-nonstreaming.md`](plan-4-endpoints-nonstreaming.md) —— P4 三端近似 + 非流式
- [`plan-5-m2-gates-closeout.md`](plan-5-m2-gates-closeout.md) —— P5 实证门 + 默认升级 + 收尾
- [`kickoff.md`](kickoff.md) —— 新会话/subagent kick-off 提示词

## 实证门（不可绕过）

- **M-2（每端点，P2 Anthropic / P5 CC·Responses·WS）**：起**非 4141 端口**测试实例，造长非重复 text 块（缓冲期 > 300s），用真实客户端（`@anthropic-ai/sdk` / claude CLI / codex）断言**不 idle 断连**。plaintext mock 不够（Bun-undici 假性 abort，见记忆 `bun-upstream-transport`），须真 h2/HTTPS。
- **golden 字节等价（P0/P1/P3）**：`enabled:false` 四格式（Anthropic/CC/Responses/Gemini）真实渲染 golden 预捕，每 byte-critical commit 回放。

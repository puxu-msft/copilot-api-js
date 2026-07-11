# Block 级缓冲重试 — 实施计划总览（README）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施。步骤用 `- [ ]` 复选框跟踪。
>
> **权威 spec:** [`docs/spec/2026-07-11-block-level-buffered-retry.md`](../../spec/2026-07-11-block-level-buffered-retry.md)（已获批）。本目录是其实施计划；spec 是「什么/为何」的单一事实源，计划是「怎么做」，冲突以 spec 为准。

**Goal:** 把整响应 all-or-nothing 缓冲重试推广为 **block 级延迟提交**，4 端点（Anthropic messages / Responses-HTTP / Responses-WS / Chat Completions）全默认开、退役整响应模式，救回 req_484 类「单大 tool_use 块 mid-stream 截断」并保留增量流式体验。

**Architecture:** 在 `runResponseBufferedSink`（`src/lib/pipeline/driver.ts`）引入 per-codec `commitBoundaries` 谓词，把提交点从「drain 后一次」倒置为「循环内每个块边界」；重试窗口收紧为 `!committedAny && !retreated`；首块提交后截断优雅降级为新终局 `partial-degrade`。Anthropic 靠 keepalive anchor@0 全程 open + 块间 `text_delta@0` 续命（sink 单槽 openBlock 改块栈），其 wire 形状经**两段 PoC 门**（先验代理可产出、再验客户端接受）实证后默认 on，三级 fallback 保证默认 on 确定可交付。

**Tech Stack:** TypeScript / Bun（`bun test`）+ node:http2 上游 / Hono SSE + WS / zstd History / consola。测试 = `bun test`（后端单例隔离见 skill `test-isolation`）、PoC 探针放 `exp/`（poc-first）。

---

## Global Constraints（每个任务隐含包含，逐字来自 spec）

- **无向后兼容负担**：旧配置键 `protect_streaming_max_retries`/`_buffer_cap_bytes`/`_heartbeat` 一次性迁移到 `buffered_retry.*`，允许短期报错，不留双轨。
- **命名铁律**（消除 YAML 标量/map 冲突）：布尔 mode-switch = `<vendor>.buffered_retry.enabled`（`buffered_retry` 恒为 map）；覆盖键 = `<vendor>.buffered_retry.{max_retries,buffer_cap_bytes,heartbeat_sec}`；Anthropic 例外用三态 `protect_streaming_generation` + `anthropic.buffered_retry.*` 覆盖。解析优先级：per-vendor 覆盖 > 共享 `buffered_retry.*` > 内置默认（max_retries 3 / buffer_cap_bytes 16777216 / heartbeat_sec 15）。
- **不改算法核**：`response-rewrite-adapters.ts:8`「Algorithm cores are NOT rewritten」——recover-tool-call / decode 的缓冲释放逻辑**不得改**（块内释放不变量是**核实项非改造项**，无 flushBlock 原语）。
- **no-auto-server**：不跑 `bun run dev`/`start`；服务器行为由用户启动验证。可跑 `bun run typecheck`/`lint:all`/`bun test`。
- **合成帧必打 `synthetic` 标记**（richest-data-flow ADR），History `clientResponse.sseEvents` 完整记录客户端所见含 error 帧；失败尾帧沿用 `writeSynthetic → recordForwarded → ctx.fail` 的 settle-前-record 顺序（persistence-async-invariants）。
- **细粒度提交**：每任务末显式 pathspec commit（`git commit -- <精确路径>`），conventional commits，无模型署名。

## 相位 DAG（依赖 + 顺序）

```
P0 机制地基（commitBoundaries 接口 + 共享配置键 + telemetry vendor 维度 + outcome 分类）
   │  纯新增，不动提交点，默认仍关，行为逐字不变
   ▼
P1 Anthropic 块级 ── 含 §4 anchor 协同 + 两段 PoC 门（决定 anchor 策略）+ 提交点倒置 + 块内释放核实 + retreat bug 修复 + 默认 on、退役 whole
   │  覆盖 req_484。P1 是最硬阶段，PoC 门产出决定 anchor 实现分支（主/备/兜底）
   ├────────────┬────────────┐
   ▼            ▼            ▼
P2 Responses   P3 Chat      P4 Responses-WS
  HTTP 块级     Completions   terminal-only
 (output_item) 净新建终止-only (复用 responses 键)
```

- **P0 必须先落**（定义 P1-P4 共用的 `commitBoundaries` 接口 + 配置 + telemetry）。
- **P1 独立于 P2-P4**，但 P1 的 anchor sink 改造（块栈）是 Anthropic 专属，P2-P4 无 anchor、不依赖它。
- **P2/P3/P4 相互独立**，均只依赖 P0，可并行实施（不同端点文件、行级共存）。

## 红线（commit invariants — 每 commit 终态不变量，中间态绝不半坏）

- **R1** P0 落地后默认行为**逐字不变**（提交点未动、默认仍关）——golden-fixture 预捕获旧 buffered 行为，P0 各 commit 后回放等价。
- **R2** P1 提交点倒置的**任一 commit** 都不得让「首块提交后截断」错误地重试（`!committedAny` 门必须与提交点倒置同一 commit 落地，不留「已倒置但门未收紧」的半坏态）。
- **R3** anchor 改造（块栈）与「块间发 text_delta@0 而非裸 ping」必须**同一 commit**——否则出现「块级已开但块间裸 ping 断连」的 C1 复发窗口。
- **R4** 默认 on（P1 末 / P2/P3/P4 末）必须在该端点的 keepalive 实证门（PoC/oracle）通过**之后**的 commit——绝不先翻默认再验证。
- **R5** 每阶段 landing 关闭对应 backlog 条（session-closeout doc-sync）：P1→retreat-bug(:251-257)；P2→Responses caps(:308-314)；P3→backlog:316 CC 腿；P4→backlog:300-306；telemetry→vendor-blind(:324-330)。

## 冻结契约（single source of truth — P0 产出、P1-P4 逐字消费）

> plan-review 发现混合起草导致契约分裂（C1/H1/H3）。以下为**唯一权威签名**，P0 实施前冻结，任何 plan 文件的代码样例与此冲突时**以本节为准**：

```typescript
// RunBufferedOpts 新增字段（P0 Task 1 加进 src/lib/pipeline/types.ts）
commitBoundaries?: (frame: ClientFrame) => boolean   // 缺省=terminal-only=现行为
telemetryVendor?: string                             // driver 注入进 onBufferedResolve.meta.vendor

// onBufferedResolve 唯一签名（vendor 由 driver 从 opts.telemetryVendor 注入；
// retriesBeforeDegrade 由 stats 从 retries 形参推导，NOT 经 meta 传）
onBufferedResolve?: (outcome: ProtectStreamingOutcome, retries: number, meta: { vendor: string }) => void

// telemetry（P0 Task 2 改 src/lib/anthropic/protect-streaming-stats.ts）
type ProtectStreamingOutcome = "success" | "exhausted" | "retreated" | "partial-degrade"
function recordProtectStreamingOutcome(o: ProtectStreamingOutcome, retries: number, meta: { vendor: string }): void
function getProtectStreamingStats(): Record<string /*vendor*/, ProtectStreamingStats> // 单对象→Record（breaking，无兼容负担）

// 配置解析（P0 Task 3 加进 src/lib/state.ts）
function resolveBufferedCaps(vendor: string): { maxRetries: number; bufferCapBytes: number; heartbeatSec: number }
state.chatCompletionsBufferedRetry: boolean   // 新 config 字段（P0 Task 3 建 chat_completions 配置节 + CONFIG_MANAGED_DEFAULTS 三处，默认 false）

// vendor 取值：anthropic / responses / chat_completions / responses_ws
// ClientSink 新增（P1 Task 3）：suspendHeartbeat?(): void / resumeHeartbeat?(): void
```

**消费方对齐**：P2/P3/P4 的 handler **不再硬编码 vendor、不读 meta.retriesBeforeDegrade**——把 `commitBoundaries` + `telemetryVendor:"<vendor>"` 传进 opts，`onBufferedResolve: (o,r,meta)=>recordProtectStreamingOutcome(o,r,meta)` 原样透传 driver 注入的 `meta={vendor}`。既有 caps 消费者（`messages/handler-v4.ts:1136-1137`、`responses/handler-v4.ts:379-380`）在 P0 Task 3 一并迁到 `resolveBufferedCaps`（无双轨）。

## 阶段文件

| 文件 | 阶段 | 交付物 | 状态 |
|---|---|---|---|
| [`plan-0-mechanism-floor.md`](plan-0-mechanism-floor.md) | P0 | commitBoundaries 接口 + **driver 块级提交骨架（committedAny 门 + partial-degrade，vendor-agnostic）** + 共享配置键 + 迁移 + telemetry vendor 维度/新分类；默认仍关、行为中性 | 待实施 |
| [`plan-1-anthropic-block-level.md`](plan-1-anthropic-block-level.md) | P1 | Anthropic content_block_stop 谓词 + anchor 协同（sink 块栈 + 两段 PoC 门 + 心跳挂起/恢复）+ 块内释放核实 + retreat 修复 + 默认 on、退役 whole；覆盖 req_484 | 待实施 |
| [`plan-2-responses-http.md`](plan-2-responses-http.md) | P2 | Responses HTTP output_item.done 块级 + via-cc-fallback 排除 + keepalive 实证门 + 默认 true | 待实施 |
| [`plan-3-chat-completions.md`](plan-3-chat-completions.md) | P3 | CC 净新建终止-only buffered + keepalive 实证门（backlog:316 CC 腿）+ 默认 true | 待实施 |
| [`plan-4-responses-ws.md`](plan-4-responses-ws.md) | P4 | Responses-WS terminal-only buffered（复用 responses 键）+ close-code/commit 时序 + 默认 true | 待实施 |
| [`kickoff.md`](kickoff.md) | — | 各阶段新会话 kick-off prompt | ✓ |

> **DAG 调整（P2 起草者发现）**：driver 的块级提交骨架（消费 commitBoundaries + `!committedAny` 门 + partial-degrade 分类）是 **vendor-agnostic**，已从 P1 上移到 **P0**（`commitBoundaries===undefined` 时行为中性）。P1 收窄为 Anthropic anchor 协同专属；P2/P3/P4 直接依赖 P0 骨架。

## 收尾（全阶段 landing 后，session-closeout）

- 建 ADR `docs/decisions/2026-07-11-block-level-buffered-retry.md`（决策核 = 退役整响应 + 覆盖换体验，非「默认 on」表象）。
- doc-sync：`docs/DESIGN.md`（流式写出行 + driver 例外 :57 + 配置表改名键/新默认 + :74-76「默认关」叙述）、`docs/streaming.md`、前身 RFC 加 superseded banner。
- 新建 backlog 两条：Gemini buffered 结构不兼容排除（§7.4）、web_search no-search 直发暂未保护（§7.5，指向未来独立 spec）。

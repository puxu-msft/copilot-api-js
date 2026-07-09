# Codex / Responses tier-1 硬化 — 实施计划（overview）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 task 实施。步骤用 `- [ ]` 复选框追踪。
> 本项目纪律：`no-auto-server`（不启服务器）、逐语义单元 pathspec 提交、每 task 末 `typecheck` + 针对性 `bun test` 绿灯。

**Goal:** 把 Codex / Responses（含上游 WebSocket）路径抬到与 Anthropic 路径同级的 tier-1 健壮性基线（关闭码正确性、崩溃防护、下游保活、mid-stream buffered 重试、上游保活/截断），并修复 §1.1 的 before-first-event 降级被击败根因。

**Architecture:** 分 6 阶段（Phase 0–5），每阶段独立可交付、可提交。Phase 0 直接止血（关闭码 1001→1000，恢复 WS→HTTP 降级）；后续逐层对齐 Anthropic 已成熟的 driver 共享原语（`runResponseBufferedSink`）与保活/崩溃防护机制。**driver 原语只新增 caller、绝不改签名/行为**，以保护已稳定的 Anthropic 路径。

**Tech Stack:** Bun/Node TypeScript、Hono、undici（客户端 WebSocket，WHATWG 严格）、node:http2、`bun:test`、`refs/codex`（Codex 容忍契约 oracle，只读）。

**Spec（单一事实源）:** [../../spec/2026-07-09-codex-responses-tier1-hardening.md](../../spec/2026-07-09-codex-responses-tier1-hardening.md)。每个 task 的需求隐含包含 spec + 本文 Global Constraints。

---

## Global Constraints（每个 task 隐含遵守）

- **关闭码**：上游 WebSocket lifecycle 关闭一律用 `1000`（WHATWG 允许 `1000` 或 `3000–4999`；`1001` 被 undici 同步抛 `DOMException('invalid code')`）。下游 `ws.ts`（Hono `WSContext` on Bun）的 `1011/1013` 须**实测**运行时是否抛出，据实处理，不盲改语义正确的服务端码。
- **崩溃防护原语**：上游 WS 回调（WHATWG `EventTarget` / `addEventListener`）与裸 `setTimeout` 用新增的 `guardCallback`；**禁用** `withErrorSink`（其依赖 node `EventEmitter` 语义，在 EventTarget 上是 no-op 虚假保护）。
- **driver 不变量**：`runResponseSink` / `runResponseBufferedSink` / `runExchange` **只新增 caller，不改签名/行为**；driver 内**永不按 format 分支**；Responses 作 `runResponseBufferedSink` 第二消费者，全走 opts（`sawMessageStop`/`anchor`/`retryCap`）。
- **mid-stream 重试默认关**：用户已确认 Codex 默认**不做** mid-stream auto-retry；默认 live `runResponseSink`（掉线→fail + 保留 partial + 截断 error frame）；buffered 重试是**可配置启用**的保护开关（门控如 `state.protectStreaming`）。buffering ⇒ **强制**下游保活。
- **保活配置**：复用间隔 `streamKeepalivePingSec`（默认 20s）；**不复用** `streamKeepaliveMode`（Anthropic 帧型枚举）。Responses 帧型独立、打项目合成标记（`synthetic:"keepalive"`）。
- **爆炸半径 tripwire**：Anthropic 既有 golden 回归（buffered / keepalive / anchor）每阶段保持绿。
- **测试隔离**：bun 单进程跨文件单例；用既有 `tests/helpers/sandbox-paths.ts` preload + `FakeSocket extends EventTarget`；新增 module-global 单例须 reset（skill `test-isolation`）。
- **实证优先**：否定性/通过性/PoC 结论不自证（skill `empirical-verification` / `verifying-authoritative-claims`）。R5.1 保活可行性以 `ss` 实测为准。

## Phase DAG（依赖与顺序）

```
Phase 0 (关闭码, 止血) ──▶ Phase 1 (崩溃防护, 依赖 closeUpstreamWs)
                                   │
Phase 2 (下游保活) ────────────────┼──▶ Phase 3 (buffered 重试 + 截断 gate, 依赖 Phase 2 保活)
                                   │
                                   └──▶ Phase 4 (上游保活 PoC + idle 余量, 独立可并行)
                                                        │
                                              Phase 5 (测试收口 + doc-sync, 汇总)
```

- **Phase 0** 独立、最高优先（修真实事件）。
- **Phase 1** 依赖 Phase 0 的 `closeUpstreamWs`。
- **Phase 2** 独立（下游 SSE/WS 保活）。
- **Phase 3** 依赖 Phase 2（buffered commit 前零真实帧 → 必须先有强制保活）。
- **Phase 4** 独立可与 2/3 并行（PoC 结论驱动是否落地 WS 保活 / 是否 R4 承重）。
- **Phase 5** 汇总（L1 守卫、黄金回归、Anthropic tripwire、doc-sync）。

## 关键文件与职责（decomposition lock-in）

| 文件 | 职责 | Phase |
|---|---|---|
| `src/lib/openai/upstream-ws-connection.ts` | 上游 WS 生命周期；`closeUpstreamWs` 原语、回调 `guardCallback` 包裹 | 0, 1 |
| `src/lib/transport/crash-safety.ts` | **新增** `guardCallback(fn, onEscape)`（EventTarget 同步回调工厂，纯加法） | 1 |
| `src/routes/responses/ws.ts` | 下游 WS-to-client 关闭码实测；下游 WS 保活对齐 | 0, 2 |
| `src/routes/responses/handler-v4.ts` | 下游 SSE 保活注入；buffered sink 采用（opt-in） | 2, 3 |
| `src/lib/pipeline/client-sink.ts` | 复用既有 heartbeat hook 注入 Responses 帧 | 2 |
| `src/lib/pipeline/driver.ts` | 仅新增 `runResponseBufferedSink` caller；`:114` 陈旧注释 doc-sync | 3 |
| `src/lib/openai/upstream-ws-attempt.ts` / `upstream-ws.ts` | fallback 边界、上游保活 PoC | 0, 4 |
| `src/lib/state.ts` / config | Responses buffered 的 `protectStreaming*` 对等键；保活间隔复用 | 2, 3 |
| `tests/responses/upstream-ws-connection.unit.test.ts`（等） | 现含 `FakeSocket`；新增 throwing-socket 变体 + 契约守卫 | 0–5 |

## 各阶段目标与交付物（task 骨架）

### Phase 0 — WHATWG-WS 关闭码正确性（详见 [plan-0-close-codes.md](./plan-0-close-codes.md)）
- 交付：`closeUpstreamWs(socket, reason)`（1000 + try/catch）；6 处 `close(1001)` 替换；更新现有断言（`upstream-ws-connection.unit.test.ts:155` 等 1001→1000）；throwing-socket 变体证明修复；§1.1 before-first-event 黄金回归（降级被击败→修复后降级 HTTP）；`ws.ts` 1011/1013 运行时实测结论。
- DoD：§1.1 场景转绿；无 `close(1001)` 残留；L1 契约守卫（关闭永不传禁用码）。

### Phase 1 — 上游-WS lifecycle 崩溃防护
- 交付：`crash-safety.ts` 新增 `guardCallback(fn, onEscape)`；`upstream-ws-connection.ts` 每 `addEventListener` 注册点 + 裸 `setTimeout` 包裹，`onEscape → markUnusable + failRequest + consola.warn`；fault-injection 测试（监听器抛出 + 定时器抛出两形状 → 进程不退出、请求 fail）。
- DoD：注入回调抛出，进程存活、错误记录；空闲池连接 idle-close 抛出不崩。
- 依赖：Phase 0 `closeUpstreamWs`。

### Phase 2 — Responses 下游客户端保活
- 交付：Responses SSE 保活帧 `event:<marker>\ndata:{"type":"response.<keepalive>"}`（合成标记）；间隔 `streamKeepalivePingSec`；覆盖 header-前静默 + reasoning 静默两段；`ws.ts` 下游 WS 保活形态核定（应用层帧 vs 协议 ping）；以 `refs/codex` 容忍契约为 oracle 的测试。
- DoD：>20s <300s 静默下 Codex 收到带标记保活帧且容忍（不报错、重置 idle）；history forwarded 轨含标记、上游轨不含。
- 决策留 task：R3.3 帧型/配置（复用间隔 + 固定帧 vs Responses 专属键）。

### Phase 3 — 传输重试对齐 + 截断检测
- 交付：R4-pre 核验（R1 解锁降级后 pre-stream 覆盖是否有缺）；R4-mid 采用 `runResponseBufferedSink`（`sawMessageStop:()=>acc.status!==""`、`anchor:undefined`、Responses `protectStreaming*` 对等键、opt-in）；buffering⇒强制 Phase 2 保活接线；R5.2 截断 gate 在实际 `runResponseSink` 路径核验。
- DoD：buffered 模式 mid-stream WS drop 触发重试（attempts>1）+ 成功/失败语义；live 模式保 fail+partial；Anthropic golden tripwire 绿。
- 依赖：Phase 2。

### Phase 4 — 上游保活 PoC + idle 余量
- 交付：R5.1 PoC 两问（undici WS upgrade socket 能否开 TCP keepalive，`ss` 验；GHC 是否转发/容忍带外 WS 帧），PoC 代码入 `exp/ws-upstream-keepalive/` + 结论文档；据结论落地 WS 保活或记"R4 承重"；R5.3 `state.streamIdleTimeout` 相对最长 reasoning 静默余量核验。
- DoD：保活可行性有实测结论；idle 余量有结论。
- 独立可并行 2/3。

### Phase 5 — 测试收口 + doc-sync
- 交付：L1 契约守卫（上游关闭永不禁用码、`ws.ts` 码固化）；§1.1 黄金回归纳套件；Anthropic 爆炸半径 tripwire；`docs/DESIGN.md`「活的架构现状」更新 Responses 条目；`driver.ts:114` 注释更正；未采纳/推迟项入 `docs/todo/deferred-backlog.md`。
- DoD：`lint:all` + `typecheck` + 全 `bun test` 绿；跨文档 grep 一致（skill `session-closeout`）。

## 待探究点动态捕获（用户约定）

实施中发现的下一步方向 / 扩展探究点 → 落 `docs/todo/deferred-backlog.md`（根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么），并在 spec §8 追加 O 指针。已知候选：liveness 调度器共享化（gate 在 Phase 4 PoC）、Anthropic+Responses 完整传输合流、Responses 专属 keepalive 配置键。

## 执行说明

- 后续每阶段的详细 TDD plan（`plan-1`…`plan-5`）在该阶段开始前 just-in-time 编写：Phase 2–4 的具体步骤代码依赖 Phase 2 的配置/帧型决策与 Phase 4 的 PoC 结论，提前写死会变成占位式伪代码。Phase 0（无 gating）已完整落 [plan-0-close-codes.md](./plan-0-close-codes.md)。
- 每阶段 plan 配 kickoff prompt（`plan-kickoff.md`），供复制开新会话 / 派 subagent。
- 执行取向：subagent-driven（每 task 新 subagent + 两阶段审查）。

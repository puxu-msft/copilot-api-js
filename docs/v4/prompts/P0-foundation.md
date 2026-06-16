# P0 — 地基实现提示词

复制以下内容到新会话启动 P0 实现。

---

我要实施 copilot-api-js 管线重构 v4 的 **P0 阶段（地基）**。这是 ≥1000-LOC 渐进重构的第一阶段，**不改任何运行时行为**，只做接口定义、transport 提取、observability 收敛、重试提升。

**先读**（理解上下文）：
- `docs/v4/README.md`、`docs/v4/00-decisions.md`、`docs/v4/01-architecture.md`
- `docs/v4/02-current-state.md` §1（重试）、§5（context/observability）、§6（client/transport）
- `docs/v4/03-spec/envelope-driver.md`、`docs/v4/03-spec/retry-transport.md`
- `docs/v4/04-migration-plan.md` 的 P0 表
- 遵守 `docs/v4/prompts/README.md` 的通用红线（中文、不碰工作区文件、不启服务器、bun run 验证、subagent review）

**四个 commit（每个结束 typecheck+test 绿、行为不变、可独立 revert）**：

### P0.1 — 接口定义（纯新增，零运行时）
新建 `src/lib/pipeline/envelope.ts` + `src/lib/pipeline/types.ts`，按 `03-spec/envelope-driver.md` 定义 `RequestEnvelope`、`LazyMessageView`、`ClientFormat`、`UpstreamEndpoint`、`RequestStage`/`ResponseStage`/`ExchangeStage`、`PipelineDriver`、`DriverRequestResult`、`RouteDecision`。按 `03-spec/retry-transport.md` 定义 `RetryStrategy`(新版 env-based)、`RetryAction`、`Transport`、`PreparedRequest`（transport 侧待发送字节；history 侧既有 `WireRequest` 不同概念，勿撞名）、`UpstreamStream`。**无消费者**。`PrepareHints` 复用现有定义（`request/pipeline.ts:91`）。invariant：typecheck 绿。

### P0.2 — 提取 transport（纯收发）
按 `03-spec/retry-transport.md` §4 新建 `src/lib/transport/send.ts`，提取三个 client（`02 §6.1`）的共性骨架：token 检查 → combineAbortSignals → fetch(DISABLE_BUILTIN_FETCH_TIMEOUT) → captureHttpHeaders → !ok 抛 HTTPError → stream?guardSseIterable(events):json。**保留** rate-limiter 包裹。现有三个 client **改为调用 `transport.send`**（prepare 仍在 client 内，本 commit 不动 prepare）。invariant：client 行为**字节不变**，现有 client/transport 测试全绿。注意 Anthropic client 此 commit 仍保留其 2-attempt 内循环（P0.4 才提升）。

### P0.3 — observability 双轨收敛
现状 RequestContext 双轨发射（legacy `emit()`→manager `onEvent` + 新 `publisher`，`02 §5.2`）。按 `03-spec/envelope-driver.md` §5：把所有 `setXxx` 改为 publish 事件，删除 `manager.handleContextEvent`（manager.ts:244）的双写桥接，bus 成唯一通道。invariant：**bus 事件集 + 4 个 sink（History/Ws/Telemetry/Console）输出 fixture 前后一致**；history 测试全绿。⚠️ 这是 P0 风险最高的 commit——先写 sink 输出 golden fixture，改完对比无 diff。若过渡期新旧并写同一输出，用 flag/silent 防双写污染。

### P0.4 — Anthropic effort 内循环 → strategy
现状 `anthropic/client.ts:100` 有 2-attempt `invalid_reasoning_effort` 内循环（`02 §6.6`）。按 `03-spec/retry-transport.md` §2.2 提升为 `effort-learning` RetryStrategy，挂入 `buildAnthropicStrategies`（network/token-refresh 之后、body-field 之前）。client 退化为单次收发。invariant：effort-learning fixture **连跑 10+ 次行为等价**（learn → retry → 成功提交 negotiation cache）。

**完成后**：更新 `docs/v4/05-progress.md` 的 P0 表，每个 commit 记录 invariant 验证结果。每个 commit 做 subagent review 并亲自复核"行为等价""无消费者""字节不变"等断言。

**关键坑**：
- P0.2 的 `guardSseIterable` 统一**先不要**动 Anthropic 的 `processAnthropicStream`（那是 P2.6 的事）——P0.2 只提取 OpenAI 两个 client 的收发，Anthropic client 暂时保持自己的流路径，或让 transport.send 支持两种流包装。范围以"行为不变"为界，有歧义先问。
- P0.3 不要改 `HistoryEntryData` 字段集（稳定契约）。

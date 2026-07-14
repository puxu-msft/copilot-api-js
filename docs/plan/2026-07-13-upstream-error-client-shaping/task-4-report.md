# Phase 4（AskUserQuestion 合成）实施报告

**分支**：`feat/upstream-error-client-shaping`（隔离 worktree `.worktrees/upstream-error-client-shaping`）
**日期**：2026-07-14
**状态**：DONE（Task 4.1 / 4.2 / 4.3 全部落地；4.3 按实测结论走「记录 D-1 + 哨兵测试」escalation 路径，非「锁定理想不变量」——见 §4.3）

## 提交

| 短哈希 | 说明 |
|--------|------|
| `5b64050e` | feat: add AUQ synthesis builders（Task 4.1，纯序列化函数 streaming + non-streaming 两变体，两遍模板渲染）——**上一会话已提交** |
| （本会话见下方） | feat: wire AUQ synthesis into pre-commit error shaping glue（Task 4.2 接线 + 4.3 history 哨兵测试） |
| （本会话见下方） | test: add MED-3 wire-shape oracle to AUQ unit tests |
| （本会话见下方） | docs: record D-1 clientResponse-after-fail gap + MED-3 risk annotation |

## 测试摘要

- Phase 4 新增：`tests/anthropic/error-shaping-auq.unit.test.ts`（7 例：3 non-streaming + 1 MED-3 oracle + 3 streaming）+ `tests/routes/messages/error-shaping-auq.it.test.ts`（6 例：5 端到端 + 1 Task 4.3 D-1 哨兵）= **13/13 绿**。
- 回归：`error-shaping-precommit.it.test.ts` + `error-shaping-glue.unit.test.ts` + `error-shaping.unit.test.ts` = **57/57 绿**（glue.ts 接线未破坏 Phase 1/2 行为）。
- `bun run typecheck` 全绿；`bunx eslint --no-cache`（4 个改动文件）全绿。
- 禁改文件确认零改动（整个 Phase-4 range）：`src/lib/openai/stream-accumulator.ts`、`src/lib/openai/responses-stream-accumulator.ts`、`src/lib/anthropic/stream-accumulator.ts`、`src/lib/codec/openai-cc/`、`src/lib/codec/openai-responses/`。

## 各任务落地

### Task 4.1（builders，已于 `5b64050e` 提交）

`error-shaping.ts` 追加两个纯函数：
- `buildAskUserQuestionResponse(decision, ctx): AnthropicMessageResponse`（stream:false，整段 tool_use 响应，`stop_reason:"tool_use"`）。
- `buildAskUserQuestionFrames(decision, ctx): Array<ClientFrame>`（stream:true，自包含 SSE 帧序列 message_start → content_block_start(tool_use) → input_json_delta(整个 JSON 一次性下发) → content_block_stop → message_delta(stop_reason:tool_use) → message_stop，每帧打 `tagFrameSynthetic(frame, "error-shaping-auq")` 标记）。
- 两遍渲染：Phase 1 `decide()` 完成第一遍（`{error_type}`/`{status}`），本 Phase 完成第二遍（`{model}`/`{request_id}`）。
- 合成 `AnthropicMessageResponse` 用最小字面量 `as unknown as AnthropicMessageResponse`（沿用 `dry-run-pipeline.ts` 既有约定，避免满足 SDK 严格 `Message` 类型的 `container`/`stop_details`/完整 `Usage`/`ToolUseBlock.caller` 等对合成响应无意义的字段）。

### Task 4.2（glue 接线）

- **偏离计划**：计划建议在 `handler-v4.ts:192` 后加 `c.set("clientRequestStream", payload.stream ?? false)` 一行 side-channel。**实际未加**——因为 `handler-v4.ts` 的 catch 块已经 `c.set("requestContext", ctx)`，而 `ctx.originalRequest` 已携带 `stream` 与 `model` 两个字段（正是 side-channel 想重复暴露的），`ctx.id` 即 reqId。改从 `c.get("requestContext")` 读取，**零改动 `handler-v4.ts`**（该文件是 Phase 3/5 并发编辑热点，避开可减少 rebase 冲突面）。
- `shapePrecommitError` 的 `ask-user-question` 分支：从 ctx 读 `stream`/`model`/`id`，`stream:true` 走 `streamSSE` 逐帧 `writeSSE`，`stream:false` 走 `c.json(buildAskUserQuestionResponse(...))`。
- **CF-2 门控**：函数首行 `if (!state.errorShapingEnabled) return forwardError(c, error)`（Phase 2 已有）+ `decide()` 内部按 `config.askUserQuestion` 决定返回 `ask-user-question` 还是 `canonical-error`——两个门任一 false 都回落到 canonical。测试显式覆盖两条回落路径（`errorAskUserQuestion=false` → 402；`errorShapingEnabled=false` 即使 `errorAskUserQuestion=true` → 402）。
- **401/403 无特判**：401/402/403 都到达 `decide()`（401/403 → auth_expired，经 token-refresh 策略耗尽后冒泡；402 → quota_exceeded），均进入 AUQ 候选，wiring 点不新增 401 特判（测试含 401 用例锁定）。

### Task 4.3（history 一致性——escalation 到 D-1）

按计划「若既有 API 不支持则记入 README 待裁决节、停止深挖」的指示执行。**实测探针**（隔离 runtime，402→200 AUQ，非流式）确认既有 API **不支持** AUQ 的 client/upstream 状态分裂：

| 观测项 | 值 |
|--------|-----|
| `res.status`（客户端实收） | 200（AUQ）✓ |
| `entry.attempts[0].upstreamResponse` | `{status: 402, success: false}` ✓ **真实上游错误保留** |
| `entry.state` | `failed` |
| `entry.clientResponse` | **`undefined`** ✗ 合成的 200 完全没落库 |

**根因**：AUQ 是 pre-commit 整段合成——`handler-v4.ts` 泛型错误分支先 `ctx.fail()` 冻结快照（且不像 499-abort 分支那样先 `setClientResponseStatus`），`shapePrecommitError` 之后才构造 200；observability 中间件安全网的 `setClientResponseStatus` 对已 settle 的 entry 是 no-op（`middleware.ts` 自注释确认），SSE 路径中间件更是提前 return。修复需改 `RequestContext` settle 生命周期，超出 Phase 4 授权范围。

**处理**：① README §0 新增 **D-1** 待裁决项（发现 / 根因 / 影响面 / 3 个选项 / 推荐选项 1）；② `error-shaping-auq.it.test.ts` 补一条**哨兵测试**——正向锁定「真实 402 保留在 attempts」（richest-data-flow 保证），并显式断言「clientResponse 缺失」为已知限制，未来谁修 settle 时点该测试变红即强制回看 D-1。不自行改 `handler-v4.ts`。

## Concerns（须主会话/用户知悉）

1. **AUQ options schema 差异（承接 Phase 1 契约，本 Phase 未改）**：Phase 1 已提交的 `AuqQuestion.options` 是 `ReadonlyArray<string>`（纯字符串），但**真实 GHC/CC 的 AskUserQuestion `options` 是 `{label, description}` 对象**（实测证据：`tests/infra/debug-dry-run-pipeline.http.test.ts:108` 的真实降级 fixture `options: [{ label: "只做 #1 (rename)", description: "..." }]`）。本 Phase 按指示**复用 Phase 1 的 `AuqQuestion` 原样、不重设计**。若真实 CC 对纯字符串 options 渲染异常，需回 Phase 1 修改 `AuqQuestion.options` 类型 + `optionsForErrorType` 文案（跨 Phase 契约改动，不在 Phase 4 范围）。**建议主会话评估是否补一个 Phase 1 契约修订项。**

2. **MED-3：CC 交互式渲染假设未实测（履行选项 A，未做选项 B）**：本 Phase 全部测试只验证协议形状，**没有**用真实 Claude Code 消费合成帧确认它渲染成交互式问句 UI。「CC 会把合成 AskUserQuestion 渲染为交互式问句」是继承自 spec 的**未实测假设**，且 AUQ 仅在**交互式**会话有意义（headless/子 agent 无用户可问）。已履行选项 A：① 补独立 wire-shape oracle（`error-shaping-auq.unit.test.ts` 用 `backfillAskUserQuestionHeaders` 这个为真实 CC 流量写的消费方函数，验证合成 `questions[]` 满足 CC「每项必须有 question」契约、返回 identity 即无需 repair）；② 在 `phase-4-askuserquestion.md` 顶部 + 本报告显式标注风险。**未做**选项 B（真 CC 交互式渲染 PoC，需额外测试基础设施）。**未声称验证了 CC 渲染行为。**

3. **D-1：AUQ 的 200 客户端响应无法落 history `clientResponse`**（详见 Task 4.3 + README §0 D-1）：功能与真实错误保留均不受影响，纯 client-facing 响应元数据的可观测性缺口。已记录 + 哨兵测试锁定，留给主会话/用户裁决是否走 D-1 选项 2/3（改 settle 生命周期）。

4. **偏离计划的 `handler-v4.ts` 零改动**（详见 Task 4.2）：计划建议的 `c.set("clientRequestStream", ...)` side-channel 未加，改从既有 `c.get("requestContext").originalRequest` 读取——更少改动、避开 Phase 3/5 并发热点，功能等价。

# Step 1 item 3 B kick-off prompt — web_search 旁路 decode 测试覆盖

> Self-contained 启动 prompt（可冷接手）。背景见 `docs/audits/deferred-items.md` §2 Step1 item3(B)。

## 你要做什么

web_search 双跳旁路（`src/routes/messages/web-search-direct.ts`）有**第二份 decoder 副本**，独立于 v4 主路径 S5 链——`:375` 流式 `createToolInputStreamDecoder` / `:550` 非流式 `decodeToolInputBlocksInResponse`。它**零 decode 断言**，与主路径行为有漂移风险（`mem:feedback-fix-all-comparison-sites`）。补流式 + 非流式的 decode（+ backfill）断言锁住它。

裁判轴：长远正确 + 完整。Bun 项目（`bun test`，不是 npm）。

## 为什么旁路独立 + 为什么要测

主路径（handler-v4 → driver S5 `ANTHROPIC_RESPONSE_REWRITES`）的 decode 已有 golden + dry-run 测试锁定。但 web_search 双跳是 `[bypass]`（DESIGN「活的架构现状」表）——走 legacy `handleDirectAnthropicCompletion`（`web-search-direct.ts`），自带 decoder 调用。两份副本若行为漂移（如一侧改了 opts、一侧没改），只有主路径被测会漏掉旁路回归。本次 decode 可观测性（da5d9c6）已给两侧都接了 `onDecodeFailure`+`backfillAskUserQuestionHeader`——但旁路那两处**没有测试**证明 decode/backfill 真生效。

## Harness（直接复用，已存在）

`tests/anthropic/web-search/web-search.http.test.ts`（587 行）已驱动真实 handler + mock 上游：
- `upstreamFetchMock`（:169）：第一跳 `/v1/messages` → 返回 `web_search` tool_use（:80-95）；第二跳（`hasToolResult`，:192）→ 返回 `secondHopBody(model)`。
- `secondHopBody(model)`（:113）：当前返回一个 thinking+text 的 SSE 序列（:158-162）。**这就是经旁路 decode handler 的二跳合成响应**——把 AskUserQuestion+stringified questions 塞进这里即可测旁路 decode。
- `applyFetchMock` / `createFullTestApp` / `setStateForTests` 已接好（:254-261）。

## 任务

### T1 — 流式旁路 decode（+ backfill）
- 加一个二跳 SSE 变体（或参数化 `secondHopBody`），其内容含一个 `AskUserQuestion` tool_use，`input.questions` 是 **stringified JSON 数组**且 item **缺 `question`**（镜像真实 GHC 降级、两 failure 叠加，对齐 `tests/infra/debug-dry-run-pipeline.http.test.ts` 的 `askUserQuestionUpstream`）。
- 测试：`web_search.enabled` 开 + `decodeToolInputFields:{AskUserQuestion:["questions"]}` + `backfillQuestionFromHeader:true`（默认值，但显式 `setStateForTests` 求确定性 + `afterEach` restore）。POST 流式 `/v1/messages` 带 web_search 工具。
- 断言：**客户端实收**的 forwarded 流里该 tool_use 的 `questions` 是**结构化数组**（decode 生效）**且** item 有 `question`（backfill 生效）。复用 `debug-dry-run-pipeline.http.test.ts` 的 `forwardedQuestions` reassemble 思路（拼 input_json_delta partial_json）。

### T2 — 非流式旁路 decode（+ backfill）
- 二跳返回**非流式 JSON**（`stream:false` 请求路径走 `handleDirectAnthropicNonStreamingResponse` → `web-search-direct.ts:550` `decodeToolInputBlocksInResponse`）。secondHopBody 给一个 JSON 变体（`AnthropicMessageResponse` 含 AskUserQuestion tool_use、stringified questions）。
- 断言：客户端响应 JSON 里该 tool_use 的 `input.questions` 是数组 + backfilled。

### T3（可选，drift 守卫）
- 断言旁路与主路径对**同一输入**产出**同形态**（decode+backfill 结果一致）——若易做则加，锁死两副本不漂移。

## 注意 / 红线
- **history 保留上游原貌**：旁路 decode 只改 forwarded（客户端实收），`inboundResponse`/`outboundResponse` 的原始 sseEvents 保留 stringified——可顺带断言 history 那侧仍是字符串（对齐 `richest-data-flow` / decode 仅改转发的契约）。
- 旁路非流式当前用**旧序** filter→recover→restore→decode（DESIGN 注，待其迁 driver 收敛）——decode 在 restore 后，故旁路非流式按**客户端原名**匹配（与主路径 wire-名匹配不同）；这意味着旁路非流式**不受** Step1 item2 的 sanitize×wire-name 盲点影响。测试时注意这个序差，别假设与主路径逐位一致。
- 隔离纪律：改全局 state 的测试配 `afterEach restoreStateForTests`/`autoRestoreState`（bun 单进程跨文件泄漏）。

## 验收
- `bun test tests/anthropic/web-search/web-search.http.test.ts` 绿；`bun run typecheck` 绿；`npx eslint` 改动文件零错。
- 流式 + 非流式 decode+backfill 断言各至少一条。
- 收尾：deferred-items §2 Step1 item3(B) 标完成；若发现旁路与主路径真漂移=真 bug，按 `fix-all-comparison-sites` 抽共享或对齐。
- subagent 对抗 review（显式裁判轴：长远正确+完整；绝对断言读 file:line 核验）。

# Phase 0 — 激活态 Golden 基线

> Stage A 的 Task 0。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。本 phase 是**一切迁移的字节等价基准**，无生产改动、纯测试。

## 背景

v4 重构 P0-P3 已完成，driver 编排七阶段（S1 解析 → S2 路由 → S3 请求改写 → S4 收发 → S5 响应改写 → S6 翻译 → S7 写回）+ 各格式 codec 已在生产。Stage A 要**激活休眠的 `rewrite-registry`**（`src/lib/pipeline/rewrite-registry.ts` 的 `REQUEST_REWRITES`/`RESPONSE_REWRITES` 至今为空），把散在 handler pump（`src/routes/messages/streaming-pump.ts` 的 `processOneStreamEvent` 手写嵌套）的响应改写迁进 registry，让"新增拦截/修复上游怪癖 = 注册一个 ResponseRewrite"。

这是 **byte-critical 重构**：响应 SSE 字节若变，下游 SDK 会挂/400。RFC §7 审计指出——现有 golden（`tests/anthropic/anthropic-v4.http.test.ts`）只锁了 ok/thinking 两条 **no-op-rewrite 透传流**，所有**激活态** byte-critical 路径**零覆盖**。后续每个迁移 commit 的字节等价基准就是本 phase 建的 golden。

## 目标

新建 `tests/anthropic/response-rewrite-golden.http.test.ts`，在**当前（改动前）**的 handler-v4 路径上逐字节锁定激活态场景（这些 golden 在后续每个迁移 commit 后重跑必须仍全绿）。

**必须覆盖的场景**（每条都要触发对应改写的真实激活路径，非透传）：
1. **server-tool-filter suppress + index densify**：请求含 `server_tool_use` block 的流 → filter suppress 该块 + 后续块 index 从 N densify 到 N-1（核 `src/lib/anthropic/server-tool-filter.ts:102` `createServerToolBlockFilter` 的 `filteredIndices`/`clientIndexMap`/`nextClientIndex` 重映射）。
2. **tool-input-decode buffer/flush**：含 AskUserQuestion tool_use 的流（`state.decodeToolInputFields` 默认 `{AskUserQuestion:["questions"]}`）→ buffer input delta、mid-stream `content_block_stop` 边界 finalize。
3. **recover-tool-call CANDIDATE/COMMIT + rollback**：设 `state.recoverToolCallText=true` + 上游发 `<invoke>` 文本降级流 → CANDIDATE 缓冲、COMMIT 合成 tool_use；**rollback 路径**（candidate 被新 `content_block_start` 打断，吐 `[stopFrame, ...bufferedFrames]`，核 `src/lib/anthropic/recover-tool-call/stream.ts:93-98`）。
4. **recover + decode 同激活 + 流末双 flush**：两个 buffering 改写同时缓冲 + 流结束 → 双 flush 顺序（recover.flush 输出喂 decode、decode 再 flush，现状 `handler-v4.ts:655-663`）。
5. **recover × filter index 空间交互**：recover 合成 tool_use 用 `maxUpstreamIndexSeen+k` 上游 index 空间 + filter densify。
6. **非流式各场景**：server-tool block 过滤、tool-input decode、name restore、recover（非流式走 `renderNonStreamingV4` 的 whole-response helper）。
7. **heartbeat ping 穿插**：Stage A heartbeat 仍 handler-side，golden 比对 forwarded 时混入 ping 会让逐字节 flaky → 用 **0 间隔或 fake timer 隔离**。

## 手法

仿 P3.3a / P3 收尾的 golden 捕获：临时加 `console.error("###CAP_<key>###" + JSON.stringify(text))` 跑一次抓真实字节 → 转 inline golden 常量 → **用 Edit 删临时打印（前向编辑，绝不 git checkout）**。mock/app 范式参照 `tests/anthropic/anthropic-v4.http.test.ts`（`createFullTestApp`、`applyFetchMock`、`createSseResponse`）+ 时序场景参照 `tests/anthropic/fake-sse-heartbeat.unit.test.ts`。

## 验收

- `bun test tests/anthropic/response-rewrite-golden.http.test.ts` **当前代码全绿**（改前基线，PASS 即正确锁定）。
- `bun run typecheck` 绿；`bunx eslint --fix tests/anthropic/response-rewrite-golden.http.test.ts` 干净。
- 无临时 `###CAP_` 打印残留（grep 确认）。

## 提交

```bash
git add -- tests/anthropic/response-rewrite-golden.http.test.ts
git commit -m "test(pipeline): Stage A Task0 激活态响应改写 golden 基线(改前锁字节)"
```

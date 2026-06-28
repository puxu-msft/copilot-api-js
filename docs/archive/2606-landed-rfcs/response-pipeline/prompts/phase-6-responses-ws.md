# Phase 6 — Responses 逐帧改写 + WS（A.C）

> Stage A 的 Task 6 / 设计稿的 A.C。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。**前置**：Phase 0（golden 手法）、Phase 1（flushChain-finally）。**与 Anthropic 响应链（Phase 3/4/5）格式独立**——可并行分派，但共改 `rewrite-registry.ts`/`driver.ts`/`types.ts`，需协调合并。

## 背景

OpenAI Responses API 有自己的响应改写，且**两条传输**都消费 driver：
- HTTP SSE：经 driver.runResponse。
- **WebSocket**：`src/routes/responses/ws.ts` 是**独立 WS 管线**，也 consume `driver.runResponse`，额外做 `fixStreamEventIds`（修 `response.output_item.added` 与 `.done` 间 item ID 不一致，DESIGN.md `fixResponsesStreamIds`）+ `normalize_call_ids`（`call_`→`fc_`）+ restore。

这些 Responses 专属逐帧改写当前在 handler/ws 内联，未入 registry。设计稿审计（§4.C）要求纳入——让 Responses 路径也"新增拦截 = 注册一条改写"，且 **HTTP 与 WS 两条传输共享同一 registry**（避免改写只在一条传输生效的割裂）。

**关键差异**：Responses 改写多为**逐帧 id 重映射 / 字段修正**，**非 buffer/flush**（不像 Anthropic 的 recover/decode）。故风险低于 Phase 4，无 index densify 那类时序耦合。

## 目标

1. 把 Responses 专属改写（`fixStreamEventIds`、`normalize_call_ids`、`strip_image_generation_tool` 响应侧若有、stream-id restore）注册为 `ResponseRewrite` 条目，`appliesTo(env)` 守卫按 Responses 格式 + 对应 config flag（`fixResponsesStreamIds`/`normalizeResponsesCallIds`）。
2. driver.runResponse 对 Responses env 跑这些 registry 改写，HTTP SSE handler 删内联调用。
3. **WS 同步切换**：`responses/ws.ts` 也经同一 registry 链（它已 consume runResponse，确认 registry 改写对 WS 帧同样生效）；WS 专属的连接级处理（keep-open、frame size 限制、call-id restore 落在 WS 出口）保留在 ws.ts，但**逐帧内容改写**走 registry。

## 关键约束

- **WS wire 协议不变**（通用红线 10）：客户端侧 Responses WS 的帧序列/字段逐字节不变。Responses WS golden 须含 `response.output_item.added`/`.done` id 一致性、call-id 归一、completed 后 keep-open vs 1000-close 两态。
- **HTTP/WS 等价**：同一逻辑响应经 HTTP 与经 WS，改写后内容帧应一致（仅传输封装不同）。这是把改写收进共享 registry 的核心收益，用测试锁死。
- driver-owned-writeout（设计稿 §3.2/§3.3 的 `ClientSink`/`ResponseOutcome`）是 **Stage B** 的事，**本 phase 不引入** sink 翻转——WS 仍按现状 consume generator。

## TDD

1. 改前捕获 Responses HTTP SSE + WS 两条 golden（id 一致性 / call-id / keep-open）。
2. 逐条迁改写进 registry + 守卫 + driver 跑 + handler/ws 删内联 → 两条 golden 等价 → 每条一 commit。
3. WS 路径连跑 10-25×（连接时序）。

## 验收

- Responses HTTP + WS golden 逐字节等价 + HTTP/WS 内容帧一致性测试绿。
- `/api/status.upstream_ws` 形状不变（通用红线 10）。
- `bun run test:backend`（含 `tests/responses/`）绿；`bun run typecheck` 绿；`bunx eslint --fix`。
- **subagent 对抗 review**（全量工具）：核 WS 与 HTTP 是否真共享同一 registry 实例化、appliesTo 是否漏掉某 flag 分支、keep-open 态未受影响。主线亲核 `responses/ws.ts` 引用 file:line。

## 提交

```bash
git add -- src/lib/pipeline/rewrite-registry.ts src/lib/pipeline/driver.ts src/routes/responses/ws.ts <responses handler> tests/responses/...
git commit -m "refactor(pipeline): Stage A A.C Responses 逐帧改写纳入 registry(HTTP+WS 共享,fix-stream-ids/normalize-call-ids)"
```

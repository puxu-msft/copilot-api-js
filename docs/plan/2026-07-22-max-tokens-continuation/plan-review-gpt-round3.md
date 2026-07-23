# max_tokens 续传实施计划第三轮紧确认（GPT 异模型对抗审）

## 评审范围

仅复核修订提交 `3df2e90c` 对第二轮 1 个 blocker 与 3 个残留的闭合情况：P0/P3 的 CC／Responses observer 分档、`strategy-prevented-stitch` 可观测性、Q5 anchor index 账、Responses reverse leg 归类。

## 已读取／执行的证据

- 修订计划：`/home/xp/src/copilot-api-js/docs/plan/2026-07-22-max-tokens-continuation/plan-0-classifier-and-observability.md`、`plan-1-anthropic-continuation.md`、`plan-3-cc-responses.md`、`plan-Q5-three-way-overlap.md`、`plan-M-terminal-ownership-matrix.md`。
- master 代码：`src/routes/chat-completions/handler-v4.ts:329-365`、`src/routes/responses/candidate-response-session.ts:104-165`、`src/lib/pipeline/driver.ts:1015-1050, 1132-1150`、`src/lib/anthropic/keepalive-anchor.ts:216-263`、`src/routes/responses/handler-v4.ts:576-645`。

## 总体 verdict

**需先作一处计划排序修订，之后可开工实施。**

**blocker 数量：0。**

上轮的分型 observer blocker 已通过显式分档闭合；Q5 anchor 计数事实和 Responses reverse leg 归类均已改正并与 master 一致。仅剩 `strategy-prevented-stitch` 的任务顺序仍允许一个已启用但不可观测的 P1 commit，违反每 commit 终态自洽和“不静默吞配置”的验收约束。

## 事实性发现

[major] `plan-1-anthropic-continuation.md:173-189, 191-216` — `strategy-prevented-stitch` 虽已有真实 history／telemetry readback 任务，但排在 Task 1.5 的 handler 生产接线之后，形成一个不满足冻结诊断契约的可启用 commit。证据：Task 1.5 将 `resolveEffectiveMaxTokensContinuation("anthropic")` 接入 driver 并单独提交 `feat(handler)`；Task 1.6 才把 `diagnostics` 写入 `PipelineInfo.strategyPreventedStitch` 并注册 telemetry outcome，且又要求另一次提交。故 Task 1.5 完成至 Task 1.6 合入前，用户的 `visibility:passthrough + classes.text:continue` 会被正确降级且不触发协议错误，但 history／telemetry 仍看不到 `strategy-prevented-stitch`——仍属静默吞掉配置意图。建议：将 Task 1.6 的 producer wiring、真实 history readback 与 telemetry counter 并入 Task 1.5 的首次 production consumer commit，或将 Task 1.6 改为 Task 1.5 的硬前置并禁止单独交付 1.5。测试应在该同一 commit 断言：非法组合不续写、history 字段为 true、outcome counter 递增。

## 四项逐项确认

1. **CC／Responses observer 分档：已闭合。**
   - `plan-0-classifier-and-observability.md:8-25, 233-281` 现在明确 P0 是 Anthropic-only，且把范围边界和真实 Anthropic history／telemetry oracle 写入验收，不再伪称 CC／Responses 已接线。这与目前实测人群以及 P1 Anthropic-only 范围一致，是显式分档，不是静默砍掉 spec 的跨格式要求。
   - `plan-3-cc-responses.md:28-102` 新增 CC Task 3.0a／3.0a-wire 和 Responses Task 3.0b／3.0b-wire，并将其设为后续 P3 task 的硬依赖。所列挂点属实：CC candidate `createState` 与 `onRenderedFrame` 的 accumulator 更新在 `src/routes/chat-completions/handler-v4.ts:329-353`；Responses 的同类状态与解析更新在 `src/routes/responses/candidate-response-session.ts:104-136`。计划也正确指出 CC `toolCallMap` 本身没有 closed 标记、Responses 则可用 `finalizedOutputIndexes`。

2. **`strategy-prevented-stitch` 记录：未完全闭合。**
   - 字段预留已存在于 `plan-0-classifier-and-observability.md:258`，Task 1.6 的真实 history／telemetry oracle和实现步骤也足够具体，见上方 major。
   - 但其在首个 handler production wiring commit 后才执行，未满足每个 commit 的完整可观测性不变量。

3. **Q5 index 账：已闭合。**
   - `plan-Q5-three-way-overlap.md:36-65` 已正确改为 anchor 不计入 `wireDeliveredBlocks`，并指定 producer oracle 的期望序列 `anchor@0 → real@1 → continuation@2`。
   - 该事实与 master 一致：anchor 通过 `sink.writeAnchor` 直接写出，见 `src/lib/anthropic/keepalive-anchor.ts:235,261`；真实帧才在 `driver.ts:1132-1150` 的 flush loop 中经过两层 remap，且仅真实 `content_block_start` 触发 `wireDeliveredBlocks++`。`driver.ts:1026-1027` 也确实将 empty-text anchor 与 continuation 组合标为未测 corner。计划没有再把该风险伪装成已证事实，而是把它交给 Q5.3 producer oracle。

4. **Responses reverse：已闭合。**
   - `plan-M-terminal-ownership-matrix.md:120-150` 已改为“本版本不支持、强制透传”，并列出 producer oracle；`plan-3-cc-responses.md:211-227` 的 Task 3.12 具体化了该 oracle。
   - master 事实吻合：`src/routes/responses/handler-v4.ts:585` 调用的是 `driver.runResponseSink`，不是 `runResponseBufferedSink`，故没有本特性所依赖的 success-path buffered terminal interception seam。

## 可否开工实施

**暂不可开工。**

只需修正上述 Task 1.5／1.6 的提交顺序与 commit invariant：让 effective config 的首次生产消费、`strategyPreventedStitch` history 记录和 telemetry outcome 同时交付。完成该单点计划修订后，本轮所核四项均闭合，可按 gate-first 顺序开工实施。

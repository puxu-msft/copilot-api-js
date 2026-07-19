---
name: project-responses-buffered-merge-landed
description: Responses buffered 块级语义压缩 + 终结对账（buffered-merge）全 36 task landed 分支；候选托管 reducer + 两正交旋钮；承重决策=drop-delta 默认作用于所有 Responses 流
metadata: 
  node_type: memory
  type: project
  originSessionId: a048630b-9b10-48c5-8924-4053edf4b5f0
  modified: 2026-07-19T21:01:43.540Z
---

Responses buffered-merge 特性（spec/plan `2026-07-14-responses-buffered-block-merge`）**全 36 task 已实施**在分支 `feat/responses-buffered-block-merge`（本会话 2026-07-19 从 Task 2.10 接手到收官），待合并 master。权威现状见 DESIGN.md「活的架构现状」新增行 + plan 头部状态注解。

承重要点（stub，细节在 docs）：
- **候选托管 reducer**（`buffered-merge-reducer.ts`）经候选工厂 `transformBufferedFlush` 缝接进 driver `flushBufferedFrames` 咽喉；两正交旋钮 `event_compaction`（默认 drop-delta）+ `completed_output`（默认 repair-if-incomplete）。
- **承重决策（用户拍板）**：spec 假设 `buffered_retry` 默认 OFF、称特性「加性不翻默认」，但代码库已 flip `responsesBufferedRetry` 默认 **ON** → 默认 drop-delta 现作用于**所有** Responses 流，closed-item `output_text.delta` 被从 forwarded 轨过滤。**纯 delta 累加消费者拿空文本**；文本存活于 `output_item.done.item.content` + 被 repair 的 completed。**生产启用前须实跑 `exp/responses-buffered-merge-codex-oracle` 确认真实 Codex 读 `.done`**。
- **测试教训**：候选托管 `transformBufferedFlush` 只在有 generation binding 时触达（`driver.ts` `currentCandidateResponseOpts` 只读 `generation.currentSession(upstream)`），bare-driver `runResponseBufferedSink(deps,...)` 无 binding 会绕过 reducer → 接线测试必须走 HTTP e2e（`createFullTestApp` 全驱动路径），plan 原设想的 bare-driver harness 不可行。
- **@ai-sdk/openai 比官方 `openai` SDK 更宽容**：不因 `content_part.added` 缺失抛错，从 `response.completed.output` 重建（本会话 Task 5.5 实测）；官方 `openai` SDK 的 ResponseAccumulator 则抛 `missing content`。
- 相关 eslint --fix 类型回归见 [[tooling-eslint-fix-at-autofix-breaks-types]]。

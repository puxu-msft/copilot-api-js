---
slug: task1b-task3-seam
status: in-progress
base: 38ee9d8641848fc97dfbca371bc322f2d623ab70
branch: agent-a4519c20a545ed3b6
worktree: /home/xp/src/copilot-api-js/.worktree/agent-a4519c20a545ed3b6
plan: docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md
agent-id: a4519c20a545ed3b6
session-id: unavailable
continuity: 须连续；Task 1b 与已落地 Task 3 在 response processor 和测试上存在语义接缝，必须合并后验证。
---

# Task 1b／Task 3 merged-seam 实施进度

## 已核验基线

- 目标隔离 worktree 为 `/home/xp/src/copilot-api-js/.worktree/agent-a4519c20a545ed3b6`，起始 `HEAD` 为 `38ee9d8641848fc97dfbca371bc322f2d623ab70`，并已机械确认含 Task 3 最终提交 `adc023f4`、`98f15061` 与文档提交 `38ee9d86`。
- Task 1b 只读候选为 `/home/xp/src/copilot-api-js/.worktree/agent-a5c59dd66952edb78` 的 `51286a057510b9e9cbe223a624e5f860119825ac`，其净变更范围为共同基线 `c972a946520abd2328aa6e14ec2e34ca0a9bce66..51286a057510b9e9cbe223a624e5f860119825ac`。
- 冻结不变量：parser／History upstream 保持 `ParsedSseFrame`；direct render 仅在客户端边界 project 为 wire `ClientFrame`；Task 3 的唯一 post-render gate 接收 project 后的 wire frame；普通与 finish frame 恰分类一次，finish frames 先 classify＋yield 再 finish verdict；public `createResponses` 保持 flat；client frames 不复制 parsed provenance；不提前 Task 4。

## 已完成的集成工作

- 已将 `c972a946..51286a05` 的净 patch 应用到 Task 3 HEAD，明确排除发生语义冲突的 `response-processor.ts` 与其测试，避免 blind cherry-pick 候选历史。
- combined seam 红测先证实旧 Task 3 `postRender` gate 收到 rich parser object：`projects direct rich SSE to wire before exactly-once post-render classification` 以 `"kind" in frame === true` 按预期失败。随后按 Task 1b 的 rich carrier／projection policy 与 Task 3 的 finish ordering 手工合并 processor；测试转绿。
- 当前 processor 的普通／finish输出均继续经过 Task 3 的唯一 `emit → postRender` gate；rich `ParsedSseFrame` 只在 direct／skip-render边界 project为 wire frame。parser已进入 History 捕获，fresh rewrite经显式 `fresh` policy不能继承 ID provenance。
- 已完成初轮定向验证：Task 1b parser／encoder／public Responses boundary目标集绿；Task 3 adapter／grammar／candidate／boundary／hedge目标集绿；processor seam 7 pass；`bun run typecheck`绿。

## 剩余项

- 扩充 combined-seam tests，覆盖 fresh same-value ID、finish frame顺序、public flat/internal rich与outcomes preserved，随后逐项实施与正控。
- 运行完整 Task 1b／Task 3矩阵、deterministic performance、target lint和`bun run test:backend`；每个红测试分类、修复或作为阻塞记录。
- 每个实现commit同步本文件并填入source SHA→本树SHA映射。

## 在途意图

- 下一语义单元只补 combined seam 可观察行为测试；不更改Task 4 owner／compatibility边界。已应用的Task 1b净patch尚未提交，必须先完成当前红绿测试组与类型检查，再提交。

## 已作废的路子

- 不将 `ParsedSseFrame` 扁平化来回避 History 或 Task 3 consumer。
- 不在 `response-processor` 恢复 Task 1b 已过时的 `yield* finish.frames` 旁路或删除 Task 3 的 `postRender` gate。
- 不以 ID 值或对象形状推断 rewrite provenance；fresh rewrites own fields，same-value ID 合法但不继承 parser provenance。
- 不恢复第二 classifier，不提前删除 Task 3 compatibility projections或实施 Task 4 owner migration。

## Source mapping

| Task 1b source SHA | 本树 SHA | 内容／状态 |
| --- | --- | --- |
| `937027bd`…`51286a05` | 待集成 | 将按净 patch 语义吸收，不保留一一 cherry-pick 映射。 |

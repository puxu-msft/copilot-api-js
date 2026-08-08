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

- Task 1b净patch与首次combined seam已在 `74dcdcea` 提交。后续完整目标测试发现 Task 3回归：`candidate-response-session` 将 candidate classifier 置于 processor input callback，并被 processor 的 `input.onRenderedFrame ?? opts.onRenderedFrame` 优先选择遮蔽外层 callback；使外层的工具名恢复不执行。当前修复意图是在 driver 的已组装 opts 中先 outer transform，再调用 candidate唯一classification gate，processor只消费已组装 opts callback。`generation-runtime-baseline` 的 `cc-direct` frame-origin 预期从 `render:client` 更新为 `client-transform:client`，因为 finish frame现在与普通frame同经该唯一gate；这是冻结“finish frame先project+classify+yield”契约的观测更新，不是放宽断言。

## 已处理的失败

- `tests/pipeline/generation-runtime-baseline.http.test.ts` 与 `tests/pipeline/hooks/driver-provenance.unit.test.ts` 首次联合运行失败，均由上述同一callback遮蔽根因导致，非既有失败；其余Task 1b／Task 3目标测试在同轮通过。修复后必须复跑两者并确认恢复。

## Source mapping

| Task 1b source SHA | 本树 SHA | 内容／状态 |
| --- | --- | --- |
| `937027bd`…`51286a05` | `74dcdcea` | 按 `c972a946..51286a05` 净patch集成；processor冲突按Task 3唯一post-render gate手工合并。 |

## 结构怪味审计

- `src/lib/pipeline/stream/response-processor.ts:88-96`：callback选择层级不明确会遮蔽外层transform，属于职责错位／双接缝弱一档；本轮修为driver组装外层transform→candidate classifier的单一callback，不在processor重新合并。
- `src/lib/pipeline/generation/candidate-response-session.ts:169-187`：候选session同时承担hook、外层transform与分类，属于过渡期编排密集；本轮不重构，因为Task 4才替换compatibility projection与owner接线，记录为该阶段边界。
- 第三方方案：SSE rich carrier／WHATWG framing与项目协议grammar均为项目内契约，无合适第三方库替代。

## 已作废的路子

- 不将 `ParsedSseFrame` 扁平化来回避 History 或 Task 3 consumer。
- 不在 `response-processor` 恢复 Task 1b 已过时的 `yield* finish.frames` 旁路或删除 Task 3 的 `postRender` gate。
- 不以 ID 值或对象形状推断 rewrite provenance；fresh rewrites own fields，same-value ID 合法但不继承 parser provenance。
- 不恢复第二 classifier，不提前删除 Task 3 compatibility projections或实施 Task 4 owner migration。

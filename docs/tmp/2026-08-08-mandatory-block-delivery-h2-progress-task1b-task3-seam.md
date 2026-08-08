---
slug: task1b-task3-seam
status: blocked
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

- public flat／internal rich、finish frame顺序与outcomes preserved已有Task 1b／Task 3定向套件覆盖；本轮新增fresh same-value ID combined seam并已绿。剩余的测试实施项为零。
- 唯一未闭合门为`bun run test:backend`：进程级SIGUSR2导致两次执行均exit 1，必须定位信号来源或在稳定环境重跑。
- 实现收口后需要主会话安排独立代码复审；本叶子执行单元不能派生reviewer。

## 在途意图

- Task 1b净patch与首次combined seam已在 `74dcdcea` 提交。后续完整目标测试发现 Task 3回归：`candidate-response-session` 将 candidate classifier 置于 processor input callback，并被 processor 的 `input.onRenderedFrame ?? opts.onRenderedFrame` 优先选择遮蔽外层 callback；使外层的工具名恢复不执行。当前修复意图是在 driver 的已组装 opts 中先 outer transform，再调用 candidate唯一classification gate，processor只消费已组装 opts callback。`generation-runtime-baseline` 的 `cc-direct` frame-origin 预期从 `render:client` 更新为 `client-transform:client`，因为 finish frame现在与普通frame同经该唯一gate；这是冻结“finish frame先project+classify+yield”契约的观测更新，不是放宽断言。

## 已处理的失败

- `tests/pipeline/generation-runtime-baseline.http.test.ts` 与 `tests/pipeline/hooks/driver-provenance.unit.test.ts` 首次联合运行失败，均由上述同一callback遮蔽根因导致，非既有失败；修复后联合复跑为15 pass／0 fail，Task 3扩展组合为125 pass／0 fail。
- `bun run test:backend` 全后端门尚未通过，原因是7个已枚举测试失败与crashed shard；SIGUSR2日志已在后续Phase1证据中降级为进程内测试行为，不能作为exit 1归因。

## SIGUSR2 Phase 1 证据（2026-08-08）

- wrapper重现日志：`/tmp/task37-sigusr2-phase1/backend-20260808T091351Z.log`、事件时间线：`/tmp/task37-sigusr2-phase1/backend-20260808T091351Z.events`、进程树：`/tmp/task37-sigusr2-phase1/backend-20260808T091351Z.children`。wrapper `2918764`、runner `2918774`同属PGID `2918764`，wrapper trap未触发；只证明日志不来自wrapper，不足以指定child。
- `strace` 缺失：`/bin/bash: strace: command not found`，故不能取得 syscall sender→receiver。替代的`BUN_OPTIONS=--preload` tracer覆盖129个 Bun child，记录PID／PGID但没有`received-SIGUSR2`；同时对`shutdown-sigusr2.unit`单跑验证，该测试直接调用`handleShutdownSignal("SIGUSR2")`即可产生相同日志、无需OS signal。因此backend首行SIGUSR2降级为**进程内测试行为**，sender→receiver无可证实事实，也不解释exit 1。
- A 已闭合：`errorFrameCanonicalRewrite` 的非error passthrough现在明确断言`provenance:"preserve"`。先运行33 pass／0 fail；将生产分支暂时变异回裸`{kind:"emit",frames}`后该断言按目标失败，恢复后再通过。测试迁移提交为`1ca35e35`。
- B 已闭合：测试fixture不满足Task3 adapter contract，而非encoded sink行为：`makeEnv()`缺少必填`clientFormat`，`defaultAdapter(undefined)`在processor启动前抛错，所以heartbeat timer未arm、guard也未进入，表现为0 ping和错误outcome。最小probe证明raw encoder／decoder：`sink.write(PING)`得到`[PING]`；只补`clientFormat:"anthropic"`后两条two-racer测试转为3 pass／0 fail。fixture修复提交为`3d194954`。
- 唯一生产发送点为`src/lib/restart/takeover.ts:46`的`process.kill(pid,"SIGUSR2")`；`scripts/parallel-test.ts`只分片spawn。backend运行3／3出现该日志，但一轮明确为16 shards、4672 tests、4665 pass、7 fail、2 crashed shards，exit由失败／crash解释。
- 单跑7项分类：①`error-frame-canonical-rewrite.unit`稳定红，Task1b `preserveFrame`返回`provenance:"preserve"`而旧deep-equal遗漏该字段，属契约迁移候选；已有fresh／preserve policy及combined seam为正控，未改。②two-racer两项稳定红：sink改raw encoded write后仍无ping／abort错误变stream-error，属真实整合回归。③Anthropic v4与三个rewrite golden稳定红：History upstream-original content重复拼接，属真实History capture回归。④UDS单跑24 pass／0 fail，backend超时／child exit143为并发污染或环境候选。⑤SCC ratchet稳定红，新循环从Task37未改的`buffered-merge-reducer.ts`开始；基线worktree缺undici，无法AB归因。
- C 根因已确认：`runResponseSink` 先用`currentCandidateResponseOpts`组装绑定candidate callback，再调用`runResponse`，而后者检测generation binding后第二次`mergeCandidateResponseOpts`。outer不存在`onUpstreamFrame`时，第二次merge嵌套candidate callback，使同一candidate `onUpstreamFrame`执行两次。最小S1 fixture显示History upstream track本身是9个正确事件，重复发生在handler accumulator而非parser capture／rewrite capture／projection。修复点在shared driver direct-sink assembly：binding存在时调用assembled-only入口，避免二次merge；`response-rewrite-golden`、`anthropic-v4`与two-racer组合45 pass／0 fail。
- 下一单一假设：修复后的driver direct sink仍应保留outer observer与candidate classifier的exactly-once顺序；下一步只跑Task3 driver／candidate与History四文件门，不修复其他失败。

## 验证

- 正控：暂时把 direct render projection变异为回传rich `ParsedSseFrame`，`response-processor.unit` 以目标combined-seam断言 `"kind" in frame === true` 失败；恢复`projectParsedSseFrame`后7 pass／0 fail。
- `bun run typecheck`：通过。
- Task 1b parser／encoder／public-boundary 子集：通过；Task 3 adapter／grammar／candidate／driver 子集：125 pass／0 fail；combined seam：22 pass／0 fail；canonical deterministic performance：5 pass／0 fail。
- target ESLint：通过，仅有第三方`baseline-browser-mapping`数据陈旧warning。
- 全后端：blocked，见本节SIGUSR2记录。

## 本轮自我批判

- 内部替代方案：可把外层transform与candidate classification重构为单独的typed pipeline stage，但那会越过Task 4的owner迁移边界；本轮采用已组装opts的单一callback保持当前契约。
- 判据判别力：rich→wire seam已通过exact mutation正控；callback遮蔽由真实live baseline与hook-provenance两条独立测试共同捕获。仍缺fresh same-value ID／public-flat与outcomes-preserved的显式combined单测，列为剩余项。
- 第三方方案：无能替代本项目自有SSE provenance与DeliveryGrammar契约的成熟库。

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

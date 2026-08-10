# Task 37（Task 1b × Task 3 交付接缝）合并态复审 —— 待核验命题清单

**这份文件是派发件的输入，不是结论。** 它把账本里那句散文式的接缝契约翻译成逐条可证伪的命题，供两个正交视角的独立评审逐条取证。命题为真为假都由评审裁决，本文件不预设答案。

## 基线

| 项 | 值 |
| --- | --- |
| 评审目标（冻结） | `638f6f3c898f7562fc086bfb2c5f1f4b04a5b5ad` |
| 接缝合并提交 | `bd6afab5`（2026-08-08，`merge: integrate parsed SSE delivery seam`） |
| 契约来源 | `.superpowers/sdd/progress.md` 的 “Cross-task integration seam” 节 + `docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task1b-task3-seam.md` 的「冻结不变量」 |
| 计划 | `docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md` |

## 为什么现在必须重审：接缝已大幅漂移

`bd6afab5` 之后又有 **46 个提交**触及 `src/lib/pipeline`、`src/lib/transport`、`src/lib/codec`。核心接缝文件的净漂移（`git diff --numstat bd6afab5..638f6f3c`）：

| 文件 | 漂移 |
| --- | --- |
| `src/lib/pipeline/driver.ts` | +320 −89 |
| `src/lib/pipeline/stream/response-processor.ts` | +182 −70 |
| `src/lib/pipeline/types.ts` | +22 −1 |
| `src/lib/pipeline/generation/candidate-response-session.ts` | +20 −15 |
| `parsed-sse-frame.ts` / `sse-encoder.ts` / `client-sink.ts` / `responses-client.ts` / `error-frame-canonical-rewrite.ts` | 未变 |

**因此「`bd6afab5` 当时通过了定向验证」不能作为本轮的证据。** 每条命题都必须在 `638f6f3c` 上重新取证。账本原话：*“A clean three-way merge is not evidence of semantic compatibility.”*

## 待核验命题（I1–I11）

每条要求：**判定（HOLDS / VIOLATED / UNVERIFIABLE）+ `file:line` 或命令输出**。`file:line` 必须按 `638f6f3c` 的当前文件复核，不得引用历史行号。

| # | 命题 | 备注 |
| --- | --- | --- |
| I1 | parser 与 History upstream 轨保持 rich `ParsedSseFrame` 载体，未被扁平化 | 反例形态：为迁就下游消费者把 rich 载体拍平 |
| I2 | direct render **仅在客户端边界**把 rich frame project 成 wire `ClientFrame` | 探测深度要对齐：测的是「边界那一处」还是「整条链」，先声明 |
| I3 | Task 3 的**唯一** post-render gate 收到的是 project 之后的 wire frame，不是 rich 对象 | 当时的正控是断言 `"kind" in frame === false` |
| I4 | 普通 frame 与 finish frame **各恰好分类一次** | 「唯一」是全称断言，须给出穷举依据而非采样 |
| I5 | finish frame 的顺序是 **classify + yield 先于 finish verdict** | |
| I6 | public `createResponses` 保持 flat 形状（内部 rich、对外扁平） | |
| I7 | client frame **不复制** parsed provenance | |
| I8 | 未提前实施 Task 4（owner 迁移、compatibility projection 删除都不得出现） | 越界即 blocker |
| I9 | adapter / candidate wrapper 保持显式 projection 边界，且**不丢弃已分类的 outcome** | 账本点名的合并门原文 |
| I10 | driver direct-sink 组装**不再二次 merge** candidate response opts；同一 candidate 的 `onUpstreamFrame` 恰好执行一次 | 这是 `6aab6de4` 修的 C 类根因，`driver.ts` 此后漂移 +320/−89，须重验 |
| I11 | `errorFrameCanonicalRewrite` 的非 error passthrough 断言 `provenance:"preserve"` | `1ca35e35` 迁移的契约 |

## 两个已登记的结构怪味 —— 复核其处置是否仍然成立

集成者当时记录了两处怪味并写明「本轮不重构」的理由。请核实**在当前合并态下该处置是否依然站得住**（行号是当时的，须重新定位）：

1. `response-processor.ts:88-96`（当时）——`input.onRenderedFrame ?? opts.onRenderedFrame` 的 callback 选择层级会**遮蔽外层 transform**。当时的修法是把「外层 transform → candidate classifier」在 driver 里组装成单一 callback，processor 只消费已组装的 opts。**请核实这个遮蔽形态没有在后续 46 个提交里以任何形式回归。**
2. `candidate-response-session.ts:169-187`（当时）——candidate session 同时承担 hook、外层 transform 与分类，编排密集；理由是 Task 4 才替换 owner 接线。

## 已作废的路子（不要建议回头走）

集成者已明确否掉下列方向，除非你能拿出推翻它的证据，否则不要把它们当作修复建议：

- 把 `ParsedSseFrame` 扁平化来回避 History 或 Task 3 consumer。
- 在 `response-processor` 恢复 `yield* finish.frames` 旁路，或删除 Task 3 的 `postRender` gate。
- 以 ID 值或对象形状推断 rewrite provenance（fresh rewrite 拥有自己的字段；same-value ID 合法但不继承 parser provenance）。
- 恢复第二个 classifier；提前删除 compatibility projection；提前做 Task 4 owner migration。

## 当时唯一未闭合的门

`bun run test:backend` 在集成者手上从未通过（记录里是 7 个失败 + 2 个 crashed shard，且 SIGUSR2 日志已被降级为进程内测试行为、不能用作退出码归因）。**该门由主会话在 `638f6f3c` 上重跑关闭，结果单独记录**；评审无需重复跑全量，但若你的取证与该结果冲突，请明确指出。

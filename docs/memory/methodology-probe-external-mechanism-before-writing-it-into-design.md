---
name: methodology-probe-external-mechanism-before-writing-it-into-design
description: 写设计时引用外部系统（SQLite/运行时/第三方库）的具体机制，必须先跑探针证实该机制存在且行为如你所想——本会话凭印象连犯三次同型错误
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d47f5188-e871-4ab0-a58a-82fc0713e57f
  modified: 2026-07-28T12:08:11.231Z
---

写 spec/plan 时**引用外部系统的具体机制**（SQLite 语法与行为、运行时 API、第三方库能力），**必须先跑一次探针**再写进设计。凭印象写会产生「看起来专业、实则不存在」的机制，且**同一份文档里会反复犯**——因为错误来源是同一个：把「我记得大概是这样」当成事实。

**本会话的三次同型错误**（History 读路径 spec，v1→v3 各一次）：

1. **`PRAGMA table_info` 探测 generated column** —— 写进迁移的幂等性设计。实测：`table_info` **不返回** VIRTUAL generated column，只有 `table_xinfo` 返回（`hidden=2`）。后果是第二次 `ADD COLUMN` 报 `duplicate column name`，与「幂等」验收判据直接冲突。讽刺的是我自己的探针输出里早就显示了这个现象（列清单里没有 `session_id`），我没读出含义。
2. **查询计划判据写成一刀切「禁止 SCAN」** —— 犯了两次。第一次与物化表的正确计划矛盾（`SCAN v3_sessions USING INDEX` 是对的），改完第二次又与 exact count 矛盾（`COUNT(*)` 无谓词的正确计划就是 `SCAN t USING COVERING INDEX`）。
3. **「影子索引 + 一次原子 rename cutover」** —— 整个机制不存在。实测 `ALTER INDEX ix RENAME TO ix2` → `near "INDEX": syntax error`。SQLite 根本没有 `ALTER INDEX`。

**Why:** 外部系统的机制是**可在秒级证实的事实**，不是需要推理的判断。一次 `bun -e` 内存库探针就能定论的事情，凭印象写等于把可验证事实降级成猜测，然后让它承重——设计里越是关键的机制（迁移幂等、验收判据、cutover 原子性），越容易因为「听起来合理」而躲过自审。异模型 reviewer 逐条实测后全部推翻，说明这不是运气差，是方法缺陷。

**How to apply:**
- 设计文档里每出现一个**具体的外部机制名**（PRAGMA、ALTER 子句、某 API 的返回形状、某 flag 的效果），落笔前跑探针。SQLite 用 `bun -e` + `:memory:` 库，秒级。
- **查询计划类判据尤其危险**：不要写全局禁词（「无 SCAN」「无 temp B-tree」），要 per-query 列出**允许的 access path**——因为同一个关键词在不同查询里可能是正确计划。写之前把每条目标查询的 `EXPLAIN QUERY PLAN` 实际跑一遍，照抄输出。
- **自己的探针输出要读完**：本会话第 1 条的证据早就在我自己的输出里，我只用它确认了「能建索引」就略过了列清单的异常。
- 与 [[feedback-pass-null-clean-not-self-validating]] 互补：那条讲核实**他人/工具**的断言，这条讲核实**自己**写下的机制。与 skill `verifying-authoritative-claims`、`empirical-verification` 同族。
- 派 reviewer 时可以直接下指令：「把文档中所有涉及 <外部系统> 具体行为的断言挑出来逐条实测，别信我写的」——本会话这么做之后，最后一轮 12 条断言全部成立。

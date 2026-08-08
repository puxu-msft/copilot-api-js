---
name: feedback-one-authority-allows-contextual-restatement
description: 单一事实源是一个权威裁决来源，不是禁止多处完整描述；各语境可完整复述但必须引用同一权威来源
metadata:
  type: feedback
---

“单一事实源”表示同一事实、决策、契约或易变状态有一个明确的权威来源，负责冲突裁决与规范更新；**不表示该事实只能出现一次**。README、DESIGN、API 参考、skill、HANDOVER、KICKOFF 与 memory 面向不同读者，可以各自完整写出读者完成任务所需的解释，但必须命名或链接同一个权威来源，不得静默改变其含义。冲突时回到权威来源裁决并修正复述。

真正需要保持唯一的是**写入所有权**，不是解释文字的出现次数：类型由 owner 定义、消费方 re-export；明细账派生摘要；活跃进度从 progress 文件转交 HANDOVER 后只在 HANDOVER 继续更新。这些机制仍允许其他文档作带权威引用的完整解释。

**Why:** 2026-08-08 收尾时，我把“文档单一事实源”误读为“必须删除所有重复描述”，建议只让 `docs/request-pipeline.md` 保留完整契约、其他位置尽量只放指针。用户纠正：这样会让 README／skill／交接在自己的读者语境中不完整；正确目标是共享一个权威裁决来源，而不是把所有其他文档削成裸指针。

**How to apply:** 新增或更新复述时先写清权威来源；稳定且任务关键的内容可以完整复述，易变状态／数字附 snapshot、commit 或日期并纳入同一语义改动的同步检查。只有高 churn 信息无法可靠同步时，才把其易变部分缩成精确指针。全局权威规则是 user-rule `41-doc-mgmt` 的 `one-authority-allows-contextual-restatement`；项目增量见 `CLAUDE.md`“文档路由”。

**Related:** [[methodology-downgrading-a-gate-needs-a-reachable-trigger]]、[[methodology-time-base-errors-recur-name-the-clock]]

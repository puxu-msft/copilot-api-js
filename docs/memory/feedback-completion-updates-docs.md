---
name: feedback-completion-updates-docs
description: 完成纪律——任务收尾不只删过时 pending 记忆，还要把已落地的机制同步进常驻活文档，不留孤立 spec
metadata:
  type: feedback
---

任务**完成**时,doc-sync 是"完成"本身的一部分,不是可选收尾:
- 删掉已过时的 pending/计划类记忆(机制已落地,记忆里的"待做"已失真)。
- **更重要**:把已落地的机制**回填进常驻活文档**(docs/DESIGN.md、各模块设计文档、README、路由/配置表等)。
- 别留**孤立 spec**——设计文档描述了 A,代码实现成了 B,而文档没回填 B = 文档腐烂,后来者被误导。

**Why:** "代码改完但文档没同步"= **未完成**,不是另一项可延后的任务。这与"知识归类"([[feedback-knowledge-routing-docs-vs-memory]])是两件事:归类决定"写哪",本条强调"doc-sync 属于 done 的定义"。[[feedback_complete_root_cause_fix]] 要求**暂缓项**写满文档;本条对应**已完成项**——完成了就得让活文档反映现状。

**How to apply:** 收尾 checklist 加一项:"这次改的机制,有没有对应的常驻文档需要回填?" 有 → 改完才算 done。删 pending 记忆与更新活文档成对做。与 [[feedback-distill-lessons-at-boundaries]] 配套。

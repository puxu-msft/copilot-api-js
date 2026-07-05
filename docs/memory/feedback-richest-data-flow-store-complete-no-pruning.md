---
name: feedback-richest-data-flow-store-complete-no-pruning
description: richest-data-flow 后端每阶段数据必须完整存已归入 ADR 2026-07-05-richest-data-flow；见那里
metadata:
  type: feedback
---

**已归入 ADR `docs/decisions/2026-07-05-richest-data-flow.md`。** 钩子：数据以最丰富形式流动、使用决策交给末端；**后端存储必须完整**（永不为 DRY/YAGNI/无消费者/与另一腿字节相同裁剪数据模型），前端展示可选择性呈现；"无数据源"常是没接线该建非删。是本项目 always-on 原则（CLAUDE.md `richest-data-flow`）。对称面：合成帧须可辨识 [[feedback-synthetic-data-must-be-distinguishable-from-real]]。

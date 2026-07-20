---
name: feedback-synthetic-data-must-be-distinguishable-from-real
description: 注入真实流的合成帧必打可辨识标记已归入 ADR 2026-07-05-richest-data-flow；见那里
metadata:
  type: feedback
---

**已归入 ADR `docs/decisions/2026-07-05-richest-data-flow.md`（richest-data-flow 对称面）。** 钩子：注入真实数据流的合成帧（keepalive/占位/mock/降级）**必打可辨识标记**，否则伪装成真实数据、污染 history/log/UI 可观测性、把异常状态（上游沉默）掩盖成正常；上游轨绝不含合成物、合成物只进 forwarded 轨打标记。互补 [[feedback-richest-data-flow-store-complete-no-pruning]]。

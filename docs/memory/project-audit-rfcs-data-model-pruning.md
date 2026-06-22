---
name: project-audit-rfcs-data-model-pruning
description: 其他 RFC/设计可能也用 DRY/YAGNI 裁剪了数据模型（砍字段/删腿/no-consumer），需未来按 richest-data-flow"后端完整"原则全面审计修复
metadata:
  type: project
---

operator 指出（2026-06-22）：history-http-header-capture RFC 暴露的"用无消费者/重复裁剪数据模型"错误（见 [[feedback-richest-data-flow-store-complete-no-pruning]]）**可能在其他 RFC/已落地设计里也存在**，需在未来**全面审计修复**——凡因 DRY/YAGNI/无消费者删过字段、砍过 per-stage/per-attempt 记录、或把"无数据源"当删除理由（实为没接线）的，都要按 richest-data-flow"后端存储必须完整、前端选择性展示"重新评估、补齐。

**How to apply**：审计 `docs/rfc/` 全部 + 已落地的 observability/history/context 数据模型。初筛信号词（删/砍/无消费者/死代码/YAGNI/reserved for future use/never populated）命中的优先：observability-rewrite、response-pipeline/*、activity-detail-main-outline、upstream-stream-truncation-detection、anthropic-rewrite-reorg、pre-response-abort-handling、streaming-upstream-rst-buffered-retry、stale-reaper-cancellation。判据：某字段/腿/per-attempt 记录是否描述了一个**真实发生的可观测阶段**——若是，无论有无消费者都该完整存（前端可不展示）。区分"裁剪数据模型"（禁止）vs"收敛捕获机制/单一 owner"（允许）。这是 phase/会话边界的可复用待办，非本会话一次性任务。

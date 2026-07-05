---
name: pattern-extensible-telemetry-registry
description: 可扩展持久遥测 registry 框架三支柱已归入 skill telemetry-architecture 一节；见那里
metadata:
  type: project
---

**已归入 skill `telemetry-architecture`（一、registry 框架三支柱）。** 钩子：①提取下沉 sink 层、聚合叶子 type-light ②开放 counters bag + 泛型复制器=零持久版本 bump ③聚合后不可重算的因子拆最细（成本 per-token-type）。含 histogram count/sum 须同批观测、基数 cap per-store 独立解析两坑。权威设计 `docs/spec/operational-stats-and-lineage-removal.md`。相关 [[feedback-richest-data-flow-store-complete-no-pruning]]、[[feedback-pass-null-clean-not-self-validating]]。

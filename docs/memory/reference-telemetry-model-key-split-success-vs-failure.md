---
name: reference-telemetry-model-key-split-success-vs-failure
description: /api/status model 维度 key 成功/失败分裂已归入 skill telemetry-architecture 二节；见那里
metadata:
  type: reference
---

**已归入 skill `telemetry-architecture`（二、model 维度 key 成功/失败分裂）。** 钩子：成功腿 key=`outboundResponse.model`(规范名)、失败腿=`inboundRequest.model`(客户端别名)，直接 join `/models` 静默丢失败腿→双侧 `normalizeModelId` 归一 + `unmatched` 可见。`telemetry-dimensions.ts:110`。相关 [[feedback-richest-data-flow-store-complete-no-pruning]]。

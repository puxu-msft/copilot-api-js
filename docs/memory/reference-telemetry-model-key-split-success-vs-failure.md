---
name: reference-telemetry-model-key-split-success-vs-failure
description: /api/status 遥测 model 维度 key 成功/失败分裂——成功腿=规范名、失败腿=客户端别名；join 目录须双侧 normalizeModelId + unmatched 可见
metadata:
  type: reference
---

REFERENCE（实测确证）：`/api/status` 的 `requestTelemetry` model 维度 key **随成功/失败分裂**——`extract: (entry) => entry.outboundResponse?.model ?? entry.inboundRequest.model ?? "unknown"`（`src/lib/observability/telemetry-dimensions.ts:110`）。

- **成功腿** key = `outboundResponse.model` = `normalizeModelId(上游返回名)`（`request.ts` settle 处归一化，对齐 `/models` id；Claude 规范名可 join）。
- **失败腿**（上游 4xx/5xx，无 outboundResponse） key = `inboundRequest.model` = **客户端逐字别名**（`opus`、date 后缀 `claude-opus-4-8-20250514`、override 名）。
- `normalizeModelId`（`src/lib/models/resolver.ts`）**只归一化 Claude 版本号 pattern**（`claude-{family}-{major}-{minor}(-date)` → dot 形），非 Claude / 老式 `claude-3.x-sonnet`（数字在族名前）/ 大小写变体 **原样返回**。

**后果**：同一逻辑模型的成功与失败遥测落在**不同 key**；直接按 `model.id` join `/models` 目录会**静默丢失失败腿计数 + 别名遥测**（failure 系统性偏低）。

**正解**（`ui/src/composables/model-telemetry-join.ts` 的 `buildModelTelemetryIndex`）：telemetry key 与 `model.id` **双侧都过 `normalizeModelId`** 再匹配，归一到同值的成功+失败腿聚合合并（平均时延用 total/count 重算）；归一后仍无 catalog 匹配的行进 **`unmatched` 列表可见呈现**（richest-data-flow，绝不静默丢弃）。测试用 date-suffix 正样本钉死（`ui/tests/model-telemetry-join.test.ts`），否则 `VERSIONED_RE` 改动会静默破坏合并。

设计与失配形态清单见 [spec/2026-07-05-ui-v4-models-enhancement.md](../spec/2026-07-05-ui-v4-models-enhancement.md) §4.2。任何消费 `/api/status` 或 `/api/stats?dimension=model` 遥测并要 join 目录的工作都会踩此坑。相关：[[feedback-richest-data-flow-store-complete-no-pruning]]（unmatched 可见即"无数据源常是没接线非真无源"的对称面）。

---
name: methodology-content-addressed-normalization-boundary-strip
description: 内容寻址哈希归一化方法论已归入 skill history-sqlite-schema 内容寻址归一化节；见那里
metadata:
  type: project
---

**已归入 skill `history-sqlite-schema`（内容寻址归一化 search_index 去重）。** 钩子：①config-无关 canonical 投影（绝不复用 config 清洗、递归剥 `cache_control`）②剥样板用 own-line 边界锚定正则、**容 `\r`**（全局 `<tag>.*</tag>` 误删 inline 字面提及）③易变清单靠真实数据实测枚举 ④测试独立 oracle。`src/lib/history/normalize-message.ts`。相关 [[methodology-recoverable-backfill-cooperative-stop-and-keyset]]。

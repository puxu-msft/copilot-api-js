---
name: methodology-record-signals-at-committed-outcome-not-per-attempt
description: buffered-retry 信号须在 committed settle 点记录已归入 skill persistence-async-invariants §3；见那里
metadata:
  type: project
---

**已归入 skill `persistence-async-invariants` §3（buffered-retry 信号在 committed settle 点记录）。** 钩子：L2 buffered-retry 让 S5 逐 attempt 重跑，闭包内 eager 记录被丢弃尝试污染（set-once 标志永不清 / 计数器膨胀）；正解 per-attempt 累积（`ctx.repairOutcomes`）+ `onAttemptReset` 清空 + committed 点一次 flush。**不丢 ≠ 不清**。

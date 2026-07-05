---
name: methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit
description: 给分类联合加新变体且被多站点消费时——路由到既有下游 outcome 复用全 handler + 穷尽 Record<Union,_> 让编译器枚举每个必改站点
metadata:
  type: feedback
---

给一个**被多站点消费的分类联合**（`StreamErrorKind`、provenance 枚举等）加新变体时，两个手段把"逐站点改+容易漏"压成"近乎免费+编译器强制全覆盖"（2026-06 实证：reaper-cancel 要在全 6 个 handler settled-abort 站点发 error 帧）：

- **路由新变体到既有下游 outcome、复用全部消费者**：不新增 outcome kind（那才要逐站点加分支），让新变体经既有分流落进**已有 outcome**。实例：`classifyStreamError` 加 `reaper-cancel` kind，driver `runResponseSink` 只把 `client-abort`→`settled-abort`、其余一律 `stream-error`，故 `reaper-cancel` 自动走 `stream-error`、全 6 站点既有发 error 帧路径零改动接住。先读下游分流找"默认落进哪个既有 outcome"往那对齐。
- **穷尽 `Record<Union, _>` 当站点审计**：联合加成员后所有 `Record<TheUnion, X>`（各格式 kind→错误映射）立即编译报错缺该 key→`tsc` 一遍即得全部必改点、零漏站。配套：`switch` 带 `default` 不强制穷尽，要靠 Record 或 `satisfies`/never-check 才有编译保证。

是 [[feedback-fix-all-comparison-sites]]（多比较点逐处修）的正向版：与其修后逐处找，不如用类型系统前置逼出全站点。

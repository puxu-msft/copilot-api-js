---
name: methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit
description: 给分类联合加新变体且被多站点消费时——路由到既有下游 outcome 复用全部 handler、靠穷尽 Record<Union,_> 让编译器枚举每个必改站点
metadata:
  type: feedback
---

给一个**被多个站点消费的分类联合**（`StreamErrorKind`、provenance 枚举、错误 kind 等）加新变体时，有两个手段把"逐站点改 + 容易漏"压成"近乎免费 + 编译器强制全覆盖"。2026-06 实证：④ reaper 装牙齿要让一个新的 reaper-cancel 来源在全 6 个 handler settled-abort 站点发 error 帧。

**Why**：reviewer 估计要逐站点改 6 处（含 Responses HTTP+WS 两独立站点），手工枚举高漏率。实际两手段把它压没了。

**How to apply**：
- **路由新变体到既有下游 outcome 复用全部消费者**：不新增一个 outcome kind（那才要逐站点加分支），而是让新变体经既有分流落进**已有的 outcome**。④ 实例:`classifyStreamError` 加 `reaper-cancel` kind，而 driver `runResponseSink` 只把 `client-abort`→`settled-abort`、**其余一律 `stream-error`**——故 `reaper-cancel`(≠client-abort)**自动**走 `stream-error`，全 6 站点既有 H3(发 error 帧)路径零改动接住。先读下游分流逻辑找"默认落进哪个既有 outcome",往那个 outcome 对齐,比加新 outcome 省掉 N 站点。
- **穷尽 `Record<Union, _>` 当站点审计**：联合加成员后,所有 `Record<TheUnion, X>`(各格式的 kind→错误类型/消息映射等)**立即编译报错缺该 key**——TS 穷尽性把"哪些站点必须处理新变体"变成编译器枚举的事实清单,`tsc` 跑一遍即得全部必改点,**无需手工 grep 枚举、零漏站**。这是"类型即站点覆盖证明"。配套:`switch` 带 `default` 不强制穷尽(漏不报错),要靠 Record 或 `satisfies`/never-exhaustive-check 才有编译保证。

是 [[feedback-fix-all-comparison-sites]](多比较点逐处修)的正向版:与其修后逐处找,不如用类型系统**前置**逼出全部站点 + 用既有 outcome 复用免改。也呼应 best-complete-solution(用既有正确原语、不加冗余表面——同会话 C3b-pre2 发现 `sink.write` 已够就不加 `emitPingOnAttach`)。

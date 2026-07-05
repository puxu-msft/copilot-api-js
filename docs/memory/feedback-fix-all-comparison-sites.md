---
name: feedback-fix-all-comparison-sites
description: 归一化键/id 粒度类 bug 常在多处比较点复发——grep 全仓逐处修，最好抽单一共享 primitive
metadata:
  type: feedback
---

根因是"键/id/粒度归一化不一致"（canonicalization、prefix、大小写、trim、`call_`/`fc_` 前缀转换）的 bug **几乎总在多个比较点复发**——同一归一化假设分散在 N 处 `===`/`Map.has`/`Set`/查表，修了最显眼那处不等于修好，下次换条路径又复发。是 CLAUDE.md `architecture-health-first` "refactor to shared primitive" 在**比较点**场景的实例（本项目三套兼容层 id/key 互转、prefix-hash 归一高发）。

**How**：定位归一化 bug 后 **grep 全仓**找所有对同类键/id 做比较或查表的点、逐处核对是否都用一致归一化；最优解=归一化抽单一 primitive、所有比较点过它。grep 真扫全用正向对照（[[feedback-pass-null-clean-not-self-validating]]，空命中≠扫净）。正向版（类型系统前置逼出全站点、免逐处找）见 [[methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit]]。

---
name: feedback-fix-all-comparison-sites
description: 归一化键/id 粒度类 bug 常在多处比较点复发——grep 全仓逐处修，最好抽单一共享 primitive；且 grep 共享 primitive 有盲区（分叉源腿如 Gemini 流式漏捉，靠合并态审查逮）
metadata:
  type: feedback
---

根因是"键/id/粒度归一化不一致"（canonicalization、prefix、大小写、trim、`call_`/`fc_` 前缀转换）的 bug **几乎总在多个比较点复发**——同一归一化假设分散在 N 处 `===`/`Map.has`/`Set`/查表，修了最显眼那处不等于修好，下次换条路径又复发。是 CLAUDE.md `architecture-health-first` "refactor to shared primitive" 在**比较点**场景的实例（本项目三套兼容层 id/key 互转、prefix-hash 归一高发）。

**How**：定位归一化 bug 后 **grep 全仓**找所有对同类键/id 做比较或查表的点、逐处核对是否都用一致归一化；最优解=归一化抽单一 primitive、所有比较点过它。grep 真扫全用正向对照（[[feedback-pass-null-clean-not-self-validating]]，空命中≠扫净）。正向版（类型系统前置逼出全站点、免逐处找）见 [[methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit]]。

**盲区：grep 共享 primitive 会漏「分叉源」腿**（2026-07-12 ghc-usage-details 实例）。给「所有腿」加一个横切字段时，grep 那个共享构建函数（`usageFromTotalInput`）看似逼出全站点（找到约 11 处），但**某条腿用的是分叉的源函数**就不在命中里：Gemini **流式**腿的 4 个 settle 点走 `geminiUsageFromMeta`（读 Gemini 原生 `usageMetadata`），从不调 `usageFromTotalInput`——故 grep 主 primitive 静默漏掉它，cache_write 在该腿丢失。**逮住它的是合并态 subagent 审查**（对照 spec「承诺覆盖哪些腿」逐腿核实），不是 grep。教训：① 枚举「腿/格式/端点」这个**业务维度**，逐腿确认字段落地，别只信「grep 到了 primitive 的全部调用点」；② 分叉源腿常见于 Gemini（经 CC 翻译、有独立 usageMetadata 通路）——横切改 usage/token 时**显式点名 4 腿**（chat/responses/ws + gemini 流式与非流式各异）。承重放大器：若该腿又有 born-marking（`cache_write_backfilled=1`）之类「已处理」标记，漏捉会变**永久不可恢复**，双重损失。→ 合并态审查价值见 user-rule `40` `review-merged-state`。

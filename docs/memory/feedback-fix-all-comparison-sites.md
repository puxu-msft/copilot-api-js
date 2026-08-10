---
name: feedback-fix-all-comparison-sites
description: 归一化键/id 粒度类 bug 常在多处比较点复发——grep 全仓逐处修，最好抽单一共享 primitive；且 grep 共享 primitive 有盲区（分叉源腿如 Gemini 流式漏捉，靠合并态审查逮）
metadata:
  type: feedback
---

根因是"键/id/粒度归一化不一致"（canonicalization、prefix、大小写、trim、`call_`/`fc_` 前缀转换）的 bug **几乎总在多个比较点复发**——同一归一化假设分散在 N 处 `===`/`Map.has`/`Set`/查表，修了最显眼那处不等于修好，下次换条路径又复发。是 CLAUDE.md `architecture-health-first` "refactor to shared primitive" 在**比较点**场景的实例（本项目三套兼容层 id/key 互转、prefix-hash 归一高发）。

**How**：定位归一化 bug 后 **grep 全仓**找所有对同类键/id 做比较或查表的点、逐处核对是否都用一致归一化；最优解=归一化抽单一 primitive、所有比较点过它。grep 真扫全用正向对照（[[feedback-pass-null-clean-not-self-validating]]，空命中≠扫净）。正向版（类型系统前置逼出全站点、免逐处找）见 [[methodology-route-variant-to-existing-outcome-and-exhaustive-record-audit]]。

**盲区：grep 共享 primitive 会漏「分叉源」腿**（2026-07-12 ghc-usage-details 实例）。给「所有腿」加一个横切字段时，grep 那个共享构建函数（`usageFromTotalInput`）看似逼出全站点（找到约 11 处），但**某条腿用的是分叉的源函数**就不在命中里：Gemini **流式**腿的 4 个 settle 点走 `geminiUsageFromMeta`（读 Gemini 原生 `usageMetadata`），从不调 `usageFromTotalInput`——故 grep 主 primitive 静默漏掉它，cache_write 在该腿丢失。**逮住它的是合并态 subagent 审查**（对照 spec「承诺覆盖哪些腿」逐腿核实），不是 grep。教训：① 枚举「腿/格式/端点」这个**业务维度**，逐腿确认字段落地，别只信「grep 到了 primitive 的全部调用点」；② 分叉源腿常见于 Gemini（经 CC 翻译、有独立 usageMetadata 通路）——横切改 usage/token 时**显式点名 4 腿**（chat/responses/ws + gemini 流式与非流式各异）。承重放大器：若该腿又有 born-marking（`cache_write_backfilled=1`）之类「已处理」标记，漏捉会变**永久不可恢复**，双重损失。→ 合并态审查价值见 user-rule `40` `review-merged-state`。

**同构第二例（2026-08-09，Task 37 H2 error 帧）——这次漏的不是「分叉源」，是「同一动作的另外几个入口」。** 缺陷形态：判定「这帧是不是 Anthropic `error`」的地方各自只读 payload 顶层 `type`，而 raw error 帧只在 SSE `event:` 行上标识自己。我按拼写 grep（`=== "error"`、`accumulateAnthropicStreamEvent(` 的调用点）枚举出 **7 处**并宣称完整；独立评审又找出 **5 处**——三个 reverse Messages accumulator 入口（Responses／Chat／Gemini，形状是 `accumulateAnthropicStreamEvent(JSON.parse(raw.data) as never, …)`）和两个 Anthropic translator（`anthropic-to-responses-stream` / `anthropic-to-cc-stream`，形状是 `event = JSON.parse(ev.data)` 后 `switch (event.type)`）。**它们全都在我早先某次 grep 的输出里出现过，我没接着做。**

**这一例把教训收窄成一句可执行的**：**grep 枚举的是「共享同一拼写的位置」，不是「共享同一错误的位置」。** 同一个语义动作可以有若干个各自手写的入口，它们连函数名都不同——上例是「喂给累加器」这个动作有六个入口、「把 SSE 帧解析成 StreamEvent」这个动作有八个。**判据**：别问「这个符号被调用了几次」，问「**这件事在系统里被独立做了几次**」，然后按业务维度（腿／格式／端点／翻译方向）逐个点名核实。修法仍是抽单一 primitive，但**入口清单必须由业务维度而非符号引用给出**。

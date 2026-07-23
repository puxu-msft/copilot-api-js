---
name: methodology-lying-variable-name-dual-source-value
description: 变量名断言单一身份、值却取自会撒谎的源（原始 vs 已变换）→ 名实不符是 bug 复发温床；根治=抽单一原语+命名反映真实来源+单一抑制权
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 53d72f7f-380e-429b-9caf-cf435d0e47e7
  modified: 2026-07-23T07:39:21.947Z
---

**变量名断言了它是什么，值却取自一个「会撒谎」的源——这种名实不符是同类 bug 反复复发的温床。**

实例（2026-07-23，codec model-resolution 重构）：四个入站 codec 各自内联 `const clientModel = raw.modelOverride ?? incoming.model`。名字叫 `clientModel`（断言「客户端原始模型名」），但在 anthropic `/v1/messages` 路径上 `incoming.model` 已被 handler **预解析**成 resolved 名（handler 传 `body: wireBody`，model 已改），于是 `clientModel === resolvedName` 恒成立、`clientModelName` 恒 `undefined`、`ctx.clientModel` 从不设置 → TUI 完成日志行/detail 不显示重映射 `sonnet → claude-sonnet-5`。其他三条路径（cc/responses/gemini 传原始 body）碰巧对——**"碰巧对"不是被强制的不变量，是复发温床**：哪天有人为对称让 cc handler 也预解析，同一 bug 静默重现。同一层还有个孪生：translate 层字段 `clientModel` 实际持 resolved 名（`resolvedModelName || env.body.model`），又一处名实不符。

**Why**：同一个概念有**多个候选源**（原始 body vs 已变换 wire body vs resolved target），源之间在部分路径上恰好相等、部分路径上分叉。变量名只能断言一个身份，一旦取自「在某路径会变成另一个东西」的源，名字就撒谎了；而单测常直接注入这个字段（绕过接线），让显示逻辑假绿、把 bug 藏到集成缝。

**How to apply**：
- 闻到「名实可能不符」立刻按 [[feedback-never-paper-over-smells-warn-loudly]] 停下核实——追值的**真实来源**是否与名字断言一致，别被 JSDoc/注释背书（本例 cc codec 注释 `// client's original` 只在它不预解析时才真）。
- 根治三件套（正中 [[feedback-fix-all-comparison-sites]] 抽共享 primitive + [[methodology-full-primitive-not-partial-else-silent-field-drop]]）：① 抽**单一原语**集中派生逻辑，把「原始名只从原始源取、绝不从已变换源取」这条规则写在一处，四路径全调它；② **命名反映真实来源**（`requestedModel` 真原始 vs `resolvedName` 已解析 vs 观测层 `clientModel`），杜绝一个名字骑两身份；③ **单一抑制/判定权**（本例 `isSameModelName` 作唯一「是否真重映射」判据，别让 codec 用 `!==`、显示层用 `isSameModelName` 两套语义漂移）。
- **独立 oracle 锁接线缝**：显示单测直接注入字段会假绿，必须补「真实 codec.parse → 持久化产物（history `requested`/`clientRequest.model`，读一个**区别于**原语返回值的源）」的端到端断言，并用[[feedback-pass-null-clean-not-self-validating|正样本证伪]]（对旧代码跑，确认 `Received: null` 才信）。

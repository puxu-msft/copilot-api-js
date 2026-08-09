---
name: feedback-domain-knowledge-belongs-in-skills-not-always-on-rules
description: 现存 always-on rules 里有相当一部分其实是领域知识，只因当初没意识到才写进规则；正确归属是内聚的 skill，规则里只留引用
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5cbe8f72-b4ad-4b37-8a03-2bfe84487e37
  modified: 2026-08-09T01:43:49.036Z
---

用户 2026-08-09 明确：**`~/.claude/rules/` 里现存的部分内容虽然是 always-on rules，但那只是因为当初用户没有意识到——它本质是领域知识，更适合成为内聚的 skill，由规则引用。**

**Why:** always-on rules 每次会话都进上下文，容量有限且彼此竞争注意力；而领域知识的特征是**篇幅长、带案例、只在特定情境下需要**（`62-docs-and-handover` 的 `reread-docs-after-writing` / `replacement-must-cover-what-it-restates`、`63-engineering-practice` 的变异测试恢复协议、`64-concurrency-and-refactor` 的重构陷阱都是这个形态：每条都带完整实证与操作步骤）。把它们常驻，既挤占了真正需要常驻的判据，又因为不在情境中而召不回具体做法。**「当初写成规则」不构成它现在该留在规则里的理由**——那是认知的产物，不是裁决。

**How to apply:**
- 遇到某条 rule 内容明显是「某个情境下的完整方法论」（有触发情境、有步骤、有实证案例）时，**主动提议把它下沉成 skill**，规则里保留一条带触发词的短引用。不要自行搬迁——归属变更影响所有项目，属 B 级，须交未卷入第三方评审并让用户拍板。
- 反向也成立：**判据式、无情境、必须每次都成立的东西**（`user-prompt-first`、`never-push`、`no-accidental-data-loss`）留在 rules，不要下沉——下沉等于让它在没被召回时失效。
- 分界句：**它是「无论在做什么都要成立的判据」，还是「做某类事时才需要的做法」？** 前者留 rules，后者进 skill。
- 新写指令文本时按同一分界选归属，别默认往 rules 里加。

**Related:** [[feedback-one-authority-allows-contextual-restatement]]（规则引用 skill 不违反单一权威——权威在 skill，规则里是带触发词的引用而非复述）、[[feedback-skill-claims-needing-field-proof-must-self-verify]]（下沉后的 skill 仍须自带自验表）。

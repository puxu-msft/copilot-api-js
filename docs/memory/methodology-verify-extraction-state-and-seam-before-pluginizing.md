---
name: methodology-verify-extraction-state-and-seam-before-pluginizing
description: 「把功能剥离成 hook/可插拔单元」前先核实现状抽取程度 + 缝位(pre- vs post-translation)
metadata:
  type: project
---

用户提「把更多功能从核心剥离、形成 hook/可插拔单元」这类**复现型**请求时,动工前必先核实两件事,否则会提议重做已完成的工作、或把行为放错缝。

**Why:** 2026-07-21 一次「入站 system-prompt / preprocess 剥离」探索,初版 spec 提议剥进 S3 `rewrite-registry`,经 GPT reviewer 三轮对抗审逐层证伪:① **缝位错**——两个行为都是 pre-translation 关切,而 rewrite-registry 是 post-translation(翻译在 S2、早于 S3);② **现状核查**——`preprocessAnthropicMessages`、`processAnthropicSystem`/`processOpenAIMessages`/`processResponsesInstructions` **本就已经是提取好的 per-format 纯函数**、各 codec 已各自调用,「剥成纯函数」基本已完成;③ v2 又发明了「InboundUnit 平行 registry」(N=1 成员、无接入机制)和「S0 driver 缝」(parse 是 runRequest 首行、preprocess 在 route 层、根本无此缝)——都是过度设计/虚构缝。最终 v3 收窄成一个薄增量(格式分发函数统一三处调用)。

**How to apply:**
- **先核实现状抽取程度**:grep 目标行为是否已是独立函数/已注册单元,别把「已经是函数」的东西重复包装成「可插拔」。
- **先核实缝位**:pre-translation(parse/S1b 前后、操作客户端原生 body)绝不放进 post-translation registry(S3、操作已翻译的上游 body);翻译发生在 S2,是分水岭。
- **N=1 别造 registry**:只有一个成员时,`order`/`appliesTo`/driver 编排是空转复杂度——用共享纯函数 + 显式调用,registry 化等真有 N>1 且需跨点组合排序再说(但用户明确要「建向可插拔」时,单一分发入口是合理折中,见本次 v3)。
- **别虚构 driver 缝**:parse 是 `runRequest`/`inspectRequest` 首行,route 层 pre-parse 代码不在 driver 编排范围,别把它画进阶段序列图当 driver 单元。
- **真正最大的未插件化区在 retry 策略**(接缝② 16 策略、跨 attempt 决策),不是入站侧——见 `docs/todo/deferred-backlog.md`「retry 策略可插拔化」。
- 权威:spec `docs/spec/2026-07-20-inbound-system-prompt-dispatch-hook.md`(§0 演进日志逐版记了 v1→v3 被证伪的点)。关联 [[feedback-verify-named-target-resolves-before-large-work]]、[[feedback-existing-code-has-no-authority-dont-accommodate]]。

---
name: feedback-main-thread-impl-subagent-verify
description: 实现自己在主线做(紧控制)，subagent 用于密集独立核验而非外包实现；大阶段主线继续、上下文预算自己管
metadata:
  type: feedback
---

默认分工:**实现自己在主线做**(保持紧控制、连续上下文),**subagent 用作密集的独立核验层**(审查、对抗复核、探针),而**不是把实现外包**出去。一个大阶段在主线持续推进即可,不必为"省上下文"把实现拆给 executor subagent——上下文预算自己管理。

**Why:** 主线实现 = 对代码的连续掌控 + 即时纠错;subagent 的价值在"独立视角核验"(见 skill `empirical-verification`),把实现本身外包反而丢失连续上下文、增加来回对齐成本。这 refine 了"executor subagent → reviewer subagent"的旧模型:执行留主线,验收靠 subagent。

**How to apply:** 实现自己写;每完成一步随时拉 subagent 做独立核验(不设次数上限)。只有当任务**天然可并行且互不依赖**时才考虑把整块分派 subagent(见 CLAUDE.md `no-premature-stop` 的并行场景)。与 skill `empirical-verification` 配套:那条管"如何核验",本条管"谁来实现"。

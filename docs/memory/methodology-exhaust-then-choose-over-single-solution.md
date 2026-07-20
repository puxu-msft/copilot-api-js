---
name: methodology-exhaust-then-choose-over-single-solution
description: 面对「找方法/可行性」类任务，穷举可行方案面 + 实测 + 对抗评审再择优，而非找到一个能跑的就上；每次「感觉可以了」都要被下一层验证否掉
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1a1428a4-9c8e-4a9d-98f3-08d5bf495030
---

用户在本项目一次「找到让客户端主动重试的方法」任务中，看我给出**一个**验证扎实的方案后追问：「你是找到了一种方案，还是穷尽了可能的方案、编写可行性穷举文档后选择了最好的？」——这是承重的工作方式纠正。

**Why:** 找到一个能跑的方案 ≠ 找到最好的方案。单点方案常建立在**半对的推断**上：本例「post-commit relabel overloaded 触发 CC 重试」只对了一半（实测发现窗口窄到「第一个 content_block_stop 之前」，真实 thinking 流一旦完成任何块即关窗）。穷举才暴露出机制其实有**四层**（SDK pre-200 / inner streaming / outer lvo / onError 请求变异），单点只切了一片。对齐 user-rule `60` `poc-if-unclear` + `record-not-adopted` + 项目 `best-complete-solution`。

**How to apply:** 「找方法/可行性」类任务按此流水线，别跳步：
1. **穷举可行方案面**（不是找到一个就停）——offload 给并行 subagent 分层/分区穷举，带显式「穷尽非挑重点」裁判轴（否则 agent 默认 YAGNI 只报「重点」）。
2. **实测 supersede 源码推断**——搭最小 oracle 亲手证（本例 fake Anthropic server + 真 CC 客户端数重发次数），实测与源码冲突处以实测为准；每个「意外结果」连跑确认确定性。正样本对照先证 harness 能抓到坏行为再信绿。
3. **对抗评审**——异模型 subagent 读源码核我的综合是否失真/有共同盲点；评审的绝对断言（file:line）**亲自核实**再采纳（本例评审说的 sawUpstreamError=commit-not-retry，我 grep 核实行号错但语义真）。
4. **写可行性穷举文档**（`exp/<topic>/FINDINGS.md` 源码推断 + `REPORT.md` 实测，冲突处横幅指向 REPORT），**据完整地图择优**，再与用户对齐。
5. **每次「感觉可以了」都被下一层否掉**是常态、是好事：单点方案 → 穷举推翻两处源码推断 → 对抗评审抓架构级 BLOCK → 补实测证明备选修法也受同一根因约束 → 收敛到最干净方案。

关联：验证簇 [[feedback-pass-null-clean-not-self-validating]]（结论不自证）；实测 harness 见 skill `empirical-verification` / `client-proxy-e2e-testing`；子代理经济 [[feedback-tier-subagent-review-skip-for-mechanical-micro-changes]]（但本例是高风险大特性、该重投评审）。

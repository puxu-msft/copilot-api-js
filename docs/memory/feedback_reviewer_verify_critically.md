---
name: feedback_reviewer_verify_critically
description: "交付/ExitPlanMode/报告任何重大产出前主动派 subagent audit(不等用户提醒、连改记忆/翻译这种琐碎也审、看似简单的改动同样过一轮);且不信任何声音权威——subagent/reviewer/文档/记忆/自洽/自己都可能错,行动前读它引用的每个 file:line、用独立实测裁决而非判断谁更对。通用裁决手法见 skill verifying-authoritative-claims、always-on 原则见 CLAUDE.md empirical-verification+subagent-explicit-rubric"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcf9fafe-25b3-479f-89db-3ebb825f8394
---

本条只留**主动时机 + 项目实证案例**；通用裁决手法已上行 skill [[verifying-authoritative-claims]]，always-on 原则在 CLAUDE.md `empirical-verification`+`subagent-explicit-rubric`。

**主动时机（用户认可的工作方法，主动发起不等催）：** executor → reviewer 验收 → 主线再 sanity check；**且任何重大产出（计划/设计/命名）在 ExitPlanMode/交付/报告前就主动跑一轮 subagent audit**，把发现回填再请批准——用户曾在 ExitPlanMode 时拦下追问"是否做过 audit"，说明默认先审再交付而非被催才补。**门槛不设下限**："太小不值得审"要抵制，连翻译/改记忆这种琐碎也不跳，看似简单的改动同样过一轮（简单改动的回归正因没人审才漏）。subagent 报告本身也是声音权威，**行动前读它引用的每个 file:line**，绝不整份信任照搬。

**项目实证（反复踩的坑，知道往哪查）：**
- Executor 误判："0 个消费者"实有 3 个；bugfix subagent 跑 3 次声称修好 flaky，独立连跑 12 次抓出 3 次失败。
- Reviewer 误判：基于不全 grep / 设计意图偏差；或基于**过时文档**——曾提 CRITICAL"Bun 不支持 fake timers"，最小探针验证 bun 1.3.8 实际支持，推翻该 CRITICAL。
- **Reviewer "我亲测了"但喂合成样本**：审 spec 时 reviewer 跑 `jsonrepair` 得 CRITICAL"修成合法但语义改坏"，但它测的是**自己捏造的** `{"q":"\\\\u67b6"}`；主线用**真实 history 字节**（entry `req_1782740067043_965`）复跑证明 jsonrepair 正确补 `]}`、中文语义保真→推翻该 CRITICAL（同会话另 3 个 CRITICAL 复跑全确认）。教训：声音权威的"empirical demo"也是声音权威，**先查它测的是真实工件还是合成代理**——empirical≠可信若输入失真；用真实样本（history sqlite 原始字节）复跑才裁决。
- 逐条核 subagent 抓真 bug：commit 审计标"main.ts 与 ConsoleSink double consola hijack"，`grep -n setReporters` 确认 `initConsolaReporter()`+新加 `attachConsoleSink` 都调 setReporters → 真问题，`hijackConsola:false` 修；没查验就会当"过度警惕"跳过。
- 第一个 review agent 把 rate_limiter 单位换算判"识别了但低估"，第二个 agent 才挖出 `recoveryTimeoutMinutes`+`DEFAULT_CONFIG` 双默认值全链路——**必要时发起任意多次新 subagent 交叉核实，次数不设上限**。
- 连 subagent"跑了 20 次全过"也自复跑 25 次才采信。

**推论 + 价值观冲突：** 依赖随机+真实时序的测试，fake timers+mock 随机源是正确根因修复不是症状掩盖。reviewer 默认持 ROI/YAGNI，与本项目"长远正确+完整"冲突，其"可安全删除/无影响/无消费者"结论尤其要对照本项目裁判轴复核（"无消费者"常是没接线非真无源，该建而非删）。报告标注每条是"经我复核 confirmed"还是"仅 reviewer 声称"。

关联：[[feedback_real_problems_over_risk]]、[[feedback_complete_root_cause_fix]]、[[feedback_no_unilateral_action]]、[[feedback-pass-null-clean-not-self-validating]]、[[feedback-mine-the-pass-with-warn]]、[[feedback-self-consistent-needs-independent-oracle]]

---
name: feedback_reviewer_verify_critically
description: "在 ExitPlanMode 或交付任何重大产出（计划/设计/命名）前，主动发起一轮 subagent audit/review——不等用户提醒。且不要信任任何「声音权威」（executor、reviewer、文档、记忆）：每条主张都用独立实测裁决——flaky 测试连跑 10–25 次、文档与观测冲突时写探针、对照代码事实复核绝对断言"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcf9fafe-25b3-479f-89db-3ebb825f8394
---

每次让 subagent 执行修复后，**以及任何计划/重大产出在请求用户批准前（ExitPlanMode 之前）**，**必须主动**再让另一个 subagent 做 audit/review——这是用户认可的工作方法，且必须**主动发起，不等用户提醒**（用户曾在 ExitPlanMode 时拦下追问"是否做过 subagent audit/review"，说明默认就该先审再交付，而非把审查当成被催才补的步骤）。但同样重要：**没有任何一方的"声称"是终审判决**。executor、reviewer、文档、记忆都是"声音权威"，都可能错。裁决手段必须是**独立实测/事实核对**，而非再推理或信任声明本身。可信度排序：**亲手实测 > 文档推断 > 单方声称**。

**Why:** 同一主题反复踩坑：
- Executor 误判（"0 个消费者"实际有 3 个；bugfix subagent 只跑 3 次就声称修好 flaky，独立连跑 12 次抓出 3 次失败）。
- Reviewer 误判（基于不全的 grep、对设计意图理解偏差；或基于**过时文档**——曾提 CRITICAL"Bun 不支持 fake timers"，写最小探针验证 bun 1.3.8 实际支持，推翻该 CRITICAL）。
- 连 subagent 的"跑了 20 次全过"统计也自己复跑 25 次才采信。
两个 subagent、一份文档都是声音权威；以事实而非声音权威为依据（[[feedback_no_unilateral_action]]、[[feedback_real_problems_over_risk]] 同此精神）。

**How to apply:**
1. **闭环 + 主动时机**：executor → reviewer 验收 → **主线 agent 再做 sanity check**，核对 reviewer 的关键结论是否与代码/实测事实一致，特别是"无消费者""无影响""可安全删除""已通过""不支持"等绝对断言。不因为有了 reviewer 步骤就跳过主线判断责任。**时机不限于代码修复后**——计划、设计、命名方案等任何重大产出，在 ExitPlanMode / 交付前就**主动**跑一轮 subagent audit，把发现回填修订再请批准；不要写完直接 ExitPlanMode 等用户来问。**门槛不设下限**——"这改动太小,不值得审"是要抵制的合理化;**看似简单的改动同样过一轮**(简单改动的回归往往正因没人审才漏)。本条吸收了"review-before-reporting"(完成/报告/实施前都派独立对抗复审,连翻译/改记忆这种琐碎也不跳),不再单列。与 [[feedback-pass-null-clean-not-self-validating]] 互补:那条防"信 pass/empty 的假阴性",本条防"因小而跳过审"。
2. **裁决用实测,不用再推理**：
   - **subagent 回应逐条分析、不可跳过**：它的每条发现都要读懂并批判核实——subagent 也会误判/低估（如本次第一个 review agent 把 rate_limiter 单位换算判为"识别了但低估"，第二个 agent 才挖出内部字段 `recoveryTimeoutMinutes` + `DEFAULT_CONFIG` 双默认值的完整链路）。既不盲信也不甩手跳过；**必要时发起任意多次新 subagent 交叉核实，次数不设上限**，直到事实清楚。
   - 核对代码事实（grep/读实际代码），不信"我觉得"。
   - reviewer 提 CRITICAL 或事实主张且与你的观测冲突 → **写最小探针实测裁决**，不陷入"谁推理得更对"。
   - flaky/时序测试 → **连跑 10–25 次**确认确定性（跑 3 次碰巧全过 ≠ 修好）。
   - 环境能力主张（"X 不支持 Y"/"版本不够"）→ 永远探针验证，文档可能过时或版本不符。
3. **报告标注**：reviewer 的判断是"经我复核 confirmed"还是"仅 reviewer 声明"。
4. **冲突处理**：executor 与 reviewer 冲突时（如 "0 消费者" vs 实际 3 个）明确告知用户冲突点。
5. **推论**：依赖随机性+真实时序的测试，fake timers + mock 随机源是**正确的根因修复**（消除随机/真实时钟依赖），不是"症状掩盖"——别被"看起来像绕过"的直觉误导。

关联：[[feedback_real_problems_over_risk]]、[[feedback_complete_root_cause_fix]]、[[feedback_no_unilateral_action]]

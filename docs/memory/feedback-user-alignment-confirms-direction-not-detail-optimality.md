---
name: feedback-user-alignment-confirms-direction-not-detail-optimality
description: 跟用户逐节对齐只证明方向对、不证明细节最优，落盘 spec 前仍须过异模型对抗审查
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2d448603-e703-4917-9c68-76e079e8823b
---

跟用户逐节确认设计（哪怕每节都点头）只证明**方向**对了，**不**代表细节是最优化的；落盘 spec / 进 writing-plans 之前仍须过异模型（GPT）对抗审查细节。

**Why:** 用户点头是「方向 gate」，不是「细节 gate」——用户在意图层面把关，但不会逐一核验模式分类、默认值、集成缝、测试分配这些实现级最优性。跳过 subagent 审查直接落盘 = `no-self-review` 违背，且同模型自审有盲区。用户明确纠正过：「即使核对完证明方向对，也不表示细节最优，应该跟 GPT review 过一遍」。

**How to apply:** brainstorming 五节全过、正要 Write spec 时，插一道 cross-model adversarial review（`gpt-souls:reviewer` 挑细节/集成缝正确性、`gpt-souls:architect-advisor` 挑形状/默认/范围是否最优），派活 prompt 显式写裁判轴（长远正确+完整，非 ROI/YAGNI ——见 [[feedback-subagent-review-before-any-user-facing-proposal]] / user-rule 40）。吸收其客观事实、对判断谨慎取舍，达成共识再落盘。与 `subagent-review-before-ExitPlanMode` 同源，扩展到「任何 user-facing 设计定稿点」。

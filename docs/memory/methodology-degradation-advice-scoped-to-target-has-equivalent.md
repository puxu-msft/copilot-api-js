---
name: methodology-degradation-advice-scoped-to-target-has-equivalent
description: "「别继承旧路径的退化」这类审计建议只在目标格式真有对应值时成立;目标客观无对应值时,诚实退化+marker 才是保真、发明语义不贴的值是错——本会话 content_filter→refusal 过度改进被 orchestrator 亲手核实驳回"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d3ca528-62fc-4185-bcfb-7992d9022f37
---

**「别继承旧中转路径的退化 / 直接映射应更保真」这类审计建议,适用范围是「目标格式真有对应值、旧中转把它压扁了」;当目标格式**客观没有**对应值时,沿用既有诚实退化 + observability marker 才是保真,发明一个语义不贴的值反而是错。**

**实例(anthropic↔responses 直接桥,2026-07-15)**:审计正确指出「stop_reason 经 CC 中转把 `refusal`/`pause_turn` 退化成 `end_turn`,直接桥别继承」。实现者据此把 Responses `content_filter` 也映射成 Anthropic `refusal`(而非旧路的 `end_turn`)。**过度应用**:
- 对 `refusal`/`pause_turn` 成立——Anthropic **真有**这些 stop_reason,CC 丢了、直接桥该保。
- 对 `content_filter` **不成立**——Anthropic **客观没有** content_filter stop_reason(`cc-to-anthropic.ts` 已记载),且 Responses 自身把 `content_filter`(审核过滤)与 `refusal`(模型拒答)区分为两概念(`responses-to-anthropic.ts` 有独立 refusal 分支)。把 content_filter 映射成 refusal = 混淆两个目标格式自己都区分的概念,是**语义错配**,非保真。
- 裁决=沿用既有 N3(`content_filter`→`end_turn` on the wire + `contentFiltered` ctx marker 保信号),非发明 refusal。

**通用手法(裁决「该不该保真升级」)**:
1. 先问「**目标格式真有这个值吗?**」——查目标格式的类型/枚举定义(独立 oracle),别凭「更保真总是对」直觉。
2. 有 → 保真升级成立(别继承中转退化)。
3. 无 → 诚实退化到最贴近的已有值 + 打 observability marker 保信号(richest-data-flow 靠 marker 不靠伪造 wire 值);发明语义不贴的值是错。
4. **实现者采纳审计意见时最易过度应用**——orchestrator 亲手核实两侧 file:line(目标格式类型 + 旧路 marker 机制)才裁,别橡皮图章。

姊妹 [[methodology-broken-reference-supply-vs-delete]](补符号 vs 删引用按消费者契约裁)、[[methodology-classify-lost-info-vs-equivalence-before-config-migration]](丢信息 vs 等价变换先辨)。逮法=合并态审 + [[feedback-pass-null-clean-not-self-validating]] 验证簇。

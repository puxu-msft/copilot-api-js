---
name: feedback-synthetic-data-must-be-distinguishable-from-real
description: 合成/注入进真实数据流的帧(keepalive/占位/mock/降级)必须打可辨识标记,否则伪装成真实数据、污染 history/log/UI 可观测性、把异常状态(上游沉默)掩盖成正常;是 richest-data-flow 的对称面
metadata:
  type: feedback
---

把 keepalive 从自明的 `event: ping` 改成空 `content_block_delta`(为解决 CC 300s no-real-content idle 上限)——**功能对了**,但空 content_delta 与真实内容帧**字节无法区分**,在 forwarded 轨伪装成真实响应。用户一针见血:一条"上游其实沉默、只有心跳"的请求,history/UI 看起来像正常 streaming,运维根本看不出真相——大量心跳把上游没通信这件事掩盖了。这个维度我完全没想到(只想着保活功能),靠用户反复推才看见,是**设计盲区不是验证不足**。

**Why**：richest-data-flow 有两个对称面（原则权威聚合于 ADR `docs/decisions/2026-07-05-richest-data-flow.md`）。已知面=[[feedback-richest-data-flow-store-complete-no-pruning]]"后端完整存真实数据、不裁剪数据模型"。这次暴露的面=**合成/注入的数据必须可辨识**——否则它把异常通信状态(上游死/沉默)伪装成正常,违背"History 忠实反映真实通信状态"。**功能正确 ≠ 可观测性正确;"能保活"不代表"可观测"**。自明的合成帧(ping,type="ping" 一眼可辨)看似无害,但一旦换成伪装成内容的形态(空 content_delta),就从"诚实的 keepalive"变成"欺骗性的假内容"。

**How to apply**：任何往真实数据流注入合成帧(keepalive / 占位 block / mock 上游 / 降级 error 帧)时,先问一句:**下游消费者(history / log / UI / diff / 运维)能否区分合成 vs 真实?** 落地三原则:①**原始/上游轨绝不含合成物**,始终忠实(上游沉默=那段轨没有帧,可核对);②合成物只进 forwarded/派生轨、且打**显式标记**(如 `SseEventRecord.synthetic` 字段,所有注入点全打含 ping);③下游据标记区分显示(如 badge "13 events · 11 keepalive" 一眼看出上游只发了 2 个真实帧、心跳行 dim+标签)。**改动横切数据的形态时(如 keepalive 帧类型 ping→content_delta),必须评估所有下游消费者,不只客户端**——看似只影响客户端,实则污染了 forwarded 轨的可辨识性。活案例 `client-sink.ts` 的 synthetic 标记 + `SseEventsSection.vue` keepalive 计数。链完备性自审 [[feedback-multidim-completeness-audit-before-claiming-done]](可观测性正是最易漏的那个维度)。

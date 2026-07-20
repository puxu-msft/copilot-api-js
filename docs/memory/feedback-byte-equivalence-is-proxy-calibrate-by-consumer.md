---
name: feedback-byte-equivalence-is-proxy-calibrate-by-consumer
description: 逐字节等价是代理非目的、按消费者三层校准已归入 skill large-refactor §7；见那里
metadata:
  type: feedback
---

**已归入 skill `large-refactor` §7（字节等价是代理，按消费者校准）。** 钩子：真 invariant=对在意的消费者无可观测行为变化。三层：①转发客户端响应 SSE（苛刻外部 SDK，死磕逐字节）②上游 GHC wire（GHC 独立 oracle 才终审）③history/UI（回归 tripwire，可覆盖）。信号：inline-lock 纯噪声大对象=该换 oracle。协议正确性别用自洽、用独立 oracle 见 [[feedback-pass-null-clean-not-self-validating]]。

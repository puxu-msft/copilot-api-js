---
name: methodology-golden-fixture-pre-capture
description: 行为保持的流/输出重构，先把 golden 测试锁在改动前的旧代码上
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3327a03a-0bda-49b3-8f24-9230fe3ebdd8
---

行为保持地重构某个流/输出（bus 事件、SSE 帧、wire payload、sink 输出）时，先写 golden 断言测试并**在旧代码上跑通**——这就把当前行为**锁定**了。然后再重构；同一个不动的测试改后仍通过 = 证明等价。一个只在重构后才存在的 golden 什么都证明不了（它只是编码了新代码的行为）。

**为什么：** 这是"字节/行为等价"invariant（[[methodology-commit-invariants]]）背后的具体验证手段。能抓到全套件绿也漏掉的：事件重排、漏发/多发、payload 漂移。

**怎么用：**
- 捕获**序列 + 判别字段**（kind、field、previousState、presence 标志），**不**捕全 payload——更少误报，仍抓结构性回归。
- **归一化易变字段**（id、startTime、durationMs、时间戳）——断结构不断噪声。
- 在「改动前的 HEAD」上跑→通过（golden 锁定）→重构→须仍通过 + 连跑 N× 确认确定性。

本会话实例（v4 P0.3，最高风险 commit）：`tests/context/context-bus-stream.it.test.ts` 记录 success/fail/abort 三流的 `request.*` bus 事件流（kind/field/previousState/state/hasSummary），先在双轨旧代码上通过，再在 ctx 改为直接 publish 后仍通过——证明收敛是事件流等价的。

**配套视角：** 当重构是**提升/上移**逻辑（如内循环→pipeline strategy），区分**结果等价**与**机制等价**。机制理应改变（每尝试独立限流、重试日志、多记 history 行）——这是目的，不是回归。invariant 是结果（learn→retry→成功），而非字节级机制一致。

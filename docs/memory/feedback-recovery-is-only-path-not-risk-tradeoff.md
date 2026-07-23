---
name: feedback-recovery-is-only-path-not-risk-tradeoff
description: 连接已死后重连重发是唯一出路而非风险取舍——别把必要恢复框成「双计费/双执行取舍」
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c920d902-6204-44cc-a3c9-8980aa0b5232
  modified: 2026-07-23T03:27:25.190Z
---

当一个恢复动作是**交付任何可用结果的唯一出路**时，绝不把它框成「有风险的取舍」。

实例：pre-response h2 关闭（`status=0`、零帧、连接已死）后重连重发是**唯一**能给 client 交付响应的方式。Plan agent/reviewer 默认带 ROI/安全保守味，把它写成「弱保证、用户接受极小概率 POST 双执行/双计费的取舍」。用户当场纠正：**「上一个连接都不可用了，新连接必须建立才能正常通信，哪来的双计费问题，这没得选」**。

**Why:** 把「唯一出路」误框成「取舍」会误导决策（让人以为存在「更省」的不重试选项，实则那是「零交付」）。且归因错了——若上游 teardown 前已计量，那笔沉没账是**已经发生的、与重不重试无关**；不重试并不能退款，只会「既扣了 quota 又没拿到响应」。LLM 生成除计费外无非幂等副作用，重发无正确性危害。

**How to apply:** 遇到「连接/资源已死 → 重建是继续的唯一途径」的场景，如实陈述「这是唯一出路、非选项」+「沉没成本与恢复动作无关」+「如实记录（如可能记双次就记双次、不掩盖）」，而非套「双X风险取舍」模板。cap 仍要有（`hasRetried` 闩限至多 1 次），但那是有界性说明、不是「取舍辩护」。关联 [[feedback-never-propose-short-term-mitigation]]（有根因可修就只提根因）、[[feedback-existing-code-has-no-authority-dont-accommodate]]。

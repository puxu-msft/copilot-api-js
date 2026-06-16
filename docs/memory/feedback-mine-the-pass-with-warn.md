---
name: feedback-mine-the-pass-with-warn
description: "当 subagent 报告「PASS 但有 1 个 WARN」时，把这个 WARN 当作真正的线索——它往往只是更深层回归之上的一层薄壳，否则你会错过它"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 74cbbf78-f572-4505-b8b0-b822b5e0292e
---

延伸自 [[feedback-subagent-feedback-also-critically-verify]]：subagent 审计经常以「PASS 但有 1 个 WARN」或「WARN 低优先级」收尾。默认的诱惑是直接交付。**别这么做。** 把这个 WARN 再往深挖一层——它往往是 subagent 只抓到一半的真实回归的可见冰山一角。

**Why:** subagent 擅长表层检查（grep、type、lint、基础 test）。它们在多步因果链上较弱。它们标记的某个「死导出」之所以死，可能是因为你破坏了调用契约——而调用契约被破坏就是一个回归，只是 subagent 没有回溯到的那个。

**Example from this session（commit 4 / 可观测性重写）：**
- subagent：「PASS——可以交付。WARN：`notifyShutdownPhaseChangedAndFlush` 是死导出（无调用者）。建议按原则9 删除。」
- 我深挖：该函数死掉是因为 `shutdown.ts:setPhase` 现在调用 `bus.publishAndFlush`。没问题。
- 再往深挖：bus.ts 里的 bus.publishAndFlush 返回硬编码占位值 `pendingWsBuffer: 0`。WsSink 对 `system.shutdown_phase_changed` 的 handler 是同步的——bus 不会 await 它的工作。
- **真实回归**：shutdown 的 phase frame 已发送，但 WS TCP drain 并没有被 await。socket 可能在 phase frame 离开本机之前就关闭。旧的 `notifyShutdownPhaseChangedAndFlush` 有这个 drain 语义；我的迁移悄悄丢掉了它。
- 修复：把 WsSink 的 handler 改为 `void | Promise<void>`，在 `needsFlush` 时返回 `broadcastAndFlush()` 的 promise；bus.publishAndFlush await 异步 handler，于是这条链路端到端重新接上了。

**How to apply:**
- 当 subagent 报告以「PASS 但这里有个小 WARN」结尾时，把它当作 YELLOW 标志，而非 GREEN。提交前花 5-15 分钟顺着这个 WARN 的因果链走一遍。
- 具体要问：「这个被标记为死/孤儿的代码在保护着遗留代码做的什么事？我的迁移有没有保留它？」
- 重新 grep 该保护机制的目的，而不只是它的存在。（`broadcastAndFlush` 听起来不危险；「强制关闭前的 WS TCP drain」听起来就危险。）
- 如果发现真实回归，提交前就修掉它，而不是在后续补丁里修。按 [[feedback_complete_root_cause_fix]] / 原则8。

Related: [[feedback-subagent-feedback-also-critically-verify]], [[feedback_reviewer_verify_critically]], [[feedback_complete_root_cause_fix]]。

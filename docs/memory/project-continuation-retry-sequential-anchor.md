---
name: project-continuation-retry-sequential-anchor
description: 续写重试特性进度指针（P2 Anthropic 续写已完整 landed+验证+FF 合并进 master de37feff；D2 反转退役空-text 保活；P3-P7+synthetic marker 待续）
metadata: 
  node_type: memory
  type: project
  originSessionId: e50d58b9-1344-4e5e-8465-029ffad8c542
  modified: 2026-07-23T05:36:27.542Z
---

**续写重试**（首块 commit 后 mid-stream cut → 合成 continuation 轮续写、缝合进同一条客户端流救回）——**P2 = Anthropic 续写已完整 landed、端到端验证、FF 合并进 master（`de37feff`，full test:backend exit 0）**。

**权威归属(勿在记忆重复详情):**
- **P2 落地权威记录 = plan `docs/plan/2026-07-22-continuation-retry-sequential-anchor/plan-2b-continuation-executor.md` §11**(提交序 + 合并态审 findings 处理 + 验证)。交接:同目录 `HANDOFF.md`(头部已更新 P2 landed)。
- spec(含实施状态+端点矩阵)/ADR(Accepted):`docs/{spec,decisions}/2026-07-22-*`。

**架构形状(stub):** SSOT 新增第 5 个 verdict `continued` + role `continuation`(部分成功的 parent 无诚实旧 verdict——committed 排他单例 + commitTerminal 强制结算)→ `coordinator.runContinuation`(镜像 runRecovery,parent 结算 continued 非 failed)→ **driver committedAny 旁路分支复用同一 `for(;;)` 循环**(无独立 executor;被掐腿无 message_stop 故只需 message_start dedup + wire-index offset,primary 腿 offset 0 惰性)→ handler 接线 → telemetry 拆分。

**承重教训(高价值,反复可用):**
- **[D2 用户反转] 退役"向 client 发空-text block 保活"**:空 text block 错误形状 + G2 实证不重置 CC 300s 死线。默认 `stream_keepalive_mode: ping`,P1 顺序 anchor 代码转休眠(非删)。**块级 CLI-safety 改由"块级缓冲严格按 index 顺序输出"承担**,非空 anchor。过渡期长静默=裸 ping、接受 >300s 断连(待 keepalive 调研)。
- **[C3 承重 offset] 续写块 re-index 的 offset 必须=wire 已交付块数,绝不是 ledger 长度**:extractor 排除 thinking 但 thinking 已上线占 wire index → 两计数域不同 → 用 ledger 长度会**静默损坏**(合并块+幻块,不 throw)。`exp/continuation-stitch/` PoC + mutation-verified 测坐实。
- **[方法论] 别把测试失败当"无关预存"dismiss——对照 master 跑**:我把 4 个 History V3 fail 当预存忽略,实为 stale-branch bug(分支落后 master 32 commit、master 已修 `record.dispatches.length`)。合并态审逮住。失败归因先核基线,别信 HANDOFF 注。
- **[best-effort 降级]** 续写尽力救回:dispatch 失败(如候选预算超 `maxTotalCandidates`)优雅降级 `continuation-exhausted`,绝不崩请求。
- **[验证] client-facing wire 正确性用真 SDK oracle**:`tests/e2e-client/continuation-sdk.it.test.ts`(真 @anthropic-ai/sdk 消费缝合流,含 thinking-offset + chained 多跳)。mock 驱不动 `runContinuation` 候选会话终态 → 多跳成功走生产路径 e2e。

**剩余:** P3 incident e2e、P4-P6 CC/Responses 续写(D4 全端点分阶段,当前仅 Anthropic)、P7 默认翻转(依赖 >300s keepalive)、synthetic:continuation provenance marker(`docs/todo/2026-07-22-continuation-synthetic-provenance.md`,纯可观测缺口)。

**Related:** [[feedback-pass-null-clean-not-self-validating]] [[project-block-level-buffered-retry-execution]] [[methodology-verify-running-server-has-fix-before-diagnosing-from-log]]

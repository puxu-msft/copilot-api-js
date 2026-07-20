---
name: project-block-level-buffered-retry-execution
description: block 级缓冲重试特性执行进度指针（P0-P4 全部实质实现已 landed+reviewed；只剩 3 个默认翻转 + P1 接线 gated 在用户实证门；whole-branch review + 收尾 pending）
metadata:
  node_type: memory
  type: project
  originSessionId: ebe4a147-09a1-4d7e-8522-d207df456a23
---

**block 级缓冲重试**（整响应 all-or-nothing 缓冲推广为按提交边界延迟提交、掉线透明重试；源起 req_484 单大 tool_use mid-block 截断无 message_stop）——4 端点非对称提交粒度（**P2 Responses-HTTP=块级/partial-degrade 可达；P3 CC + P4 Responses-WS=terminal-only/partial-degrade 不可达；P1 Anthropic=块级但接线待落**）。

**权威归属（勿在记忆重复详情）：**
- spec（三轮对抗审查获批）：`docs/spec/2026-07-11-block-level-buffered-retry.md`。
- plan 集：`docs/plan/2026-07-11-block-level-buffered-retry/`——README「**冻结契约**」节 = 单一事实源。
- **执行**：隔离 worktree `.worktrees/block-level-buffered-retry`（分支 `feat/block-level-buffered-retry`，从 master `88a11516`）。**durable ledger `.superpowers/sdd/progress.md` = 权威进度**（每 Task 状态+commit+承重 concern；gitignored 但按约定追踪）。

**现状（2026-07-13）——本会话从 P2T2 一路推到全特性实质完成：**
- **P0**（机制地基 3/3）✅ reviewed。**P1**（Anthropic）T1-T5,T7 mechanism ✅ reviewed；**T6 接线+默认on 阻在用户 PoC stage-2**（两块并存+300s 死线，exp/block-level-anchor-coexist）。**P2**（Responses-HTTP）T1-T5 ✅（含 keepalive M-2 harness `exp/responses-keepalive-idle-oracle`）；T6 翻转 T7 doc 待。**P3**（CC）T1-T3 ✅（含 keepalive harness `exp/cc-keepalive-idle-oracle`）；T4 翻转待。**P4**（WS）T1-T2 ✅（T1 terminal-only 修正后）；T3 翻转待。
- **剩余全部 gated**：3 个默认翻转（P2T6/P3T4/P4T3，一行 config 默认）阻在**用户跑 keepalive M-2 oracle**；P1T6 阻在**用户跑 PoC stage-2**。门未过则对应默认保持 false（安全不牺牲）。
- **进行中**：whole-branch capstone review（opus，`88a11516..3baf6095` 28 commits）。**收尾待**：ADR（退役整响应+非对称粒度+coverage tradeoff 决策）、doc-sync（DESIGN.md 活架构行 + streaming.md）、P2T7、记忆维护。plan-4 Task1 代码块已订正（ecece007）。

**本会话教训（拟收尾下沉 skill/记忆）：**
- **绿测掩盖 plan 级 spec 违反**：P4T1 plan 代码块把 HTTP 块级谓词 `isResponsesCommitBoundary` 误标「terminal 用法」粘进 terminal-only 语境 → 块级 live-commit 关重试窗口，output_item.done 后掉线降级 partial-degrade 不重试；绿测用 partialFrames 故意不含 output_item.done 故零区分力。**per-task 独立 review（非自审）逮到**。learn-by-analogy：P2 HTTP 正确用块级/P3 CC 正确用 error-only/**仅 P4 WS 错**。→ [[feedback-pass-null-clean-not-self-validating]]
- **plaintext mock 让 Bun-undici 上游假性 abort**：keepalive oracle 的 mock 必须 `node:http2`(HTTPS/h2)——明文 http mock 让代理在 Bun 下 ~5ms abort（同 skill `bun-upstream-transport` 上游坑），plaintext 会产生 M-2 false-negative。
- **test-authoring gotcha**：`applyConfigToState()` 每请求调（system-prompt/override.ts，热重载 by-design 非 bug）→ 测试 `setStateForTests` 突变被覆写，须 `setBufferedRetryOverride`；旧标量键 `protectStreamingMaxRetries` post-P0 已删，用 `bufferedRetryShared:{maxRetries}`。
- **ledger 漂移**：压缩丢了 P1T7/P2T2 已过 review 的记录，回填时靠 `git log`+读旧 subagent transcript 尾部恢复（`tail`+python 解 jsonl 最后 assistant text，别读整包）。

**承重提醒**：① 恢复先 `cat` ledger 别重派 complete Task；② 3 flips+P1T6 须**改 config.yaml/schema 默认**（经 applyConfigToState 传播）**非 state 突变**（会被每请求重导覆写）；③ subagent API 近期不稳（本会话挂 2 次），失败按 BLOCKED 内联接管或重派；④ CC-live 默认心跳=保留（parity Anthropic/Responses，已向用户 FYI 可 override）。**Related:** [[feedback-subagent-review-before-any-user-facing-proposal]] [[feedback-tier-subagent-review-skip-for-mechanical-micro-changes]] [[git-commit-pathspec-commits-worktree-not-index]]

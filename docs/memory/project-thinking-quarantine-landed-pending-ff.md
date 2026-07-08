---
name: project-thinking-quarantine-landed-pending-ff
description: thinking「cannot be modified」400 三层修复已在 feat/thinking-quarantine 完成+已并 master、待 FF；根因=相邻性；thinking_block_sanitize 重命名仍排队
metadata: 
  node_type: memory
  type: project
  originSessionId: f1d9e4dd-0da3-47cb-94b6-e805cb0ca3d2
---

「thinking blocks cannot be modified」400 的三层修复**已实现+审查完毕**，在分支 `feat/thinking-quarantine`（worktree `.worktrees/thinking-quarantine`），2035 test pass、typecheck clean、opus whole-branch review 判 ready-to-merge。已 `git merge master`（commit `3f0e6b35`，auto-resolve 9 文件无手动冲突）整合了 master 的并发 reactive-rejection 特性，集成后仍绿。

**根因（PoC 实证订正）**：非签名毒化、非我方 sanitge，而是**折叠后 latest-assistant 消息内两个 thinking 块相邻**（留 1→200 / 2 相邻→400 / 交错分隔全保留→200）。归属：spec `docs/spec/2026-07-07-thinking-signature-quarantine.md`、plan `docs/plan/2026-07-07-thinking-quarantine.md`、`docs/DESIGN.md` 活的架构现状、PoC `exp/thinking-signature-quarantine/`、skill `[[ghc-anthropic-upstream]]`（根因行已订正）。三层：L1 always-on de-stack 保全 thinking（`thinking_destack_strategy`）/ L2 reactive strip-all（`strip_thinking_on_reject`）/ L3 (session,agent)/TTL quarantine（`poisoned_thinking_quarantine`+`ttl_hours`）。

**待办（下会话接手）**：
1. **FF 到 master 被用户主工作树的未提交 `config.yaml` 卡住**（分支也改了它、git 拒覆盖）——用户清净工作树后 `git merge feat/thinking-quarantine` + `git worktree remove .worktrees/thinking-quarantine`（分支已验证 conflict-free）。
2. **2 个失败是 master 既有、非本特性**：`setConnectTimeoutForTests` 未注册进 RESETTERS（master 的 http2 connect-timeout 特性、用户正 uncommitted 编辑中）+ history UI shell（build:ui artifact）。别当本特性 bug。
3. **排队的独立小重构**：`anthropic.thinking_block_sanitize` 枚举重命名——`empty_thinking`→`all_empty`、`empty_any`→`signature_empty`、新增 `thinking_empty`/`any_empty`、默认 `all_empty`（行为不变）+ compat 值迁移；语义=按「哪个字段空」触发丢弃，见 `content-blocks.ts filterEmptyThinkingBlocks`。用户已认可映射方向、待做。

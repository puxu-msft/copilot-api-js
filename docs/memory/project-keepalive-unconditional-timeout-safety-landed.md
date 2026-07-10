---
name: project-keepalive-unconditional-timeout-safety-landed
description: keepalive 无条件 timeout-safety 特性已落地分支 feat/keepalive-timeout-safety，待 user-run oracle + merge
metadata: 
  node_type: memory
  type: project
  originSessionId: ae755faf-64e4-410f-9659-b8eff8a536f1
---

keepalive 无条件 timeout-safety（修生产 incident：live/delayed-commit 纯 pre-response 静默→裸 ping→CC 300s watchdog→客户端 320s 断连，实测 20 条）已实现于分支 `feat/keepalive-timeout-safety`（worktree `./.worktrees/keepalive-timeout-safety/`，19 commits，基于 master `80366363`）。

核心：合成注入器从 driver 搬到 **handler 层唯一注入器**（sink 构造时挂 `heartbeat.injectAnchor`、独立于 driver/pump，覆盖 `await p` pre-response 窗口）；无真实 message_start 时合成（`resolvedName`）；live 路径经 `makeReconcilingSink` 装饰器对账（drop 真实 message_start + content_block_* +1 remap + 首真实块前收口）；三模式 `ping`/`enveloped_ping`/`empty_text`（`content_delta` 经 migrateValue 迁移到 empty_text）。

**权威**：ADR `docs/decisions/2026-07-09-unconditional-keepalive-timeout-safety.md` + spec `docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md` §10（含 §10.1.5 架构 + §10.3 freezeHeartbeat 实现期修正）+ plan `docs/plan/2026-07-09-...md`（头部实施状态）。

**状态（2026-07-09）**：code-complete + 全阶段 review + opus whole-branch 终审 + I-1 承重缺口（pump 终末失败不收口锚点）修复并独立复核 = MERGE-READY。回归 2183 pass/0 fail、引入零新 lint/typecheck 错。**待办**：① user-run oracle（`exp/cc-idle-280s/` 实测 live empty_text 存活 >300s，no-auto-server）② merge 决策（**oracle 绿前不 merge**）。**deferred**（已落 backlog）：POST-COMMIT error 帧 + stop@0 不进 history clientResponse.sseEvents（既有 pattern、wire 协议完整）。落地后此记忆可降为「已合并」stub 或删。

**Related:** [[project-v4-pipeline-rearchitecture]]、skill `claude-code-connection`（CC 两层 watchdog）、`empirical-verification`（oracle）。

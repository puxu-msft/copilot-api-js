---
name: project-keepalive-unconditional-timeout-safety-landed
description: keepalive 无条件 timeout-safety 已合并入 master 64e36612（oracle 实测通过）
metadata: 
  node_type: memory
  type: project
  originSessionId: ae755faf-64e4-410f-9659-b8eff8a536f1
---

keepalive 无条件 timeout-safety（修生产 incident：live/delayed-commit 纯 pre-response 静默→裸 ping→CC 300s watchdog→客户端 320s 断连，实测 20 条）**已合并入 master（`64e36612`，2026-07-09；21 commits，从 `feat/keepalive-timeout-safety` rebase + FF，worktree 已删）**。

核心：合成注入器从 driver 搬到 **handler 层唯一注入器**（sink 构造时挂 `heartbeat.injectAnchor`、独立于 driver/pump，覆盖 `await p` pre-response 窗口）；无真实 message_start 时合成（`resolvedName`）；live 路径经 `makeReconcilingSink` 装饰器对账（drop 真实 message_start + content_block_* +1 remap + 首真实块前收口）；三模式 `ping`/`enveloped_ping`/`empty_text`（`content_delta` 经 migrateValue 迁移）。

**oracle 实测通过（真实 CC + 隔离实例）**：empty_text 存活 **330.5s**（is_error=false）、ping 对照 **320.1s** 精确复现 incident。见 `exp/cc-idle-280s/REPORT.md §8`。

**权威**：ADR `docs/decisions/2026-07-09-unconditional-keepalive-timeout-safety.md` + spec `docs/spec/2026-07-08-buffered-keepalive-empty-text-anchor.md` §10（§10.1.5 架构 + §10.3 freezeHeartbeat 修正）+ plan `docs/plan/2026-07-09-...md`。DESIGN.md 已同步。

**deferred（已落 backlog）**：POST-COMMIT error 帧 + 锚点 stop@0 不进 history clientResponse.sseEvents（既有 pattern、wire 协议完整）。

此特性已完结。本记忆可保留为已合并 stub 或后续清理（并发会话另在仓库 MEMORY.md e809a760 记有条目）。**Related:** skill `claude-code-connection`（CC 两层 watchdog）、`empirical-verification`（oracle）。

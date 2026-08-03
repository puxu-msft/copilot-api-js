---
slug: impl-1
base: 1b8712b4
branch: feat/inter-block-anchor-allocator
worktree: /home/xp/src/copilot-api-js/.worktrees/anchor-alloc
plan: docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md
agent_id: 130363ec-1cbc-419f-86e5-7e19b0f46a7f
status: in-progress
---

## 剩余项

- [x] 核心 mutation 正控已记录实际输出：wire-torn close 例外、heartbeat 时钟、legacy writer allowlist、partial-delivery projection。类型非法组合由 `@ts-expect-error` + `bun run typecheck` 负责 compile-red；owner→owner exactly-once 与 13 关闭者由同一 owner API、架构零 legacy stop 守卫和现有站点回归联合覆盖。
- [x] 终态门：`bun run typecheck` 绿；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` = 6828 pass／0 fail／31.65s。
- [ ] 独立 code review 由主会话补做；本 leaf 无 Agent 工具，不得自行派审。验收：长远正确 + 完整轴下无 blocker／major。
- [ ] 用显式 pathspec 提交实现、测试、计划状态和本进度文件。验收：commit message 为冻结的 Conventional Commit，提交只含 M1 路径，进度对账脚本无缺项。

## 在途意图

- M1 生产形状已接通：owner failure 纯翻译、收紧 union、owner close 权威、bridge、heartbeat 时钟、wire partial delivery 诊断与 allowlist 守卫均已落工作区；当前重点是补齐正控和最终审查，不再改设计。
- 已实跑 mutation：① `closeOpenAnchor` 改回通用 `ownerUnavailable` 后，`wire-torn blocks frontier progress but still closes the already allocated anchor exactly once` 以 `owner unexpectedly rejected: wire-torn` 转红；恢复后 1 pass。② 删除 close heartbeat 时钟更新后，`owner block and anchor-close writes advance the heartbeat activity clock` 以 Expected 20／Received 10 转红；恢复后 1 pass。③ 把 legacy writer allowlist 清空后，架构守卫报 `lib/pipeline/delivery/session.ts` offender；恢复后 1 pass。
- 全量门最近一次结果：`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` 为 6828 pass／0 fail／32.37s；此后只改了 handler 的 owner-failure 短路收尾、测试说明和守卫 allowlist，最终提交前必须重跑。
- 本环境未暴露独立 `agent_id` 变量；frontmatter 的 `agent_id` 使用当前 leaf session id `CLAUDE_CODE_SESSION_ID=130363ec-1cbc-419f-86e5-7e19b0f46a7f`，保证可追溯。

## 已作废的路子

- 不按关闭站点拆 commit：会违反“按 anchor 原子迁移”的冻结红线。
- 不让 legacy close 同步清 `openAnchorIndex`，也不保留 legacy guard 作为关闭权威；两案均已在处置表中否决。
- 不把 partial-delivery 塞入 `warningMessages` 或翻译层；持久记录只在 owner commit-aware catch 产生点写入 `PipelineInfo`。
- 不让 `reconcileLiveFrame` 继续产 stop 帧或写 `anchorClosed`；这会保留第二关闭权威。纯函数只做 envelope drop + bridge remap，装饰器经 raw inner 的 owner port 关闭。
- 不把 `closeOpenAnchor` 纳入 `wireTorn` 通用 preflight；mutation 已证明会留下未闭合 anchor。
- 不依赖旧 live-reconcile unit fixture 中手工置 `injected:true` 代表 allocator 已分配；bridge 的权威是 `anchorsOpened()`，fixture 必须同步推进 allocator 的既有兼容入口。

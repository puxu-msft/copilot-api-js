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

- [x] Major 1：新增 `message_stop as the first terminator closes anchor@0 exactly once before forwarding it`，走真实 delivery owner + live decorator + driver stack，断言唯一 `stop@0` 位于 `message_stop` 前。
- [x] Major 2–3：七个 handler 终局点统一经 `settleMessagesOwnerFailure` 分流；live 装饰器把 client-gone 保真成 `StreamClientAbortError`，其余 owner failure 以 typed error 交给 driver classifier。分类 oracle 覆盖 client-gone→aborted、wire-torn→caller failed path、session-terminating 的 settled/pending 两支。
- [x] Major 4：新增冻结 13 站点的具名 registry，每站点独立测试；行为 oracle 已覆盖 message_stop、live client-gone 与既有 direct/driver 路径，mutation 在 scratch worktree 逐站点执行待记录。
- [x] Major 5：`ClientSink` 移除 `writeAnchor`；仅 delivery-private `OwnerRawSink` 持有 capability。变量提取 witness 现由 `@ts-expect-error` 锁定 TS2339，scratch compile-red 待记录。
- [x] 本修复 commit 前终态门：`bun run typecheck` 绿；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` = 6848 pass／0 fail／41.08s；精确改动文件 `bunx eslint` 绿。
- [x] `/tmp/anchor-m1-mutations` mutation 完成并恢复：① `message_stop` matcher 去掉该分支后，具名测试缺 `content_block_stop@0#anchor`，0 pass／1 fail；② capability witness 删除 `@ts-expect-error` 后 `bun run typecheck` 报 TS2339 `ClientSink` 无 `writeAnchor`；③ 同时移除 live client-gone 的 source tag 与 driver typed mapping 后，具名测试 Expected `settled-abort`／Received `stream-error`，0 pass／1 fail；④ 13 个 close site 逐个删除后，各自具名 `M1 close site: <name>` 均 exit 1／named-fail。恢复后 `anchor-close-sites` 14 pass／0 fail，`bun run typecheck` 绿。
- [ ] 独立复审由主会话完成；本 leaf 不派生 agent。

## 守卫换轴记录

1. **语义不变量**：只有 generation delivery owner 有权向客户端写出 synthetic anchor 结构帧；其他生产层只能请求 owner 执行关闭，不能自行发出该帧。
2. **权威事实源**：TypeScript 编译器依据 `ClientSink`／owner-private raw sink capability 的类型边界裁决谁持有 anchor 写能力；不再由测试代码重新解析调用拼写。
3. **已知绕法映射**：同行调用、先提取 `legacyStop` 变量、给方法或 sink 起别名、把调用搬到另一生产文件——只要接收的是公共 `ClientSink`，均因类型上不存在 `writeAnchor` 而 TS2339；只有 owner 持有的私有 raw sink capability 暴露该方法。
4. **独立 witness**：保留评审给出的变量提取写法作为 compile-time type test；正常树用 `@ts-expect-error` 固化“必须编译失败”，scratch worktree 删除该注解后 `bun run typecheck` 必须非 0 且实际输出 TS2339。

## 已完成的旧 M1 证据

- 核心 mutation 正控已记录实际输出：wire-torn close 例外、heartbeat 时钟、legacy writer allowlist、partial-delivery projection。
- commit `6333d800` 终态门：`bun run typecheck` 绿；`FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http` = 6828 pass／0 fail／31.65s。
- 两路独立 review：0 Blocker／5 Major；结构面通过，失败路径与 oracle 待本轮闭合。

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

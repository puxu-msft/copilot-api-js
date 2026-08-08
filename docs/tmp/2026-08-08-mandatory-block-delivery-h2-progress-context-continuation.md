---
slug: context-continuation
status: in-progress
base: 993a64a93c137c15eb12f7aea8ec0806cbb46769
branch: worktree-continuation
worktree: /home/xp/src/copilot-api-js/.claude/worktrees/continuation
plan: docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/README.md
source-session: 64e52e2f-eb0b-485a-9332-0e3d32adc328
source-transcript: /home/xp/.claude/projects/-home-xp-src-copilot-api-js/64e52e2f-eb0b-485a-9332-0e3d32adc328.jsonl
continuity: 须连续；旧会话明确命中两次 context-window 400，已按 PID 与 session marker 核对后停止。
---

# Mandatory block delivery 接续进度

## 已恢复的提交与 WIP

- 冻结主实施树：`mandatory-block-delivery-h2-implementation`，接续基线 `993a64a9`。
- Task 37 分支：`agent-a4519c20a545ed3b6`，相对共同基线 `38ee9d86` 有 11 个提交；已用三方 merge `--no-commit` 应用到本树，零冲突，尚未提交。
- Task 9 接力分支：`agent-a76fa535d0dc7246e`，相对 `993a64a9` 有 4 个提交；本树尚未合入，仍只读。
- 旧会话与上述两个源 worktree 在接力时均为 clean；没有未提交 WIP 需要复制。

## 当前门禁

- Task 37 最终定向集合：`139 pass / 0 fail`。
- H2／proxy pollution／SCC 修复门：`47 pass / 0 fail`。
- `bun run typecheck`：通过。
- target ESLint：通过；仅输出 `baseline-browser-mapping` 数据陈旧提示，无 lint finding。
- `bun run test:backend`：在当前未提交合并态运行，`16 shards / 5664 tests / 5664 pass / 0 fail`，用时 `45.14s`。命令口径为 unit＋it＋http；测试数不与此前不同失败运行横比。
- 实现门已闭合；独立代码评审仍未执行，因此 Task 37 尚不能标 complete，也不能据此解锁后续 Task 1／4。

## 三个 backend 失败的守护不变量与处置

1. `tests/transport/h2-keepalive-ping.unit.test.ts` 守护：同步 `session.ping()` 抛错必须被隔离，后续 interval tick 仍可执行。依据是测试文件注释。单跑原测试 `3 pass / 0 fail`，16-shard 下真实 `15ms` interval 在等待 `55ms` 后只得到一次 tick，属于固定墙钟在调度饥饿下 false-red。首次把测试改为手动 scheduler 后按目标红：合并态函数没有 scheduler seam，delay 未记录、tick 为零。生产函数增加默认仍为 `setInterval` 的注入点后，新测试 `3 pass / 0 fail`；正控是去掉 production `catch` 后第一次手动 tick 必须抛错。
2. `tests/history/search/uds-transport.it.test.ts` 守护：真实 `Bun.serve` handler 中并发查询缺失 sidecar 时，160 个请求均降级为 `[]`，child 无 uncaught／unhandled并以 0 退出。依据是该测试 `:300-345` 的事故说明与负控记录。单跑持续 `24 pass / 0 fail`、约2秒；16-shard 下先命中默认5秒，再把预算改30秒后仍精确卡满30秒，证明单纯放宽 timeout 不是修复。阶段探针证明 child 卡在第0批40个本地HTTP请求，未到 `server.stop()`，因此 `server.stop(true)` 路线也被证伪。按 `parallel-test.ts` 的 LPT 算法重建49文件bucket后，`tests/infra/proxy.unit.test.ts + victim` 在第1轮稳定复现；Bun最小探针证明 `process.env.KEY = undefined` 会保留键而不是删除，污染者把缺失代理变量恢复成了存在的错误值，child继承后本地fetch挂起。根修：原值缺失时 `delete process.env[key]`，每个 proxy describe 的 afterEach 同时恢复三个env键与 `cachedProxyOptions` no-proxy状态；同一红控配对修后 `42 pass / 0 fail`。UDS受害测试已完全恢复零diff。正控仍是文件既有记录的 listener-after变异，在原始复现中250/250非零退出。
3. `tests/architecture/circular-deps-ratchet.unit.test.ts` 守护：core SCC 只能缩小，新增 cycle 或成员必须红。该测试单跑稳定红；不得更新 baseline。Task 37 新增 `pipeline/types.ts -> transport/parsed-sse-frame.ts` 类型边，使旧有的运行时聚合反向类型边闭环。逐层抽出窄 SSOT：`BufferedFlushContext`、`OwnerOperation`、`FeatureKind`、`V3TimingSource`，并让 `context/types.ts` 直接依赖 history/model 的类型拥有方而非运行时 barrel。每轮 ratchet 从大批新环缩到4条、1条，最终 `2 pass / 0 fail`；相关消费者 `83 pass / 0 fail`，baseline 未改。

## 本轮已验证

- H2 deterministic scheduler：`3 pass / 0 fail`。
- Proxy污染红控：修前 `proxy.unit + UDS` 第1轮即超时；修后同一配对 `42 pass / 0 fail`，且 UDS受害文件最终零diff。
- SCC ratchet：`2 pass / 0 fail`，baseline diff为空。
- 类型抽取消费者：`83 pass / 0 fail`。
- Task 37最终定向：`139 pass / 0 fail`；修复门复跑 `47 pass / 0 fail`；typecheck、target lint、全backend均通过，完整数字见“当前门禁”。

## 剩余项

1. 对 Task 37 做独立规格／代码评审，闭合 Critical／Important 后标 Task 37 完成并解锁 Task 1／4。
2. 从 Task 9 的strict primitive红测继续；不得把4个checkpoint当Task 9完成。
3. 全计划最终仍需完成 Tasks 1、4、5、6、9～12与 merged-state review／live docs；本 checkpoint 只闭合 Task 37集成门。

## 在途意图

- 当前 merge 尚未提交；所有 staged 文件来自 Task 37 分支，接续修复将与本文件一起进入该 merge 的最终验证范围。
- Task 9 不与当前 merge 并行写，避免 mutation／测试与 Task 37 合并态互相污染。

## 已作废的路子

- 不再恢复旧会话：它已两次明确返回 `input exceeds the context window`。
- 不把 SIGUSR2 日志当 backend 失败原因；旧 progress 已证明它来自进程内 shutdown 测试行为。
- 不用“单跑绿”忽略全套件 false-red；修测试判据的调度模型。
- 不更新 circular dependency baseline 来吞掉新增环。

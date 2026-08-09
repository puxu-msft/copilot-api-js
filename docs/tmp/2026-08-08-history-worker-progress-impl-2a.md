---
slug: impl-2a
base: d8296920adb45864ab0a6d1af2bdcb018ad727bc
branch: history-worker-batch-2a
worktree: /home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a
plan: docs/plan/2026-08-07-history-persistence-worker.md
agent_id: main-session
status: active
---

> **状态：进行中。** 本文件是 Batch 2a 的活跃进度真相源；`impl-1`／`impl-1b` 已停更、只作历史证据。只记 git 不保存的三项：剩余项及验收、在途意图、已作废路线。

## 启动前硬门（本会话实跑）

- `REVIEWED_PLAN_COMMIT=22c8e08bfd2aac389c85c49b9241e2a3294b8c6f`：`rev-parse --verify` 成功、`merge-base --is-ancestor … master` 成功、plan blob 两侧同为 `fe26b74feae99b7e72ef67f3cfadbe993a89122c`。会话起始 `master@d8296920`。
- Peer 复查 `git log 22c8e08b..master -- src/lib/history src/lib/config src/lib/context src/lib/shutdown.ts tests/history`：18 条。与本批相关的实质改动是 `954a1bff fix: release history admission on capture failure`（`lightweight-model-operation.ts` 把 `failBeforeTerminal` 的 catch 提升到覆盖整个 capture 段），另有 `b19e34e4`／`2502d66b`／`7a99a254`／`d38fcb9c` 落在 History 查询与 search sidecar。**均不触碰 Batch 2a 要新建的 Worker semantic backend 面**，故本批不继承任何需重验的 1b 断言；`954a1bff` 只影响 admission 释放路径，Batch 2a 不接生产 terminal subscriber，因此不构成前置。

## 剩余项及验收

- [ ] `read-connection.ts`：主线程 readonly handle registry（`installHistoryReadDatabase`／`getHistoryReadDatabase`／`closeHistoryReadDatabase`），只保存 `openDatabaseReadonly()` 的 handle，不跑 schema／maintenance。
- [ ] `connection.ts` 支持 worker-owned handle：把完整 open 序列（owner check／WAL／pragma／vacuum／analyze）抽成不写 module singleton 的 opener，`openDatabase()` 保持既有单例语义委派到它。
- [ ] `backend.ts`：Worker 内 semantic open→owner/schema/migration→journal recovery；`persist-operation` 走 prepare→journal→transaction→ACK；retry 消费完整四字段 `persistRetry`，delay 走可注入 seam。
- [ ] `restart-policy.ts`：有上限指数 backoff、consecutive failures、`nextRetryAt`，clock/timer 可注入。
- [ ] `runtime.ts` 加 restart／replay：普通 crash（`error`／非预期 `exit`）保留未 ACK envelope 并按 messageId 原序重放；`fatal` 才进 terminal-failed。
- [ ] `semantic-backend.it.test.ts`：临时磁盘 DB＋独立 readonly connection 验 operation／summary／tracks／journal 收敛；非默认 `maxBackoffMs`＋injectable delay 证明真实 backend 消费每次等待上限。
- [ ] `crash-replay.it.test.ts`：before journal／after journal／mid transaction／after commit before ACK 四窗口＋old-generation ACK 拒绝。
- [ ] `restart-policy.unit.test.ts`：注入 clock/timer 测 bounded 指数 delay／consecutive failures／`nextRetryAt`。
- [ ] `fatal-state.unit.test.ts`：fatal 终结全部未 ACK 为 failed、reservation 各释放一次、后续 enqueue 立即 failed、`drain()` 确定性 reject、waiter／config barrier reject、与迟到旧 ACK 交错无双释放。
- [ ] 门禁：plan Step 2a.7 的定向集合＋`bun run typecheck`＋`bunx eslint`；两方向 mutation 正控（冻结 exact patch 注入／反向恢复）。
- [ ] 独立 review 到 0 blocker／major，再 fast-forward 合 `master`，回填计划状态行。

## 在途意图（决定与理由）

- **crash 注入不进生产协议。** 四个 crash window 由 `tests/history/worker/fixtures/` 下的 fixture worker entry 提供：它 import `backend.ts` 的真实消息循环与真实 backend，只额外传一个由 `workerData` 驱动的 crash hook。生产 `history-worker.ts` 仍是不带 hook 的薄入口，`protocol.ts` 不新增 test-only 字段。
- **crash 机制＝worker 线程内 `process.exit(code)`。** 已在本 worktree 实测（Bun）：worker 内 `process.exit(3)` 只杀该 worker，主线程收到 `exit:3` 且**不发 `error`**，主进程存活。因此 runtime 必须把「非预期 `exit`」当普通 crash 走重启，不能当 fatal。
- **`maxBackoffMs` 消费证据走文件回读。** Worker 不能回传闭包，且 `parseWorkerToMainMessage` 会拒绝未知消息类型；fixture worker 把每次注入 delay 的实测毫秒写入 `workerData` 指定的临时文件，测试读该文件断言「每次等待 ≤ 非默认 cap 且至少一次触到 cap」。删掉 backend 对 `maxBackoffMs` 的传递后等待会按 `backoffMs * 2^n` 增长并越过 cap，该用例必须红。
- **transient 失败用既有 `setV3CommitFailureInjectorForTests` 制造**（抛 `database is locked`，persist-guard 归为 transient），不新造分类通道。
- **restart-policy 测试单独成文件。** Task 2a 的 Files 清单只列三份测试，但 File Structure 的 `tests/history/worker/*.unit.test.ts` 通配已覆盖；把 restart policy 断言塞进 `fatal-state.unit.test.ts` 会造成名实不符，故新建 `restart-policy.unit.test.ts`。

## 已作废的路线

- 不给 `initialize`／`HistoryWorkerStartConfig` 加 test-only crash 字段：生产协议不为测试开洞。
- 不用「主线程 `worker.terminate()`」当 crash 注入：它无法停在 journal 之后／事务之中这类 worker 内部时刻，四个窗口会退化成同一个。
- 不让 backend 读 `getDatabase()` 主线程单例：Worker handle 必须显式传入，否则 Batch 6c 删除主线程 connection 时会留下隐式依赖。

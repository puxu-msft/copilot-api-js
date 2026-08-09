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

- [x] `read-connection.ts`：主线程 readonly handle registry（`installHistoryReadDatabase`／`getHistoryReadDatabase`／`closeHistoryReadDatabase`），只保存 `openDatabaseReadonly()` 的 handle，不跑 schema／maintenance。
- [x] `connection.ts` 支持 worker-owned handle：新增 `openOwnedHistoryDatabase(dbPath)`（完整 open 序列、不写 module singleton），`openDatabase()` 委派给它并保持单例语义（且改为「成功后才赋值」，失败时单例仍为 null）。
- [x] `backend.ts`：Worker 内 semantic open→owner/schema→`applyForwardMigrations`→`recoverV3Journal`；`persist-operation` 走 prepare→journal→transaction→ACK；retry 消费完整四字段 `persistRetry`，delay 经 `runWithTransientRetry` 的新 `delay` seam 注入。
- [x] `restart-policy.ts`：有上限指数 backoff、consecutive failures、`nextRetryAt`，clock 可注入。
- [x] `runtime.ts` 加 restart／replay：普通 crash（`error`／非预期 `exit`）保留未 ACK envelope 并按 messageId 原序重放；`fatal` 才进 terminal-failed。
- [x] `semantic-backend.it.test.ts`：临时磁盘 DB＋独立 readonly connection 验 operation／summary／tracks／timeline／objects／journal 收敛；非默认 `maxBackoffMs`＋injectable delay 证明真实 backend 消费每次等待上限。
- [x] `crash-replay.it.test.ts`：before journal／after journal／mid transaction／after commit before ACK 四窗口＋顺序重放＋old-generation ACK 拒绝。
- [x] `restart-policy.unit.test.ts`：注入 clock 测 bounded 指数 delay／consecutive failures／`nextRetryAt`／默认上限。
- [x] `fatal-state.unit.test.ts`：fatal 终结全部未 ACK 为 failed、reservation 各释放一次、后续 enqueue 立即 failed、`drain()` 确定性 reject、config waiter reject、与迟到旧 ACK 交错无双释放；另加 restart 窗口内 fatal／drain 两条。
- [x] 门禁与 mutation 正控（见下）。
- [ ] 独立 review 到 0 blocker／major，再 fast-forward 合 `master`，回填计划状态行。

## 门禁证据（commit `7f0c37a3`，worktree `.worktrees/history-worker-batch-2a`）

- `bun run typecheck` → 绿。
- `bunx eslint src/lib/history/worker src/lib/history/v3/store.ts src/lib/history/sqlite tests/history/worker` → 0 problems。
- `bun test tests/history/worker tests/history/v3 tests/history/sqlite tests/architecture` → 415 pass／0 fail（57 files）。
- `bun run test:backend` → **7323 pass／0 fail／7323 executed／35 skipped**（16 shards，77.87s）。

### Mutation 正控（三条，均为冻结 exact patch 注入＋反向恢复，恢复后 `git status` 干净、`git diff HEAD` 为空）

| 冻结件 | SHA-256 | 变异 | 观测到的红 | 旁路检验 |
|---|---|---|---|---|
| `/tmp/hw2a-mut/m1-maxbackoff.patch` | `4c783848…` | backend 不再把 `maxBackoffMs` 传给 `runWithTransientRetry` | 实测等待变成未加盖的 `[100,200,400,800,1600]`（期望 `[100,137,137,137,137]`） | 同文件另外 5 条仍绿 |
| `/tmp/hw2a-mut/m2-replay.patch` | `8d878807…` | restart 后不重放未 ACK envelope | 四个 crash window ＋顺序重放共 5 条红（outcome 永不落定＝记录静默丢失，故红的形态是超时而非断言） | generation-isolation 一条仍绿 |
| `/tmp/hw2a-mut/m3-fatal-order.patch` | `6e48f65f…` | fatal 时不在结算前先发布状态 | `waiter was admitted after the runtime went terminal-failed` | 同文件另外 8 条仍绿 |

## 已改动的既有守卫（`red-tests-may-be-guarding-something`，逐条落盘待评审裁决）

1. **`runtime.it.test.ts` 四处 `emitError` → `fatalMessage`。** 守的不变量是「terminal-failed 时回调与请求各结算一次、observer 错误被隔离」，不是「transport error 即 terminal」。Batch 2a 按 spec §7.1／§13.5 让普通 crash 变成可恢复重放，故触发器换成 `fatal`；不变量原样保留。
2. **`rejects startup when the Worker exits before ready` → `restarts instead of failing …`。** 旧断言冻结的是 Batch 0「任何 exit 即终态」。spec §7.1 明写「普通 crash／**可重试启动错误**走自动重启」，故改为断言 restart＋consecutiveFailures＋`nextRetryAt`，并要求后续 ready 解决同一个 `start()` promise——覆盖面变大而非变小。
3. **`real source Worker … failed ACK` → `persisted ACK`。** 旧值断言的是 Batch 0 占位 backend 的硬编码 `"failed"`，属于「占位数据的机械更新」，外部 oracle 是真实落盘。
4. **`settles callbacks and requests before isolating status observer errors` → `isolates status observer errors without preventing…`。** fatal 现在发布两次状态（先给 admission close 信号、后带最终计数），观察者被调用 2 次。字面顺序断言与 spec §7.2 的步骤 2→3 冲突，故改为断言真正要守的性质：抛异常的 observer 不阻止结算。
5. **`packaged-runtime.it.test.ts` 构建目录移入仓库内 `dist/`。** 打包后的 worker bundle 现在与 `main.mjs` 一样依赖外部化的 `consola`；ESM 从**文件位置**向上找 node_modules，放在 `os.tmpdir()` 会让 Node 侧 `ERR_MODULE_NOT_FOUND`——那是测试放置位置的产物，不是 bundle 的缺陷。
6. **`entry-test-discovery-baseline.json`**：新增 4 个测试文件进 `files`，`minimum_executed` 7279 → 7323（实测 executed 值，命令＝`bun run test:backend`，commit `7f0c37a3`）。
7. **删除 `runtime.ts` 的 `createInProcessHistoryPersistenceRuntime`／`InProcessHistoryWorkerTransport`**，改为测试 fixture `tests/history/worker/fixtures/in-process-runtime.ts`：它跑**真实**消息循环＋**真实** backend，因此不可能比真 Worker 更友好（spec §12.1），同时把 `bun:sqlite`／压缩编解码挡在主线程模块图之外。生产侧无调用点（已 grep 确认）。

## 在途意图（决定与理由）

- **crash 注入不进生产协议。** 四个 crash window 由 `tests/history/worker/fixtures/` 下的 fixture worker entry 提供：它 import `backend.ts` 的真实消息循环与真实 backend，只额外传一个由 `workerData` 驱动的 crash hook。生产 `history-worker.ts` 仍是不带 hook 的薄入口，`protocol.ts` 不新增 test-only 字段。
- **crash 机制＝worker 线程内 `process.exit(code)`。** 已在本 worktree 实测（Bun）：worker 内 `process.exit(3)` 只杀该 worker，主线程收到 `exit:3` 且**不发 `error`**，主进程存活。因此 runtime 必须把「非预期 `exit`」当普通 crash 走重启，不能当 fatal。
- **`maxBackoffMs` 消费证据走文件回读。** Worker 不能回传闭包，且 `parseWorkerToMainMessage` 会拒绝未知消息类型；fixture worker 把每次注入 delay 的实测毫秒写入 `workerData` 指定的临时文件，测试读该文件断言「每次等待 ≤ 非默认 cap 且至少一次触到 cap」。删掉 backend 对 `maxBackoffMs` 的传递后等待会按 `backoffMs * 2^n` 增长并越过 cap，该用例必须红。
- **transient 失败用既有 `setV3CommitFailureInjectorForTests` 制造**（抛 `database is locked`，persist-guard 归为 transient），不新造分类通道。
- **restart-policy 测试单独成文件。** Task 2a 的 Files 清单只列三份测试，但 File Structure 的 `tests/history/worker/*.unit.test.ts` 通配已覆盖；把 restart policy 断言塞进 `fatal-state.unit.test.ts` 会造成名实不符，故新建 `restart-policy.unit.test.ts`。

## 执行期发现（实现前未预见）

- **fatal 的发布必须早于结算。** 写「reservation 各释放一次」用例时才发现：结算未 ACK 项会释放 reservation，而释放会唤醒 FIFO waiter；若订阅者尚未 `admission.close()`，那个 waiter 会拿到一个「History 永远写不成」的准入。spec §7.2 的步骤顺序（步骤 2 关闭 admission 早于步骤 3 终结未 ACK）正是防这个，实现据此调整并由 M3 变异钉住。
- **restart 窗口里 `drain()` 原本会杀掉 runtime。** 崩溃到新 generation 之间没有 transport，`send()` 旧实现直接 `throw` → terminal-failed，与 spec §8.2「drain 中普通 crash 仍重启、重放并继续 drain」冲突。改为：已启动且非终态时**挂起**该消息，请求在 ready 之后再补发。
- **补发必须晚于重放。** Worker 串行处理收到的消息，若 `drain` 在重放之前补发，它会对「主线程队列里还没送出去的 envelope」报告「已全部落定」——一个会撒谎的 drain barrier。故 `reissueOutstandingRequests()` 排在 `replayPendingEnvelopes()` 之后。
- **bun 1.3.14 harness 陷阱：** `expect(pending).rejects.toThrow(...)` 若在 promise **尚未** reject 时创建，会把整个测试文件挂死（无任何输出，`-t` 过滤也一样），已用两行探针复现。改用 `.then(onFulfilled, onRejected)` 捕获后再断言。

## 已作废的路线

- 不给 `initialize`／`HistoryWorkerStartConfig` 加 test-only crash 字段：生产协议不为测试开洞。
- 不用「主线程 `worker.terminate()`」当 crash 注入：它无法停在 journal 之后／事务之中这类 worker 内部时刻，四个窗口会退化成同一个。
- 不让 backend 读 `getDatabase()` 主线程单例：Worker handle 必须显式传入，否则 Batch 6c 删除主线程 connection 时会留下隐式依赖。

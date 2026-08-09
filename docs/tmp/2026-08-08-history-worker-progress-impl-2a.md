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
- [x] `backend.ts`：Worker 内 semantic open→owner/schema→`applyForwardMigrations`→`recoverV3Journal`；`persist-operation` 走 prepare→journal→transaction→ACK；retry 消费完整四字段 `persistRetry`（四条均有变异对照，见下表），delay 经 `runWithTransientRetry` 的新 `delay` seam 注入。
- [x] `restart-policy.ts`：有上限指数 backoff、consecutive failures、`nextRetryAt`，clock 可注入。
- [x] `runtime.ts` 加 restart／replay：普通 crash（`error`／非预期 `exit`）保留未 ACK envelope 并按 messageId 原序重放；`fatal` 才进 terminal-failed。
- [x] `semantic-backend.it.test.ts`：临时磁盘 DB＋独立 readonly connection 验 operation／summary／tracks／timeline／objects／journal 收敛；非默认 `maxBackoffMs`＋injectable delay 证明真实 backend 消费每次等待上限；三种 outcome（`persisted`／`failed`／`conflict`）均有断言。
- [x] `crash-replay.it.test.ts`：**四个注入时刻**（before journal／after journal／mid transaction／after commit before ACK）＋顺序重放＋generation 隔离两个方向。
- [x] `restart-policy.unit.test.ts`：注入 clock 测 bounded 指数 delay／consecutive failures／`nextRetryAt`／默认上限。
- [x] `fatal-state.unit.test.ts`：fatal 终结全部未 ACK 为 failed、reservation 各释放一次、后续 enqueue 立即 failed、`drain()` 确定性 reject、config waiter reject、与迟到旧 ACK 交错无双释放；另加 restart 窗口内 fatal／drain 两条。
- [x] 评审发现的四处生产缺陷已修（journal recovery 静默吞失败／fatal 不终止 Worker／restart 携旧 config／backoff 期 shutdown 遗留未结算），另修一处实测发现的可重试启动错误被误判为 fatal。
- [x] 门禁与 mutation 正控（见下）。
- [ ] 独立 review 到 0 blocker／major，再 fast-forward 合 `master`，回填计划状态行。

## 门禁证据（commit `af5130ce`，worktree `.worktrees/history-worker-batch-2a`）

- `bun run typecheck` → 绿（exit 0）。
- `bunx eslint src/lib/history tests/history tests/architecture` → exit 0，0 problems。
- `bun run test:backend` → **7352 pass／0 fail／7352 executed／35 skipped**（16 shards，57.33s）。
- **flaky 复核：** poison-journal 用例最初在 `test:backend` 下 3 次红 2 次；定位为产品缺陷（可重试启动错误被判 fatal）并修复后，`test:backend` 连跑 5 次全绿。
- **收尾期观测到的争用型 false-red（不是本批引入，别当既有失败挥手放过，也别当本批回归）**：最后几次全量里出现过 3 条**互不相同**的红——`tests/history/v3/store-performance.it`「CAS live physical bytes …10x smaller」（两次，17.5s／19.8s，明显是计时）、`tests/telemetry/backfill-wiring.unit`「接线 3」、以及一次 `activeStreamCount …row 1 — pre-header req.error`。**判据三条**：①每条**单跑均绿**（perf 3 pass、telemetry 8 pass）；②**每次红的是不同的测试**——真回归会稳定咬同一条；③`git log master..HEAD -- tests/telemetry src/lib/telemetry` **为空**，本分支从未碰过遥测。故归类为 16-shard 负载下的争用敏感判据，与 `docs/todo/deferred-backlog.md` 已登记的「`store-performance.it` 的耗时比值断言在 16-shard 下间歇性失败」同族。**`executed` 恒为 7358**（=discovery floor），说明没有测试被静默跳过。

### Mutation 正控（第二轮，commit `290cfb9e`；第三轮见下节）

第一轮只有三条，**对抗性评审用 18 条冻结变异实测，其中 11 条全绿通过**——实现是对的，测试分不出它和一个坏实现。下表是补齐后的复测，每条均为「先冻结 exact patch → `git apply` 注入 → 实跑 → `git apply --reverse` 恢复 → `git status --porcelain` 复核为空」。命令均为 `bun test <文件>`，工作目录 `.worktrees/history-worker-batch-2a`。

| 变异 | SHA-256 前 12 | 改了什么 | 观测到的红 |
|---|---|---|---|
| `always_persisted` | `08c3eb06b3da` | `persist` 恒返回 `"persisted"` | permanent-failure ＋ maxTotalMs 两条 |
| `no_conflict` | `a43d543406a4` | 去掉 conflict 分支 | 同 id 不同 digest 一条 |
| `no_recovery` | `a4f5b059251a` | 启动不跑 `recoverV3Journal` | orphan-journal ＋ poison-journal 两条 |
| `ignore_journal_failures` | `3902aba841f9` | 恢复失败不再阻断 ready | poison-journal 一条 |
| `no_maxtotal` | `ef4d12f202b8` | 不传 `maxTotalMs` | maxTotalMs 一条 |
| `gen_isolation` | `ec07b85efffd` | generation 判据 `!==` → `>` | retired-generation 一条 |
| `reissue_order` | `5b93c511d903` | 补发与重放顺序对调 | drain-barrier 一条 |
| `crash_dedup` | `3ac649f3b2dd` | 去掉 `this.transport !== transport` | error＋exit 一条 |
| `restart_revision` | `bc8331f82941` | restart 不带 latest desired config | restart-config 一条 |
| `restart_delay` | `8d646ee4925f` | restart 延迟写死 0 | backoff 接线一条 |
| `replays_count` | `c7ca38bb786e` | 未发过的 envelope 也计入 replays | replaysTotal 一条 |
| `no_terminate_fatal` | `e97f87bbf5ae` | fatal 不终止 Worker | terminate 一条 |
| `shutdown_no_settle` | `3bfe6801ca9d` | backoff 期 shutdown 直接返回 | shutdown-backoff 一条 |
| `window_drift` | `9c2d0266e1c9` | 把 after-journal 注入点挪到 operations insert | after-journal 一条 |

**一条故意留绿、必须照实记：** `journal_in_tx`（`657abb676065`，把 journal INSERT 移进 operation 事务，使它不再是 write-ahead 账本）在 `crash-replay.it.test.ts` 上 **11 pass／0 fail**。这不是缺口被忽略，而是职责划分：四个 crash window 验的是**收敛**，而收敛由 runtime 的**重放**达成（未 ACK envelope 还在主线程队列里），与 journal 是否 write-ahead 无关；崩溃瞬间的行数在两种实现下相同，所以窗口断言也分不出来。write-ahead 性由 `tests/history/v3/store.it.test.ts` 守（该变异下它红 2 条），journal recovery 单独的判别力由 `semantic-backend.it.test.ts` 的 orphan-journal 用例守（`no_recovery` 变异下它红）。
**第二轮复审对本条的更正**（评审实测，我采纳）：在补齐后的 HEAD 上，该变异在 `tests/history/worker` 下**会红 1 条**（permanent-failure 用例）——但那是**偶然耦合**（journal 写入位置变了，失败注入器看到的东西也变了），**不是 write-ahead 性被守住**。结论不变、理由以本段为准。

### 第二轮复审新增的变异（commit `af5130ce`）

| 变异 | SHA-256 前 12 | 改了什么 | 观测到的红 |
|---|---|---|---|
| `retired_all_stale` | `4bada3cc732a` | 不区分退休 generation | 「崩溃后未替换前的 ACK 不被采信」一条 |
| `start_after_fatal2` | `b543a5a0e88d` | 去掉 terminal 后的 `start()` 拒绝 | 「二次 start 被拒」一条 |
| `no_tombstone_gen` | `88133b92a425` | tombstone 不比对 generation | 「跨代 ACK 属协议违规」一条 |
| `counters_after_callback` | `81b2494f6022` | 计数更新挪到回调之后 | 「回调看见结算后计数」一条 |
| `no_await_terminate` | `69411e866ab6` | shutdown 不等 Worker 关闭 | 「fatal 后 shutdown 等待关闭」一条 |

**已撤回的机制（用户裁决 2026-08-09）**：第三轮曾加过 `maxConsecutiveFailures`（默认 10，超限转 terminal）及其变异对照 `no_budget_cap`。两位评审对它结论相反——对抗性评审认定它闭合了「无限重启无终态」，spec 一致性评审认定它与冻结 spec §7.1／§7.2 冲突。**用户裁决撤掉上限、恢复字面合规**，改为登记 `docs/todo/deferred-backlog.md`：「Batch 2b 接线时必须给 History Worker 启动加截止时间」。现有测试改为断言**反向性质**——连续 12 次崩溃后仍非 terminal、envelope 仍在、第 13 代 ready 后恢复，即「不得凭次数合成终态」。

**仍无变异对照的既知项**（`no-silently-cut-but-defer`，留给 Batch 2b 或后续批次，不在本批修）：
- fatal 分支写 tombstone（当前 tombstone 判别力落在非终态路径上；评审两轮均实测该变异全绿）。
- `stopMaintenance()` 的空实现（Batch 4b 才有可停的东西）。
- **crash window 的 `(1,1)` 无法区分「事务中未提交」与「已提交但尚未删 journal」**：两者的判别完全依赖 `store.ts` 里 journal DELETE 恰好是事务最后一句；若有人把 DELETE 提到 operations INSERT 之前，`mid-transaction` 会读出 `(0,1)`＝`after-commit`，两个窗口静默互换身份而测试全绿。评审建议在 marker 里补 `inTransaction` 字段——**当前 driver 没有 in-transaction／autocommit 内省接口**（已 grep `packages/foundation/src/sqlite/driver.ts`），补它要先给 driver 加能力，超出 2a 范围。
- **in-process host 适配器的红是「整个测试进程死亡」而不是一条红**（`runtime.it.test.ts` 的 host 契约用例）：信号极响但形态特殊，接手者看到「测试跑着跑着进程没了」应先查这条。

## 已改动的既有守卫（`red-tests-may-be-guarding-something`，逐条落盘待评审裁决）

1. **`runtime.it.test.ts` 四处 `emitError` → `fatalMessage`。** 守的不变量是「terminal-failed 时回调与请求各结算一次、observer 错误被隔离」，不是「transport error 即 terminal」。Batch 2a 按 spec §7.1／§13.5 让普通 crash 变成可恢复重放，故触发器换成 `fatal`；不变量原样保留。
2. **`rejects startup when the Worker exits before ready` → `restarts instead of failing …`。** 旧断言冻结的是 Batch 0「任何 exit 即终态」。spec §7.1 明写「普通 crash／**可重试启动错误**走自动重启」，故改为断言 restart＋consecutiveFailures＋`nextRetryAt`，并要求后续 ready 解决同一个 `start()` promise——覆盖面变大而非变小。
3. **`real source Worker … failed ACK` → `persisted ACK`。** 旧值断言的是 Batch 0 占位 backend 的硬编码 `"failed"`，属于「占位数据的机械更新」，外部 oracle 是真实落盘。
4. **`settles callbacks and requests before isolating status observer errors` → `isolates status observer errors without preventing…`。** fatal 现在发布两次状态（先给 admission close 信号、后带最终计数），观察者被调用 2 次。字面顺序断言与 spec §7.2 的步骤 2→3 冲突，故改为断言真正要守的性质：抛异常的 observer 不阻止结算。
5. **`packaged-runtime.it.test.ts` 构建目录移入仓库内 `dist/`。** 打包后的 worker bundle 现在与 `main.mjs` 一样依赖外部化的 `consola`；ESM 从**文件位置**向上找 node_modules，放在 `os.tmpdir()` 会让 Node 侧 `ERR_MODULE_NOT_FOUND`——那是测试放置位置的产物，不是 bundle 的缺陷。
6. **`entry-test-discovery-baseline.json`**：新增 6 个测试文件进 `files`，`minimum_executed` 7279 → 7352（实测 executed 值，命令＝`bun run test:backend`，commit `af5130ce`）。
7. **删除 `runtime.ts` 的 `createInProcessHistoryPersistenceRuntime`／`InProcessHistoryWorkerTransport`**，改为测试 fixture `tests/history/worker/fixtures/in-process-runtime.ts`：它跑**真实**消息循环＋**真实** backend，因此不可能比真 Worker 更友好（spec §12.1），同时把 `bun:sqlite`／压缩编解码挡在主线程模块图之外。生产侧无调用点（已 grep 确认）。
8. **`recoverV3Journal` 返回值由 `number` 改为 `{ recovered, failures }`。** 守的不变量是「未提交 journal 行会被重放」，不是「返回一个计数」；旧签名把恢复失败写进 `error` 列后咽掉，调用方无从得知。`store.it.test.ts:313` 的 `toBe(1)` → `toEqual({ recovered: 1, failures: [] })` 属占位断言的机械更新（外部 oracle 是真实落盘行）。**注意范围**：`state.ts` 的 legacy 主线程 writer 保持原行为（只新增 error 日志），因为它仍是 Batch 2b 之前的生产权威，把损坏行变成启动失败会改变已发布行为（§11.2 第 3 条）。
9. **`HistoryWorkerReady` 新增必填 `recoveredJournalOperations`。** 四处手写 ready 字面量（`scripted-transport.ts`／`runtime.it.test.ts` 的 `readyMessage`／`protocol.unit.test.ts` 两处）补该字段，属协议 schema 驱动的占位数据更新——18 条红全部是同一机械成因，无一条是断言被放宽。

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
- **可重试启动错误被误判为 fatal（由一次 flaky 红暴露的真缺陷）。** 新写的 poison-journal 用例在 `bun run test:backend` 下 3 次里红 2 次，收到的是 `database is locked` 而不是预期消息。追下去发现是产品缺陷而非测试问题：Worker 把**任何** initialize 抛错都变成 `fatal`，于是负载下一瞬间的 `SQLITE_BUSY` 会让 History 在整个进程生命周期内不可恢复——与 spec §7.1「普通 crash／**可重试启动错误**走自动重启」冲突。修法不加新协议消息（`fatal` 按定义即终态），而是让 Worker 以专用退出码结束线程，走既有的重启路径。修完 `test:backend` 连跑多次全绿（最终口径 7352 pass／0 fail @ `af5130ce`）。
- **对抗性评审的判别力结论比功能结论重要。** 18 条变异 11 条全绿，说明「N 条测试全绿＋每项都有变异对照」这种汇报会让读者高估覆盖面——三条变异只证明了「已写的那三条判据会红」，证明不了判据覆盖了该覆盖的面。上面的第二轮表格连同「故意留绿」那条一起记，正是为了不再制造这种高估。
- **修一条约束时新引入了两条（第二轮复审抓到）。** ① 让 fatal 终止 Worker → `transport` 变 undefined → `start()` 的「已启动」守卫失效 → 二次 `start()` 会清掉 sticky fatal 标志。② 补 generation 退休后，最初写成「退休代的**所有**消息都作废」，把 `fatal` 也挡掉了——而 `fatal` 报的是替代代只会重新撞上的永久条件，挡掉它等于多赔一轮必败的重启。两条都由已有用例当场变红抓到，教训是 `fix-one-constraint-violates-sibling-constraint`：改一处状态转移后，要回头看**依赖同一状态**的其他判断。
- **无限重试比一次响亮的失败更糟——但「修哪一层」不是实现者能自己定的。** 可重试启动错误修完后，持续失败变成「delay 封顶 30s、`start()` 永不 settle、§8.1 永不监听」——进程看着活着、什么都不做，取代了原来的 exit 1。**这一条是我自己没想到、对抗性评审提出的**，而我先前给用户的汇报里还把「30s 封顶所以不是风暴」当成结论——那个判断只回答了「是不是风暴」，没回答「有没有终态」。我随后在 runtime 里加了次数上限，**又被 spec 一致性评审判为与冻结 spec 冲突**：§7.2 的 fatal 成因是「已知永久」的条件，「试了 N 次」不是。两位评审结论相反、且争的是冻结 spec 的行为契约，**已交用户裁决：撤掉上限，把 deadline 归给拥有进程启动的一方（Batch 2b），登记进 `docs/todo/deferred-backlog.md`**。教训有两层：①「有没有终态」是比「是不是风暴」更该问的问题；②**发现缺陷 ≠ 有权选修复层**，缺陷真实并不代表可以在冻结契约上单方面开新终态。
- **bun 的 per-test timeout 拦不住悬挂的 `.rejects`。** 跑 `start_after_fatal` 变异时整个文件挂死 >5 分钟、两次被外部 timeout 杀掉（第二次连 `}, 10_000)` 显式超时都没用）。改成 `Promise.race` 对短定时器后，同一变异 1 秒内变红。**推论：任何「断言某 promise 会 reject」的用例，若被测缺陷会让该 promise 永不 settle，就必须用 race 而不是 `.rejects`**，否则它的变异对照拿不到可用的红。

## 已作废的路线

- 不给 `initialize`／`HistoryWorkerStartConfig` 加 test-only crash 字段：生产协议不为测试开洞。
- 不用「主线程 `worker.terminate()`」当 crash 注入：它无法停在 journal 之后／事务之中这类 worker 内部时刻，四个窗口会退化成同一个。
- 不让 backend 读 `getDatabase()` 主线程单例：Worker handle 必须显式传入，否则 Batch 6c 删除主线程 connection 时会留下隐式依赖。

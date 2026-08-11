# Batch 2b 测试可信度评审（testing 视角）——专找假绿

- **锚点**：HEAD `389cec95`，范围 `git diff baef58b3..HEAD -- tests/`。评审期间 HEAD 从 `a49f278b` 前进到 `389cec95`，本文所有实测均在 `389cec95` 上复跑。
- **裁判轴**：长远正确 + 完整；不因改动大扣分。唯一问题是**绿是不是廉价的绿**。
- **取证环境**：`/tmp/b2b-mutation-tree`（worktree 只读拷贝 + 主树 `node_modules` 软链），变异全部在副本上跑；**worktree 内除本文件外未做任何修改**。基线对照树 `/tmp/b2b-base-tree`（`git archive baef58b3`）。
- **方法（沿用派活方给的范式）**：对每份新测试构造「实现坏掉但它照绿」的场景，能构造出来就是缺口；构造不出来则如实列出试过的反例方向。
- **状态**：本轮先交**第 1 个缺口**，按要求边查边落盘。

---

## 缺口 1

### [blocker] `tests/history/worker/event-loop-isolation.it.test.ts` —— 真 Worker 臂没有正控：**Worker 根本没阻塞时，整份文件照绿**

**坏实现**：注入的 500ms 同步阻塞**从未在 Worker 线程里执行**（`workerData` 通道断了 / 键名改了 / fixture 入口被换掉）。

**为什么会照绿**：阻塞量是通过 `workerData` 传进 Worker 的，而缺失值会被**静默吞掉**，不会报错。

`tests/history/worker/fixtures/blocking-backend-worker.ts` 末两行：

```ts
const fixture = workerData as BlockingBackendFixture
installHistoryWorkerMessageLoop(parentPort, withSynchronousBlock(createHistoryWorkerBackend(), fixture.blockMs))
```

`tests/history/worker/fixtures/blocking-backend.ts` 的 `busyWaitMs`：

```ts
const until = Date.now() + ms
while (Date.now() < until) { /* spin */ }
```

`ms` 为 `undefined` 时 `until` 是 `NaN`，`Date.now() < NaN` 恒假，**循环一次都不进**。于是「真 Worker 阻塞了 500ms 而主线程仍然响应」与「Worker 压根没阻塞、主线程当然响应」这两个世界，本文件的判据分不出来。

**实测（变异 E，HEAD `389cec95`，副本树）**：把 fixture 改成读一个不存在的键（`(workerData as X | undefined)?.blockMsTypo`，等价于通道断了），单跑该文件：

```
基线            1 pass 0 fail
MUT-E（Worker 臂零阻塞）  1 pass 0 fail
```

**为什么现有的控制拦不住它**：

- 负控（`expect(inProcess.stall).toBeGreaterThanOrEqual(BLOCK_MS * 0.8)`，`:118`）只证明 **in-process 臂**能冻结、metronome 不瞎；它对 Worker 臂里那份注入是否生效**一无所知**——两臂虽然共用 `withSynchronousBlock`，但**注入参数走的是两条不同的通道**（in-process 直接闭包传参，Worker 走 `workerData` 序列化），断掉的恰恰是后者。
- `expect(inProcess.stall).toBeGreaterThan(worker.stall * 2)`（`:122`）在 `worker.stall ≈ 0` 时**更容易**成立，方向与拦截相反。
- `expect(outcome).toBe("persisted")`（`:103`）只证明「有活干过」，不证明「那活是慢的」。
- 这与派活方已证实的那条 e2e 教训是**同一形态**：断言集合里的每一条在坏实现下都有别的成立理由，缺的是「被测的那件事确实发生过」这一条正控。

**修法**：给 Worker 臂补一条对称的正控——测 `driveOneOperation` 的**总耗时**（Worker 侧真实花掉的时间），断言 `≥ BLOCK_MS * 2 * 0.8`（两个注入点：`initialize` + `persist`），与既有的 `worker.stall < BLOCK_MS * 0.5` 并置。两者同时成立才等于「活确实很慢，但慢在别的线程」。另把 `blockMs` 的缺省从「隐式 `NaN`」改成显式抛错（`busyWaitMs` 对非有限值 throw，或 fixture 入口校验 `workerData`），让通道断裂当场变红而不是变成零阻塞。

> **缺口 1 已被派活方修复并用同一变异手法验证（提交 `fb29504c`）**：`busyWaitMs` 拒绝非有限值（修在共用基座）、fixture 入口缺 `workerData.blockMs` 抛错、测试补 `worker.elapsed` 正控。本节保留作记录。以下缺口 2–6 锚定 **HEAD `1d44fc37`**。

---

## 缺口 2

### [blocker] `tests/helpers/isolated-fixture.ts:164` —— 129 个 fixture 文件里，**第 2 个用例起生产落盘路径完全失效，且静默**

这一条不在你点名的 6 份里，但它是**这 6 份为什么每一份都不得不在自己的 `beforeEach` 里先 `await initHistory(false)` 再重新拉起**的根因（`bringup-lifecycle:169`、`delivery-ack-ordering:174`、`semantic-cutover:169` 三处注释各自独立地描述了同一个症状）。那些 `initHistory(false)` 是**绕过**，不是修复；绕过之外的 129 个文件仍然踩在坑里。

**机制**：`RESETTERS` 里注册了 `{ name: "releaseHistoryPersistenceRuntime", reset: releaseHistoryPersistenceRuntime }`，它在 `afterEach` 的**最后**执行——晚于同一个 `afterEach` 里的 `resetTestRuntime()`（`isolated-fixture.ts:296-300`）。`resetTestRuntime()` 刚通过 `initHistory(true, 100)` 建好并 `start()` 了一个 runtime，并让 admission 的 sink 指向它（`state.ts:216`）；紧接着 `releaseHistoryPersistenceRuntime()` 把它 `shutdown()` 并摘出 registry。于是下一个用例整个生命周期里：

- `peekHistoryPersistenceRuntime()` 是 `undefined`；
- admission 的 sink 仍指着那个**已 shutdown** 的 runtime；
- `runtime.enqueue()` 命中 `runtime.ts:188` 的 `this.stopped` 分支，**当场以 `"failed"` 结算，不写盘、不抛错、不打日志**。

**实测（HEAD `1d44fc37`，探针在 `/tmp/b2b-mutation-tree`，走完整生产链：bind reservation → `publishModelOperationTerminal` → `drainModelOperationTerminalSubscribers` → 直接查 `v3_operations`）**：

```
PROBE t1 runtime=present    persisted=1 durability=undefined
PROBE t2 runtime=undefined  persisted=0 durability=failed     ← 同一份代码，只因为它是第 2 个用例
```

**正控（base `baef58b3`，同一探针）**：

```
PROBE runtime-at-test-start=undefined
PROBE persisted-rows=1 durability=undefined
```

base 上同样没有 runtime 却落盘成功——彼时 admission 的 sink 是进程内 `LegacyHistoryTerminalSink`，registry 的释放与它无关。**所以这是 2b 引入的回归，不是既有状态**，且在 `1d44fc37` 上依然复现。

**为什么这是「廉价的绿」的总源头**：它使「发一个请求 → 断言 History 里有这条记录」这类端到端断言在 129 个文件里**结构性地无法成立**，剩下的路只有「用 `commitV3HistoryEntry` 直接播种」——本批大量既有测试正是这样被改写的。测试基座被改成了能通过的形状，而坏掉的接缝没人看得见。

**修法**：`releaseHistoryPersistenceRuntime` 不该在 `RESETTERS` 里——它清的是「本进程 History 的写者」，不是「某个测试注入的 mock」。防 mock 泄漏应该 reset `setHistoryPersistenceRuntimeForTests(undefined)` 那一层，registry 单例的生命周期交给 `resetTestRuntime()` 的 `initHistory` 自愈分支。改完必须补一条**留在 fixture 里**的端到端回归（第 2 个用例发一次真实请求并断言落盘），否则同一个洞会再开。

---

## 缺口 3

### [major] `initHistoryWithinStartupDeadline` 的 `deadlineMs <= 0`（文档化的「永久等待」opt-out）**没有任何行为覆盖**——把它反转成「立刻放弃」，两份 deadline 测试全绿

`startup-deadline.ts` 的短路是 `if (!enable || deadlineMs <= 0)`，文档写明「`deadlineMs <= 0` 关闭 deadline（永久等待）」，配置侧也把它当作显式 opt-out（`history-startup-deadline-config.unit.test.ts:105-110`「0 is honoured as an explicit opt-out (wait forever)」）。但那条用例只断言 **getter 返回 0**，从不驱动行为。

**变异 L**：`deadlineMs <= 0` → `deadlineMs < 0`。语义后果：配了 `startup_deadline_ms: 0` 的运维得到的不是「一直等」，而是**一个 0ms 的定时器立刻开火**，每一次健康启动都以 `startup deadline exceeded ... within 0ms` 退出 1。实测（HEAD `1d44fc37`，副本树）：

```
基线   tests/history/worker/startup-deadline.it.test.ts + tests/config/history-startup-deadline-config.unit.test.ts  →  10 pass 0 fail
MUT-L  同上                                                                                                        →  10 pass 0 fail
```

这与 config 测试 `:92-97`「a value past the JS timer ceiling never becomes an instant deadline」是**同一类反转**——上界那侧写了行为判据，下界这侧只写了 getter 判据。缺口正好落在两条判据**之间**。

**修法**：在 `startup-deadline.it.test.ts` 加一条行为用例：装一个永不 settle 的 `NeverReadyRuntime`，`initHistoryWithinStartupDeadline(true, 0)`，用 `Promise.race` 对一个短定时器断言它**在该定时器到期时仍未 settle**（而不是断言它 reject），跑完 `abandon()` 收尾。这条判据同时覆盖 `0` 与负值两个入口。

---

## 缺口 4

### [minor] deadline 成功路径上的定时器泄漏无人看见——删掉 `clearTimeout` 全绿

`startup-deadline.ts` 的 `finally { if (timer) clearTimeout(timer) }` 是唯一防止「bring-up 成功后仍挂着一个最长 30s 的定时器」的地方。**变异 J**（删掉该行）实测：`10 pass 0 fail`，与基线一致。

后果是有界但真实的：定时器会让事件循环在**每一次成功的 History 启动之后**多存活至多 `startup_deadline_ms`。对常驻 server 无感，对任何跑完就该退出的路径（CLI 子命令、测试进程、未来的一次性工具）就是最长 30 秒的假挂起。

**修法**：在既有的「a bring-up that fails on its own propagates that failure」用例之后追加一条：成功路径下 `initHistoryWithinStartupDeadline(true, 30_000)` 返回后，断言进程没有残留 timer（Bun 下可用 `setHistoryStartupDeadlineMs` + 一个可注入的 `setTimeout` seam，或退一步用 `process._getActiveHandles`/计数式 fake timer）。若判据成本过高，至少把这条写进注释说明「未覆盖」，别让读者以为 `finally` 有守卫。

---

## 缺口 5

### [minor] `bringup-lifecycle.it.test.ts` 的「竞争 readonly handle」看不见**我们自己那个句柄被泄漏**

`state.ts` 回滚里那句 `else readDatabase.close()` 处理的正是这条路径：`openDatabaseReadonly()` 成功、`installHistoryReadDatabase()` 因为别人已发布而拒绝——此时**我们开出来的那个句柄既没发布也没人持有**，只能由这里关掉。

第 3 条用例断言了 `peekHistoryReadDatabase()).toBe(competitor)` 以及（你新加的）competitor 仍可用，但**没有任何断言覆盖「我们那个句柄」的归宿**。**变异 H**（删掉 `else readDatabase.close()`）实测：`6 pass 0 fail`，与基线一致。泄漏的是一个真实 fd + 一个 SQLite 读锁，且每次失败的 bring-up 再泄一个。

**修法**：这条不需要新机制——Linux 下可直接数 `/proc/self/fd` 中指向该 `dbPath` 的条目，在 bring-up 失败前后各取一次，断言只多出 competitor 那一个。（作为对照，把 `else readDatabase.close()` 删掉时该断言必须变红。）若不想依赖 `/proc`，退而求其次是给 `openDatabaseReadonly` 加一个测试可见的 open/close 计数 seam。

---

## 缺口 6

### [major] 两种运行形态都红，而且**失败集互不相交**——「绿」取决于同进程里还有谁

同一棵树、HEAD `1d44fc37`：

| 命令 | 结果 | 红的是谁 |
|---|---|---|
| `bun test tests/history` | **617 pass / 3 fail** | `crash-replay.it.test.ts` 的三条 `converges to exactly one operation after a crash *`（`Expected 1, Received 6`） |
| `bun test --parallel tests/history` | **615 pass / 5 fail** | `history-api.it` 三条、`history-store.it` 的 `clearHistory > removes all entries`、`durability-overlay.it` 的 `retains failed after the writer gives up` |

`crash-replay.it.test.ts` **单跑 12 pass / 0 fail**——它在共享进程里数到 6 条遗留操作，是磁盘产物跨文件累积的直接读数。`--parallel`（即 `test:unit`/`test:it`/`test:http`/`test:backend:isolated`/`test:cov` 五个脚本的形态）那 5 条则源于两个**只由 `bootstrapTestRuntime()` 安装、进程级不重置**的设施：`setHistoryStoreWipeForTests`（不装则 `clearHistory()` 只清 in-flight）与 `installInProcessHistoryRuntimeFactory()`（不装则 `initHistory(true)` 拉起**真 Worker**，主线程的故障注入器对它无效）。

**决定性对照**（`389cec95` 上测，机制未变）：把 `tests/history/history-store.it.test.ts` 与一个**字典序更靠前**的 `useIsolatedRuntime` 文件放进同一进程 → **32 pass / 0 fail**；换成字典序更靠后的 → **41 pass / 1 fail**。同一个用例的成败取决于同分片里有没有、以及在不在它前面跑过一个 bootstrap 文件。这不是绿，是抽签。

**修法**：让「拿 `historyTestDbPath()`」与「装 wipe seam + in-process factory」成为不可分割的一步（导出一个幂等的 `installHistoryTestBackend()`，或把这两项挪进 `bunfig` preload，与 `sandbox-paths.ts` 同层），并给「同进程第二个文件看到的是空库」加一条守卫测试。

---

## 未找到缺口的部分（试过哪些反例方向）

**`tests/history/worker/delivery-ack-ordering.http.test.ts` —— 未找到缺口。** 试过的方向：① 结构性论证本身（永不 ACK 的替身 ⇒ 若交付真的等 ACK，请求无法完成 ⇒ bun 超时判红）——成立；② 「envelope 根本没到 runtime，断言却因为别的原因成立」——用变异 A（把 `request.ts:987` 的 `if (isHistoryPersistenceReservation(...))` 改成恒假，即生产路径永不 publish）实测该文件 **0 pass / 1 fail**，说明它与生产发布点真有耦合，不是自说自话；③ 「`settleTerminalPublication()` 只推 50 个微任务、若发布路径跨了宏任务边界会不会假绿」——那种情况下 `expect(runtime.envelopes).toHaveLength(1)` 变红而非变绿，方向安全。**唯一要记的边界**：它的 `beforeEach` 自己做了 `initHistory(false)` + 重新拉起，因此绕开了缺口 2；它证明的是「接线正确时交付不等 ACK」，**不能顺带证明那 129 个只靠 fixture 的文件里接线是好的**。

**`tests/history/worker/bringup-lifecycle.it.test.ts` 的其余 5 条 —— 未找到缺口。** 试过：撤掉事务回滚里的 `if (peekHistoryPersistenceRuntime() === runtime) await releaseHistoryPersistenceRuntime()` → **3 pass / 3 fail**；把 `serializeHistoryLifecycle` 的 `lifecycleTail.then(transition, transition)` 换成 `Promise.resolve().then(transition)`（撤掉串行化）→ **4 pass / 2 fail**；把 `startedDbPath = dbPath` 提前到 readonly 安装之前（顺序反转）→ **5 pass / 1 fail**。三个变异都打在目标机制上、红的用例也正是对应那两条 property。你自审修的「竞争 readonly handle 加『句柄仍可用』断言」我独立复核过：`close 但保留发布` 这一形态确实只有加了可用性断言才抓得到，原来的对象身份断言在 close 之后依然成立。唯一没被覆盖的是缺口 5 那条。

**`tests/config/history-startup-deadline-config.unit.test.ts` —— 未找到独立缺口**（它的空白已由缺口 3 表达）。试过：① 「absent key 保持默认」是否空过——`beforeEach` 先把值置回 `HISTORY_STARTUP_DEADLINE_MS`，所以「config 层什么都不做」也会绿，属**弱判据**，但它要断的语义（缺键不改值）本身就允许「什么都不做」，不构成假绿；② 断掉 `config.ts:959` 的接线 → `applyConfigToState feeds the configured deadline` 变红，接线是真的被覆盖的；③ 上界反转（`MAX + 1` 变成近零 deadline）有行为方向的判据（`> 1000`），下界（0）没有——那正是缺口 3。

**`tests/history/worker/startup-deadline.it.test.ts` 的其余 3 条 —— 未找到缺口。** 你修的「禁用不受 deadline 约束」我复核过：改成「替身关闭耗时 80ms、deadline 1ms」之后，`expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60)` 才真正区分「走了短路」与「被 deadline 砍断」，原版确实是空过。前两条（stuck → deadline 错误带计数器；自行失败 → 传播原因不包装成 deadline）我试过互换 `NeverReadyRuntime` 的两种模式、以及把 `HistoryStartupDeadlineError` 的计数器改成读常量，均能变红。

---

## 关于 e2e 的第三种 marker（不依赖日志文本）

你给的两条已证伪的候选（扩到 `warn` 是假红；`telemetry.db` 惰性创建、无判别力）我都认可，并且认为它们失败的原因是**同一个**：都在找「下一阶段留下的痕迹」，而下一阶段在这个 fixture 里**本来就会失败得很早**（缺 token），所以正确与坏掉两种进程留下的痕迹天然相同。**换 marker 换不掉这个前提，得换掉前提本身。** 三个方向，按我的推荐排序：

1. **给 History 阶段一个专属退出码（推荐）。** 把 `packages/cli/src/start.ts:395` 的 `process.exit(1)` 换成一个具名常量（比如 `EXIT_HISTORY_STARTUP_DEADLINE = 70`），e2e 断言 `exitCode === 70`。这一下把 oracle 变成**结构性、无文本、且与「后面因别的原因死掉」天然不共享取值**——正是你那条教训里所有断言一起失效的根因（大家都退 1）。这是一处生产改动，但它本身就是对的：不同致命原因给不同退出码是运维应得的（`systemd` 的 `RestartPreventExitStatus`、监控告警都能直接用），不是为测试而加的钩子。代价：需要在 `docs/API.md` 或 README 记一行退出码表。
2. **把「缺 token」这个提前死因移除，让 `everAcceptedAConnection` 重新获得判别力（不改生产）。** 现在这条断言恒为 `false`，两种世界都成立；而只要后续阶段**能走通到 listen**，「忘了 exit」就会真的开始监听，`everAcceptedAConnection === true` 当场变红。做法是给这一次 spawn 传 `--github-token <伪造值>` 并把上游指向一个本地 stub。**诚实的前提**：我没有实测过伪造 token 能否走完 `initTokenManagers`（`start.ts:456`）而不发真实网络请求——如果它必须换取 Copilot token，这条就要连 stub upstream 一起搭，成本明显高于方案 1。**请勿在未实测前采用。**
3. **换一个「一定被 eager 创建」的下一阶段痕迹。** 逻辑上可行，但需要先在 `start.ts` 里找出 History 之后**第一个无条件写盘**的动作并确认它不是惰性的；`telemetry.db` 的教训说明这需要逐个实测而不是读代码判断。作为方案 1 的备胎。

**另外一条与 marker 无关、但影响这份 e2e 可信度的观察**：`afterEach` 里的 `spawnSync(["pkill", "-9", "-f", "main.ts start --port ${PORT}"])` 依赖 `PORT` 的唯一性来避免误伤。`PORT` 是 `42000 + random(2000)`，**没有占用检查**；在本仓「常有并发 agent 会话同时跑测试」的前提下，两个会话抽到同一个端口时，后者的 `pkill` 会打掉前者的被测进程（表现为 `signalCode` 非 null、`exitCode` 为 null，恰好撞上 `:118` 的断言）。建议把匹配式再收窄一格（把临时 `XDG_DATA_HOME` 路径也放进 `-f` 模式，它是本次运行唯一的），这样即使端口碰撞也不会误杀。

---

## 最终 verdict

**存在阻断合并的假绿：是。** 具体是缺口 2（blocker）与缺口 6（major，两种形态都红且失败集不相交）。

- **缺口 2** 不是「某条断言写弱了」，而是**测试基座使一整类端到端断言无法成立**，并且这一批已经在用「直接播种」和「每份新测试自己 `initHistory(false)`」来适应它。这类缺陷的代价不在本批，在下一个以为 fixture 会把请求落盘的人身上。
- **缺口 6** 意味着当前分支在 5 个已命名档位上是红的，而在默认档位上因为分片组成不同而红在另外三条；任何一侧的「全绿」都不能代表另一侧。
- 缺口 3 / 4 / 5 不阻断合并，但缺口 3 的形态（上界有行为判据、下界只有 getter 判据）值得单独记一笔——它正是 `gaps-between-criteria-not-within` 的实例：每条判据单看都对，缝在两条之间。

你点名的 6 份新测试**本身**质量高于本批被改写的既有测试：`bringup-lifecycle`、`delivery-ack-ordering`、`startup-deadline`（修后）、`event-loop-isolation`（修后）我都用变异打过且能变红；`config` 单测的接线是真覆盖的；e2e 的结构性 marker 问题有解（方案 1）。**阻断项全部落在它们之外的基座上。**

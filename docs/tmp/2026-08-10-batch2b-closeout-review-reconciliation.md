# `discover_nonfile_candidates` 独立双向对账

## 评审范围与方法

- 事件源：`/home/xp/.claude/projects/-home-xp-src-copilot-api-js/90838c7c-2dd4-461a-a8e2-77529f4540ed.jsonl`，`wc -l` 独立计得 6096 条 JSONL。
- 仓库：`/home/xp/src/copilot-api-js` 当前本地 `master`；按需核对已移除的特性 worktree 与 Git 对象。
- job tmp：`/home/xp/.claude/jobs/90838c7c/tmp`。开始时用 `find … \( -type f -o -type l \)` 得 170 项；包含本报告，故与派活时的 169 项一致。
- 顺序：先枚举并冻结 I1～I16，再首次读取作者清单；随后为覆盖 transcript 合并后半段继续按同一事件源补 I17～I22。没有用作者条目反向生成独立集合。
- 扫描词簇：`abandon/放弃/作废/改为`、`falsify/disprove/证伪/推翻`、`wrong/cwd/worktree/remove/14 fail`、`calibration/标定/threshold/pass/fail`、`mutation/变异/positive control`、`probe/能力/retryable/SQLite`；并顺序深读命中区间的 tool_use/tool_result。

## 独立枚举

| ID | 类别与事件 | transcript／文件证据 |
|---|---|---|
| I1 | **范围错误**：`backend13.log` 的 `test:backend` 在主检出运行，7722 executed、7708 pass、**14 fail**、9 skipped、exit 1；绑定特性树重跑为 7382 pass、0 fail、36 skipped。 | JSONL 4951、4959、4962、4965。4965 直接打印旧 cwd `/home/xp/src/copilot-api-js` 与新 cwd `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a`。 |
| I2 | **变异假绿**：删 CLI deadline catch 的 `process.exit(1)`，第一版四断言仍全绿；进程继续到 Phase 4，因缺 token 非零退出，耗时 7206ms vs 7180ms。加 post-deadline 判据后变异才红，后又收紧为 exact exit 1 + no signal。 | JSONL 4375、4381、4397、4428、4456、4579、4611～4647。变异符号→`packages/cli/src/start.ts`；测试→`tests/e2e/history-startup-deadline.e2e.test.ts`。 |
| I3 | **否决路线／能力探针**：用 `telemetry.db` 是否出现作为“继续执行”的 marker；正确态与删 exit 的变异态目录都只有 `history-v3.db logs github_token config.yaml`，因 DB 惰性创建而零判别力。 | JSONL 4597、4600、4604～4610。只否定此 marker，不证明 telemetry 初始化完全没执行。 |
| I4 | **否决路线／false-red**：把 post-deadline 禁词扩成 `error|warn|fatal`，正确实现变红；teardown 期间 Worker 合法继续打印 retryable warning，故退回只禁 `error`。 | JSONL 4611、4623～4631、4643；当前 `/home/xp/src/copilot-api-js/tests/e2e/history-startup-deadline.e2e.test.ts:121-125`。 |
| I5 | **变异假绿**：Worker 臂 `blockMs` 缺失时 `Date.now()+undefined` 为 `NaN`、循环零次，相对断言反而更易绿；原测试变异仍 1 pass。补 Worker elapsed 正控与 finite 校验后，错 key 变异 0 pass／1 fail，恢复 1 pass／0 fail。 | JSONL 4498、4539、4554～4568。符号→`workerData.blockMs`；测试→`event-loop-isolation.it.test.ts`。 |
| I6 | **变异假绿**：竞争 readonly handle 仅断 `toBe(competitor)`，close 后 identity 仍可能相同。第一次变异会清指针、身份断言先红；第二次“close 但保留发布”才精确由 usability 断言咬住。 | JSONL 4665、4683～4685、4691～4707。 |
| I7 | **变异假绿**：“禁用不受 deadline 约束”原测试为空过；快速 `initHistory(false)` 即使失去 `!enable` 短路仍可能赢过 1ms timer。构造 80ms shutdown 后，删 `!enable` 得 3 pass／1 fail，恢复 4 pass／0 fail。 | JSONL 4723、4741～4749。 |
| I8 | **变异假绿**：`deadlineMs===0` 永久等待原先只测 getter；`<=0`→`<0` 时两测试仍绿。新增 120ms 后仍 waiting 的行为判据后，同一变异 10 pass／1 fail。 | JSONL 5269～5282。 |
| I9 | **运行时探针 + 正控**：fixture `afterEach` 先 rebuild runtime、后 release，导致每文件第 2 个测试起 registry 空而 sink 指向 stopped runtime，落盘静默失败。HEAD 探针 t1 persisted=1、t2 persisted=0/durability=failed；base `baef58b3` 同链 persisted=1。正式三用例修前 1 pass／2 fail，修后 3 pass／0 fail。 | JSONL 5001、5040、5065。符号→`tests/helpers/isolated-fixture.ts` 的 teardown 顺序；测试→`fixture-persistence-survives-teardown.it.test.ts`。 |
| I10 | **证伪错误归因**：fixture 修复后出现 `Cannot use a closed database`；先怀疑 query 缓存旧句柄，源码证实 queries 每次重新 get。真因是 `openInMemoryDatabase()` 发布 read handle，而 `closeDatabase()` 不撤销发布；修后原分片 0 fail。 | JSONL 5188、5191～5206、5212～5238。 |
| I11 | **证伪因果解释／修订标定**：一次 `test:it` 58 fail 被解释成约 52 条测试依赖“不落盘”，据此回退正确修复。复查只有约 16 条真断言失败，其余主要为 Bun SIGILL；重施修复后连续两次 5 fail、无崩溃，错误解释与回退均撤销。 | JSONL 5319、5326、5329、5401、5407、5411、5425、5440、5446、5456。可复用判据：先看 failure population/runtime crash，再至少复跑两次。 |
| I12 | **标定值**：Worker stall 30ms vs in-process 1053ms；补 liveness 后 10ms vs 532ms，两侧 HTTP 200。 | JSONL 3490、4214、4456。仅是当次 Linux/Bun/负载观测，不是跨机器 SLA。 |
| I13 | **运行时能力探针**：正确 owner marker + `BEGIN EXCLUSIVE` 令真实 Worker 持续得到 retryable `database is locked`，约 6s deadline 后 exit 1；没有误入 permanent owner failure。 | JSONL 4349、4381、4579。测试输出中的 retryable 分类约束了不同 SQLite 阻塞点。 |
| I14 | **解析范围修正 + 正控**：guard 子串 `sqlite/read` 误伤合法 `sqlite/read-connection`；收紧到 specifier 末尾后，四个真 V2 specifier 仍被抓，新模块放行。 | JSONL 1320、1348；progress `/home/xp/src/copilot-api-js/docs/tmp/2026-08-09-history-worker-progress-impl-2b.md:76`。 |
| I15 | **范围校准**：顺序 `bun test tests/history` 为 0 fail；`--parallel` 为 5 fail；`bun run test:it` 稳定 5 fail；LPT `test:backend` 可 0 fail。各 selector／runner 形态不可互相替代。 | JSONL 5292、5446、5468。 |
| I16 | **继承的否决路线**：不得让主线程与 Worker 同持 semantic 写句柄；不得在 2b 提前切 raw capture。原裁决来自前段会话，当前 transcript 以 handover 输入承接。 | JSONL 20 返回 handover 第 70～73 行；当前 progress `:86-89`。若要求“本会话新产生”，须标继承背景。 |
| I17 | **错误恢复路线**：声称要 `SendMessage` 恢复 API 中断 reviewer，却调用 `Agent` 派了新 agent；新 agent 无法代发。随后主会话直接 `SendMessage` 原 agent 成功。 | JSONL 2442、2451～2459。 |
| I18 | **解析错误**：两次 codemod 自身成功但把 import 插坏。一次插入既有多行 import 中间，typecheck TS1003/TS1005；一次产出 `import { commitV3HistoryEntry` 下一行直接 `openTestDatabaseAsReadSource,`，typecheck TS1005。 | JSONL 1116～1129、5840～5849。 |
| I19 | **否决路线**：合并态先让共享 primitive `openDatabase()` 自动发布 read handle；focused 两文件 31 pass，但完整分片因 live History 已装 handle 抛错。撤回后改 test-only `openTestDatabaseAsReadSource()`，受影响文件 34 pass，合并态 0 fail。 | JSONL 5769～5788、5793、5814～5819、5824～5857。 |
| I20 | **合并路线取舍**：master 大幅重写 `queries.ts` snapshot-ready 结构，而本分支 delta 仅 accessor。采用“取 master 结构、重放 `getHistoryReadDatabase()` delta”，否决用陈旧特性结构覆盖 master。 | JSONL 5602～5615；同形冲突见 5686～5711。 |
| I21 | **线程范围修正**：生产 `state.ts` 的 summary-backfill start/drain 在 cutover 后跨线程够不到真实 Worker，须删；fixture 的 in-process backend 与主线程同实例，`drainV3SummaryBackfill()` 反而须保留。 | JSONL 5585～5592、5641～5660。 |
| I22 | **能力探针**：Bun 上 `setTimeout(fn, 2147483648)` 实测约 7ms 触发，而非等待更久；配置上界须 2^31−1，setter 还需 clamp。 | `/home/xp/src/copilot-api-js/src/lib/history/startup-deadline-config.ts:16-21`；progress `:127` 只留“约 1ms”机制摘要。 |

## 双向对账

### 方向 A：作者列了、事件源找不到或原句过强

#### A-1．作者 A6 的“`erasableSyntaxOnly` 拒构造函数参数属性”未找到事件源

- 核查了 6096 条 JSONL、normalized tool timeline，以及 `erasableSyntaxOnly`、`parameter propert`、`参数属性`、`TS1294`、`HistoryStartupDeadlineError` 附近 typecheck 输出。
- 未找到该错误或相应修正。当前源码显式字段只证明最终形状，不证明本会话尝试过参数属性并被该选项拒绝。
- 处置：删除候选，或补 transcript/tool-log origin 后再保留。

其余作者 14 条均找到来源：A1→JSONL 4456；A2→5769～5838；A3→SCC ratchet 红及 `d418b4e6`；A4/A5→4597～4647；B1→5319～5472；B2→2647～2653；C1→4951～4965；C2→1116～1129 与 5840～5849；D1→5292/5440/5446；D2→5857/5891；D3→4428；E1→progress:46 所述实跑；E2→`startup-deadline-config.ts:16-21`。

### 方向 B：事件源找到、作者没列

作者清单实际有 15 条。以下 17 条遗漏均为独立事件；相同事件的多次 tool call 已合并。

1. I2：删 `process.exit(1)` 后 startup-deadline 第一版四断言仍全绿；作者 D3 只列耗时，没列完整“符号→测试→错误实现仍绿→新判据才红”。
2. I5：Worker 臂 `blockMs` 缺失静默零阻塞及 key-rename 变异。
3. I6：readonly handle identity 假绿及第二次精确变异。
4. I7：禁用路径 deadline 测试为空过。
5. I8：`deadlineMs===0` 边界行为为空过。
6. I9：fixture teardown 缺陷本身的 HEAD 探针、base 正控、1 pass／2 fail 回归；作者 B1 只列围绕修复的错误爆炸半径解释。
7. I10：先错归因为 query 缓存、后定位 `closeDatabase` 发布／撤销不对称。
8. I12：30ms/1053ms 与 10ms/532ms、两侧 200 的线程隔离标定。
9. I13：exclusive-lock 确实走 retryable startup→deadline 的能力探针。
10. I14：read-consumer guard 子串误伤与双向对照。
11. I15：顺序 history 0、parallel history 5、`test:it` 5、backend 0 之间不可互换的 scope correction。
12. I17：API 中断 reviewer 恢复时误派新 agent，随后改回 `SendMessage` 原 agent。
13. I21：同一个 summary-backfill 调用在生产跨线程无效、fixture 同线程有效的相反合并处置。
14. I22：Bun timer overflow 的具体约 7ms 能力探针；作者 E2 只写泛化“约 1ms”。
15. JSONL 2424～2440：删 start-failure release 后精确复现 terminally-failed 污染，2 pass／1 fail；恢复 6 pass／0 fail。
16. JSONL 2670～2696：绕过 `serializeHistoryLifecycle` 后，并发 bring-up 一条 rejected、shutdownCalls 0，目标两测试红。
17. JSONL 2704～2727：撤销 bring-up rollback 后，`shutdownCalls` 判据精确变红。

不重复计数：I18 已是作者 C2；I19 已是作者 A2；I20 是成功的合并处置与被否决替代面，作者没有列，但其稳定结论已完整写入 merge commit `42bdc6aa`，本轮按“非文件候选须防重做”仍建议保留在 closeout 叙述中，但不纳入上述 17 条最低遗漏集；I16 是继承背景而非本轮新产生。

## 作者条目逐项载体核实

| 作者项 | 亲自打开载体后的裁决 |
|---|---|
| A1 | ✓ `/home/xp/src/copilot-api-js/docs/tmp/2026-08-09-history-worker-progress-impl-2b.md:126` 明写第一版“先清引用再 await”被守卫判红，最终用 `finally`。 |
| A2 | **不成立**。`/home/xp/src/copilot-api-js/tests/helpers/history-v3-fixtures.ts:192-203` 只讲最终 helper 的正向设计与 ownership；没有承载“先试 `openDatabase()` 自动发布、完整分片因 live handle 否决”的历史。该路线存在于 transcript 及 merge commit message，但不在作者写的待查 helper docstring。 |
| A3 | ✓ `/home/xp/src/copilot-api-js/src/lib/history/startup-deadline-config.ts:3-7` 写明 config import 拖入 SCC，故抽零依赖叶子；正文承载了不重新冻结 SCC 的理由。 |
| A4 | ✓ `/home/xp/src/copilot-api-js/tests/e2e/history-startup-deadline.e2e.test.ts:121-125` 明写 widening 到 `warn` 是 false-red。 |
| A5 | ✓ 同文件 `:123` 明写 `telemetry.db` marker 被试过且无判别力。 |
| A6 | 无事件源，不再核载体，计方向 A。 |
| B1 | ✓ progress `:136` 与 `/home/xp/src/copilot-api-js/docs/todo/deferred-backlog.md:1357-1358` 完整承载 58-fail 错判、SIGILL、两次 5 fail 与判据。 |
| B2 | 待查结果：progress 未载；当前测试注释承载“missing file 与 owner check 是同一 seam 的两种失败”，事件本身由 JSONL 2647～2653 证明。 |
| C1 | ✓ 作者标“无载体”准确；通用 rule/skill 不是本次 14-fail 实例载体。 |
| C2 | ✓ 作者标“无载体”准确；未发现项目正文记录本次 import codemod 语法破损实例。 |
| D1 | ✓ backlog `:1358` 与 progress `:138` 承载 5 条既有失败及基线边界。 |
| D2 | ✓ progress `:38` 已承载合并态 7732 pass／0 fail；作者只查 `:55` 的旧 6717 快照，定位应改为 `:38`。 |
| D3 | ✓ progress `:125` 与 backlog `:1322` 均承载 7206ms vs 7180ms 及非零退出假绿。 |
| E1 | ✓ progress `:46` 明写 readonly DDL 已存在对象 no-op、缺失对象写失败与顺序依赖。 |
| E2 | ✓ `/home/xp/src/copilot-api-js/src/lib/history/startup-deadline-config.ts:16-21` 承载 ceiling、wrap 与 Bun 实测约 7ms；progress `:127` 只有约 1ms 机制摘要，二者应区分。 |

**载体核实不成立：1 条（A2）。** C1/C2 的“无载体”是正确分类，不算不成立；A6 属方向 A，不重复计载体失败。

## 已知 wrong-tree 事实的精确裁决

作者写“报 14 fail”准确，但应保留完整口径：

> `backend13.log` 首行证明 cwd 为 `/home/xp/src/copilot-api-js`；该主检出运行枚举 7722 tests，7708 pass、14 fail、9 skipped、exit 1，失败栈也指向 `/home/xp/src/copilot-api-js/tests/...`。同一命令显式绑定 `/home/xp/src/copilot-api-js/.worktrees/history-worker-batch-2a` 后枚举 7382 tests，7382 pass、0 fail、36 skipped。因此 14 fail 不是 Batch 2b worktree 的门禁结论。

“由 `git worktree remove` 后 cwd 留在主树导致”与时间顺序一致；最强直接证据仍是两个日志首行 cwd，不能只留因果叙述。

## Verdict

作者清单未列全，当前版本不能作为 `review_temp_manifest` 的双向空 diff receipt，也不能释放临时证据删除。应把 17 条方向 B 纳入；mutation 条目保持“符号→测试→失败形状”的可重建粒度，而不是只写“做过变异”。

方向A: 1 条 / 方向B: 17 条 / 载体核实: 1 条不成立


# 第二轮：对 `cafa89a6` 落盘成品复审

## 逐条对账 I1～I22

### 已充分落盘

I1→progress `:173`；I2→`:156`；I5→`:157`；I7→`:159`；I8→`:160`；I9→`:164`；I10→`:168`；I11→`:137,169`；I12→`:179`；I13→`:183`；I14→`:76`；I15→`:175`；I16→`:88-89`；I17→`:188`；I18→`:174`；I19→`:90`；I22→`:184`。其中变异行均给出了符号、测试和失败形状，能按文本重建。

### 未落盘或粒度不足

1. **I3 未落进 progress**：`telemetry.db` marker 在正确态与删 `process.exit(1)` 的变异态目录完全相同，因惰性创建而无判别力。当前只存在于测试源码注释，不在 `cafa89a6` 新增段落；若本轮目标是把 I1～I22 全部落进 progress，这条缺失。
2. **I4 未落进 progress**：post-deadline 禁词扩到 `warn|fatal` 是正确实现会红的 false-red；合法 retry warning 在 teardown 中继续出现。也只在测试源码注释，不在补录段落。
3. **I6 粒度不足**：`:158` 的“变异的符号／改动”只写“竞争 readonly handle 的处置”，测试只写“bring-up 事务用例”。应明确为删除/替换 rollback 中对未发布 `readDatabase` 的处置，并给完整测试路径 `tests/history/worker/bringup-lifecycle.it.test.ts` 及具体用例；否则无法仅凭该行定位重建。
4. **I20 未落进 progress**：合并时取 master 的 `queries.ts` snapshot-ready 结构，再重放 `getHistoryReadDatabase()` 窄 delta；否决用陈旧特性结构覆盖 master。progress 只在 `:40` 指向 merge commit，没有写该取舍正文。
5. **I21 未落进 progress**：生产跨线程的 summary-backfill start/drain 够不到 Worker，而 in-process fixture 同线程所以相同 drain 必须保留；这组相反处置没有写进补录段落。

故按“缺失或不足以重建都算未落盘”的口径，未落盘为 5 条。

## 反方向：落盘文本中的无支撑／过强断言

1. **`:148` 撤回 `erasableSyntaxOnly` 事件是错误的，必须纠正。** 第二轮深扫薄区间找到直接来源：JSONL 2775 的 typecheck 明确报 `tests/history/worker/bringup-lifecycle.it.test.ts(71,5): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.`；JSONL 2777 明说“参数属性语法…禁止”，JSONL 2778 将 constructor parameter property 改为显式字段。上一轮我判“找不到”是 false negative；作者原 A6 成立，不应撤回。
2. **`:148`“17 条全是 git 记不下”过强。** 至少 I19/I20 已写进 merge commit `42bdc6aa` 的 message，I3/I4 也已在测试注释中。准确说法应是“作者自查清单漏了 17 条，其中若干虽已有零散 carrier，但未在候选清单中对账”。
3. **`:168` 的判据“先查发布/撤销，别先怀疑缓存”从单实例外推成无条件诊断顺序。** 本轮只证明该实例的真因，不证明所有远端症状都应先排 publication。可收窄为“遇到被发布句柄的 close 后远端报错时，把 publish/withdraw ownership 与缓存并列排查”。
4. **`:179` 新增“带并发负载”没有事件证据。** 30/1053 与 10/532 来自 focused isolation test 运行；transcript 没有证明这两组值是在并发负载下测得。应删该限定，保留 Linux/Bun/当次测试环境。

## 第二轮薄区间新发现

1. **A6 不是无来源项，而是上一轮漏检。** 来源闭合见 JSONL 2775～2780；这是对第一轮方向 A 的撤回。
2. **实际执行过的 mutation J 未进入 I1～I22，也未进入变异台账**：删 `startup-deadline.ts` 成功路径的 `clearTimeout`，`10 pass / 0 fail`，说明 timer 泄漏无人看见。证据在 `/home/xp/src/copilot-api-js/docs/tmp/2026-08-09-batch2b-review-testing.md:108-116`；progress `:140` 只写“删 clearTimeout 仍绿”，没有符号→测试→失败形状的台账粒度。
3. **实际执行过的 mutation H 未进入 I1～I22，也未进入变异台账**：删 rollback 的 `else readDatabase.close()`，`bringup-lifecycle` 仍 `6 pass / 0 fail`，漏掉本次打开但未发布的 readonly fd/读锁。证据在 review-testing `:120-128`；progress `:140` 同样只是摘要。

### 第二轮 verdict

`cafa89a6` 已吸收大多数高价值事件，但尚未达到 I1～I22 逐条闭合：5 条缺失/不可重建，4 条新断言无支撑或过强；薄区间还发现 2 条新 mutation，并纠正上一轮对 A6 的错误否定。需修订后再复审，当前仍不能出“双向 diff 为空”的删除 receipt。

第二轮 — 未落盘: 5 条 / 无支撑断言: 4 条 / 新发现: 3 条


# 第三轮：`b8c257e6` 收敛复审

## 第二轮 9 条逐项闭合

- **未落盘 5 条**：I3、I4 已在 progress `:91-93` 补齐；I6 已在 `:163` 补全 rollback ownership 分支、完整测试路径和两次变异的失败形状；I20 已在 `:184` 补正文；I21 已在 `:185` 补正文。五条均已闭合。
- **无支撑／过强 4 条**：A6 已在 `:153` 恢复并给出 JSONL 2775/2778；“17 条全是 git 记不下”已在 `:151` 收窄为“未进入候选清单、未被对账”；closed-database 判据已在 `:190` 收窄为 publish/withdraw 与缓存并列排查；线程标定已在 `:201` 删除“带并发负载”，并明确负载未记录。四条均已闭合。
- **第二轮新发现 mutations J/H**：已在 `:171-180` 独立成表，分别给出变异符号、完整测试路径、10 pass／0 fail 与 6 pass／0 fail；与“变异后转红”表分开，粒度足以重建。

## 本次修订新引入的无支撑断言

1. **progress `:185` 把 fixture 侧写成 `startV3SummaryBackfill`／`drainV3SummaryBackfill`“那对调用”都要保留，证据只支持保留 drain。** Transcript JSONL 5641～5660 的 fixture 冲突与最终合并只引入、保留了 `drainV3SummaryBackfill()`；没有 fixture 侧 `startV3SummaryBackfill()` 冲突或保留动作。生产侧确实删除了 start 与重入 drain，但 fixture 侧只涉及 drain。建议改成：“生产侧的 start 与重入 drain 都删；fixture 侧仅 `drainV3SummaryBackfill()` 因同线程而保留。”

除这一处外，新“变异后仍绿”表与 `queries.ts` 合并取舍均有 transcript／review-testing 支撑，未发现新增夸大。

## Verdict

第二轮 9 条已全部闭合，但本次修订新引入 1 条范围过强断言，因此尚不能写“双向 diff 为空”。修正 `:185` 后再做一次只核该句的复验即可收敛。

第三轮 — 未闭合: 0 条 / 新引入无支撑: 1 条

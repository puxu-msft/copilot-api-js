# Task 9 独立评审 —— 视角二：验收判据鉴别力（false-green / false-red 双向）

- 评审对象：commit `8b839820`、`756a1b30`、`10891dff`（HEAD）
- 工作树：`/home/xp/src/copilot-api-js/.claude/worktrees/placeholder`，分支 `worktree-placeholder`
- 只读评审。所有变异实验在 `/tmp/t9`（本工作树的 tar 副本 + `node_modules` 符号链接到主树）内进行，**本工作树未被写入任何变异**。
- 裁判轴：长远正确 + 完整，拒绝 ROI/YAGNI。两个方向都查。

> 本文件按「审完一条就追加」的方式增量写入。

---

## 证据闭合 #1 —— 三份变异 patch 全部仍然有效（Q2）

**结论：三份 patch 都能 apply，且都真正打在当前实现的目标机制上。** 进度文件第 68 行只声称验证了 `evidence-missing` 一份，另两份仅做过 `git apply --check`；本轮补齐了实际注入验证。

`git apply --check`（在本工作树，只 check 不 apply）：

```
evidence-missing.patch   → exit=0
consumer-format.patch    → exit=0
startup-bypass.patch     → exit=0
```

`/tmp/t9` 内实际注入（`patch -p1`）并运行：

| patch | 目标机制（当前 file:line） | 注入后 | 变红的测试 |
|---|---|---|---|
| baseline | — | `34 pass / 0 fail` | — |
| `evidence-missing` | `src/lib/history/v3/store.ts:1663`（`hydrateManifest` 里 `validatePersistedOperationEvidenceRefs` 降级成只校验 manifest 自述 refs） | `30 pass / 4 fail` | `transport-evidence.it.test.ts` 的 `operation evidence refs mismatch` 四条 oracle |
| `consumer-format` | `store.ts:1490` 附近 `decodeManifestEnvelope` formatVersion 白名单 → `version > 3` | `33 pass / 1 fail` | `detail version 0` 参数化用例；实收 `operation digest mismatch` 而非 `unsupported manifest format version` |
| `startup-bypass` | `store.ts:370` 附近 `ensureV3Schema` 的 version 不匹配即 return → 强行重刷 schema 顶版本 | `16 pass / 3 fail` | `legacy-db-fixtures.it.test.ts` schema5-manifest-v1/v2 两条 + `migrations-wiring.it.test.ts:228` |

三份 patch 均以 `patch -R -p1` 反向恢复，恢复后 `/tmp/t9/src/lib/history/v3/store.ts` 与工作树版本 `diff -q` 完全一致。

**补充**：`consumer-format` 与 `startup-bypass` 的 hunk 分别以 offset 126、38 行匹配——上下文仍锚得住但行号已大幅漂移。三份 patch **都没有文档写明「预期哪条测试变红」**，本次是靠逐一注入反推的。见后文主观建议。

---

## 证据闭合 #2 —— **MAJOR：Transaction B 的 commit-time strict gate 完全没有鉴别力（false-green）**

**位置**：`src/lib/history/v3/store.ts:919`（HEAD `10891dff`）

```ts
        transactionBFailureInjectorForTests?.("refs")
        hydrateManifest(db, prepared.compressedManifest, prepared.id)   // ← 这一行
        transactionBFailureInjectorForTests?.("strict")
        db.prepare("UPDATE v3_operations SET summary_json=? WHERE operation_id=?").run(prepared.summaryJson, prepared.id)
        publishValidatedOperationSummary(db, prepared.id, restoreReadyMarker)
```

**变异实验**（`/tmp/t9`，与 HEAD 逐字节一致，`diff -q` 已验证）：删掉第 919 行这一句 strict 校验，其余不动。

| 范围 | baseline | 删掉 strict gate 后 |
|---|---|---|
| `bun test tests/history/`（66 文件） | `547 pass / 23 skip / 0 fail` | **`547 pass / 23 skip / 0 fail`（完全不变）** |
| `bun test tests/infra tests/restart tests/architecture tests/diagnostics` | — | `771 pass / 1 fail`，唯一失败是 `process-identity` 那条要求当前目录是一个 git 仓库副本的用例（`/tmp/t9` 不是），环境性失败，与变异无关 |

**为什么这是缺陷而不是「防御性代码不必测」**：冻结架构 `.superpowers/sdd/task-9-summary-integrity-architecture.md` 明确把这条 gate 写成验收项——

- §3.1 第 31 行：「B：…在一个transaction中执行"canonical INSERT → summary pending → operation refs → **strict validate** → summary ready → journal+refs删除"」
- 矩阵第 1 行判据：「同tx先pending、写refs、**strict后ready**」
- 矩阵第 2 行判据：「Operation `INSERT` new key，**未完成B或strict失败** … **负：直接insert、bad manifest/evidence；断言零发布**」

也就是说「strict 失败 ⇒ B 整体 ABORT ⇒ 零发布」是**规格里点名要求的负控**，而当前测试集**没有任何一条实现它**。`transactionBFailureInjectorForTests?.("strict")` 只是一个**阶段标记**：注入器人为抛错测的是「在该点回滚」，与「真的调用了 `hydrateManifest`」互相独立——删掉 gate、保留注入器，注入型测试照绿。这正是 `evidence-weaker-than-it-looks` 说的「变异对照 ≠ 覆盖面」。

**后果形态**：`insertOperationEvidenceRefs` 或 manifest 编码将来出任何一处偏差，写入路径不再 fail-closed，会把一条**读不回来**的 canonical row 连同 `projection_status='ready'` 一起持久化，并按 `restoreReadyMarker` 保留全局 ready marker。读侧信任 marker，于是缺陷第一次暴露是在**读取时**（detail 抛 `operation evidence refs mismatch`），而不是写入时回滚——恰好是 Task 9 要消灭的形态。

**修复建议**：补一条负控——用一个「注入式使 `insertOperationEvidenceRefs` 少写一条 ref（或写错 `byte_length`）」的 seam，断言 `commitPreparedOperation` 抛错、`v3_operations` 无该行、`v3_operation_summaries` 无该行、marker 保持原值。可复用已有的 `transactionBFailureInjectorForTests` 形状，但注入点必须**改变真实数据**而不是抛异常，否则仍然测不到 gate 本身。

---

## 证据闭合 #3 —— 活提交路径的 marker 恢复条件**有**鉴别力（正面结论）

变异：`store.ts:922` 的 `publishValidatedOperationSummary(db, prepared.id, restoreReadyMarker)` → 第三参改为 `true`（即「任何新提交都无条件把全局 ready marker 立起来」）。

结果：`tests/history/` `545 pass / 2 fail`，两条按目标变红——

```
✗ History V3 summary projection migration > strict repair refuses to publish readiness when normalized evidence refs diverge from the manifest
✗ persisted summary SQL query > keeps the legacy read path until the projection readiness marker is published
```

结论：`restoreReadyMarker` 这条「原本不 ready 就不擅自发布」的判据双向可判，不需要补。

---

## 证据闭合 #4 —— `states-flush-freeze` 的 true/false 语义没有写反，且不再有 false-red（Q3）

**语义核对（机械核对视角）**：`drainScheduled{Negotiation,Calibration}PersistenceForTests()` 的定义在
`src/lib/anthropic/feature-negotiation.ts:551-557` / `src/lib/models/calibration/engine.ts:306-312`：

```ts
if (!persistTimer) return false
clearTimeout(persistTimer); persistTimer = null; await persist...(); return true
```

而 `schedulePersist()`（`feature-negotiation.ts:523` / `engine.ts:265`）第一行就是 `if (persistenceFrozen) return`。所以 **frozen ⇒ 无 timer ⇒ `false`；未 frozen 且发生了一次学习 ⇒ 有 timer ⇒ `true`**。

**逐用例第一人称走查**：8 处断言全部方向正确——
- `states-flush-freeze.it.test.ts:79` freeze 后 → `false` ✓
- `:90` `clearAnthropicFeatureNegotiationForTests()` 解冻后 → `true` ✓
- `:99` SIGINT（不 freeze）后 → `true` ✓
- `:114` SIGUSR2 handoff freeze 后 → `false` ✓
- `:131` calibration freeze 后 → `false` ✓
- `:144` `resetAllLimitsForTesting()` 解冻后 → `true` ✓
- `:168` SIGINT 后 → `true`；`:170` freeze 后 → `false` ✓

**false-red 检查**：`markSystemRejectModel`（`feature-negotiation.ts:358-365`）**无条件**调用 `schedulePersist()`；`learnCalibration`（`engine.ts:167-186`）在测试用的 `(20000, 26000)` 入参下也必然走到 `schedulePersist()`。因此「期待 true」的四处不存在「状态没变脏所以没排期」的假红。实跑 10 次：**10/10 `6 pass / 0 fail`**（脚本 `/tmp/run10.sh`）。相比原来的 `setTimeout 1100/5200ms` 是**严格更确定**，且把 3 个用例的显式 timeout（10s/10s/15s）一并去掉。

**false-green 检查（变异对照）**：删掉 `feature-negotiation.ts:524` 的 `if (persistenceFrozen) return` 后，该文件 `4 pass / 2 fail`，变红的正是两条 freeze 用例。gate 有鉴别力。

**残留（不构成 finding）**：新 oracle 只覆盖「经 debounce 排期」这一条写盘路径。若将来有人加一条**绕过 `schedulePersist` 的直写**，`drain → false` 仍成立，而紧随其后的磁盘断言此刻是**立即**读而非等 1.1s，理论上可能读到写盘未落。当前 `persistFeatureNegotiation()` / `persistLimits()` 的调用点只有 debounce timer、`flushAndFreeze`、drain-for-tests 三处（`rg` 输出：`engine.ts:270,310,328`、`feature-negotiation.ts:528,555,573,934`），该路径不存在，故不升级为 finding。

---

## 证据闭合 #5 —— **MAJOR：store-performance 放宽后，写路径「不随历史长度退化」这条不变量已彻底无人守，且进度文件的替代品声明是错的（Q4-①）**

**改动**：`tests/history/v3/store-performance.it.test.ts:132-133` 删除

```ts
expect(prepareRatio).toBeLessThan(3)
expect(commitRatio).toBeLessThan(5)
```

**进度文件第 47/71 行的声明**：「canonical deterministic work counter 与 recursive SCC guards 仍为硬门」「真实复杂度另由 deterministic work counter＋reachable recursive SCC gate 守护」。

**逐条核实这些「替代品」的被测对象**（机械核对）：

| 声称的替代硬门 | 实际 file:line | 实际被测对象 |
|---|---|---|
| deterministic work counter | `tests/history/v3/canonical-performance.unit.test.ts:205-232`（`conversationRatio < 8`、`sseRatio < 8`） | `src/lib/context/model-operation-record.ts` 的**内存内 captured-value 遍历访问次数**，**完全不碰 SQLite** |
| reachable recursive SCC gate | 同文件 `:236-256` | 同上，对 recorder 源码做静态 SCC 分析 |
| CAS 容量 | `store-performance.it.test.ts:159-160` | 存储**字节数**，不是时间/工作量 |
| writer memory | `store-performance.it.test.ts:196+` | RSS / pendingBytes，不是随历史长度的退化 |

四者**没有一个**覆盖 `commitPreparedOperation` 的**每次提交成本随库内既有 operation 数增长**这件事。「另由 X 守护」的说法把不同被测对象混为一谈（`align-probe-depth-with-subject` 的同型错误：先声明被测对象再选探测方式，这里被测对象被换掉了）。

**这条不变量是活的，而且当前实现确实在退化**（实测，探针 `/tmp/t9/probe-commit-scale.ts`，in-memory DB，逐次提交计时，取前 200 次与后 200 次的中位数）：

| 版本 | N | 前 200 次中位 | 后 200 次中位 | ratio |
|---|---|---|---|---|
| HEAD `10891dff` 原样 | 6000 | 2.014 ms | **3.752 ms** | **1.863** |
| 仅把 `store.ts:890` 的 `getSummaryProjectionReadiness(db).ready` 换成 O(1) 的 `isSummaryProjectionReady(db)` | 6000 | 1.933 ms | **1.630 ms** | **0.843** |

根因：`commitPreparedOperation` 在每次 Transaction B 开头执行

```ts
const restoreReadyMarker = getSummaryProjectionReadiness(db).ready    // store.ts:890
```

而 `getSummaryProjectionReadiness`（`summary-store.ts:479-495`）里那条
`SELECT SUM(CASE WHEN projection_status='pending' …) FROM v3_operation_summaries` **无 WHERE、无索引可用，是整表扫描**；调用方只取 `.ready` 一个布尔，`pending`/`poisoned` 两个计数算完即弃。而 `.ready` 在 `isSummaryProjectionReady`（`summary-store.ts:471-477`）里是一次 `history_meta` 主键查找，O(1)。

**归因诚实说明**：这条 O(N) 读**不是本轮引入的**——`git show ab594029:src/lib/history/v3/store.ts:883` 已经是同一句。所以本 finding 的过错不在「引入退化」，而在**同一个 commit 里既把唯一能发现这类退化的判据删了，又用一个被测对象不同的判据冒充替代**。

**同时必须承认原断言本身也弱**：HEAD 原样跑该测试实测 `prepareRatio=0.649 / commitRatio=0.308`（256 条 flood），远在 3/5 阈值之下——**它在 256 行规模下根本抓不到上面这条 O(N) 扫描**。所以「删掉 wall-clock 断言」这个动作方向没错（它同时是 false-red 源与低鉴别力判据），**错在停在「删掉」**。

**修复建议（长远正确的形状）**：把判据从 wall-clock 换成**确定性工作量计数**，而不是取消。可行做法：给 driver 加一个「本次提交内执行的 SQL 语句 + 扫描行数」计数 seam（或用 SQLite `sqlite3_stmt_status` / `PRAGMA` 计数），断言「第 1 次提交与第 N 次提交的扫描行数之比 < 常数」。这类判据不受 CPU 争用影响，不会 false-red，且在 N=256 就能抓到上面这条整表扫描。顺带把 `store.ts:890` 改成 `isSummaryProjectionReady(db)`（同 commit 实测提交成本降 2.3x）。

---

## 证据闭合 #6 —— management-routes 删除 `DROP TRIGGER` 后，count oracle **仍有**鉴别力（Q4-②，正面结论）

**改动**：`tests/infra/management-routes.http.test.ts:380` 删掉 `getDatabase().exec("DROP TRIGGER v3_operation_summaries_after_summary_update")`，只保留 `UPDATE v3_operations SET summary_json='{broken' …`。

**新 fixture 下的状态**：protected-update trigger（`summary-schema.ts` 的 `v3_operation_summaries_after_protected_update`，`summary_json` 在 `protectedOperationColumns` 里）会把该 summary row 置 `poisoned` 并删除 marker；而 `v3_operations.summary_json` 里那串 `'{broken'` **仍然原样躺在库里**——这正是 oracle 需要的诱饵。

**变异对照**：把 `countV3Operations`（`store.ts:1400-1405`）改成先 `SELECT summary_json FROM v3_operations` 并逐行 `JSON.parse`（模拟「count 路径去解析 summary 载荷」的坏实现），运行该文件：

```
11 pass / 1 fail
✗ management and history HTTP routes > GET /api/status counts persisted operations without parsing summary payloads
```

红的正是目标用例。注意 `src/routes/status/route.ts:130-139` 外层有 `try { … } catch {}`，坏实现不会 500，而是让 `historyEntryCount` 停在 0——断言 `toBe(1)` 照样抓得住。

结论：这处 guard 放宽**没有**削弱判别力，无需处置。

---

## 证据闭合 #7 —— **BLOCKER：判据之间的缝——readiness 全套判据判对了，fallback 读路径照样把被污染的投影交给客户端（Q5，主动构造的「实现坏掉但判据全绿」场景）**

**位置**：`src/lib/history/v3/store.ts:1247-1253`（HEAD `10891dff`）

```ts
function summaryFromRow(db, row): EntrySummary {
  const stored = storedOperationFromRow(db, row)          // ← 完整 strict 校验，然后……
  if (row.summary_json) return { ...(JSON.parse(row.summary_json) as EntrySummary), pinned: row.pinned === 1 }   // ← 把校验结果丢掉，返回未校验的缓存值
  return recordToEntrySummary(stored.record, stored)
}
```

**构造出的场景**（探针 `/tmp/t9/probe-fallback-gap.ts`，HEAD 原样，实测输出）：

```
STEP1 readiness {"ready":true,"pending":0,"poisoned":0} marker= 1
STEP2 derived row {"projection_status":"poisoned","projection_error":"canonical operation changed"} marker= null
STEP3 fallback read returns [{"id":"gap-op","endpoint":"ATTACKER-CONTROLLED","previewText":"FABRICATED PREVIEW"}]
```

步骤：① 正常提交一条合法 operation，`validateAndMarkSummaryProjectionReady` 判 ready、marker=1；② 直接 `UPDATE v3_operations SET summary_json=<篡改值>`——**每一条 readiness 判据都正确动作了**：protected-update trigger 把 derived row 置 `poisoned`、`projection_error='canonical operation changed'`、并删除 marker（fail-closed）；③ 然后走 marker 缺席的 fallback 读路径（`visitV3Summaries` → `summaryFromRow`），返回的是**那份被篡改的 `summary_json` 原文**。

**这就是 `gaps-between-criteria-not-within` 的教科书形态**：Task 9 的判据全部围绕「要不要相信 marker」设计，每条单看都对、也都有变异对照（见本报告 #3/#8）；但**「marker 说不可信之后，读路径实际交出去的是什么」这一整类没有任何判据**。整棵 `tests/history/`（547 pass）在上述被污染状态下**全绿**。

**判据缺口的严重性判定**：Task 9 的目标就是 summary 完整性/就绪性。这里 readiness 机器完美运转，而消费者绕过它——**判据集合对本任务的首要失效模式零鉴别力**，按本轮 rubric 属 BLOCKER。

**在途状态（必须诚实标注）**：评审期间该共享工作树出现了**未提交**的同伴改动（`git status`：`M src/lib/history/v3/store.ts`、`M tests/history/v3/transport-evidence.it.test.ts`），其中 store.ts 的改动**正是删掉上面那行 `summary_json` 快捷返回**并改为从已校验的 record 重投影。我把该未提交版本拷进 `/tmp/t9` 重跑同一探针，STEP3 变成 `{"endpoint":"unknown","previewText":""}`，即生产代码的洞已被在途修复。**但**：`git diff -- tests/history/v3/transport-evidence.it.test.ts` 里新增的两条测试是 journal identity 相关，**没有一条覆盖上述 fallback 场景**。所以即使那份 WIP 落地，**判据缺口依然存在**——必须补一条负控：污染 canonical `summary_json` → marker 撤销 → 断言 fallback 返回的是**重投影值而非缓存值**。

（本 finding 针对评审目标 HEAD `10891dff`。`/tmp/t9` 与 HEAD 的一致性已由 `git show 10891dff:src/lib/history/v3/store.ts` 与副本 `diff -q` 逐字节确认。）

---

## 证据闭合 #8 —— 三条旧 readiness 测试改写**没有**削弱断言（Q1，正面结论）

**改写前后对照**（`git show 8b839820 -- tests/history/v3/summary-projection-migration.it.test.ts`）：旧断言是 `tryMarkSummaryProjectionReady(db) → {ready:false}` + `marker === null`；新断言是 `inspectSummaryProjectionReadiness(db) → {ready:false}`（无副作用负控）+ `validateAndMarkSummaryProjectionReady(db) → {ready:true}` + marker `"1"` + 派生列被修复回 canonical 值（正控）。

**关键核实一：`inspectSummaryProjectionReadiness` 不是测试专用 oracle。** 它就是旧 `tryMarkSummaryProjectionReady`（`git show ab594029:src/lib/history/v3/summary-store.ts:567-603`）的只读一半——同一条 divergence SQL、同一条 statuses SQL、同一个 `ready` 计算式；并且**生产路径在用**：`store.ts:1314` 是 `validateAndMarkSummaryProjectionReady` 里 repair 循环之后的最终发布闸门。所以负控打的是活路径，不是 `exhaustive-record-proves-table-not-that-live-path-reads-it` 那种死表。

**关键核实二：两个方向的检测能力都还在（变异对照）。**

| 变异 | `tests/history/` 结果 | 变红的用例 |
|---|---|---|
| `summary-schema.ts:73` `projectionEquality` → `"1=1"`（typed 列 divergence 检测失效） | `545 pass / 2 fail` | `backfills historical rows and publishes readiness only after every projection is ready`、`detects a typed projection mismatch before strict repair rebuilds it from canonical state` |
| `summary-store.ts:587` 的 `not_ready` 统计项改成常量 `0`（非 ready 状态闸门失效） | `543 pass / 4 fail` | `strict repair refuses a valid manifest whose embedded operation identity belongs to another row`、`… normalized evidence refs diverge …`、`detects a non-ready status before strict repair republishes the canonical projection`、`an unhydratable historical manifest becomes a visible poison and blocks readiness` |

即：三条改写后的用例分别咬住了 divergence 检测（两条）与 not_ready 闸门（一条），**改写没有丢掉旧断言守的不变量**。

**关键核实三：marker 撤销（`deleteMeta`）分支仍有正控。** 三条改写用例确实把 `marker → null` 换成了 `marker → "1"`，但 `strict repair refuses a valid manifest whose embedded operation identity belongs to another row`（`:226` 先 `ready===true`、marker="1"，`:234-235` 篡改后 `ready===false`、`marker` 必须 `toBeNull()`）完整覆盖了「原本 ready 的库在检出问题后必须撤 marker」这条路径。

**结论**：本项不构成 `migrating-an-oracle-must-not-weaken-its-assertions` 违例。

---

## 证据闭合 #9 —— **MAJOR：门禁口径——结论诚实，但引用的数字不可复现，且「已闭合」的断言已被实测证伪（Q6）**

### 9a 诚实的部分

进度文件第 70/77 行明确写「官方 `bun run test:backend` 在本机16 shards下…未绿」「交付不得把后者改写成"官方门通过"」「低并发结果证明当前逻辑集合可全量通过，不证明官方runner在本机资源条件下可靠」。**这个口径本身是诚实的**，没有把降并发的结果冒充官方门。

### 9b 官方门的当前状态与文档不符（stale current-state claim）

我在 16 CPU（`nproc`=16）本机实跑官方命令 `bun scripts/parallel-test.ts unit it http`：

| 树 | 结果 | exit |
|---|---|---|
| `/tmp/t9`（与 HEAD 逐字节一致）第 1 次 | `6705 tests · 6704 pass · 1 fail · 45.98s` | 1 |
| `/tmp/t9` 第 2 次 | `5846 tests · 5845 pass · 1 fail · 29.38s` | 1 |
| 工作树（含同伴 WIP）第 1 次 | `5796 tests · 5796 pass · 0 fail · 30.17s` | **0（绿）** |
| 工作树第 2 次 | `5555 tests · 5553 pass · 2 fail · 57.19s` | 1 |

`/tmp/t9` 两次的唯一失败都是 `process-identity` 那条要求当前目录是 git 仓库副本的用例——`/tmp/t9` 不是，是我造的环境 confound，与被评审改动无关。**所以官方 16-shard 门在本机是能绿的**（工作树第 1 次 exit 0）。文档把「官方门未绿」写成当前状态已经过期（很可能是 `fb04255a` drain seam 整合后才变的），按 `stale-context-at-session-end` 应重新取证再写。

### 9c 文档引用的通过数不可复现（`every-number-carries-scope` / `cross-check-with-two-methods` 违例）

同一个 699 文件集合（`439 unit + 193 it + 67 http`，工作树与 `/tmp/t9` 用 `fd` 计数完全一致），四次官方运行给出 **6705 / 5846 / 5796 / 5555** 四个不同的 tests 总数；文档写的是 **7198 pass / 30 skip / 1 todo**，是第五个数。

根因（已用 `od -c` 取证）：`scripts/parallel-test.ts:154` 的

```ts
const stripAnsi = (s: string): string => s.replaceAll(/\[[0-9;]*m/g, "")
...
for (const m of plain.matchAll(/^\s*(\d+) pass\b/gm)) passSum += Number(m[1])
```

`stripAnsi` 只删了 `[0m` / `[32m` 这一段，**没有删前面的 ESC 字节本身**。`bun test` 汇总行的实际字节序列（`od -c` 实测，用八进制表示）是 `033 [ 0 m` `033 [ 3 2 m` `空格 1 3 空格 p a s s` `033 [ 0 m` `\n`。strip 之后行首剩下两个 `033`（ESC），而 `^\s*` 里的 `\s` **不匹配 ESC**，该 shard 的 tally 于是被整条漏掉。哪些 shard 被漏取决于其输出是否着色，因而**每次运行漏的量不同**——正是上面四个数各不相同的原因。exit code 仍然可信（取自各 shard 退出码），**但「N pass / 0 fail」这行正是交付报告引用的证据，它不可信**。

处置建议：把 strip 的正则改成同时吃掉 ESC（`/\x1b\[[0-9;]*m/g`）；并顺带修 `results` 的读取顺序——当前 `await p.exited` 早于读 `p.stdout` / `p.stderr`，输出超过管道缓冲的 shard 有死锁或丢输出风险。修完再重新取一次带 commit 锚的数字写回进度文件。

### 9d 「persistence freeze flaky 已闭合」被实测证伪

进度文件第 73 行称改用 drain seam 后「定向freeze＋resetter `9 pass / 0 fail`，原49-file bucket `580 pass / 2 skip / 0 fail`」，据此认为该 flaky 已闭合。实测：工作树第 2 次官方门运行里，该文件**仍然红**——

```
tests/restart/states-flush-freeze.it.test.ts:74
expect(hasLearnedRejectModel(snapshot1, "claude-sonnet-4-9")).toBe(true)
Expected: true   Received: false
```

**失败点是 `:74`，即 `flushAndFreezeNegotiation()` 之后「立即落盘」这条断言——本轮 drain seam 完全没有触及它**（本轮改的是 `:79/:90/:99/:114` 那几条 debounce 等待）。所以「换成 drain 断言 ⇒ 该文件确定了」这个推论不成立：drain seam 只消除了 debounce 等待这一个成因，`:74` 是另一个成因（同 bucket 单进程内的模块级共享状态/时序），仍未被诊断。

隔离复现尝试：把全部 32 个引用 feature-negotiation 的测试文件放进**同一个** `bun test` 进程连跑 6 次，**6/6 `388 pass / 0 fail`**。所以它只在官方全量负载下暴露，属于典型的「隔离绿、门禁红」——按 `full-suite-red-classify-before-pollution-playbook`，不能靠隔离跑绿宣告闭合。

同一次运行还红了 `History V3 store performance > CAS live physical bytes are at least 10x smaller…`，实测 **18340.79ms** 超过它自己的 `15_000` timeout。这说明：本轮虽然删掉了 wall-clock **ratio** 断言，同一文件里的 wall-clock **timeout** 仍然是活的 false-red 源（见 #5 的建议：换确定性工作量计数，而不是逐条放宽）。

---

## 总评

| 项 | 值 |
|---|---|
| verdict | **存在 blocker** |
| BLOCKER | 1（#7 fallback 读路径无判据；生产侧已有未提交在途修复，但**判据缺口不会随之关闭**） |
| MAJOR | 3（#2 Transaction B strict gate 零鉴别力；#5 写路径退化判据被删且替代品声明错误；#9 门禁数字不可复现 + 两条「已闭合」断言被证伪） |
| MINOR | 0（未凑数） |
| 正面结论 | #1 三份变异 patch 全部有效；#3 marker 恢复条件有鉴别力；#4 drain 断言语义正确、10/10 确定、变异可红；#6 count oracle 放宽后仍有鉴别力；#8 三条改写测试未削弱断言 |

### 双视角覆盖证据

**机械核对视角做了什么**
- 逐条 `git show` 对比 `8b839820` 对 6 个测试文件的 diff，与改写前的 `ab594029` 版本逐函数对账（`tryMarkSummaryProjectionReady` vs `inspectSummaryProjectionReadiness`）。
- `rg` 全仓清点 `inspectSummaryProjectionReadiness` / `validateAndMarkSummaryProjectionReady` 的**生产**调用点，确认负控打在活路径上。
- `fd` 双树计数测试文件（439/193/67 = 699），确认两棵树发现集合一致，据此判定文档的 tests 总数不可复现。
- 读 `scripts/parallel-test.ts` 的聚合实现，用 `od -c` 取 `bun test` 汇总行的真实字节，定位 `stripAnsi` 漏删 ESC 这一具体缺陷。
- 对照冻结架构 `.superpowers/sdd/task-9-summary-integrity-architecture.md` §3.1 与矩阵第 1/2 行，核实「strict validate」是规格点名的验收项。
- `git apply --check` 三份变异 patch；`git show 10891dff:<file>` 与 `/tmp` 副本 `diff -q` 逐字节验证实验基线。

**第一人称执行视角模拟了什么**
- 扮演「提交一条新 operation」的写路径：跟着 Transaction B 逐句走 canonical INSERT → refs → strict → summary ready → journal 删除，发现 strict 那一句没有任何判据在看它，随即用删行变异证实。
- 扮演「库被外部改了一列」的运维场景：直接 `UPDATE v3_operations SET summary_json=…`，逐步观察 trigger → poison → 撤 marker → fallback 读，撞出 #7 的缝。
- 扮演「跑官方门禁的交付者」：真的跑了四次 `bun scripts/parallel-test.ts unit it http`，而不是引用文档里的数字，因此撞到 tally 不可复现与 `:74` 仍然红。
- 扮演「读 freeze 测试的维护者」：逐个用例走 freeze/解冻状态机，确认 true/false 方向，再连跑 10 次确认无偶发。
- 扮演「未来要复跑变异对照的人」：三份 patch 逐一 `patch -p1` 注入、跑测试、`patch -R` 还原，发现两份此前只做过 `--check`。

### 只读与副作用声明

- 本评审**未修改**被评审对象的任何源码或测试；工作树内只新建了本报告 `docs/tmp/2026-08-08-task9-review-acceptance.md`。
- 所有变异注入与探针都在 `/tmp/t9`（tar 副本，`node_modules` 符号链接到主树）内进行，每次注入后均反向还原并 `diff -q` 校验。
- 在工作树内运行过两次官方测试门禁（只读执行，测试自身用 DI 临时目录沙箱）。**期间观察到同伴的未提交改动**（`M src/lib/history/v3/store.ts`、`M tests/history/v3/transport-evidence.it.test.ts`），未触碰。

---

---

# 复评 Round 2（HEAD `129a4dbd`）

复评基线：`/tmp/t10` = 工作树 tar 副本，`git show 129a4dbd:src/lib/history/v3/store.ts` 与副本 `diff -q` 逐字节一致。整棵 `tests/history/` 基线 **`550 pass / 23 skip / 0 fail`**（原 HEAD 是 547，新增 3 条：1 条 dml fallback 负控 + 2 条 journal identity 负控）。

## R2-1 —— BLOCKER 闭合复核（复评问题 1）

### 结论：**两个 BLOCKER（我的 #7 = spec F1；spec F2）都真的闭合了，生产侧与判据侧都闭合。修在了正确的层。** 另有一条相邻契约的代价必须记账，见 R2-1d。

### a) #7 / F1 —— 生产缺陷闭合，且判据有鉴别力（双向已验）

**正向（正确状态不被判红）**：`/tmp/t10` 原样跑我 Round 1 的同一份探针 `probe-fallback-gap.ts`：

```
STEP1 readiness {"ready":true,"pending":0,"poisoned":0} marker= 1
STEP2 derived row {"projection_status":"poisoned","projection_error":"canonical operation changed"} marker= null
STEP3 fallback read returns [{"id":"gap-op","endpoint":"unknown","previewText":""}]
```

STEP3 从 Round 1 的 `ATTACKER-CONTROLLED` / `FABRICATED PREVIEW` 变成重投影值。缺陷闭合。

**反向（错误状态必须被判红）**：把缓存快捷返回按原缺陷形态重新注入 `summaryFromRow`（用子查询取回 `v3_operations.summary_json` 并直接返回），探针 STEP3 立刻回到 `ATTACKER-CONTROLLED`，整棵 `tests/history/` 变 **`549 pass / 1 fail`**，唯一变红的正是新增负控：

```
✗ History V3 canonical operation DML final states > the marker-absent fallback publishes the canonical reprojection, never the tampered cached summary
```

独立复现了协调方自报的 `36 pass / 1 fail`。该负控从**真实读路径** `visitV3Summaries` 取值而不是直接调内部函数，符合「wire 正确性用独立 oracle」。

**修在正确层的核实（`fix-at-the-shared-base-not-where-you-noticed`）**：`rg -n "summary_json" src/` 全仓清点，修复后剩余的读取点全部在 `summary-store.ts`（`:95`、`:116`、`:142`、`:163`），且**每一条都带 `projection_status='ready'` 过滤**、只经派生表。再逐个核实这些 raw primitive 的**生产**调用点是否都被 `withValidatedSummarySnapshot` 包住（这正是进度文件「结构怪味」一节点名要求独立评审做的检查）：

| 调用点 | 是否在 snapshot 内 |
|---|---|
| `sessions.ts:28`、`:149` | 是（显式包裹） |
| `stats.ts:107` | 是 |
| `queries.ts:351`、`:414`、`:473` | 是 |
| `queries.ts:231`（`resolveReadySummaryCursor`）、`:263`（`queryReadySummaryCandidates`）、`:321`（`hasPersistedSummaryMatching`） | 是——三者都只在 `queries.ts:512-516` 那个 `withValidatedSummarySnapshot` 闭包里被调用；`:321` 另受 `useReadyProjection` 门控，marker 缺席分支走 `persistedIds`，不碰 raw primitive |

**结论：`summaryFromRow` 当时确实是唯一未受 marker 保护的消费者，修在它身上就是共用基座，没有修浅。** 另外，重投影用的 `recordToEntrySummary(record, stored)` 与 `validateAndMarkSummaryProjectionReady`（`store.ts:1316`）写回 `summary_json` 用的是**同一个函数**，所以 ready 快路径与 fallback 路径的取值按构造一致，不会出现「两条路径给客户端不同答案」的新分叉。

### b) spec F2 —— 闭合；并且**协调方对自己变异结果的判读不完整**（请以本条为准）

协调方报告：「只去掉 decode 侧断言时 recovery 那条仍绿（邻接防线接住、错误信息相同）；两道一起去掉 → 2 fail。我判定这是纵深防御而非假绿。」

**独立复跑，结论：判定的结果对，但支撑它的实验漏了一条测试，真正没有对照的那一层被认反了。**

| 变异 | `tests/history/` | 变红的用例 |
|---|---|---|
| 基线（HEAD 原样） | `550 pass / 0 fail` | — |
| **只**去掉 decode 侧两处 `assertRecordOperationIdentity`（`store.ts:1804`、`:1812`） | `549 pass / 1 fail` | `✗ garbage collection refuses a journal payload whose embedded identity belongs to another row before deleting` |
| **只**去掉 recovery 的邻接防线（`store.ts:1862` 的 `if (prepared.id !== row.operation_id)`） | **`550 pass / 0 fail`（全绿）** | 无 |

也就是说：

- **decode 侧断言并不是「无对照的纵深防御」——它有自己的正控**，只是那条正控在 **GC** 用例上，不在 recovery 用例上。原因是 GC 路径 `journalEvidenceRefGroups`（`store.ts:1653`）**只有** decode 这一道，没有邻接防线。协调方只看了 recovery 那条测试，所以没看见它。
- **真正零鉴别力的是 recovery 里的邻接防线** `store.ts:1862`：单独删掉它，全套件依旧全绿。

**我对这一层的裁决**：邻接防线**不构成 finding，也不必补测试**——它防的是「prepare 路径将来改写 identity」这一在当前实现下**结构上不可达**的形态，要给它造正控就必须去变异 prepare 路径本身，那是把测试写成实现的镜像。正确处置是**把「本行为结构性无法正控」写进它旁边的注释**（现在的注释只说它是 adjacent defence，没说这件事），让后来者不会误以为它被守着。

**可以顺手加强、且零成本的一处**：recovery 那条负控现在断言 `/journal operation identity mismatch/i`，而 decode 侧抛的是 `[history/v3] journal operation identity mismatch: expected X, got Y`、邻接防线抛的是裸 `journal operation identity mismatch`——两者都命中同一个正则，所以该用例**分不出是哪一层拦的**。把它的断言收紧到 `/journal operation identity mismatch: expected .*, got /`，recovery 用例就同时成为 decode 层的正控，两条测试各自锚一层。这是我建议的最小改动，不新增测试。

### c) 三个 BLOCKER 的口径澄清

我 Round 1 报的 BLOCKER 只有 1 条（#7），spec 视角报了 2 条（F1、F2），F1 与我的 #7 同源。所以去重后是**两个不同缺陷**，两个都已闭合。若交付文档写「3 个 BLOCKER 已闭合」，建议改成「2 个不同缺陷（其中 1 个被两个视角各报一次）」，避免把同一缺陷计两次。

### d) **MINOR（须记账，不得默默丢）——修复正确，但落在一条本就无界的 fallback 扫描上，常数变大约 1.7 倍**

`queries.ts:267-291` 的 `queryCanonicalSummaryCandidates` 调 `visitV3Summaries` 时 **visitor 从不返回 `false`，也没有 limit**，即 marker 缺席时一次 History 列表请求会走遍整张 `v3_operations`。修复前后都是「每行完整 hydrate」（旧代码同样先调 `storedOperationFromRow` 才用缓存），所以**复杂度类没有变**；但把 `JSON.parse(缓存)` 换成 `recordToEntrySummary(record, stored)` 之后常数明显变大。

实测（探针 `/tmp/t10/probe-fallback-cost.ts`，2000 条 operation、每条 20 轮 ~400B 消息，`visitV3Summaries` 全表遍历，取 3 次中位）：

| 版本 | N | `visitV3Summaries` 中位耗时 |
|---|---|---|
| 修复前形态（保留缓存快捷返回） | 2000 | **3167 ms** |
| HEAD `129a4dbd`（一律重投影） | 2000 | **5452 ms** |

**为什么必须记账而不是接受**：marker 缺席正是**升级后第一次启动**的常态（migration 002 撤 marker，直到 startup strict repair / backfill 跑完之前一直缺席），而这恰好是用户最可能去点 History 的时刻；线性外推到 2 万条即 ~55s 单请求。

**这不是回退理由**——交出被篡改的投影比慢严重得多，修复方向正确。正确处置是按 `no-silently-cut-but-defer` 把「fallback 列表路径无界全表扫描 + 每行全 hydrate」作为独立条目写进 `docs/todo/deferred-backlog.md`（根因 / 当前行为 / 理想架构 = fallback 也按 keyset 分页并早停 / 为何暂缓 / 若做需改什么），而不是让它随本轮 remediation 一起消失在提交历史里。**顺带**：`store-performance.it.test.ts` 现在既没有写路径退化判据（我的 #5，未闭合），也没有 fallback 读路径的任何判据——这两个缺口应该一起用同一个「确定性工作量计数」方案收口。

---

## R2-2 —— schema-5 → 6 升级路径裁决（复评问题 2）

### 裁决：**你的推理是对的，升级路径确实是坏的。你列的两条「反向证据」都不是反证——它们结构上看不见这个缺陷。**

### 2-1) 实测：真实 schema-5 库跑完整生产序列，必然失败

先看 fixture 的真实形态（探针 `/tmp/t10/probe-fixture.ts`，只读打开 `tests/history/v3/fixtures/transport-evidence/schema5-manifest-v1.db`）：

```
TABLES ["history_store_identity","v3_journal","v3_meta","v3_objects","v3_operations",
        "v3_search_backlog","v3_search_membership","v3_search_objects","v3_timeline_chunks","v3_tracks"]
TRIGGERS []
V3META [{"key":"schema_version","value":"5"}]
HISTMETA ERR SQLiteError: no such table: history_meta
```

**关键事实：真实 schema-5 库连 `history_meta` 都没有 → ledger 为空。** 这是判断整件事的枢纽。

再按 `state.ts:123-127` 的生产顺序原样跑（探针 `/tmp/t10/probe-schema5-upgrade.ts`：`openDatabase` → `ensureV3Schema` → `applyForwardMigrations`，`/tmp/t10` 与 HEAD `129a4dbd` 逐字节一致）：

```
BEFORE version {"value":"5"}
AFTER ensureV3Schema version {"value":"5"}
AFTER ensureV3Schema has evidence table null
MIGRATIONS THREW: Migration 001-operation-summary-projection (up) failed: Original error: no such table: main.v3_transport_evidence
LEDGER null
FINAL TABLES [... 无 v3_transport_evidence / v3_operation_evidence_refs / v3_operation_summaries ...]
```

**`initHistory` 对 migration 失败是 rethrow（refuse-to-start 契约），所以任何持有 schema-5 History 库的存量用户，升级后服务起不来，且 ledger 永远为空、每次重启在同一处死。** 这是 BLOCKER 级的产品缺陷。

机制与你说的完全一致：`ensureV3Schema`（`store.ts:362-374`）在 `version !== "6"` 时早退（它明确声明不拥有版本迁移），而 `MIGRATIONS`（`migrations/index.ts:67`）把 `001-operation-summary-projection` 排在 `001-transport-evidence-schema` 之前，前者 exec 的 `SUMMARY_PROJECTION_MIGRATION_SQL` 里含 `SUMMARY_PROJECTION_TRIGGER_SQL`，后者有 **4 条以 `v3_transport_evidence` 为触发目标**的 trigger 语句（探针 `probe-split-triggers.ts` 实测计数=4）——SQLite 在 `CREATE TRIGGER` 时就要求**目标表**存在。

### 2-2) 你那两条「反向证据」为什么不是反证

| 你引用的证据 | 实际情况 |
|---|---|
| `transport-evidence-migration.it.test.ts:53` 那条 schema-5 测试在旧顺序下是绿的 | 它 `const migration = MIGRATIONS.find(name === "001-transport-evidence-schema"); await applyForwardMigrations(db, [migration])` ——**注入单条 migration 列表，根本没跑 `001-operation-summary-projection`**。同文件 `:91` 的 rollback 测试同样只注入这一条。两条都**从不驱动出厂 `MIGRATIONS` 数组**，所以结构上看不见顺序缺陷（`appliesTo 命中 ≠ 链被驱动` 的同型） |
| `:45` 那条顺序 guard | 见下，它是快照不是不变量 |

**还有一条更像、但同样看不见的**：`migrations-wiring.it.test.ts:193` 「production startup leaves a schema-5 database unchanged…」确实走真实 `initHistory`，但它的 fixture 里写死了 `INSERT INTO history_meta(key,value) VALUES('schema_migrations','["001-operation-summary-projection"]')`——**预先把 001 标记为已执行**，于是 001 被跳过，正好把这条排序风险中和掉。我核过 `git show 10891dff~3:` （即 `ab594029`），这个 ledger 预置**早于本轮 Task 9**，不是本轮引入的。

**所以判据侧的真实缺口是（MAJOR）**：截至 HEAD `129a4dbd`，**没有任何一条已提交测试把出厂 `MIGRATIONS` 数组跑在一个真实的、ledger 为空的 schema-5 库上**。`legacy-db-fixtures.it.test.ts` 在 HEAD 版本里 `grep -c applyForwardMigrations` = **0**（我复核过 `git show 129a4dbd:` 与 `/tmp/t10` 副本，两者都是 0）——你现在未提交的那条 `test.each` 是**第一条**这么做的测试，它一写出来就撞红了，这正说明缺口在哪。

### 2-3) 归属：**这是存量缺陷，不是本轮三个 commit 引入的**

`git log -S "v3_transport_evidence_before_identity_update" -- src/lib/history/v3/summary-schema.ts` → **`72b51429 fix: invalidate changed History evidence`**，它是 `10891dff` 的祖先，且**不在** `ab594029..129a4dbd` 这 6 个提交里。在 72b51429 之前，`SUMMARY_PROJECTION_TRIGGER_SQL` 不含任何以 evidence 表为目标的 trigger，schema-5 空 ledger 库升级是通的。所以：**Task 9 既没引入它、也没闭合它**；但它落在同一片代码面上，且现在已经被 F3 的负控暴露，交付前必须闭合。

### 2-4) 那条顺序 guard 到底守什么：**是快照，不是 Umzug 语义不变量**

`migrations/storage.ts` 的 `HistoryMetaStorage`：`logMigration` 是 `if (!list.includes(name)) list.push(name)`，`executed()` 直接返回该数组，Umzug 的 pending 集合 = `MIGRATIONS` 里不在 executed 中的项、**按 MIGRATIONS 数组顺序执行**。**ledger 是一个集合，它的存储顺序只是插入顺序，没有任何代码依赖它。** 因此 `transport-evidence-migration.it.test.ts:45` 那条 `MIGRATIONS.map(name)` 全等断言，守的不是 append-only 语义，而是一张**数组快照**；它的测试名（「registers … **after** the existing summary migration」）把一个**错误方向**的依赖固化成了守卫——真实依赖恰好相反。

### 2-5) 前移 `001-transport-evidence-schema` 是否安全：**安全，四类库全覆盖**

实测（`/tmp/t10` 内以 `MIGRATIONS.unshift(MIGRATIONS.splice(1, 1)[0])` 在模块尾部就地换序，不动字面量）：

```
MIGRATIONS OK; version now {"value":"6"}
LEDGER ["001-transport-evidence-schema","001-operation-summary-projection","002-summary-integrity-invalidation"]
FINAL TABLES [... v3_transport_evidence / v3_operation_evidence_refs / v3_journal_evidence_refs / v3_operation_summaries 全部就位 ...]
```

| 库形态 | ledger | 旧顺序 | 新顺序 | 依据 |
|---|---|---|---|---|
| 全新库 | 空 | `ensureV3Schema` 已建 v6 全表 → 001-summary OK；transport-evidence 见 `version==="6"` 早退 | 同上，只是先早退再建 summary。**等价** | 换序后 `tests/history/` 545 pass，失败的 5 条全是顺序快照（见 2-7） |
| schema-5 + 空 ledger（真存量） | 空 | **失败，refuse-to-start** | **成功升到 6** | 上面两个探针 |
| schema-5 + ledger 含 001-summary（中间版本用户） | 含 001 | 001 跳过 → transport-evidence 升 6 → 002 | 完全相同（001 仍跳过） | pending 由集合成员关系决定，与顺序无关 |
| 已升到 6 + 三条齐全 | 全 | 全跳过 | 全跳过 | 同上 |

### 2-6) 但我不建议只做换序——给出我认为最小且正确的收口形状

**换序是必要且安全的，但它只让依赖「恰好被满足」，没有把依赖写下来。** 我实测了另一条路（`probe-split-triggers.ts`）：把 `SUMMARY_PROJECTION_TRIGGER_SQL` 中 4 条以 `v3_transport_evidence` 为目标的语句剔除后，剩余部分在真实 schema-5 库上 `exec` **成功**，装出 5 条 summary 侧 trigger。所以「拆分 trigger SQL、让每条 migration 只拥有自己的 DDL」在技术上可行。

**但我不推荐拆分作为本次的修法**，理由是拆分会引入一个更差的中间态：`v3_operation_summaries_after_insert` 的**触发体**里引用 `v3_operation_evidence_refs`（SQLite 建 trigger 时不解析触发体内的表，所以能建成功），拆分后 schema-5 库会短暂存在「summary trigger 已装、evidence 表还没建」的状态；一旦 `001-transport-evidence-schema` 在那之后失败，库里就留着一条一写就炸的 trigger。**换序则保证 evidence 表先于任何 summary trigger 存在，不产生这种中间态。**

因此我建议的收口是三件，缺一不可：

1. **换序**：`001-transport-evidence-schema` 移到 `001-operation-summary-projection` 之前，并在 `MIGRATIONS` 数组处写一行注释点名理由（`SUMMARY_PROJECTION_TRIGGER_SQL` 含 `CREATE TRIGGER … ON v3_transport_evidence`，目标表必须先存在）。
2. **把快照 guard 换成表达依赖的 guard**：`transport-evidence-migration.it.test.ts:45` 与 `migrations.it.test.ts:112` 现在的 `toEqual([...])` 改为断言**相对次序**——`indexOf("001-transport-evidence-schema") < indexOf("001-operation-summary-projection")`，并在断言旁写明这条次序是 DDL 依赖而非风格。`migrations-wiring` 的三处 ledger 断言仍按集合语义更新为新插入顺序即可（它们守的是「哪些跑过」，不是顺序）。
3. **补上真正缺的那条判据**：把出厂 `MIGRATIONS`（不传第二参）跑在 `schema5-manifest-v1.db` 的真实副本上，断言 `v3_meta.schema_version → "6"`、三张 evidence 表存在、ledger 三条齐全、且 legacy row 仍可 `hydrateManifest`。**你现在未提交的那条 `test.each` 已经很接近，把它保留下来就是这条判据**——它是唯一驱动出厂数组的升级路径测试，别在换序后因为它转绿就顺手删掉。

### 2-7) 那 5 条红：**全部是顺序快照，没有一条是行为回归，也不是级联**（复评问题 4）

我在 `/tmp/t10` 换序后跑 `tests/history/` 得 `545 pass / 23 skip / 5 fail`，与你观察一致。逐条打开失败断言：

| 用例 | 失败在哪一行 | 性质 |
|---|---|---|
| `registers the transport-evidence migration after the existing summary migration` | `transport-evidence-migration.it.test.ts:46` `MIGRATIONS.map(name)` 全等 | 数组快照 |
| `an explicitly empty migration list is a no-op on a bare DB` | `migrations.it.test.ts:112` **同一个 `MIGRATIONS.map(name)` 全等断言** | 数组快照（顺带：这条断言与该用例标题毫不相干，属名实不符，建议拆走） |
| `initHistory(true) creates history_meta on the opened V3 db` | `migrations-wiring.it.test.ts:101` ledger 数组全等 | ledger 插入顺序快照 |
| `a non-empty injected MIGRATIONS array runs REAL DDL…` | `:180` ledger 数组全等 | 同上 |
| `initHistory rethrows (not swallows) when a migration fails` | `:256` ledger 数组全等 | 同上 |

失败 diff 一律是 `- "001-operation-summary-projection"` / `+ "001-operation-summary-projection"` 换位，**没有任何一条断言的是行为**（建表、触发器存在、rethrow、幂等、回滚等断言全部照绿）。所以这 5 条既不是真实波及、也不是共享 DB 状态级联，而是**同一个「把顺序写死成字面量」的快照判据被复述了 5 遍**（`one-authority-allows-contextual-restatement` 的反面：5 处复述、0 处说明理由）。

### 2-8) 附带裁决：F3 那道 `hasOperationEvidenceRefsTable` 守卫**引入了一个 false-green**

读了你未提交的 diff（`git diff -- src/lib/history/v3/store.ts`）。方向对：无条件查询会让 pre-schema-6 库整体读不出来，那是真 false-red，必须挡。**但守卫的判别对象选错了一层**（`align-probe-depth-with-subject`）：docstring 论证的是「**schema 5 及更早**没有这张表，且只可能存 v1/v2 manifest」，而代码判的是「**这张表存不存在**」。两者不等价——一个 **schema-6** 库若因任何原因缺了 `v3_operation_evidence_refs`（例如 `transport-evidence-migration.it.test.ts:91` 那条 rollback 测试构造的形态），`hydrateManifest` 会对**含非空 ref 集的 v3 manifest 整个跳过对账**，静默 fail-open——正是 F3 要修的那类「一个消费者放行、另一个拒绝」重新出现。

最小修法（保留全部 F3 收益、去掉 fail-open，一行）：

```ts
if (manifest.formatVersion === 3 || hasOperationEvidenceRefsTable(db)) validatePersistedOperationEvidenceRefs(db, manifest, expectedOperationId)
```

v3 manifest **永远**对账（缺表就大声失败），v1/v2 只在表存在时对账（legacy 库照常可读）。另建议给它配一条负控：schema-6 库 DROP 掉 ref 表后读 v3 manifest 必须抛，而不是返回。

**另一处轻微代价（非 false-green，仅记录）**：`hasOperationEvidenceRefsTable` 每次 `hydrateManifest` 都要查一次 `sqlite_schema`，而 marker 缺席的 fallback 列表会对全表逐行 hydrate（见 R2-1d，2000 行已 5.4s），等于再加 2000 次查询。可在调用侧提升一次、或与 R2-1d 的 backlog 条目一并处理。

---

## R2-3 —— 整改核验（HEAD `b0992a6c`）

复评基线：`/tmp/t11` = 工作树 tar 副本，`git show b0992a6c:src/lib/history/v3/store.ts` 与副本 `diff -q` 逐字节一致。`tests/history/` 基线 **`554 pass / 23 skip / 0 fail`**（与你报的一致）。所有变异注入后均还原并 `diff -q` 校验，最终基线复跑仍 `554 / 0 fail`。

### 3-1) 四类库全部安全，**含你最担心的那一类**（复评问题 1）

探针 `/tmp/t11/probe-populations.ts` 与 `/tmp/t11/probe-upgraded.ts`，走真实 `openDatabase → ensureV3Schema → applyForwardMigrations`：

| 群体 | 起始态 | 结果 |
|---|---|---|
| P1 全新库 | 无文件 | version `6`，ledger 三条齐全，evidence/refs/summaries 表全建，`err=null` |
| P2 真实 schema-5 + 空 ledger | fixture 原样，无 `history_meta` | **version 5 → 6**，ledger 三条齐全，三张表全建，`err=null`（Round 2 前此处必失败） |
| P3 schema-5 + ledger 只含 `001-operation-summary-projection`（中间版本用户） | version 5，summaries 表已存在 | version → 6，ledger 变为 `[summary, transport, 002]`，`err=null` |
| **P6 已升到 6 且 ledger 是旧顺序写下的** `["001-operation-summary-projection","001-transport-evidence-schema","002-…"]` | marker=`1`，1 行 `ready` | **ledger 一字未动、marker 仍 `1`、状态仍 `ready`、version 仍 6** —— **Umzug 没有认为有 pending，零 migration 重跑** |
| P5 已升到 6 + 新顺序 ledger | 同上 | 同上，零重跑 |

**「零重跑」这个结论本身也做了负控**，否则它只是个空断言：P7 = 同样的 v6 库，但把 `002-summary-integrity-invalidation` 从 ledger 里摘掉 → 002 **确实重跑**（marker `1 → null`，summary 状态 `ready → pending`）。所以 P5/P6 的「什么都没变」是有判别力的观测，不是探针失灵。

**机制**：`storage.ts` 的 `logMigration` 是 `if (!list.includes(name)) push`，`executed()` 返回该集合，pending 由**集合成员关系**决定 —— 换序不改变任何已存在库的成员关系。实测与机制一致。

**一个不构成风险、但值得写进注释的边角**：我另构造了 P4 = schema-5 + ledger 只含 `001-transport-evidence-schema` + 三张 evidence 表不存在 → `001-operation-summary-projection` 仍以同样的 `no such table: main.v3_transport_evidence` 失败。**这不是换序引入的**（旧顺序下同一形态同样失败），而且该形态**在生产不可达**：`sqlMigration` 把 transport 迁移包在事务里，ledger 里有它 ⟺ 它成功过 ⟺ 表存在且 version=6；要造出 P4 必须在 ledger 已记录后人为把 version 改回 5 并 DROP 表（这正是 `transport-evidence-migration.it.test.ts:53/:91` 两个 fixture 做的事）。真正的残余性质是：**`001-transport-evidence-schema` 对「ledger 说做过、但表被人删了」不可重入**。建议在 `MIGRATIONS` 的注释里补一句点明这条前置条件由 ledger 而非表存在性保证，避免后人以为顺序等于充分条件。

### 3-2) 改形后的 guard **仍咬得住**，而且比改形前更强（复评问题 2）

**变异 A —— 把换序改回破坏形态**（`MIGRATIONS.unshift(MIGRATIONS.splice(1, 1)[0])`）：

```
551 pass / 23 skip / 3 fail
✗ registers the transport-evidence migration before the summary migration that triggers off its table
✗ schema5-manifest-v1.db migrated to schema 6 refuses a legacy row carrying a stray normalized evidence ref
✗ schema5-manifest-v2-shared.db migrated to schema 6 refuses a legacy row carrying a stray normalized evidence ref
```

三条全红，且**质地和改形前完全不同**：改形前的 5 条红全是「把顺序写死成字面量」的快照；现在是 **1 条表达依赖方向的 guard + 2 条真实升级路径行为判据**。同时四处 ledger 集合断言在换序下**保持绿**——这正是想要的：它们不再对顺序做任何声称，于是不再被无关改动打红。

**变异 B —— ledger 少记一条**（在 `storage.ts` 的 `logMigration` 里对 `001-operation-summary-projection` 直接 `return`，即迁移跑了但没入账）：

```
551 pass / 23 skip / 3 fail
✗ initHistory(true) creates history_meta on the opened V3 db (new open-path behavior)
✗ a non-empty injected MIGRATIONS array runs REAL DDL … idempotently no-ops on rerun
✗ initHistory rethrows (not swallows) when a migration fails — refuse-to-start contract
```

四处集合断言中三处变红。**没变红的第四处（`migrations-wiring.it.test.ts:145`）是正确的绿**：那条用例自己先手工把 ledger 写成 `["001-operation-summary-projection","001-transport-evidence-schema"]` 再只跑 002，`001-operation-summary-projection` 来自手工种子而非 `logMigration`，所以变异碰不到它。

**结论：array → Set 的放宽没有丢失任何鉴别力。** `expect(new Set(...)).toEqual(new Set(...))` 双向比较成员，缺项和多项都判得出；而 `logMigration` 本身去重，所以 Set 折叠重复项这件事在此不可能掩盖缺陷。

### 3-3) F3 守卫最终形态：**两个方向都关上了，且各自有正控**（复评问题 3）

| 变异 | 结果 | 说明 |
|---|---|---|
| **C（false-green 方向）** 把守卫改回只判表存在：`if (hasOperationEvidenceRefsTable(db))` | `553 pass / 1 fail` → `✗ a v3 manifest is still reconciled when the normalized ref table is missing` | 你新增的那条负控**确实打在守卫上**，不是旁路 |
| **D（false-red 方向）** 去掉守卫、无条件对账 | `552 pass / 2 fail` → 两条 `schema5-manifest-v*.db remains readable through detail, readonly/search, summary, and direct hydrate` | 说明「legacy 允许」这一支是承重的、且有正控证明存量库仍可读 |

`manifest.formatVersion === 3 || hasOperationEvidenceRefsTable(db)` 这个形态是对的：**版本判据在前、表探测只作 legacy 允许**，与 docstring 声称的被测对象（「schema ≤5 没什么可对账」）终于对齐（`align-probe-depth-with-subject`）。

**一处可选加强（不是 finding）**：新负控用的是裸 `expect(...).toThrow()`，不锁消息。DROP 表后实际抛的是 SQLite 的 `no such table: v3_operation_evidence_refs`（来自 `operationRefs` 的 SELECT），属于「大声 fail-closed」，方向正确；但裸 `toThrow()` 分不出「因为目标机制失败」还是「因为别的原因失败」。建议收紧成 `/no such table: v3_operation_evidence_refs|operation evidence refs mismatch/i`，与你刚给 recovery 负控做的收紧同理。

### 3-4) #2 的新负控：**形态等价，判据成立**（复评问题 4）

**先证它真的打在门上**：删掉 `store.ts` 的 `hydrateManifest(db, prepared.compressedManifest, prepared.id)` 那一行（我 Round 1 用的同一个变异，当时 `tests/history/` **547 pass / 0 fail** 全绿）——现在：

```
553 pass / 23 skip / 1 fail
✗ the commit-time strict gate aborts transaction B when persisted refs stop matching the manifest
```

**我的 Round 1 #2（MAJOR）由此闭合。**

**关于「同一事务内删除」与生产形态是否等价——等价，理由是可机械核对的三条**：

1. **门看到的状态相同**：注入点 `transactionBFailureInjectorForTests?.("refs")` 位于 `insertOperationEvidenceRefs(...)` 之后、strict hydrate 之前。「插入 N 条后删掉 1 条」与「本来就只插入 N−1 条」在事务内对后续语句是**同一个可见行集**（SQLite 事务内读自己的写）。
2. **删除本身无额外副作用**：`SUMMARY_PROJECTION_TRIGGER_SQL` 里没有任何以 `v3_operation_evidence_refs` 为触发目标的 trigger（触发目标只有 `v3_operations` 与 `v3_transport_evidence`），所以这条 DELETE 不会连带触发别的东西，不会把「门变红」的功劳偷偷记到 trigger 头上。
3. **失败后的可观测终态与生产一致**：用例已断言 canonical 行、summary 行、refs 行三者皆不存在，marker 保持事务前的 `'1'`，且 journal 行仍在（`format_version: 2`）——这正是生产里 transaction B ABORT 应有的形态，冻结架构矩阵第 2 行要求的「零发布」。

**唯一不等价、也确实没被覆盖的一角（建议记账，不必本轮做）**：当前只覆盖「**少写一条 ref**」，没覆盖「**写了但值不对**」（例如 `byte_length` 偏 1、`sequence` 写错）。读路径已有 `byte_length+1` 的负控（`summary-projection-migration.it.test.ts:249`），但**提交时**这一形态没有对照。若要补，最小改动是把同一个注入器改成 `UPDATE … SET byte_length=byte_length+1`，加一条同形用例即可。

### 3-5) 门禁口径：并入我 #9c 的结论，**不补新解释**

你报的 `16 shards · 860 tests · 860 pass · 0 fail · 43.96s`，加上此前的 `2806`、`4200`，以及我 Round 1 亲自跑到的 `6705 / 5846 / 5796 / 5555`——**同一条命令、同一份 699 文件发现集合，至今已有 7 个互不相同的 tests 总数**。这与「exit code 可信、仪表不可信」的结论一致，并且现在有了更强的一条：**`fa28deb3` 把 `await p.exited` 改成与读管道并发之后，数字依旧乱跳**，所以管道背压不是（至少不是唯一）成因，我在 Round 1 给出的 `stripAnsi` 漏删 ESC 的假说也已被你的实测证伪（源码里含真实 ESC 字节）。

按 `verified-by-a-wrong-query`，正确处置是**不再给它编第三个因果解释**，而是：① 交付文档一律**不引用这行 tally**，只引用 exit code 与「哪些用例失败」；② 把「parallel-test 汇总行不可复现，根因未定」作为独立条目记进 `docs/todo/deferred-backlog.md`，附上这 7 个数字与复跑命令；③ 真要拿数字，改用每个 shard 的 junit 产物汇总（`run` 已经用 junit reporter 落盘），那是结构化输入，不经这条正则。

### 3-6) 本轮核验小结

| 我 Round 1／R2 的发现 | 现状 |
|---|---|
| #7 / spec F1（BLOCKER） | 闭合，生产 + 判据双向已验（R2-1a） |
| spec F2（BLOCKER） | 闭合；decode 侧有 GC 正控，邻接防线已按建议加注释说明其结构性不可正控 |
| schema-5 升级路径（BLOCKER，存量缺陷） | **闭合**，四类库实测全安全，且 guard 由快照改为依赖断言 + 真实升级路径判据 |
| #2 commit-time strict gate（MAJOR） | **闭合**，变异对照按目标变红 |
| F3 守卫 false-green（我 R2-2 提出） | **闭合**，两个方向各有正控 |
| #5 写路径退化判据（MAJOR） | **仍未闭合**（你已如实记为未闭合）；建议与 R2-1d 的 fallback 扫描一并用确定性工作量计数收口 |
| #9 门禁仪表（MAJOR） | 结论不变：exit code 可信、tally 不可信、根因未定；按 3-5 处置 |

---

## R2-4 —— 收口复评（HEAD `c3c792e2`）

基线 `/tmp/t12` 与 `git show c3c792e2:src/lib/history/v3/store.ts` 逐字节一致；`tests/history/` **`556 pass / 23 skip / 0 fail`**（与你报的一致）。全部变异注入后已还原，最终基线复跑仍 `556 / 0 fail`。

### 4-1) 新判据确实覆盖了它声称的不变量（复评问题 1）——但捕获面有一个真实的小洞

**先证它有鉴别力**：把 `store.ts:895` 的 `isSummaryProjectionReady(db)` 改回 `getSummaryProjectionReadiness(db).ready`，在**出厂的 N=2** 设置下跑 `store-performance.it.test.ts` → `3 pass / 1 fail`，失败在 `expect(offenders).toEqual([])`，offender 精确是：

```
SCAN v3_operation_summaries :: SELECT
         SUM(CASE WHEN projection_status='pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN projection_status='poisoned' THEN 1 ELSE 0 END) AS poisoned
       FROM v3_operation_summaries
```

**我 Round 1 的 #5 判据侧由此闭合**，而且这次是确定性判据、不受 CPU 争用影响。你自己先做出假判据又证伪它的那一段（表不存在 → 聚合提前返回 → 变异下仍全绿）我复核过成立：`getSummaryProjectionReadiness`（`summary-store.ts:480-481`）确实先查表存在性并早退，所以「只 `ensureV3Schema` 不跑迁移」的库上那条语句根本不会执行——这是一个教科书级的 vacuous-green，补 `applyForwardMigrations` 是对的修法。

**捕获完整性实测**（探针 `/tmp/t12/probe-plan-capture.ts` / `probe-plan-stats.ts`，同时包裹 `db.prepare` 与 `db.exec`）：

| 项 | 实测 |
|---|---|
| 一次提交经 `db.prepare` 的语句数 | **29**（去重后 21 条不同 SQL） |
| 被 `try/catch continue` 跳过的 | **0** —— `EXPLAIN QUERY PLAN` 对带 `?` 绑定参数、CTE、`INSERT OR REPLACE`、`json_each(?)` 全部规划成功，`.all()` 无需绑定 |
| 被前置 `if (!/^\s*(?:SELECT\|UPDATE\|DELETE\|INSERT)/i)` 跳过的 | **0** |
| 一次提交经 `db.exec` 的语句数 | **4** —— 一段 `V3_SCHEMA_SQL` 全量 DDL + `DROP TABLE IF EXISTS v3_search_{membership,objects,backlog}`（来自 `ensureV3Schema` 的当前层重刷） |

所以你担心的「try/catch 静默跳过一大片、且恰好是承重的」**没有发生**：跳过数为 0，承重的那条聚合就在被规划的 29 条里（变异实测已证）。

**但 `db.exec` 是一个真实的逃逸口（MINOR，建议补）**：guard 只包裹 `prepare`。今天经 `exec` 走的 4 条都是 DDL、与历史长度无关，所以现在不是缺陷；但它是**判据的盲区**而非「不存在的路径」——将来任何人把一条 DML 写成 `db.exec("DELETE FROM v3_operations WHERE …")`，这道门看不见。一行修法：同样包裹 `db.exec`，并断言经 `exec` 的语句全部匹配 DDL 白名单（`CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT`），有 DML 就直接判失败。这比把 exec 的 SQL 也送去 EQP 更简单，也更符合「exec 不该承载 DML」这条真正的意图。

（顺带记录、非本轮问题：`ensureV3Schema` 在**每次提交**里重刷一遍完整 `V3_SCHEMA_SQL` + 3 条 `DROP TABLE IF EXISTS`。它是 O(1) 而非 O(history)，所以新 guard 判它无罪是对的；但它仍是每提交一次的常量开销，可与 R2-1d 的 backlog 条目并列记一笔。）

### 4-2) 「查询计划不依赖行数」这个理由**不成立**；但你砍到 N=2 的**结论**成立（复评问题 2）

**理由不成立的两处，都可实测**：

1. **本仓有 ANALYZE，而且它就在测试用的开库路径上。** `connection.ts:89-90`：`openDatabase()` 无条件调用 `maybeVacuumOnStartup` + **`seedAnalyzeIfNeeded`**（`:235-244`，内部 `database.exec("ANALYZE;")`），而 `openInMemoryDatabase()`（`:296-298`）就是 `openDatabase(":memory:")`。实测该测试库在 setup 阶段 **`sqlite_stat1` 已存在**。另有 `runOptimize`（`:252-256`，`PRAGMA optimize`）在 reaper tick 上持续刷新生产库的统计。所以「no ANALYZE stats here」是错的。
2. **SQLite 的计划本来就吃统计。** 实测：在同一个库上 seed 200 行后手工 `ANALYZE`，`sqlite_stat1` 立刻出现 `v3_operation_summaries` 三个索引的 `"200 200 1"` 一类选择性统计——计划输入确实随行数变。

**为什么 `sqlite_stat1` 存在却几乎是空的**：`seedAnalyzeIfNeeded` 在 `openDatabase` 早期就跑，那一刻 v3 表还没建（`ensureV3Schema`/迁移在其后），所以 ANALYZE 只记下了 `history_store_identity` 一行；而它又以「`sqlite_stat1` 存在即返回」为条件，此后**永不重跑**。实测该库 `sqlite_stat1` 内容始终只有 `history_store_identity`。

**结论仍然成立，但要用实测而不是这条错理由来支撑**。我用加宽后的 11 张表清单跑了三组：

| 设置 | `v3_operations` 行数 | `sqlite_stat1` | offenders |
|---|---|---|---|
| N=2（出厂设置） | 2 | 只有 `history_store_identity` | **0** |
| N=200，不 ANALYZE | 200 | 同上 | **0** |
| N=200 + 手工 `ANALYZE` | 200 | 含各 v3 索引真实选择性 | **0** |

即：判据的裁决在 N=2、N=200、以及带真实统计的 N=200 下**一致**。所以砍 flood 没有削弱判据。

**处置建议**：把那条注释里的「a query PLAN is chosen from the schema, not from row counts (no ANALYZE stats here)」换成实测口径——「N=2/N=200/N=200+ANALYZE 三组裁决一致（复跑命令 X）；注意 `openDatabase` 会 `seedAnalyzeIfNeeded`，本库的 `sqlite_stat1` 只含 floor 表，因为 ANALYZE 早于 v3 表创建」。**理由写错比没写更危险**：它是给下一个人读的指令性文本，下一个人会据此认为「计划与数据无关」，从而在别处放心地用极小样本判计划。

### 4-3) `historyLengthTables` 名单确有遗漏，但**目前是潜在缺口不是活缺陷**（复评问题 3）

我把清单加宽到 11 张（补 `v3_sequence_nodes`、`v3_transport_evidence`、`v3_operation_evidence_refs`、`v3_journal_evidence_refs`、`v3_journal`、`v3_summary_backlog`）重跑 —— **三组设置下 offenders 仍为 0**。所以遗漏今天不掩盖任何东西。

但从判据设计上，**黑名单是错的形状**：它要求维护者在新增表时记得回来加一行，而「忘了加」不会有任何信号（`criteria-list-grows`）。`v3_sequence_nodes` 与两张 refs 表都是逐操作增长的，`v3_transport_evidence` 随捕获量增长——它们本来就该在名单里。

**建议改成白名单**：断言「一次提交的计划里不得出现对**任何**表的 `SCAN`，除非该表在有界表白名单里」（`v3_meta`、`history_meta`、`history_store_identity`、`sqlite_schema` 之类）。这样新增表默认被守住，且白名单每加一项都必须写理由——正是 `freeze-hit-set-not-zero-hits` 想要的形状。

### 4-4) 两处加强达到了我原本的意图，且都经变异证实（复评问题 4）

- **#2 第二方向**：`test.each` 参数化为「ref 消失」与「`byte_length+1`」。删掉 `store.ts` 的 commit-time strict hydrate 那一行 → `transport-evidence.it.test.ts` `37 pass / 2 fail`，**两个方向同时变红**。正是我建议的形状（同一注入器改 `UPDATE … byte_length+1`）。
- **F3 锁消息**：裸 `toThrow()` 已收紧为 `/no such table: v3_operation_evidence_refs/i`，与实测抛出的错误一致（该错误来自 `operationRefs` 对已 DROP 表的 SELECT），机制被钉住了。

### 4-5) 两条门禁失败：判定成立，且其中一条我能给出机制（复评问题 5）

**`tests/routes/hooks.http.test.ts` 的 `POST /reload` —— 与本轮改动无因果关系，且有确定的跨 shard 污染机制。**

`src/lib/pipeline/hooks/loader.ts:92-110`：

```ts
const HOOK_CACHE_DIR = ".hooks-cache"          // 相对路径 → 解析到 process.cwd()
let cacheInitialized = false                   // 进程级
...
if (!cacheInitialized) {
  rmSync(HOOK_CACHE_DIR, { recursive: true, force: true })   // 清空整个共享目录
  mkdirSync(HOOK_CACHE_DIR, { recursive: true })
  cacheInitialized = true
}
const compiledPath = join(HOOK_CACHE_DIR, `hook-${Date.now()}-${++loadSeq}.mjs`)
writeFileSync(compiledPath, js)
const mod = await import(join(process.cwd(), compiledPath))
```

而 `scripts/parallel-test.ts:120` 是 `Bun.spawn(["bun", "test", ...b], { cwd: REPO_ROOT })` —— **16 个 shard 共享同一个 `process.cwd()`，因而共享同一个 `.hooks-cache/`**。`cacheInitialized` 是进程级的，所以**每个 shard 首次加载 hook 时都会 `rmSync` 掉整个共享目录**，把别的 shard 刚写下、正准备 `import()` 的文件删掉；文件名 `hook-${Date.now()}-${loadSeq}` 里 `loadSeq` 也是进程级的，两个 shard 在同一毫秒、同一 seq 会撞出**完全相同的文件名**。

这条路径与 `cf377959`／`2b2c1d43` 改的东西（History 迁移顺序、`hydrateManifest` 守卫、history 测试）**没有任何交集**——hook loader 不 import History 任何模块，History 也不 import 它。**判定成立。** 并且这不只是「flake」，是可修的：把缓存目录与文件名按进程隔离（`mkdtempSync` 或路径里带 `process.pid`），或干脆放进 `XDG_DATA_HOME` 沙箱（那个是 per-process 的）。建议作为独立条目进 backlog。

**`states-flush-freeze.it.test.ts:74` —— 与本轮改动无关，有直接的时间线证据。**

我在 **Round 1**（HEAD 还是 `10891dff` + 同伴 WIP，即 `cf377959`／`2b2c1d43` 之前）跑官方门时就抓到过**同一文件、同一行、同一断言**的失败（本报告 §9d 已记录：`:74` 的 `expect(hasLearnedRejectModel(snapshot1, "claude-sonnet-4-9")).toBe(true)`）。**同一失败在本轮改动之前就存在**，因此不是本轮引入的。我也复核过它不是本轮 drain seam 的回归：`:74` 是 `flushAndFreeze` 的「立即落盘」断言，drain seam 改的是 `:79/:90/:99/:114` 那几条 debounce 等待。

**但我不给它补机制解释**——`readNegotiationDisk` 走的 `XDG_DATA_HOME` 沙箱是 per-process 的（`tests/helpers/sandbox-paths.ts` 用 `mkdtempSync`），所以上面那种跨 shard 文件互删在这里说不通；我隔离复跑（32 个引用 feature-negotiation 的文件同进程连跑 6 次）也是 6/6 绿。**根因未定，按 `verified-by-a-wrong-query` 不编第三个解释**，只登记形态与已排除的假设。

### 4-6) 收口状态表

| 发现 | 状态 |
|---|---|
| #7 / spec F1（BLOCKER） | 闭合 |
| spec F2（BLOCKER） | 闭合 |
| schema-5 升级路径（BLOCKER，存量） | 闭合，四类库实测 |
| #2 commit-time strict gate（MAJOR） | 闭合，两个方向变异均红 |
| F3 守卫 false-green | 闭合，两个方向各有正控 |
| **#5 写路径退化判据（MAJOR）** | **闭合**——确定性查询计划判据，变异下精确红在 `SCAN v3_operation_summaries` |
| #9 门禁仪表（MAJOR） | 未闭合但已正确降级：exit code 可信、tally 不引用、根因未定已入 backlog |
| 新增 MINOR（本轮） | ①guard 未覆盖 `db.exec` 逃逸口 ②N=2 的**理由**写错（结论对）③`historyLengthTables` 宜改白名单 ④hooks `.hooks-cache` 跨 shard 共享，建议入 backlog |

**verdict：无未闭合 blocker；剩余项均为 MINOR 或已登记的 backlog。** 唯一我认为应在合并前顺手做掉的是 4-2 那条**注释里的错误理由**——它是给后来者读的指令性文本，其余三条可进 backlog。

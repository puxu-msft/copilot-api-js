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

# Task 9 独立评审：spec 合规与生产图

## 评审元信息

- **评审范围：** commits `8b839820`、`756a1b30`、`10891dff`；主责为 ready-summary 冻结架构合规、生产调用图、manifest/evidence identity 与 normalized refs、既有 guard 变更、lint 整合中的语义改动、commit 边界。
- **已读取／执行的证据：** `.superpowers/sdd/task-9-summary-integrity-architecture.md`、`.superpowers/sdd/progress.md`、`docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-ready-snapshot.md`、`docs/history-v3-schema.md`；读取相关生产源码与测试；执行 `git show`／`git diff`／`rg` 调用点与提交内容审计。CodeGraph 检测到索引属于另一 worktree，未将其结果作为本树结论证据，后续均按当前 worktree `10891dff` 的文件与 Git object 复核。
- **总体 verdict：** 存在 BLOCKER，不可进入下一阶段。
- **BLOCKER 数量：** 2。

## 事实性发现

### F1 — BLOCKER — marker 缺席时的 canonical fallback 仍发布未经重投影验证的旧 `summary_json`

**位置：** `src/lib/history/v3/store.ts:1245-1255`、`src/lib/history/v3/store.ts:1257-1286`、`src/lib/history/sqlite/migrations/index.ts:106-110`、`src/lib/history/state.ts:121-133`、`.superpowers/sdd/task-9-summary-integrity-architecture.md:64-70`。

**问题：** `summaryFromRow()` 先通过 `storedOperationFromRow()`／`hydrateManifest()` 验证 canonical manifest、digest、CAS 与 evidence，但只要 `v3_operations.summary_json` 非空，就直接解析并返回该旧派生值，而不是从刚验证的 canonical record 重投影。`visitV3Summaries()` 是 marker 缺席时 list／session／stats fallback 的生产入口。因此 migration 002 撤 marker、将窄表置 `pending` 后，到异步 strict scrub 完成前，消费者仍可读到迁移前未经本轮 strict repair 的 `summary_json`；更一般地，任一受保护 canonical `summary_json` UPDATE 会撤 marker，但 fallback 仍发布该被修改值。

**证据／失败场景：** migration 002 只执行 `DELETE ready marker`、`UPDATE v3_operation_summaries ... pending` 与 trigger 安装（`migrations/index.ts:106-110`），没有清空 canonical 行的 `summary_json`。`initHistory()` await migration/recovery 后仅异步 `startV3SummaryBackfill()`，随即继续并最终返回（`state.ts:121-133`），所以 startup scrub 未完成时生产请求可进入 fallback。冻结架构明确要求 marker false 时走“strict canonical fallback”（`.superpowers/sdd/task-9-summary-integrity-architecture.md:69-70`），当前实现却把 strict hydrate 仅当 permission gate，再返回另一份未对账的缓存。调用图中 `getHistorySummaries()` 的 marker-false 分支进入 canonical candidates，sessions/stats 分别直接调用 `visitV3Summaries()`；`getSummary(id)` 单行 fallback 反而正确地从 canonical record 重投影，说明当前行为在消费者间不一致。

**影响：** 用户可观察的 list、session aggregate 与 stats 可在 migration 后、startup strict scrub 前发布 stale／伪造 summary；若 `summary_json` 是畸形 JSON，还会在 fallback 中抛解析错误。它直接违反 Task 9 “零 stale publish”与提问所指的 migration→startup 窗口，属于数据完整性／用户可观察错误。

**修复建议：** marker 缺席的所有 fallback 必须只从已 hydrate 的 canonical `record + pinned/endedAt/timingSource` 调 `recordToEntrySummary()`，不得读取 `row.summary_json`。最小共享修复是让 `summaryFromRow()` 始终返回 canonical 重投影结果；同时加入两向回归：① marker 撤销且 canonical `summary_json` 被改成合法但错误 JSON 时，list/session/stats 均返回 canonical 值；②合法旧行在 scrub 尚未结束时仍可通过 fallback 正常读取。修复方建议 `gpt-souls:implementer`。

### F2 — BLOCKER — journal recovery／GC 未把 envelope 内 operation identity 绑定到 journal owner row

**位置：** `src/lib/history/v3/store.ts:1626-1640`、`src/lib/history/v3/store.ts:1777-1805`、`src/lib/history/v3/store.ts:1809-1847`、`.superpowers/sdd/task-9-summary-integrity-architecture.md:22-33`。

**问题：** operation manifest 路径已经用 `assertManifestOperationIdentity()` 把 envelope 内 `record.identity.operationId` 绑定到 SQL row owner，但 journal 的两条消费者没有对应检查。`journalEvidenceRefGroups()` 解码 journal payload 后只对账 refs；`recoverV3Journal()` 也只对账 refs、revision 与 digest，随后直接按 payload 内 record 调 `prepareModelOperationWithTransportEvidence()`／`commitPreparedOperation()`。代码从未断言 `recoveredRecord.identity.operationId === row.operation_id`。

**证据／失败场景：** `decodeJournalPayload()` 返回 payload 自述的 `record` 与 refs（`store.ts:1777-1785`）；recovery 在 `store.ts:1824-1839` 使用 SQL row 的 refs／revision／digest做检查，但 prepared operation 的 `id` 来自 payload record（`store.ts:641-645,760-772`），最终提交的也是该自述 ID。若 journal row A 因程序错误／数据损坏携带合法的 payload B、B digest 与相同 revision，并让 normalized refs 与 B envelope一致，则所有现有检查通过，recovery 会发布 operation B，而不是 fail loud 拒绝 owner mismatch；原 row A 还不会被 B 的成功提交删除。GC 同样把该错绑 journal 当作合法 root。现有测试只覆盖 operation manifest identity（`tests/history/v3/transport-evidence.it.test.ts:386-425`）以及 journal refs mismatch（`:286-315,444-461`），没有 journal owner identity 负控。

**影响：** crash recovery 可从错误 owner 的 recovery set 发布“幽灵”operation，且留下无法正确清除的原 journal row；这属于 canonical History 身份错绑与用户可观察的数据完整性错误。它也违反冻结架构要求 recovery／GC 复用 strict decode／refs／entity 验证、禁止弱镜像（`.superpowers/sdd/task-9-summary-integrity-architecture.md:22-33`）。

**修复建议：** 抽取 journal 等价的 owner identity assertion，并在 `recoverV3Journal()` 与 `journalEvidenceRefGroups()` 解码 payload 后、任何 refs/entity使用或写入前，断言 payload record 的 operation ID 等于 SQL row `operation_id`；recovery 还应在 prepare 后断言 `prepared.id === row.operation_id` 作为邻接防线。新增负控应交换两份合法 pending journal 的 payload／digest（refs可共享）并断言 recovery 为0、GC在删除前抛错、两者均不发布任何 operation；保留原 owner 正样本防 false-red。修复方建议 `gpt-souls:implementer`。

## 生产调用图核验（HEAD `129a4dbd`）

### P1 — 通过 — 四个 readiness primitive 均有可达生产调用链

- `validateAndMarkSummaryProjectionReady` 的直接生产驱动点不是独立 facade，而是 `startV3SummaryBackfill()` 的默认 `checkReadiness` 参数（`src/lib/history/v3/store.ts:1337-1341`），worker 收敛后在 `store.ts:1389-1391` 调用。该 worker 由 `initHistory(true)` 在 migration／recovery 后、监听前启动（`src/lib/history/state.ts:121-133`），并由监听后的 `startHistoryBackfills()` 再保证启动（`state.ts:223-228`；`packages/cli/src/start.ts:584-590`）。因此 strict scrub／marker publisher 不是测试专用，也不依赖偶然 API 请求触发。
- `inspectSummaryProjectionReadiness` 的唯一生产调用点是 strict owner `validateAndMarkSummaryProjectionReady()` 内部（`src/lib/history/v3/store.ts:1322`）。它虽然被测试直接导入，但生产中会沿“CLI startup → `initHistory` → `startV3SummaryBackfill` → default callback → validate → inspect”执行；不存在 `appliesTo` 命中而 driver 缺失。
- `withValidatedSummarySnapshot` 的生产调用点覆盖 get、search target/result、list/cursor、sessions、session entries、stats：`src/lib/history/queries.ts:351,414,473,512`、`src/lib/history/sessions.ts:28,149`、`src/lib/history/stats.ts:107`。这些 facade 又由 History REST／logs／conversation rebuild 与 stats publish 路径调用，例如 `src/routes/history/handler.ts:74,94,195`、`src/routes/logs/route.ts:64`、`src/routes/responses/conversation-rebuild.ts:59`、`src/lib/history/entries.ts:36`。
- `startV3SummaryBackfill` 有两个生产直接调用点：每次启用 History 的 `initHistory()`（`src/lib/history/state.ts:133`）以及 post-listen `startHistoryBackfills()`（`state.ts:228`）；CLI composition root 分别在 `packages/cli/src/start.ts:389` 与 `:590` 驱动它们。函数内的 singleton promise guard（`store.ts:1342`）避免两条腿同时启动重复 worker。

**结论：** 当前搜索范围为 `src/`、`packages/cli/src/`、`scripts/` 与 `tests/`，命令 `rg -n 'validateAndMarkSummaryProjectionReady|inspectSummaryProjectionReadiness|withValidatedSummarySnapshot|startV3SummaryBackfill' ...` 以及 lifecycle／facade 反向搜索均未发现只被测试调用的 readiness primitive。生产图在本项未发现缺口。


### F3 — MAJOR — legacy manifest hydrate 路径跳过 normalized refs 的“空集合精确对账”

**位置：** `src/lib/history/v3/store.ts:1587-1593`、`src/lib/history/v3/store.ts:1624-1642`、`src/lib/history/v3/store.ts:1678-1683`、`.superpowers/sdd/task-9-summary-integrity-architecture.md:22-26`。

**问题：** `hydrateManifest()` 仅在 `manifest.formatVersion === 3` 时调用 `validatePersistedOperationEvidenceRefs()`。但冻结架构要求 v1／v2 的 envelope refs 语义为**空集合**，并与 normalized operation refs 逐项精确相等。当前 detail／list／summary fallback／strict repair／backfill／search sidecar 对 v1／v2 行完全不读取 `v3_operation_evidence_refs`，因此即使 normalized refs 非空，strict repair 仍可发布 ready marker。相邻的 evidence hydrate 与 GC 路径却会拒绝同一状态，形成消费者间不一致。

**证据／入口穷举：** 在 HEAD `129a4dbd` 下，对 `src/lib/history/`、`packages/`、`scripts/` 执行 `rg` 搜索 `decodeManifestEnvelope(`、`hydrateManifest(`、`decodeJournalPayload(`、`manifest_gz`、`payload_gz`、`decompressBytes(`，并反查所有 helper 调用点：

- Canonical full hydrate 的生产入口均汇入 `hydrateManifest(db, blob, expectedOperationId)`：Transaction B strict gate `src/lib/history/v3/store.ts:924`；detail／batch detail／list／visit／fallback 共用 `storedOperationFromRow()` `:1191-1243,1250-1293,1415-1437`；strict repair `:1297-1324`；backfill `:1337-1391`；search sidecar `src/lib/history/search/daemon.ts:382-401`。这些入口都从 SQL row 传必填 expected ID，`hydrateManifest()` 在 `store.ts:1678-1682` 做 owner identity 与 stored digest；但只有 v3 做 normalized refs／entity 对账。
- `decodeManifestEnvelope()` 的直接调用点只有三类：`hydrateTransportEvidence()` `store.ts:1624-1630`（identity + normalized refs + entities）；operation GC root 收集 `:1632-1642`（identity + normalized refs，entities统一在 `:1662-1669` 验证）；`hydrateManifest()` `:1678-1683`。前两者对 v1／v2 也会把 envelope 的空 refs 与 normalized refs 对账，恰好反证 full hydrate 的条件分支是漏闸，而非有意契约。
- Journal payload 只有两个 decode consumer：GC `store.ts:1645-1659` 与 recovery `:1837-1871`，两者都调用必填 `expectedOperationId` 的 `decodeJournalPayload()` `:1796-1814`；v1 与 v2 分支均在返回前做 owner identity。两者随后都将 envelope refs 与 normalized refs 精确对账，GC 在删除前验证 entities，recovery 在 prepare／commit 前验证 entities且另有 `prepared.id === row.operation_id` 邻接防线 `:1852-1863`。
- 搜索范围内不存在第二个 journal payload decoder，也不存在绕过 helper 对 `v3_journal.payload_gz` 或 `v3_operations.manifest_gz` 直接 `decompressBytes + JSON.parse` 的生产路径；`store.ts:1801` 是唯一 journal payload 解压解析点，`store.ts:1500` 是唯一 manifest envelope 解压解析点。CAS objects／tracks／timeline 的其他 `decompressBytes` 属不同载体，不是 envelope 绕路。

**失败场景：** schema 6 中一个合法 v1／v2 operation 因 writer／migration 程序错误留下任意 `v3_operation_evidence_refs` 行。`validateAndMarkSummaryProjectionReady()` 经 `hydrateManifest()` 不看这些 refs，重投影 summary 并把全库标 ready；detail、list 与 search 正常发布该 operation。随后 `hydrateTransportEvidence()` 抛 `operation evidence refs mismatch`，GC 也 fail loud，且额外 ref 指向的 evidence 无法回收。该状态违反同一 operation 的 strict-read 一致性与冻结的 empty↔empty 对账契约，但因 normalized refs direct DML 本身在外部威胁边界外，定为 MAJOR 而非新增 BLOCKER。

**修复建议：** 去掉 `hydrateManifest()` 的 format-v3 条件，对 v1／v2／v3 一律调用 `validatePersistedOperationEvidenceRefs()`；decoder 已把 v1／v2 refs规范化为空数组，所以无需新分支。新增 v1 与 v2 各一条负控：插入额外 normalized ref 后，detail、strict repair、summary fallback 与 search sidecar均拒绝／poison且不得发布 marker；再以 refs 为空的旧 fixture 作正样本防 false-red。修复方建议 `gpt-souls:implementer`。

### F4 — MAJOR — wall-clock guard 被正确退役，但“commit 不随既有 History 长度退化”没有确定性替代门；status fixture 的 DROP 删除正当，但原 count 不变量只被部分守住

**位置：** `tests/history/v3/store-performance.it.test.ts:90-132`、`tests/history/v3/canonical-performance.unit.test.ts:205-253`、`src/lib/history/v3/store.ts:890-895`、`tests/infra/management-routes.http.test.ts:372-389`、`src/routes/status/route.ts:124-139`。

**① 原不变量与现状：** 原 `prepareRatio < 3`／`commitRatio < 5` 守的是“同一 operation 的 prepare／commit 成本不应随数据库中既有 History 行数增长而显著上升”。删除阈值后，该测试只打印时间，不能阻断任何回归。`canonical-performance.unit.test.ts:205-253` 的 deterministic work counter 与 recursive SCC guard只覆盖 `ModelOperationRecorder` 的 captured-value traversal／arena copy，主体是单条 record 的 canonical capture；它不执行 `commitPreparedOperation()`、不触达 SQLite，也不能发现每次 commit 新增一次全表 scan。因此它不是该不变量的替代门。

**证据：** 本轮在 HEAD `b0992a6c` 执行 `bun test tests/history/v3/store-performance.it.test.ts tests/infra/management-routes.http.test.ts`，结果 `15 pass / 0 fail`；report-only 输出为 `prepareRatio=0.6662`、`commitRatio=0.6844`。当前生产实现已把每次 commit 的 `getSummaryProjectionReadiness()` 全表聚合换成 marker PK 查询 `isSummaryProjectionReady()`（`store.ts:890-895`），所以现存具体 O(N) 回归已修；但 `rg` 在 tests 中未找到任何针对 commit SQL 工作量／query plan／既有行数依赖的硬门。原 wall-clock 门本身也判别力不足：它受 CPU／SQLite warmup 噪声影响而 false-red，且 256 行、3×／5×阈值曾放过真实无索引全表 scan。故“直接恢复原 ratio”不正确，但“只删断言”同样丢失契约。

**影响：** 后续任何在 commit hot path 中重新引入 `COUNT/SUM` 全表 scan、按既有 operations 循环、或无界 summary reconciliation 的改动都可全绿合并；这是 frozen write-path complexity 的验收缺口，当前代码虽已 O(1)，仍属 MAJOR 测试／架构门缺失。

**① 修复建议：** 保留 wall-clock 为 report-only，新增**确定性 SQLite 工作量门**，测量对象必须是 `commitPreparedOperation()` 而非 recorder capture。优先使用 SQLite statement/scan-status 能力或 driver 注入的只读 prepare/step observer，比较相同 prepared operation 在 0 行与大 N 行基线上的 statement 数、full-scan steps／visited rows，要求与 N 无关；若当前 driver 无该能力，可加窄 test seam 统计 readiness 查询触达行数，并配 mutation 把 `isSummaryProjectionReady` 换回 `getSummaryProjectionReadiness`，确认目标测试按全表 scan 机制变红。不要用源码字符串禁止某一函数名代替执行判据。修复方建议 `gpt-souls:implementer`。

**② 原不变量与变更判断：** management test 原本守“`GET /api/status` 的 persisted count 来自 canonical `v3_operations COUNT(*)`，不解析损坏的 summary payload”。旧 `DROP v3_operation_summaries_after_summary_update` 只是让旧 trigger 不自动修复／覆盖坏 fixture；该 trigger 已由 migration 002 明确退役（当前只在 `summary-schema.ts:92` 的 cleanup SQL 中出现），现在 protected canonical UPDATE 自身会 poison summary并撤 marker。因此删除对不存在 trigger 的 DROP 是**正当 fixture 迁移**，不是放宽产品断言；保留 DROP 只会让正确 schema false-red。

**② 剩余判别力缺口：** 当前 malformed `summary_json` 仍能拦截“直接 `JSON.parse(summary_json)`”这种错误实现，但不足以完整证明 count 只依赖 canonical root。F1 修复后 marker-false summary facade会 hydrate合法 manifest并从 canonical重投影，完全不读坏 `summary_json`；把 status count误接到该 facade仍可能返回1而本测试全绿。直接 `COUNT(*) FROM v3_operation_summaries`（不筛 ready）也会在当前一行 fixture上返回1。故 DROP 删除本身合理，但“还有谁守原完整不变量”的答案是：`status/route.ts:128-136` 当前实现确实用 `countV3Operations()`，测试只守住其中“不得解析 summary JSON”的子集，没有守住“不得依赖 summary row存在／状态或 hydrate canonical”的全部语义。

**② 修复建议：** 保留现有坏 JSON case，并增加正交状态：删除该 operation 的 summary row（或同时造 missing／poisoned rows），再把 canonical manifest改成无法 hydrate但 operation root仍存在，断言 `/api/status` 仍为200且 `historyEntryCount` 精确等于 `v3_operations` 行数。这样可同时咬住 summary-table count、ready-only count与 canonical hydrate三类错误接线；正样本保留正常 operation count，避免 false-red。此补强可与①同一修复轮处理，但不要恢复已退役 trigger DROP。

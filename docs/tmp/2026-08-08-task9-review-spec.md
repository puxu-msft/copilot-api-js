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

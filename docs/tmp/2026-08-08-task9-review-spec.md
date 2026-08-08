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


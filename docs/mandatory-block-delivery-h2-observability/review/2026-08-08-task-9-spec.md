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

### F5 — BLOCKER — recovery 的 canonical API 迁移不是旧 adapter 的严格等价替换：失败 operation 被写入伪 `winnerCandidate`

**位置：** `src/lib/history/v3/recovery.ts:123-199,223-229`、`src/lib/context/model-operation-record.ts:1002-1009,1164-1198`、`src/lib/context/model-operation-record.ts:348-357`。

**问题：** 新实现只要 projected entry 有 attempts，就在 terminal 上无条件写 `winnerCandidate: candidate`（`recovery.ts:126,194-198,226`），即便没有任何 committed dispatch、candidate verdict 已明确为 `failed`。旧 adapter 只传 `committedAttempt`；`commitTerminal()` 在无 committed dispatch 时不会推导 winner（`model-operation-record.ts:1184-1198`）。因此失败／aborted／interrupted recovery record 从“没有 winner”变成“失败 candidate 是 winner”，与 `winnerCandidate` 的 canonical 语义冲突。

**严格等价核验：** dispatch verdict 保持一致——仅 completed entry 的最后 attempt 为 `committed`，其余最后 attempt 为 `failed`、前序为 `discarded`；candidate verdict 也与旧 adapter 相同——任一 committed dispatch则 `winner`，否则 `failed`（旧 adapter在 `commitTerminal()` 内执行，`model-operation-record.ts:1167-1176`）。`captureTimestamps:false` 下 occurredAt同样保持缺席：旧 `beginAttempt()` 只在 `captureTimestamps` 为真时补 now（`:1002-1009`），新 beginCandidate／beginDispatch未传 occurredAt。不过 settle 顺序并不等价：旧顺序是 dispatch settle → `recordEgress` → adapter在 `commitTerminal` 内 candidate settle → terminal；新顺序是 dispatch settle → candidate settle → `recordEgress` → terminal。这会改变 sequence、timeline与digest。该顺序变化未必本身错误，但不能归类为纯 style／严格等价，必须由 canonical lifecycle契约明确裁决并测试。

**影响：** projection recovery 是把旧 `HistoryEntry` 重新固化为 canonical V3 record 的生产脚本路径。失败记录的 terminal 会声称存在 winner，而对应 candidate 又标 `failed`；任何按 winner做顶层投影、归因或后续迁移的消费者会得到自相矛盾的 canonical History，属于用户可观察的数据语义错误。

**修复建议：** terminal 仅在 `committedDispatch !== undefined` 时同时写 `winnerCandidate` 与 `committedDispatch`；无 committed dispatch 时两者都省略。补充 completed／failed／aborted／interrupted 四态回归，逐项断言 candidate verdict、dispatch verdict、terminal winner／committed fields，并冻结期望 sequence关系；若 canonical API要求 candidate 必须先于 egress settle，则明确接受非等价 sequence并更新 recovery fixture／文档，否则把显式 `settleCandidate` 移到 `recordEgress` 后以保持 adapter顺序。修复方建议 `gpt-souls:implementer`。

### L1 — 通过 — usage 条件、retry switch 与测试 oracle 变更未发现语义丢失

- Anthropic usage：官方安装 SDK 的 `Message.usage` 与 `RawMessageStartEvent.message` 均必填；`Usage.cache_creation_input_tokens`／`cache_read_input_tokens` 是 `number | null`，不是 optional（`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:657-769,776-805,937-940,1552-1564`）。因此 `anthropic-to-cc.ts` 的 null／undefined显式判断与旧 `!= null` 等价；`anthropic-to-cc-stream.ts:193-194,261-263` 对真实 null保持不挂载，对0仍挂载，input/output必填赋值等价；`anthropic-to-responses-stream.ts:243` 去掉恒真 `if (msg.usage)` 等价。仓库测试还显式覆盖 Anthropic null cache legs（`tests/openai/anthropic-responses-reverse-roundtrip.unit.test.ts:60-61`）与 cache_write／cached 正向映射（`tests/openai/anthropic-to-cc.unit.test.ts:156-180`）。未发现“类型乐观、真实 wire 可为 undefined”的一手证据；若 GHC 发送缺字段，那已违反当前官方 SDK contract，且新 stream代码最终仍不会挂载 undefined cache field。
- Responses usage：项目 SSOT 定义 `ResponsesResponse.usage: ResponsesUsage | null`，details对象及其 `cached_tokens`／`cache_write_tokens` optional但非nullable（`src/types/api/openai-responses.ts:260-288`）。`responses-to-cc.ts:109-119` 与 stream版 `:219-236` 把重复属性读取收进局部变量，保留0、缺失时不挂载；reasoning条件未改。`ResponsesReasoningOutput.summary` 元素类型恒为 `summary_text`（`openai-responses.ts:206-215`），移除冗余 type判断不扩大当前合法输入。
- `cell-assembly.ts:104-191` 的四个 switch与旧 if链返回映射逐支相同；default仍把 `env.targetEndpoint` 传给 `assertExhaustiveEndpoint(te: never)`。`UpstreamEndpoint` 是四字面量union（`src/lib/pipeline/envelope.ts:24`），新增成员会让四处 default参数不再是never而编译失败，穷尽守卫保留。实际上旧if链末尾同样有never守卫，所以这是等价可读性重构，不是新增能力。
- 测试 oracle：`ts.flattenDiagnosticMessageText`（`tests/architecture/source-ast.ts:583`）把可能为链式对象的diagnostic完整展开，避免旧模板插值产生 `[object Object]`，只增强错误可诊断性，不改变 pass/fail gate；`unknown`显式收窄与未使用捕获组改为非捕获组均未改变断言对象或匹配集合。抽查 `756a1b30^..756a1b30` 对应 test diff未发现删除断言或放宽期望。

### F6 — MINOR — `style:` commit 混入 canonical History 与 translation 行为重构，commit message 与内容不相符

**位置：** commit `756a1b30`（113 files）；重点 `src/lib/history/v3/recovery.ts`、`src/lib/openai/translate/{anthropic-to-cc,anthropic-to-cc-stream,anthropic-to-responses-stream,responses-to-cc,responses-to-cc-stream}.ts`、`src/lib/pipeline/cell-assembly.ts`、`tests/architecture/source-ast.ts`。

**问题：** `style: integrate repository lint baseline` 暗示不改变语义，但同一 commit迁移了 deprecated lifecycle API、改变 canonical sequence与terminal fields（其中 F5 是确定错误）、重写 usage条件、改变retry控制流形状并增强测试diagnostic oracle。未来 `git log`／`git blame`／bisect会把这些变化误分类为可忽略格式噪声；reviewer也无法按语义单元独立审查或回退。

**建议边界：** 在修复 F5 后，最佳长期形状是趁分支尚未发布重写本地历史，把 `756a1b30` 拆成至少四个语义 commits：① `style: integrate repository lint baseline`，仅eslint配置、import/order、format与机械无语义lint；② `refactor(history): migrate projected recovery to candidate dispatch APIs`，含四态lifecycle回归；③ `refactor(translation): align usage mapping with provider type contracts`，含cache null／0与rich-field测试；④ `refactor(pipeline): make retry endpoint handling exhaustive`；测试diagnostic可并入相应guard commit或独立 `test: preserve structured TypeScript diagnostics`。这样每个commit可独立review／bisect，message与内容一致。

**为何推荐重写而非旁注：** `git branch --contains 756a1b30` 当前只返回 `worktree-placeholder`，用户明确说明尚未push；追加文档或后续commit无法修正原commit在blame／bisect中的错误分类，Git notes也不随普通clone可靠传播。代价是重写其后的本地SHA并同步所有进度／评审文档里的SHA引用，因此应由协调方在确认无其他会话基于该lineage写入后，在隔离worktree中一次完成并重跑现有门禁；若并发基线已使安全重写不可行，次优方案是保留历史、追加一个显眼的 `docs:` commit列出 `756a1b30` 的semantic inventory与正确分类，但这只能缓解、不能修复提交边界。建议修复方按代码／历史整理分别由 `gpt-souls:implementer` 与协调方处理。

## 最终复评（HEAD `0935acd8`）

### F7 — MAJOR — F5 的 winner 修复正确，但 recovery 尚未恢复与旧 adapter 的逐字等价

**位置：** `src/lib/history/v3/recovery.ts:123-162,217-239`、`src/lib/context/model-operation-record.ts:1002-1009,1164-1198`、`tests/history/v3/recovery-script.it.test.ts:81-116`。

**已闭合部分：** `winnerCandidate` 与 `committedDispatch` 现同出同没（`recovery.ts:229-239`），失败／aborted／interrupted不再伪造winner；candidate settle已回到egress之后、terminal之前（`:204-239`）。四态期望值正确：旧代码的最终attempt明确以 `entry.state === "completed" ? "committed" : "failed"` 决定，因此 aborted／interrupted 的dispatch确实是 `failed`，candidate相应为`failed`，terminal无winner；completed为 committed／winner。`captureTimestamps:false` 下旧、新 candidate settledAt与terminal occurredAt也都为undefined：旧adapter在`commitTerminal`里只在`captureTimestamps`为true时补now（`model-operation-record.ts:1164-1176`），新显式settle与terminal均未传occurredAt。

**残余非等价：** 旧实现先注册本attempt的effective／wire payload，随后调用`beginAttempt()`；adapter在该点才隐式创建candidate，再创建dispatch（旧 `recovery.ts` 顺序由 `git show 756a1b30^` 的 `:126-145` 与 `model-operation-record.ts:1002-1009` 共同确定）。当前实现却在进入loop前创建candidate（`recovery.ts:125-126`），再注册payload（`:128-142`），所以candidate.sequence相对payloads前移，timeline与manifest digest仍不同。candidate元数据也从旧 `{ compatibility: "attempt-adapter" }` 变成 `{ recovery: true }`，settlement reason从`attempt adapter terminal`变成`recovered from projected History V3 entry`；这些字段进入canonical manifest。故“sequence／timeline／digest逐字一致”仍不成立。

**测试缺口：** 四态回归只断言 `candidate.settledSequence > egress.sequence` 与 `terminal.sequence > candidate.settledSequence`，能抓settle位置和winner，却不比较candidate创建位置、metadata、reason或完整prepared manifest digest；因此对上述残余差异假绿。它覆盖了F5点名的四种terminal状态／verdict／winner与settle相对顺序，但没有覆盖“严格等价”的全部维度。

**影响与修复建议：** 这是canonical History timeline／manifest的行为变化，不是style重排；当前未证明新形状更正确，且提交说明声称恢复旧adapter等价。最小修复是在首次attempt已完成payload注册、即将`beginDispatch`时惰性创建candidate，并使用旧adapter相同的candidate metadata与settlement reason；更强回归应在测试内用一个冻结的旧adapter oracle构造同一entry，断言当前record（包括sequences、candidate fields、terminal fields）与其深相等，并断言`prepareModelOperation(...).digest`相等。若项目决定有意采用新recovery provenance，则不能再声称严格等价，应将其拆成明确的行为变更并冻结新的canonical契约。建议合并前处置；修复方建议 `gpt-souls:implementer`。

### F8 — MAJOR — `execDml` 去掉 `m` 修复 trigger false-positive，却引入多语句脚本 false-negative

**位置：** `tests/history/v3/store-performance.it.test.ts:145-194`。

**问题与证据：** 当前 `execDml = execed.filter((sql) => /^\s*(?:SELECT|UPDATE|DELETE|INSERT)/i.test(sql))` 只检查整个script的第一条statement。它正确忽略了以 `CREATE TRIGGER` 开头、trigger body内含DML的schema脚本，但也会放过 `CREATE TEMP TABLE ...; SELECT * FROM v3_operations`、`PRAGMA ...; UPDATE v3_operation_summaries ...` 等“首条DDL／PRAGMA，后续顶层DML”的真实 `db.exec`。这些后续statement绕过`prepare` observer，也不会进入EXPLAIN／SCAN检查，正是注释 `:184-190` 声称要封闭的入口。

**影响：** 新增的确定性write-path guard仍可被合法的多statement `exec` 写法绕过；未来重新引入history-length scan时测试可全绿。它是刚用于替代已删除wall-clock门的承重gate，不能以当前生产尚未这样写为由放任已知false-green。

**修复建议：** 不要恢复逐行`m`正则。优先对commit期间允许的`exec`调用做精确allowlist（例如当前唯一schema reconcile脚本及必要transaction control），任何新script先失败并要求作者把DML改走`prepare`，从而自然进入EXPLAIN门；若确需允许混合script，则使用SQLite-aware statement splitter／parser识别trigger `BEGIN…END`边界，再逐条对顶层DML做EXPLAIN。补双控：`CREATE TRIGGER ... BEGIN UPDATE ... END`必须绿；`CREATE TEMP TABLE ...; SELECT * FROM v3_operations`必须红。修复方建议 `gpt-souls:implementer`。

### 最终 verdict

- **BLOCKER：0。** F1、F2、F3与F5的原始数据完整性blocker均已修复；本轮定向命令 `bun test tests/history/v3/recovery-script.it.test.ts tests/history/v3/store-performance.it.test.ts` 为 `9 pass / 0 fail`。
- **合并结论：修复 MAJOR 后可合并。** F7的严格等价仍未闭合，F8的承重guard仍有确定false-green；两者应在合入master前处置。F6的commit边界由用户裁决，status count的正交加固仍为非阻断测试债。

## 收口确认（HEAD `540ca320`）

### R1 — 通过 — F7 已恢复旧 adapter 的 canonical 逐字等价

`candidate ??= beginCandidate(...)` 现在位于首个attempt的effective／wire payload注册之后、`beginDispatch()`之前（`src/lib/history/v3/recovery.ts:133-153`），与旧 `beginAttempt()` 内隐式创建candidate的位置一致；handle编号与全部event sequence因此恢复一致。candidate metadata恢复为 `{ compatibility: "attempt-adapter" }`（`:151`），settle reason恢复为 `attempt adapter terminal`（`:224-232`），两者均与旧adapter一致。candidate仍在egress之后、terminal之前settle，winner／committed字段同出同没（`:211-245`）。`captureTimestamps:false` 下，旧adapter与当前实现的candidate creation、dispatch creation、dispatch settle、candidate settle、terminal均不补`occurredAt`／`settledAt`；旧adapter在`commitTerminal()`中的terminal时间推导也得到undefined。因此 record、timeline与prepared manifest digest没有残余差异。保留旧metadata／reason以维持既有canonical digest是正确取舍；recovery provenance已有record／terminal extensions承载，不应为措辞美化破坏内容身份稳定性。

### R2 — 通过 — F8 的冻结命中集关上多语句 `exec` 缝且适配当前生产拼写

`tests/history/v3/store-performance.it.test.ts:185-199` 现在只允许逐字trim后等于 `V3_SCHEMA_SQL`，或单条 `DROP TABLE IF EXISTS \w+` 加可选分号／任意大小写。当前生产 `ensureV3Schema()` 的实际 `exec` 形状正是完整 `V3_SCHEMA_SQL` 与三条 `DROP TABLE IF EXISTS v3_search_*`；表名仅含word字符、无引号／schema限定，故不会false-red。`PRAGMA …; UPDATE …`、`CREATE …; SELECT …`及任何其他新增script都会落入`unexpectedExec`，从而fail closed；trigger body里的DML因整段script按`V3_SCHEMA_SQL`身份放行，不再误报。未来合法新增`exec`也会先红、迫使作者显式审查并更新冻结集合，这正是此gate的设计目标，不属于false-red。

### 最终可引用结论

**总体 verdict：可合并。BLOCKER 0，MAJOR 0。** 本评审范围内没有必须在合并master前继续处置的正确性、spec合规或生产接线问题。F6的历史拆分与status count正交加固仍为已记录的非阻断事项。

复评时我执行 `bun test tests/history/v3/recovery-script.it.test.ts tests/history/v3/store-performance.it.test.ts`：recovery四态与query-plan gate通过，但同文件无关的CAS容量case本次受负载影响在15秒门超时，汇总为`8 pass / 1 fail`；这不推翻协调方已提供的`9 pass / 0 fail`及全History `560 pass / 23 skip / 0 fail`证据，也不涉及F7／F8机制，但交付记录应保留这次非零复跑而不能写成“本次复评命令全绿”。

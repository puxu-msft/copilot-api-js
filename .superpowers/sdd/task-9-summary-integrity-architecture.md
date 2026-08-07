# Task 9 ready-summary 完整性架构裁决草案

> 状态：necessity claim 已获原独立 reviewer 确认；前三轮 findings 均已采纳并整改，等待原 reviewer 第四轮复审；不修改产品代码。

## 事实与冻结约束

- Reviewer finding 已由代码复核确认：ready marker 后，`queries.ts:214-240,273-280` 直接进入 `v3_operation_summaries`；`summary-store.ts:93-191,201-445` 的 get/list/session/stats SQL 只看 `projection_status='ready'`，不触达 canonical manifest/evidence。把 manifest 改成 future 999 后仍发布 summary，见 `task-9-review.md:24-30`。
- Legacy fallback 已变强，但只覆盖 marker 未 ready：candidate `store.ts:1169-1178` 先 strict hydrate，再用 summary cache。强弱路径按 readiness 分裂是根因，不是 decoder 本身。
- 窄表性能是已冻结契约：默认 page 必须使用 summary ordered index、无 temp sort、无 canonical manifest access；session/stats 同样留在窄投影，见 `summary-query.it.test.ts:174-179,207-273`。512 rows × 256 KiB manifest 的 size-independence harness 在 `summary-query-performance.it.test.ts:31-163`。
- Spec §6.2 要求 evidence 缺失/损坏时“不发布悬空 entry”，§6.3 要求 future format fail loud，§9.4 要求 summary fallback、search、readonly 全覆盖 v1/v2/v3，见 spec `:595-639,850-876`。

## 核心不变量与威胁模型

1. 发布 summary 的同一数据库快照中，必须存在一个仍有效的证明：该 summary 绑定的 manifest 格式受支持，且其 ordered evidence refs 对应的 entity 在 digest、byte length、encoding 上完整。
2. 健康 steady state 的 get/list/session/stats 不解压、不解析 manifest/evidence；复杂度保持 summary rows/aggregates 的现有量级。
3. 支持的损坏模型：应用 bug 或运维普通 SQL 经任意 SQLite connection 修改/删除/替换 canonical、evidence 或 normalized ref，包括 `UPDATE`、`DELETE`、`INSERT` existing-key、`INSERT OR REPLACE`／operation `REPLACE`、evidence digest 主键 `UPDATE`，以及 `PRAGMA foreign_keys=OFF`；还覆盖崩溃、启用守卫前已损坏、可读但 hash/length/encoding 不一致的 entity。
4. **范围待用户裁决：**已冻结 spec 明确要求 canonical manifest/evidence 损坏与 future format 不得发布，但未明确普通 SQL 直接伪造 marker/status/attestation 是否属于损坏模型。`DROP/ALTER TABLE`、drop/disable trigger、绕过 SQLite 修改 page 仍明确排除；派生状态伪造按下文“范围分叉 disposition”处理，在裁决前不得把 A 或 B 写成已冻结事实。

## A：summary row 保存 cryptographic attestation，读取时验证

- 数据模型：summary 增 `attestation_version`、`canonical_attestation`。输入应为 domain-separated SHA-256：`operation_id + manifest_format + SHA256(uncompressed manifest bytes) + ordered(dispatchIndex,sequence,digest,byteLength,encoding) + 每个 evidence 的实际 bytes SHA-256`；不能只纳入 `v3_operations.digest` 或 entity metadata，因为它们可与损坏 bytes 一起保持旧值。
- Write/backfill/crash：新写在事务 B 内 strict validate 当前 bytes 后计算并与 summary 同提交；v1/v2 refs 为空；历史行先 pending，逐行 hydrate/计算，失败 poison；marker 仅在全体有 attestation 后发布。GC 删除 entity 前使依赖 attestation 不可达或 poison。
- 入口：get/list/session/stats/search 都须验证；只比较 summary attestation 与写时保存的 operation digest/metadata 是 O(1)，但不检测写后 blob 损坏；重算当前 manifest/evidence 才正确，代价 O(读取的 canonical bytes)。
- 结论：**不可单独推荐**。Reviewer 的“ready 后 UPDATE manifest_gz、旧 summary 仍返回”探针已经实证：只在写时算一次且读取不重算当前 bytes，attestation 与旧 digest 同时不变，必然 false-green。若用 trigger/version 令写后变更使 attestation 失效，方案已转化为 C/D。

## B：write/migration/GC 维护 ready/poison/unreachable，ready query 只读 validated rows

- 数据模型：沿用 `projection_status`，增加 operation→evidence normalized dependency rows；writer/backfill strict validate 后置 ready，失败置 poisoned；GC 只删 operation/journal 均不可达 entity。
- Write/migration/crash：新 operation/summary 初始 pending，在事务 B 尾部置 ready；旧 v1/v2 strict backfill 后 ready；journal recovery 同样先验证。后台 scrub 发现 future manifest、missing/corrupt evidence 后 poison 并撤 ready marker。
- 入口与性能：healthy ready path 完全不变，为 O(summary page)／O(summary rows aggregate)；marker 撤销后回 legacy strict path并 fail loud。
- 缺口：若 poison 只由周期维护产生，SQL UPDATE 与下次 scrub 之间仍能发布 stale summary；因此纯 B 不闭合。要闭合必须用同步 invalidation trigger，成为 D。

## C：按需 batch 轻量 integrity/version join，不 hydrate

- 数据模型：`v3_operation_integrity(operation_id, validated_manifest_epoch, status, attestation)`；canonical/evidence row 有 mutation epoch；normalized refs 保存 expected evidence epoch/metadata。SQLite trigger 在 protected bytes/metadata 变化时递增 epoch。
- Query：page/get 批量 join operation integrity 并 `NOT EXISTS` mismatched refs；session/stats aggregate 同时返回 invalid count，非零即 fail loud；search 在 sidecar返回 ID 后再 batch 校验。Future manifest UPDATE 通过 epoch mismatch失效，evidence UPDATE/DELETE通过 refs mismatch失效。
- Write/migration/crash：事务 B 写 operation、refs、integrity、summary并统一提交；历史 strict backfill；journal refs在事务 A维护。v1/v2 empty refs 正常。
- 性能：不读 blob，但 list 为 O(page × refs)，stats/session 为 O(N+R)，每次 aggregate 都多 join/anti-join；违反当前“只扫窄表”的最强形状，需 PoC 才能判断实际退化。正确但不优于 D。

## 范围分叉 disposition（A 级，需用户裁决）

- **冻结 spec 的一手事实：**§6.2要求 recovery 发布前验证 evidence entity 的存在、hash/length/encoding，并禁止悬空 entry；§6.3要求 future manifest fail loud；§9.4要求 evidence 损坏阻止发布及各 consumer 覆盖。它约束 canonical/evidence 的真实性与发布结果，但没有定义 DB 内 marker/status/attestation 面对普通 SQL 的 authority 或防篡改边界。
- **Reviewer 裁决的效力：**necessity reviewer确认的是“write-once attestation不能检测写后损坏，必须重算当前bytes或有同步invalidation/version状态”。前三轮 findings 进一步推荐不可伪造authority seam，但这是架构判断，不是用户裁决，也不能反向扩写冻结spec的威胁模型。
- 因而现有权威不足以在 A/B 间自行选择：**A**排除直接派生状态伪造，只保证canonical/evidence/refs变化同步失效；**B**把普通SQL直接写marker/status/attestation纳入范围，authority matrix必须阻止重新认证。新B3 PoC只在用户选择B时构成阻断反例；选择A时不阻断。
- 我的偏好是B，因为否则持有普通SQL写权限的一方可在同一事务改canonical并重新ready，使同步失效门可被同级权限抵消；但这只是偏好，不能以“更强”替代授权。**在用户明确裁决前，本报告的authority matrix与相关controls仅是B候选设计，不得实施或声称已冻结。**

## 统一 authority matrix（仅在范围 B 获用户采纳时生效）

受控写不是可伪造的 SQL flag。每个应用 SQLite connection 注册只读 UDF `history_write_scope()`，其返回值来自 host closure；只有 `withHistoryIntegrityTransaction(scope, fn)` 能在 `BEGIN IMMEDIATE` 到 COMMIT/ROLLBACK 的同步区间内设置 scope，并在 `finally` 清除。SQL 无 setter；connection 串行执行，不能在 capability 窗口插入别的 statement；未注册UDF的外部connection触发protected DML时因函数缺失而失败。威胁模型不覆盖能自行加载extension/注册同名UDF或改trigger的恶意进程。

| Authority entity | 唯一合法 writer／来源 | 未授权或无效变化 |
|---|---|---|
| Canonical `v3_operations` manifest/revision/digest/timing | B或显式operator adopt可创建/替换；受控clear/retention可删除 | operation_id UPDATE永拒；其它未授权INSERT/REPLACE/UPDATE/DELETE永拒。若启动时已漂移，scrub poison+撤marker |
| Transaction-A journal及journal refs | A从实际journal-v2 envelope decode原子创建；B只在成功提交operation后受控删除 | A提交后immutable；existing-key INSERT/REPLACE、authority列UPDATE、DELETE永拒；恢复前六元组ordered精确相等，否则integrity failure、撤marker |
| Evidence CAS及operation/journal refs | A/B、migration、recovery经strict primitive | 沿用完整DML矩阵；被引用entity破坏永拒，预存不一致poison+撤marker |
| Ready summary projection | transaction B、migration/backfill、trusted restore、explicit adopt从同一canonical重投影；pin专用writer只改pin overlay | 除pin overlay外的INSERT/REPLACE/UPDATE/DELETE永拒；预存/受控候选不一致poison+撤marker |
| Ready marker | strict repair在全体valid后写`1`；invalidation/poison删除 | 其它INSERT/UPDATE/REPLACE写`1`永拒；DELETE仅受控invalidation |

SQLite `RAISE(ABORT)` 会回滚同一statement内先做的marker删除，所以“未授权写被拒”时旧数据和旧marker都保持有效，这是正确结果；只有已提交的受控候选校验失败或startup发现既存漂移时，poison与撤marker才持久化。不得用一个必回滚的trigger side effect声称既拒绝又留下审计状态；拒绝事件由应用错误/诊断通道观测。

## D（推荐）：normalized dependency index + authority-gated writer + 原子 ready snapshot

- 数据模型：增加 `v3_operation_evidence_refs` 与 `v3_journal_evidence_refs`，逐 event 保存 `(owner,dispatchIndex,sequence,digest,byteLength,encoding)`；主键必须包含 sequence，不得按 digest 去重。FK `RESTRICT` 只是第二层，不承担正确性。summary 可保存 A 的 attestation作审计/repair oracle，但读取正确性依赖“validated status + 同步失效”，不依赖 write-once digest自证。
- **Refs 同源门：**事务 A 只能从该事务实际写入并重新 decode 的 journal-v2 envelope 生成 journal refs；事务 B 只能从同一 transaction snapshot 实际 decode 的 manifest-v3 生成 operation refs，禁止从调用参数、prepared side array或另一份派生对象复制。v1/v2 decode结果为空 refs。
- **Strict validity primitive：**ready 前先从当前 uncompressed manifest bytes严格decode；decoded refs与normalized refs按 ordered multiset逐项精确相等，比较完整六元组并保留重复及顺序。再以manifest自身的format version作domain separation，对这些当前bytes重算operation digest（`SHA-256("history-v3:<version>:operation\0" || manifestBytes)`）并与`v3_operations.digest`精确相等；不能拿stored digest或旧attestation替代当前bytes。
- 同一primitive还须从该manifest hydrate出的当前record，加同一row的canonical timing inputs，严格重算summary JSON与全部窄表承重字段并逐项精确比较；也可先把summary置pending后，在同一repair transaction原子重写全部承重字段，再对重写结果复核。`pinned`是独立可变overlay，由专用路径同步，不属于manifest/digest/summary canonical binding；pin-only update不得改变任何被绑定字段。
- 漏/多/重排ref、改六元组任一字段、valid-v3但manifest bytes被改、stale operation digest或stale summary任一均不能ready。startup scrub、strict repair、journal recovery共用完整 `decode→digest-recompute→refs-exact-compare→entity-validate→summary-reproject` primitive；GC root discovery复用其中decode/refs/entity部分，不能各写弱一档镜像。Repair不得把“格式和refs仍合法”的write-after-attestation变体直接重新认证。
- 事务 A在`scope='journal-a'`内写evidence CAS、journal，并只从刚写入后重新读取/decode的journal-v2 envelope生成journal refs；COMMIT后journal成为immutable recovery authority。operation_id/revision/digest/payload_gz/format_version的UPDATE、DELETE、REPLACE、existing-key INSERT在任何connection及FK-off下一律由trigger拒绝。任何失败使A整体回滚。
- 事务 B在`scope='operation-b'`内先从immutable journal decode/validate，再写operation为pending、从同snapshot实际manifest生成operation refs、执行完整strict validity primitive并重投影summary；只在全部valid后置ready并删除journal+journal refs。该删除仅允许B的connection-local scope，外部执行相同SQL无法绕过；B任意失败保留完整A recovery set。
- **完整trigger matrix：**canonical operation、journal、evidence、两类refs、summary、marker分别覆盖INSERT existing-key、`INSERT OR REPLACE`/`REPLACE`、UPDATE每个authority列/PK、DELETE。每条trigger同时检查精确scope与状态转换，而非只检查SQL形状；未授权DML直接ABORT。受控writer提交候选后若strict验证失败，则在独立受控integrity transaction持久化poison+撤marker。
- `v3_operations.operation_id`禁止rename/cascade：任何scope及connection（包括FK-off）做PK UPDATE均ABORT。Evidence digest PK UPDATE及被引用evidence UPDATE/DELETE也主动拒绝，FK RESTRICT仅第二层。Operation DELETE/REPLACE/existing-key INSERT只允许transaction B或explicit adopt的完整状态机，永不继承旧ready。
- Ready summary除pin overlay外完全immutable。Projection writer只能在`operation-b|migration|backfill|trusted-restore|operator-adopt` scope中先pending、原子重写全部承重字段、strict复核后ready；直接UPDATE/DELETE/REPLACE均ABORT。Pin专用scope仅允许`pinned`同步，trigger断言其它OLD/NEW承重列完全相等。
- Migration在`scope='migration'`的单一原子transaction中撤marker、创建refs/FK/UDF-dependent triggers、将所有summary置pending并对既有row执行strict scrub/状态初始化；不得自动adopt。损坏row置poison，migration永不重建marker。Backfill同样只能从受保护canonical重投影pending row；不能把自身输入当authority。
- Ready marker表示全体projection已收敛且validated。只允许strict repair写`1`；未授权写marker拒绝。已提交候选校验失败或startup发现既存损坏时，受控integrity path持久化poison+撤marker；被ABORT的外部DML不改变旧有效状态。
- **Repair provenance：**自动repair只能从仍受trigger保护且通过strict校验的immutable journal、冻结备份/fixture，或operator显式提供的trusted original bytes恢复；必须记录source identity。当前poisoned manifest不是authority，background/startup不得据它重算digest/summary后自我洗白。
- `operator-adopt`是独立显式操作，不是repair fallback：要求有界audit reason，基于operator指定当前bytes创建严格更大的revision、新domain-separated digest、新summary与refs，在单一`scope='operator-adopt'` transaction内strict validate后才ready；保留旧revision/audit lineage，不原地改写identity。无显式adopt时unauthorized rebase-current保持poison。
- **读原子性：**get/get-list/cursor/session/stats的 marker check、query与结果解析各由一个短同步 SQLite transaction/snapshot编排，不能由调用方分两次查询。快照若在损坏提交前，发布的是该快照内仍有效状态；提交后必见marker false。Search不得跨`await`持transaction/锁；sidecar await完成后开启一个新短事务，重新检查marker并batch取summaries，marker false则明确 unavailable。
- 入口：`getSummary`、cursor、list、session aggregates/entry totals、stats、search-by-ID 全走共享 snapshot helper；marker false时沿 strict canonical fallback或抛 typed integrity error，绝不 silently filter poison。`getEntry`/session detail本来 hydrate canonical，继续 strict。
- 性能：健康路径仍只执行同一短事务中的 marker lookup + 原 summary index/aggregate SQL，无 manifest/evidence blob、无 per-row join；损坏态允许退化/失败。复杂度与现契约相同，仅 write/migration/repair/recovery/GC冷路径多 O(refs)。DROP/ALTER/trigger-disable明确不在该保证内。

## 文件面与兼容性

- `src/lib/history/sqlite/migrations/index.ts:62-66`：transport migration在`migration` scope原子包含撤marker、refs DDL、authority triggers、既有row strict scrub及状态初始化；marker重建不属于migration。
- 新建或集中到 `src/lib/history/v3/integrity-authority.ts`：connection-local UDF capability、`withHistoryIntegrityTransaction`、scope状态机、完整authority trigger SQL与strict validity primitive；所有writer复用，禁止各自实现布尔bypass。
- `src/lib/history/v3/store.ts:810-848,1169-1178,1365-1465`（candidate 行号）：A/B严格scope、immutable journal recovery authority、实际envelope/manifest同源refs、trusted restore与explicit adopt；GC复用decode/refs/entity子集。
- `src/lib/history/v3/summary-schema.ts:22-100`：ready projection authority trigger、pin-only窄scope；所有承重列DML受保护。
- `src/lib/history/v3/summary-store.ts:39-191,201-445,453-579`：`withValidatedSummarySnapshot`编排marker+query；migration/backfill/trusted restore从canonical重投影，repair验证provenance，adopt独立入口。
- `src/lib/history/queries.ts:214-240,273-280,326-481`、`sessions.ts:25-36,145-156`、`stats.ts:99-154`：入口接共享snapshot primitive；async search await后开启新事务复核，不跨await持锁。
- `src/lib/history/state.ts:115-126,216-222`：每个connection启动时注册只读authority UDF；migration后只调度trusted repair，不自动adopt；shutdown drain现有顺序保留。`projection.ts:442-448`不改变外部summary形状。
- v1/v2：decoded与normalized refs均精确为空，digest/hydrate不改；v3保留ordered重复digest refs。Future manifest、任意evidence/ref受保护变更同步失效；先存损坏由migration scrub置poison。

## 判据、mutation 与待验证点

- 所有发布控覆盖 get、cursor/list、session summary/entries、stats、search；正控为合法v1/v2/v3、same-digest重复sequence、pin-only update、合法new write、strict repair后republish，且不能被trigger误伤。
- Canonical/evidence controls：manifest/evidence/ref UPDATE，operation/evidence/ref INSERT OR REPLACE/REPLACE，FK-off referenced-evidence DELETE、evidence digest PK UPDATE、FK-off operation_id UPDATE；拒绝后断言旧有效状态仍可发布，不能把旁路SQL error冒充stale-publish guard。
- Journal authority controls：把payload与digest同改、authority列UPDATE、DELETE、REPLACE、existing-key INSERT，全部在FK-on/off两形态拒绝；篡改normalized journal refs也拒绝或使recovery integrity failure。B受控删除journal+refs为绿，外部伪造相同SQL为红。
- Projection authority controls：直接UPDATE任一承重列/summary_json、DELETE、REPLACE、existing-key INSERT均拒绝；pin-only专用writer为绿。外部直接调用SQL、创建TEMP同名表、伪造参数或尝试设置scope均不能获得受控writer authority；另一个connection在合法scope窗口内仍不能写。
- Binding controls：valid-v3 manifest bytes变化但format/refs仍合法、stale operation digest、stale summary分别及组合均不得republish。Trusted-original restore同步恢复manifest/digest/summary并strict validate为绿；unauthorized rebase-current保持poison；explicit adopt必须新revision+新digest+新summary+audit reason后为绿。
- 同源/lifecycle controls：normalized ref漏/多/重排/任一六元组字段变化不能ready；same-digest重复sequence正样本为绿。startup既损坏、A/B crash、journal recovery、GC、migration/backfill、repair/adopt分别覆盖；每项核对失败源自authority或stale-publish机制。
- Snapshot mutations：marker check/query拆开、cursor lookup拆开、session/stats aggregate拆开、search await后不复核，各自必须复现stale publish；正确同步短事务与async新事务为绿。窄表EXPLAIN与manifest-size controls保持。
- 性能控：保留 `EXPLAIN` 无 `v3_operations`/temp B-tree、manifest-size independence；增加refs规模下write/repair/GC冷路径报告。C若仍作为候选，PoC成功判据是page/session/stats无blob读取且相对窄表baseline给出可区分成本，不预设阈值。
- Necessity claim：**原独立 reviewer 已确认的最小命题**是：检测write-after-attestation的canonical/evidence损坏，必须重算当前bytes，或依赖覆盖该损坏变化的同步invalidation/version状态；write-once attestation或只验format/refs不闭合。“普通SQL不得同时伪造guard/status/marker”只有范围B成立时才是额外必要条件，现无用户/冻结spec裁决，不能并入已确认命题。

## Reviewer findings disposition 与裁决边界

- 第一轮 Important 1 trigger matrix：**采纳（C）**。补齐UPDATE/DELETE/INSERT/REPLACE/PK UPDATE，FK-off纳入范围，trigger `RAISE(ABORT)`为主门，FK降为第二层；DROP/ALTER/disable trigger明确排除。
- 第一轮 Important 2 refs同源门：**采纳（C）**。A/B只能从实际持久envelope/manifest decode，六元组ordered multiset精确相等，统一primitive覆盖scrub/repair/recovery/GC。
- 第一轮 Important 3 migration/controls/snapshot：**采纳（C）**。migration原子初始化但不republish；独立repair重建marker；所有同步入口单短事务，search await后新事务；扩充双向controls。
- 第二轮 Important 1 operation PK：**采纳（C）**。operation_id任何UPDATE一律BEFORE trigger拒绝，含FK-off；保留DELETE/REPLACE/existing-key INSERT矩阵，并增加拒绝后旧summary仍有效的正控。
- 第二轮 Important 2 repair binding：**采纳（C）**。strict primitive增加当前manifest bytes的domain-separated digest重算及完整summary重投影绑定；valid-v3 bytes变体、stale digest、stale summary均不可由repair重新认证。
- 第三轮 Important 1 journal authority：**采纳（C）**。A提交后journal及refs immutable；只有B的不可伪造connection-local scope能在成功提交时删除，恢复前做同源精确门。
- 第三轮 Important 2 projection authority：**采纳（C）**。ready summary除pin外由projection writer独占；完整DML矩阵拒绝外部写，并定义不可由任意connection伪造的UDF capability seam。
- 第三轮 Important 3 repair provenance：**采纳（C）**。自动repair仅信immutable journal/trusted original；current poisoned bytes只能经显式adopt新revision及审计reason成为新authority。

在“写后canonical/evidence损坏必须被发现”这一已冻结范围内，仍推荐D而非A/B/C方案；但D是否必须抵御普通SQL直接重写派生authority，取决于上面的范围A/B裁决。
这会改变可接受DB写者的信任边界与B3 PoC是否阻断，已不是纯内部实现细节。**需要用户明确选择A或B；在裁决前不得实施authority matrix，也不得让reviewer单方把B升级为冻结契约。**
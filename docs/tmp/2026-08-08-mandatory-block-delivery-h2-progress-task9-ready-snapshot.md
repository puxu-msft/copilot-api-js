---
slug: task9-ready-snapshot
status: in-progress
base: 0dca450e951b1c1ba72acb041501f8b5a3f65453
branch: worktree-placeholder
worktree: /home/xp/src/copilot-api-js/.claude/worktrees/placeholder
plan: .superpowers/sdd/task-9-summary-integrity-architecture.md
agent-id: main-session-a7c2cc1a
session-id: a7c2cc1a-1103-4c54-8ae1-e2837bda4112
source-session: 65cdef0e-4e88-4b62-a3b9-fd7409a63cfe
source-transcript: /home/xp/.claude/projects/-home-xp-src-copilot-api-js--claude-worktrees-continuation/65cdef0e-4e88-4b62-a3b9-fd7409a63cfe.jsonl
source-progress: docs/tmp/2026-08-08-mandatory-block-delivery-h2-progress-task9-range-a-continuation.md
continuity: 须连续；旧会话明确命中 context-window 400，当前会话先读 transcript、核对谱系与旧树状态后接力。
---

# Task 9 ready snapshot 接力进度

## 已恢复的提交与 WIP

- 旧 job `65cdef0e` 明确以 `400 input exceeds the context window` 终止，且无在途 task；不再尝试恢复旧上下文。
- 冻结旧树 `/home/xp/src/copilot-api-js/.claude/worktrees/continuation` 在核验时为 clean，HEAD `0dca450e951b1c1ba72acb041501f8b5a3f65453`，没有未提交 WIP。
- 当前执行树创建于 master `0840b929b0d0494b64c2a9ec532d0e859b159d14`。该 SHA 是 `0dca450e` 的祖先，目标侧独有提交集合为空，因此用 `git merge --ff-only worktree-continuation` 无损对齐到 `0dca450e`；旧树保持只读。
- 已恢复的 Task 9 单元：normalized refs、strict hydrate、20 格 canonical DML invalidation、Transaction B 五阶段×marker 两前态 recovery。详细红绿证据见 source progress。

## 本 checkpoint 已闭合的 gate

冻结架构 `.superpowers/sdd/task-9-summary-integrity-architecture.md` §3.5 的三项均已落地：

1. `withValidatedSummarySnapshot` 在一个短同步 SQLite transaction 中读取 marker，并在同一 snapshot 执行与解析 get/list/cursor/session/stats 的窄 SQL。
2. Search 先 await sidecar，随后开启新的短 snapshot，复核 marker并按 IDs 读取 summary；不跨 await 持 transaction。
3. Healthy ready path 不引入 canonical manifest/blob hydrate、per-row integrity join 或 temp sort。

旧形状是 `queries.ts`、`sessions.ts`、`stats.ts` 各自先调用 `isSummaryProjectionReady(db)`，再执行一条或多条 summary 查询；search 在 await 前检查 marker，await 后直接读取 summary IDs。当前形状由共享 primitive 封闭 marker→query 组合；search 的 target snapshot 与 await 后 result snapshot 分离。

## 剩余项

1. 跑完整 Task 9 与 backend／architecture门禁；记录准确命令、commit基线与通过数。
2. 对当前完整 Task 9候选做独立规格／生产图评审和独立acceptance／false-green／false-red评审，闭合blocker／major并复审；未评审前不把Task 9标为完成。
3. 每个后续语义commit继续更新本文件；Task 9全部闭合后把持久结论折入正式计划并转移活跃写入权。

## 在途意图

- Ready snapshot 已实现：共享 `withValidatedSummarySnapshot` 用短同步 SQLite transaction 绑定 marker 与窄 SQL；get/list/cursor/session/stats 均接入，search 在 sidecar await 后开启新 snapshot 复核。真实 WAL 双连接竞态矩阵、search await 撤 marker、healthy narrow performance 均已转绿。
- 修改 migration wiring 测试前已记录其守护不变量：默认 ledger 必须精确列出全部生产 migrations；注入 migration 必须追加且 run-once；失败 migration 必须不入 ledger；schema-5 fixture 必须在生产 002 所依赖的 conceptual baseline 上验证原子回滚。新增 002 后旧精确数组与 bare fixture 已漂移，应同步 fixture／oracle，绝不删除或跳过 002。
- 修改三条旧 readiness 测试前已记录其守护不变量与依据：typed projection divergence／非 ready status 必须阻止“只看派生表就发布 marker”的弱 publisher；依据是冻结架构 §3.1、§3.4 与旧 `tryMarkSummaryProjectionReady` 契约。当前 canonical-owner strict repair 会先用 `hydrateManifest` 验证 canonical／refs／evidence，再从 canonical record＋timing overlay重投影并发布合法 row；派生表 direct DML明确在受信边界外。因此保留负向 oracle 为无副作用 `inspectSummaryProjectionReadiness` 必须报告 `ready:false`，再增加正向 oracle：`validateAndMarkSummaryProjectionReady` 必须修复合法 canonical并发布 marker。canonical／evidence corruption仍必须 poison且 marker缺席，绝不放宽。
- 修改History重入生命周期前已记录其守护不变量与依据：任何会关闭或替换SQLite handle的 `initHistory(false/true)` 必须先cooperative stop并await当前summary backfill；依据是 `shutdownHistory()` 已冻结的“stop→drain→close”顺序与 `initHistory` 在config reload／test runtime中可重复调用的生产图。测试以合法canonical rows＋删除派生summary＋batch size 1确定性停在worker yield，不用sleep；旧实现应因closed handle拒绝，修复后disable返回时DB已关且旧promise已drain。
- 放宽 `store-performance.it.test.ts` 的wall-clock ratio前已记录其守护不变量与依据：原断言试图守“prepare／commit不随既有history长度退化”，但同一候选在并行Task 9集合得 `prepareRatio=7.08`、隔离单跑得 `0.74`，无法区分实现回归与CPU争用；项目SDD ledger与全局约束已冻结performance为report-only，canonical capture的真实复杂度另由deterministic work counter＋reachable recursive SCC gate守护。处置为保留真实timing／ratio日志、移除wall-clock pass/fail断言；这属于既有guard放宽，合并前必须由独立reviewer裁决，未审不得提交或关闭Task 9。
- 修改management status测试前已记录其守护不变量与依据：`GET /api/status` 的persisted count必须只数 `v3_operations`，不能解析坏 `summary_json`；依据是测试名、注释与status count专用SQL。旧fixture通过DROP `v3_operation_summaries_after_summary_update` 构造pre-trigger artifact，但该trigger已被002矩阵退役；当前protected-update trigger允许canonical update并只poison／撤marker，所以直接写坏 `summary_json` 已足以激活原oracle。删除硬编码DROP不放宽count断言，也不改产品行为。
- 继续每个语义 commit 同步本文件，禁止 amend 历史。

## 本轮红绿证据

- 红 1：shared primitive／observer 导出缺失，测试文件在模块加载时报 `Export named 'setSummarySnapshotObserverForTests' not found`。
- 红 2：primitive 最小实现后，search sidecar 内只撤 marker，旧接线错误 resolved；期望 `History summary projection is not ready after persisted full-text search`。
- 绿：summary correctness＋performance `20 pass / 0 fail`；facade 双连接接线矩阵覆盖 get、list+cursor、session aggregate、session entries、stats；typecheck、target lint、resetter completeness 均通过。
- Performance 口径：512 行、canonical manifest 总计 128 MiB；small/large ready snapshot 返回值一致，legacy blob scan 明显更慢。fixture 显式把派生 authority 置 ready，避免 canonical UPDATE trigger 撤 marker 后误测 fallback。
- Task 9 回归分组（本 ready-snapshot checkpoint 的最终工作树状态）：schema／migration `44 pass / 0 fail`，compatibility `28 pass / 0 fail`，Transaction B／evidence `29 pass / 0 fail`。failure-injection 的 `[error]` 日志来自预期抛错路径，最终测试汇总均为零失败。
- Migration wiring 漂移已闭合：精确 ledger oracle加入 `002-summary-integrity-invalidation`；schema-5 fixture补齐其 ledger 声称已完成的 operation／summary conceptual baseline，summary列从 `SUMMARY_PROJECTION_FIELDS` 同源生成。fixture仍由被测的001 migration创建transport evidence并升级schema version，故原子失败／重试判据未被绕开。
- 正控 mutation：用冻结 exact patch移除 `withValidatedSummarySnapshot` 的 `db.transaction`，保留 marker check／observer／read顺序；真实 WAL 双连接 primitive 与 get/list/cursor facade 测试按目标红。经 `git apply --reverse --check` 后反向恢复，同一 correctness＋performance＋migration＋resetter 集合 `28 pass / 0 fail`。
- Strict readiness红绿：篡改合法manifest-v3 operation的normalized ref `byte_length` 后，无副作用派生 inspector仍错误显示ready；旧弱publisher会false-green。Canonical-owner repair复用 `hydrateManifest` 后把row置poisoned、marker保持缺席。随后删除弱publisher，所有marker发布调用改走strict owner。
- Migration负控红绿：模拟前两项migration已入ledger、旧summary为ready、marker为1，只执行pending的 `002-summary-integrity-invalidation`；旧002只重装trigger，错误保留marker。修复后002在同一migration transaction撤marker、把既有rows置pending并清错误，再装trigger。
- Startup正控红绿：合法真实operation经过上述002后，旧backfill只扫描缺失row或 `summary_json IS NULL`，重启后marker仍为null。Strict owner改为成功hydrate后从canonical record＋timing overlay重算 `summary_json` 并调用 `publishValidatedOperationSummary`，真实on-disk shutdown→reopen→drain后row恢复ready、marker为1。
- Lifecycle泄漏红绿：clear测试最初在明确 `deleteMeta` 后仍观察到marker=1；根因是 `resetV3WriterForTests` 丢弃仍运行的summary backfill promise句柄，旧worker跨测试写回新DB。Reset现在只请求stop而保留句柄，isolated fixture和store suite teardown先drain；完整store suite `13 pass / 0 fail`。
- GC红绿：分别删operation normalized refs与pending journal normalized refs中的sequence 2，并另插真orphan；旧GC仍删除orphan。现在GC在任何DELETE前对manifest／journal envelope与normalized refs做ordered六元组精确对账，两种mismatch均抛错且evidence count保持3；完整store＋evidence组 `44 pass / 0 fail`。
- 当前分组验证：summary／migration／performance `71 pass / 0 fail`；History API／shutdown／resetter `27 pass / 0 fail`；identity／evidence／legacy／readonly最新组合 `45 pass / 0 fail`，单独evidence suite `34 pass / 0 fail`；typecheck通过；目标ESLint零error，仅输出第三方 `baseline-browser-mapping` 数据陈旧提示。完整backend与architecture门禁待跑，不能据此提前关闭Task 9。
- Row identity红绿：把operation A的 `manifest_gz`／digest换成合法operation B，同时保留A row与shared evidence refs；旧strict repair错误返回ready并把B summary发布到A，`hydrateTransportEvidence(A)`与GC也信任B manifest。现在 `hydrateManifest` 的expected operation ID为必填，detail／list／visit／strict repair／backfill／search sidecar全部从SQL row透传；evidence hydrate与GC复用同一identity assertion。三条负控均红→绿，shared-digest正样本保持绿。
- Evidence读取契约红绿：删除manifest-v3 operation normalized refs中的sequence 2后，旧 `hydrateTransportEvidence` 仍返回manifest bytes。该入口现复用 `validatePersistedOperationEvidenceRefs`，按identity→ordered refs→entities完整验证并返回已hydrate结果，不重复解压。
- 既有 `evidence-missing.patch` 因strict primitive重构已无法apply；按当前真实实现重建后，三份patch均通过 `git apply --check`。实际注入新patch并确认目标hunk退化后，`transport-evidence.it.test.ts` 的normalized-ref detail oracle按目标失败；`git apply --reverse --check`通过、用同一冻结patch恢复，完整evidence suite重新 `34 pass / 0 fail`。复跑配方：`git apply --check tests/history/v3/fixtures/transport-evidence/mutations/{evidence-missing,consumer-format,startup-bypass}.patch`；未在文档写裸hash，避免无生成命令的易腐指纹。
- History重入红绿：合法3-row canonical store删除summary rows后以batch size 1启动worker，旧 `initHistory(false)` 先close DB再返回，随后drain旧promise因closed handle拒绝。`initHistory` 共同入口现先stop＋await旧worker，再close／reopen；确定性测试 `8 pass / 0 fail`。Config hot-reload＋history-store相邻回归按运行时枚举为2个测试文件、`417 pass / 0 fail`；传入的 `tests/helpers/test-bootstrap.ts` 是helper，不计作测试文件。
- 完整门禁：Task 9定向集合按运行时汇总为36个测试文件、`269 pass / 22 skip / 0 fail`；全architecture为13个测试文件、`164 pass / 0 fail`。官方 `bun run test:backend` 在本机16 shards下两次非零：首轮2 fail，修复management旧trigger fixture后第二轮失败集合变为多个5秒超时／transport setup超时及重复negotiation落盘false-red；`test:backend:isolated` 同时启动699个file workers，产生27 fail（几乎全5秒timeout）与2个SIGILL。已整合master上独立语义commit `fb04255a` 的显式debounce drain seam后，原negotiation 49-file LPT bucket为 `580 pass / 2 skip / 0 fail`。最终以同一发现集合、同一LPT算法、4 shards低负载完整复验：699个测试文件，`7198 pass / 30 skip / 1 todo / 0 fail`，四个shard均exit 0，55.29秒。故逻辑全量绿，但官方16-shard命令在本机资源争用下未绿；交付不得把后者改写成“官方门通过”。
- `store-performance.it.test.ts` 的history-length wall-clock ratio在并行Task 9集合曾false-red `7.08`，隔离为 `0.74`，4-shard完整backend为report-only且未失败。按已冻结的SDD决策移除ratio pass/fail、保留timing报告；CAS容量、writer memory、canonical deterministic work counter与recursive SCC guards仍为硬门。该既有guard放宽待独立reviewer最终裁决。
- Management status旧fixture硬编码DROP已退役的 `v3_operation_summaries_after_summary_update`，单跑稳定红；当前protected-update trigger本就允许写坏canonical summary并poison／撤marker，因此删除旧DROP后原“count不解析summary”断言保持不变，单文件 `12 pass / 0 fail`。
- Persistence freeze测试原用固定1.1s／5.2s debounce等待，在共享bucket中两次让旧写覆盖新flush；等价重演master已落地的 `fb04255a`：新增negotiation／calibration显式drain action hooks与resetter豁免，测试改为断言drain true／false。定向freeze＋resetter `9 pass / 0 fail`，原49-file bucket `580 pass / 2 skip / 0 fail`。
- 全静态门：typecheck与所有本轮代码路径target ESLint均通过；Markdown／`.superpowers`无匹配lint配置，只产生ignored warnings。`bun run lint:all` 在Task 9 checkpoint（`8b839820`）基线上仍有117个文件、383项（378 errors／5 warnings），不是本轮可忽略失败。**口径更正**：`bae83f01 style: apply repository lint fixes` 起初据一份较早的master快照记为「已在master」，实测 `git merge-base --is-ancestor bae83f01 master` 非零、`git branch --contains` 只列出 `worktree-nghttp2-header-deadline`——它是特性分支上的117文件纯style commit，父基线比当前master少42个提交。
- Lint基线整合（commit `756a1b30`，113文件）：以 `git cherry-pick -n bae83f01` 取其非冲突style hunks；13个modify/delete冲突按当前HEAD的删除决定 `git rm` 保留删除，7个内容冲突保留当前分支已验证语义（`--ours`），不让旧分支style覆盖较新逻辑。其后逐项收敛剩余finding，全程禁止全仓 `eslint --fix`：① `src/lib/history/v3/recovery.ts` 由deprecated `beginAttempt`／`settleAttempt` 正式迁到 `beginCandidate`＋`beginDispatch`＋`settleDispatch`，并显式 `settleCandidate`（旧adapter在 `commitTerminal` 内隐式做这件事，不补则terminal因open candidate拒绝）、terminal改用 `winnerCandidate`＋`committedDispatch`、arena origin由 `attempt` 改 canonical `dispatch`；② Responses／Anthropic usage按类型SSOT删除恒真的null分支（`ResponsesUsage.input_tokens_details` 内字段为 `number | undefined`、Anthropic `message_start.usage` 与非流式 `response.usage` 必有），cache_write等richest-data字段全部保留；③ `cell-assembly` 的4处retry语义由连续 `if` 改为穷尽 `switch`，保住「新增 `UpstreamEndpoint` 即编译失败」的守卫；④ 测试oracle改用 `ts.flattenDiagnosticMessageText`（`messageText` 可为链式对象，正是规则要防的 `[object Object]`）、SDK oracle显式收窄 `unknown`、未使用捕获组改非捕获组；⑤ `contrib/pm2/ecosystem.config.cjs`／`hooks/strip-todowrite.ts`／`tests/diagnostics/fixtures/sonic-boom-flush-contract.mjs` 不在 `tsconfig` include 内，改为flat-config末端关闭project service并套 `disableTypeChecked`，保留语法与Prettier检查而非整体ignore。
- Lint整合后门禁：`bun run lint:all` 与 `bun run typecheck` 均零error；受影响模块定向回归（`tests/openai`、`tests/responses`、`tests/architecture`、recovery、hooks、buffered-merge-wiring、diagnostics）共119个文件 `1205 pass / 0 fail`（`Ran 1206 tests`，含1 skip），exit 0。style patch自动引入的一处typecheck回归（`buffered-merge-wiring` 的 `.at(-1)` 在TS下为 possibly undefined）已按显式断言修复，未用非空断言掩盖。
- Backend门分型补充：官方16-shard两轮失败集合变化；699-worker isolated门产生27 fail（几乎全5秒timeout）＋2 SIGILL。用同一runtime discovery与LPT算法降为4 shards后，699个测试文件、`7198 pass / 30 skip / 1 todo / 0 fail`，四shard均exit 0。官方门仍必须如实记为未绿；低并发结果证明当前逻辑集合可全量通过，不证明官方runner在本机资源条件下可靠。

## 独立评审整改（2026-08-08，两视角并行）

评审报告：`docs/tmp/2026-08-08-task9-review-spec.md`（spec合规／生产图，2 BLOCKER）、`docs/tmp/2026-08-08-task9-review-acceptance.md`（验收判据双向鉴别力，1 BLOCKER + 3 MAJOR）。两视角**独立撞到同一个首要缺陷**（spec-F1 ≡ acceptance-#7），这提高了该结论的稳健度，不是重复劳动。

### 已闭合

- **F1／#7（BLOCKER，数据完整性）** commit `af5e4553`＋`4bb77151`。`summaryFromRow` 先做完整strict hydrate，却在 `summary_json` 非空时把校验结果丢弃、原样返回缓存派生值——「锁内复核的结果被丢弃」的教科书形态。marker撤销后（migration 002、或任一受保护canonical UPDATE），`visitV3Summaries` 的三个生产消费者（`queries.ts:274` list、`sessions.ts:32`、`stats.ts:152`，均由 `!ready` 门控）会把**被篡改的summary原文**交给客户端；评审探针实测返回 `endpoint:"ATTACKER-CONTROLLED"` 而 `tests/history/` 全绿。修法=一律从已验证canonical record重投影，与 `getSummary` 单行fallback的既有行为对齐，消除消费者间不一致；顺带停止SELECT该路径不再读取的 `summary_json` 列。**判据缺口同步关闭**：新增 `summary-integrity-dml.it.test.ts` 的「marker缺席fallback发布canonical重投影而非被篡改缓存」负控，从真实读路径取值。**鉴别力已实证**：把实现改回缓存快捷返回，恰好该条变红（`36 pass / 1 fail`），恢复后 `37 pass / 0 fail`。
- **F2（BLOCKER，身份错绑）** commit `af5e4553`。manifest路径已有 `assertManifestOperationIdentity`，但journal的两个消费者（`recoverV3Journal`、`journalEvidenceRefGroups`）解码payload后从未断言自述operationId等于SQL row owner；refs／revision／digest全部对账通过仍可发布错绑operation。修法=抽出共享 `assertRecordOperationIdentity`，并把 `expectedOperationId` 做成 `decodeJournalPayload` 的**必填参数**（用类型系统逼出全部调用点，而非各处补一句），另在prepare后加邻接防线 `prepared.id === row.operation_id`。新增recovery与GC两条负控。**鉴别力已实证**：只去掉decode侧断言时recovery那条仍绿（邻接防线接住、错误信息相同，属纵深防御非假绿），两道一起移除则 `2 fail`；恢复后 `36 pass / 0 fail`。
- **#5（MAJOR，性能不变量）** commit `4bb77151`。`commitPreparedOperation` 每次提交调 `getSummaryProjectionReadiness(db).ready`，而该函数带无索引的全表聚合、两个计数算完即弃；改用O(1)主键查找的 `isSummaryProjectionReady`。评审归因诚实：这条O(N)读**非本轮引入**（`ab594029` 已同款），本轮的过错是「同一commit里既删掉唯一可能发现它的判据、又用被测对象不同的判据冒充替代」。

### 门禁口径更正（推翻我先前三处断言）

- **「官方 `bun run test:backend` 未绿」已过期**：修复后实跑 `16 shards · 2806 tests · 2806 pass · 0 fail · 32.20s`，**exit 0**。
- **`7198 pass` 这个数是错的，不可复现**：真实规模约2806。评审给出的根因（`parallel-test.ts` 的 `stripAnsi` 漏删ESC字节）**经探针实测证伪**——源码中该正则含真实ESC字节（`sed`／编辑器渲染时不可见，评审与我先后踩了同一个渲染陷阱），探针输出 `plain: " 13 pass"` 且匹配成功。**tally不可复现是事实，根因仍未定**：连续两次官方门给出 `2806` 与 `4200`。已修一处独立成立的真实隐患（commit `fa28deb3`：`await p.exited` 排在读管道之前，输出超过管道缓冲的shard会阻塞在write而无人排空），但它**没有**解决计数差异——不得把这次修复写成tally已修好。
- **「persistence freeze flaky 已闭合」被证伪**：第二次官方门 exit 1，失败点为 `states-flush-freeze.it.test.ts:74`，正是drain seam**没有触及**的那条断言。分型实测：单跑该文件 `6 pass / 0 fail`；跑它所在的49文件bucket `580 pass / 2 skip / 0 fail`；**仅在16-shard并发下偶发**。属并发负载下的既有测试隔离缺陷，非Task 9引入，**未闭合**。

### 第二轮点名项的处置（当时列为「未闭合」，现均已闭合）

- **#2（MAJOR）已闭合**（commit `af5e4553` 之后的 `cf377959` 批次前）：Transaction B的commit-time strict gate原先零鉴别力——现有注入器只测「在该点回滚」，与「strict校验是否真的在跑」互相独立，删掉 `store.ts:924` 那行仍全绿。修法不改生产代码：让注入器在 `refs` 阶段**删掉一条真实ref行**（改变真实数据，而非抛异常），strict gate若在跑就必须检出并回滚。**鉴别力已实证**：删掉该行时恰好该条变红（`36 pass / 1 fail`），恢复后37全绿。
- **#5的判据侧已闭合**（commit `2b2c1d43`，后经 `540ca320` 加固）：实现早已修好（O(1) marker查找），缺的是判据。新判据**不用计时**，改问SQLite本身——包装 `db.prepare` 捕获一次提交执行的全部SQL，对每条跑 `EXPLAIN QUERY PLAN`，断言其中不出现对任何表的全表 `SCAN`，**有界表白名单**除外（`v3_meta`／`history_meta`／`history_store_identity`／`sqlite_schema` 等）。这类判据不受CPU争用影响、无false-red，且在任意N下都成立。（初版是「列举会增长的表」的黑名单形状，忘了加新表就没有任何信号，经复评建议反转；同时补上了 `db.exec` 这条绕过 `prepare` 的逃逸口。详见「评审第三轮」与「评审收口」。）
  - **鉴别力实证过程中先做出了一条假判据，值得记**：第一版在只跑 `ensureV3Schema` 的库上运行，而 `v3_operation_summaries` 是由**迁移**创建的——表不存在时 `getSummaryProjectionReadiness` 提前返回，那条O(N)聚合**根本没被执行**，于是把O(1)改回O(N)时判据仍然全绿。**「变异后没变红」当时的真解是「判据测了个空」，不是「实现没问题」**。补上 `ensureV3Schema` + `applyForwardMigrations` 后，变异下红在 `offenders` 断言、且offender精确指向 `SCAN v3_operation_summaries`；恢复后全绿。
  - 另一处自我纠正：初版用32次flood打底，导致同文件的CAS用例超时15s（false-red），故砍到2次。**当时我给的理由「此处无ANALYZE统计」是错的**——`openDatabase` 无条件跑 `seedAnalyzeIfNeeded`，`sqlite_stat1` 确实存在；正确依据是实测（N=2／N=200／N=200+手工ANALYZE 三组offenders均为0，且N=2下变异即变红）。详见「评审第三轮」。
- **#2的负控已补齐第二个方向**（commit `2b2c1d43`）：原先只覆盖「少写一条ref」，按复评建议加了「写了但值不对」（`byte_length+1`），两个方向同一注入器、参数化两例。
- **官方门稳定性与tally可复现性**：**根因未定，且已排除两个假说**——ANSI假说被探针证伪、管道背压虽是真实隐患（已修 `fa28deb3`）但修完数字依旧乱跳。同一命令至今给出 **7个互不相同**的tally（860 / 2806 / 4200 / 5555 / 5796 / 5846 / 6705）。**不补第三个解释**。已记入 `docs/todo/deferred-backlog.md`，并确立交付纪律：**只引exit code与失败用例名，不得用tally数字作规模或增减证据**。

## schema-5 升级路径BLOCKER（本轮新发现并闭合，commit `cf377959`）

**发现路径**：给F3补负控时，在真实fixture上跑完整 `ensureV3Schema + applyForwardMigrations` 撞到；随后交独立reviewer裁决，裁决确认「推理成立，升级路径确实是坏的，两条『反向证据』都不是反证」。

- **缺陷**：`MIGRATIONS` 中 `001-operation-summary-projection` 排在 `001-transport-evidence-schema` 之前，但前者安装的触发器目标是后者创建的 `v3_transport_evidence`（实测该SQL含4条以它为触发目标的语句）。全新库看不见这个顺序问题——`ensureV3Schema` 已建好整个schema-6地基；而真实schema-5库上 `ensureV3Schema` 按设计早退（它不拥有版本迁移），于是summary迁移先跑、撞上不存在的表、抛错且ledger保持为空。`applyForwardMigrations` rethrow ⇒ **存量schema-5用户升级后服务起不来，且每次重启同一处死**。
- **归属**：存量缺陷，`git log -S` 定位到 `72b51429`（早于本轮基线 `ab594029`）。Task 9既没引入也没闭合它，但它在Task 9的交付面上，必须闭合。
- **为何一直没被发现（判据缺口，MAJOR）**：`transport-evidence-migration.it.test.ts` 的两条相关用例都走 `applyForwardMigrations(db, [单条注入])`，**从不驱动出厂数组**；`migrations-wiring.it.test.ts` 那条走真实 `initHistory`，但fixture写死 ledger 已含 `001-operation-summary-projection`（该预置早于Task 9）。HEAD上 `legacy-db-fixtures.it.test.ts` 对 `applyForwardMigrations` 的引用数为 **0**。本轮新增的 `test.each` 是第一条把出厂数组跑在真实空ledger的schema-5库上的判据。
- **收口三件**（按裁决建议）：①换序 + 在 `MIGRATIONS` 处注释点名DDL依赖方向；②把两处**全等快照**改成**相对次序**断言——`storage.ts` 的 `logMigration` 是 `if (!list.includes(name)) push`、pending由**集合成员关系**决定，ledger顺序无人依赖，所以那两处快照守的不是真不变量，其中一处的测试名还把方向相反的依赖固化成了守卫；四处ledger数组全等断言相应改为集合语义；③保留新增的 `test.each` 作为升级路径判据。**不拆分trigger SQL**：实测可行，但 `after_insert` 的触发体引用 `v3_operation_evidence_refs`，拆分会留下「trigger已装、表未建」的中间态，换序无此中间态。
- **guard变更记录（放宽既有guard，按纪律留痕）**：被改的两处快照与四处ledger全等断言，原本守的不变量经裁决确认为「数组字面量」而非任何行为契约；改形后行为断言（建表/trigger/rethrow/幂等/回滚）**全部照绿**，无一行为回归、无级联。裁决同时指出 `migrations.it.test.ts:112` 那条快照与其用例标题（"empty migration list is a no-op"）毫不相干，属名实不符，已移除并把顺序断言归位到 `transport-evidence-migration.it.test.ts`。

## F3（MAJOR，spec视角）— legacy manifest hydrate 跳过 refs 对账

- **缺陷**：`hydrateManifest` 仅在 `formatVersion === 3` 时对账normalized refs。相邻的 `hydrateTransportEvidence` 与GC路径对v1／v2**也**对账（decoder已把v1／v2的refs规范化为空数组，契约是空↔空），恰好反证这个版本条件是漏闸而非有意契约——同一operation可被strict repair发布为ready、却被evidence hydrate与GC拒绝，消费者间不一致。
- **修法与一次自我纠错**：先去掉版本条件，实测**打红2条legacy可读性测试**——schema-5库根本没有ref表，无条件查询会让旧库整个读不出来，这是真false-red。遂加表存在性守卫。但复评指出该守卫**引入了新的false-green**：docstring论证的是「schema ≤5」而代码判的是「表存不存在」，**判别对象错了一层**——schema-6库若缺ref表，含非空refs的v3 manifest会被整个跳过对账、静默fail-open。最终形态：`if (manifest.formatVersion === 3 || hasOperationEvidenceRefsTable(db))`，版本在前、表探测只作legacy allowance。
- **判据**：v1／v2各一条负控（迁到schema 6后插入多余normalized ref必须拒绝）+ 每条内含正样本（未受污染的legacy行必须仍可hydrate，防false-red）；另加一条守false-green的负控（schema-6库缺ref表时，v3 manifest仍须对账）。**鉴别力已实证**：把守卫改回只判表存在的形态，恰好该条变红；恢复后38全绿。

## 评审第三轮（spec F5／F6，acceptance R2-4）

- **F5（BLOCKER，我在 `756a1b30` 里引入的）已闭合**（commit `f5de686b`）：recovery 从 deprecated adapter 迁到canonical API时，我**无条件**写了 `winnerCandidate`，哪怕该candidate已被settle成 `failed`。旧adapter只传 `committedAttempt`，`commitTerminal` 在无committed dispatch时**不会推导winner**。后果：失败／aborted／interrupted的recovery record会声称「有winner」而对应candidate标 `failed`，canonical History自相矛盾。修法=`winnerCandidate` 与 `committedDispatch` 绑定同出同没。
  - **同时修了settle顺序**：旧adapter在 `commitTerminal` 内settle candidate（即**egress之后**），我原实现提前到了egress之前——这会改变sequence、timeline与digest，属静默非等价。已把 `settleCandidate` 移回 `recordEgress` 之后。
  - **判据**：completed／failed／aborted／interrupted 四态回归，逐项断言dispatch verdict、candidate verdict、terminal的winner／committed字段，并冻结「candidate settle晚于egress、早于terminal」的sequence关系。**鉴别力已实证**：把 `winnerCandidate` 改回无条件写，四态中三条变红；恢复后5全绿。
- **L1（通过）**：`756a1b30` 里usage条件简化、`cell-assembly` 穷尽switch、测试oracle三类改动经逐项核验**未发现字段丢失或断言弱化**。评审给出一手证据：Anthropic SDK的 `cache_creation_input_tokens`／`cache_read_input_tokens` 是 `number | null` 而非optional，故显式null判断与旧 `!= null` 等价；Responses侧details对象optional但非nullable。
- **F6（MINOR，未处置）**：`756a1b30` 名为 `style:` 却含canonical History与translation的行为重构，message与内容不符。评审建议未发布前按History／translation／pipeline／test分拆历史。**未做**——本轮已在其上叠了7个commit，重写历史的收益不抵风险；在此记录，交付时由用户裁决。
- **R2-4（acceptance收口复评）verdict：无未闭合blocker。** 三条建议均已采纳：
  - **更正了一处错误理由**（评审唯一点名的合并前必改项）：我给「N=2足够」写的理由是「此处无ANALYZE统计」——**错的**。`openDatabase` 无条件跑 `seedAnalyzeIfNeeded`，`sqlite_stat1` 确实存在（只是ANALYZE跑在v3表创建之前、且「表存在即返回」故不重跑）。结论对、理由错，而这是给后来者读的指令性文本——错的理由会让下一个人在别处放心用极小样本判计划。已改成实测口径：N=2 / N=200 / N=200+手工ANALYZE 三组下offenders均为0，且N=2下变异即变红。
  - **黑名单反转为白名单**：原先列举「会增长的表」，忘了加新表不会有任何信号；改为「不得SCAN任何表，除非在有界表白名单内」，失败方向反过来了。
  - **补上 `db.exec` 这个逃逸口**：一次提交经 `exec` 走4条（`V3_SCHEMA_SQL` + 3条 `DROP TABLE IF EXISTS`），完全绕过 `prepare` 探针。已加断言：exec只许承载DDL。**这里我又踩了一次自己的坑**——初版正则带 `m` 标志，把DDL脚本里**触发器体内**的 `INSERT`／`UPDATE` 行也算成DML、误报整份schema；去掉 `m` 只判整段开头才对。
  - 复评实测的捕获完整性：一次提交经 `prepare` 共29条（去重21），被 `try/catch` 跳过 **0** 条、被前置正则跳过 **0** 条——我担心的「EQP在带参／CTE／UPSERT上静默跳过一大片」没有发生。
- **两条门禁失败的判定经独立核实成立**，其中一条已定位机制：
  - `tests/routes/hooks.http.test.ts` 的 `POST /reload`——`loader.ts` 的 `HOOK_CACHE_DIR` 是**相对路径**，而16个shard都以 `REPO_ROOT` 为cwd ⇒ 共享同一目录；`cacheInitialized` 是进程级，于是每个shard首次加载hook都 `rmSync` 清空整个共享目录，删掉别的shard正要 `import()` 的文件。与本轮改动零交集，已记入 `docs/todo/deferred-backlog.md`。
  - `states-flush-freeze.it.test.ts:74`——评审在 `cf377959` 之前的Round 1 就抓到**同一文件同一行同一断言**失败，故非本轮引入；也不是drain seam回归（seam改的是另外四行）。**根因不补解释**，只登记形态与已排除假设。

## 评审收口（两视角最终一致）

**最终verdict：可合并，BLOCKER 0 / MAJOR 0。** 两个正交视角（spec合规／生产图、验收判据双向鉴别力）各自独立跑完多轮，最终结论一致。

**第四轮修的两条MAJOR**（commit `540ca320`）：

- **F7**：F5的修复**没修干净**。我修好了「无条件写winner」与「settle顺序」，却漏了 `candidate` 的**创建时机**——旧adapter是在 `beginAttempt` 内惰性创建的（即该attempt的payload注册**之后**），我提到了循环之前，会推移后续所有事件的sequence、进而改变timeline与digest。已改为 `candidate ??=` 惰性创建，并把metadata／reason对齐旧adapter的字符串。**取舍已记录并经评审确认正确**：这两个字段进入哈希记录，保留旧字符串（哪怕 `attempt-adapter` 这个标签对recovery语境已不贴切）换取的是**canonical identity稳定**——否则同一份未变的输入重跑recovery会产出不同digest。评审复核确认sequence／timeline／metadata／reason／timestamp／digest现已与旧adapter等价。
- **F8**：`execDml` 只查脚本首条语句，漏得掉 `PRAGMA …; UPDATE …` 这类多语句混合。改为**冻结命中集**：exec只许承载 `V3_SCHEMA_SQL` 整段或 `DROP TABLE IF EXISTS <table>`，fail-closed。评审确认覆盖当前真实拼写且无新false-red。
  - **同一处我先后犯了两个相反方向的错**：初版正则带 `m`，把DDL脚本里**触发器体内**的 `INSERT`／`UPDATE` 误报成DML（false-red）；去掉 `m` 后又变成只查首条、漏掉尾随DML（false-green）。冻结命中集绕开了「用正则判多语句脚本」这个本就不该走的路。

**已知时间敏感用例**：`store-performance.it.test.ts` 的 `CAS live physical bytes…` 贴近15秒默认超时——评审那次复跑因此红过一次（`8 pass / 1 fail`），我本地同文件4全绿。该用例**早于本轮**就在边界上（这也是我把新判据的flood从32砍到2的原因）。不属Task 9，未处置。

**交付前最终门禁（HEAD `540ca320` 之上仅余文档改动）**：

- `bun run lint:all` **零error**（本轮开始时是117文件／383项）。
- `bun run typecheck` **零error**。
- `tests/history/` `560 pass / 23 skip / 0 fail`。
- 官方 `bun run test:backend`：**exit 1**，汇总行 `16 shards · 2356 tests · 2356 pass · 0 fail · 1 shard(s) crashed`。崩溃点是 `tests/pipeline/hooks/loader.unit.test.ts` 的 `data-URL reload` 用例，**隔离下 `8 pass / 0 fail`**——正是backlog已定位机制的那条并发缺陷（`HOOK_CACHE_DIR` 是相对路径，16个shard以同一cwd spawn ⇒ 共享同一目录，每个shard首次加载hook都 `rmSync` 清空它，删掉别的shard正要 `import()` 的文件）。与本轮改动零交集。
- **口径纪律**：按已确立的规则，上面只引exit code与失败用例名；`2356` 这个tally数字**不作为规模或增减证据**（同一命令至今给出7个互不相同的值，根因未定）。

## 结构怪味审计

- `src/lib/history/queries.ts`：旧实现把 cursor、page、membership overlap 分散到多个 marker check，属于同一 API 拼接多个 SQLite epoch 的职责泄漏。本轮修为高层 API 每次只建立一个 ready snapshot；fallback 只读 canonical，不再借未 ready 的 summary 表算 overlap。
- `src/lib/history/v3/summary-store.ts`：raw query primitives 仍是公开导出，调用方理论上可绕过 `withValidatedSummarySnapshot`。本轮不隐藏它们，因为现有性能／SQL 计划测试直接调用，且 Task 9 后续 repair／backfill 也需底层 primitive；独立评审必须检查生产调用点集合仍全部受 snapshot 包裹。
- `tests/history/v3/migrations-wiring.it.test.ts`：schema-5 fixture 曾只建 meta+journal，却声称 summary migration 已执行，属于 fixture 与 ledger 名实不符。本轮补齐 operation／summary conceptual baseline，summary列同源于 `SUMMARY_PROJECTION_FIELDS`，不复制第二份列清单。
- `src/lib/history/v3/store.ts`：backfill曾把“补缺失row／补NULL summary”与“全库strict repair／发布marker”混在同一worker，但最后一步只检查、不重投影既有pending row，导致002正确撤权后无法恢复。本轮把重投影放入canonical-owner strict primitive，startup、手工repair与backfill final gate共用；避免在migration、worker循环和publisher各写一份完整性逻辑。
- `src/lib/history/v3/store.ts`：`resetV3WriterForTests`曾直接清空module-global backfill promise，属于异步资源所有权丢失；本轮改为cooperative stop＋可drain句柄。该修复位于共享生命周期基座，不只patch clear测试。
- `src/lib/history/v3/store.ts`：manifest identity、stored digest、normalized refs与evidence entity原先分别从manifest自述ID或调用方row ID取值，属于同一entity identity的双源。跨row置换可让合法B manifest借B digest通过A读取。本轮把expected row ID设为 `hydrateManifest` 必填参数，并抽 `assertManifestOperationIdentity` 供detail、strict repair、evidence hydrate与GC复用；调用点由类型系统穷尽。
- `src/lib/history/v3/index.ts`：barrel目前未re-export `validateAndMarkSummaryProjectionReady`；生产内部由 `state.ts`／`store.ts`直接接线，测试也直接从owner导入。本轮不扩大公共storage API；若Task 10需要跨边界调用，应在其activation接口设计中明确，而不是为测试便利提前暴露。

## 方案反思

1. **项目内替代方案：** 给每条 raw query 各自包 transaction 更小，但仍会让一个 API 拼接多个 epoch，因此判别力不足；本轮采用高层 facade 单 snapshot。
2. **判据判别力：** 真实 WAL 第二连接撤 marker＋poison 同时验证当前 snapshot 正确样本不 false-red、移除 transaction 后错误状态会红；search 另用 await 内只撤 marker排除 stale-reference 旁路。
3. **成熟第三方方案：** SQLite 原生 deferred read transaction 已直接提供 snapshot isolation，`BEGIN IMMEDIATE` 提供strict repair的单写原子边界，FK与trigger承担同步invalidation；无需引入ORM、外部锁库、签名系统或自制epoch协议。项目driver已统一Bun／Node transaction API，复用这些成熟原语是最佳层级。
4. **更好的内部替代方案：** 把full scrub直接塞进Umzug migration可逐字贴合架构§3.4，但会让schema migration依赖runtime hydrate／projection代码、在大库上长事务锁写，并把repair逻辑复制两份。当前分层让migration原子撤权＋安装护栏，production `initHistory` 必经的异步worker复用唯一strict primitive恢复；安全性质相同且职责更清晰。此职责分配偏差需列入独立spec review，不由实现者自判。
5. **判据判别力：** 只测migration撤marker会漏掉合法旧库永久pending的false-red；新增真实on-disk reopen正控后才撞出该缺口。只测strict corruption会漏掉派生DML被合法修复；保留inspector负控＋strict repair正控，两个方向都可判。

## 已作废的路子

- 不再 `SendMessage` 恢复旧会话；模型上下文终态不会因缩短新消息而恢复。
- 不直接在旧 worktree 写入或清理；它是接力证据源。
- 不 blind merge/cherry-pick 旧分支；本次已通过祖先关系证明可安全 fast-forward。
- 不把 marker check 和 query 仅靠调用顺序“尽量靠近”；必须由同一个 SQLite snapshot 提供原子边界。

## Checkpoint：合并 master 与门禁修复（2026-08-09，HEAD `b9b5895b`）

本节一次性补记四个提交（`ca5f4cf7` / `a0c82cc3` / `e24de3a1` / `b9b5895b`）——它们在一次连续的合并-验证循环里产生，其间没有可供落盘的中间稳定点；此后恢复每 commit 更新。

### 已落地

- **合并 master**（`ca5f4cf7`）。merge-base `6d431481`，本分支领先 108 个提交（含前序会话的 parsed SSE delivery seam、candidate delivery classification、HTTP2 termination evidence，以及本轮 Task 9），master 领先 404，149 个文件重叠、30 个冲突、53 个 hunk。原则是**两侧不矛盾就都保留**，不做整文件取舍。
- **合并暴露的真回归**：parsed SSE wrapper 被直接写进 canonical arena，`upstreamResponse.frames` 引用的值因此没有顶层 `data`，`precontent-recovery-matrix` 变红。修在共享存储边界（`src/lib/context/request.ts` 的 `canonicalFrameFields`），让 `frameWireKey`、raw capture、canonical arena 共用同一个投影原语，而不是改断言。
- **CAS 字节比判据的超时**（`a0c82cc3`）：15s → 120s。实测隔离约 9s、16 路分片下 **16.29s**，越界 1.3s 就让整个门禁变红。它的 oracle 是字节比（109x / 218x vs 阈值 10x），wall clock 在这里只会产生 false red；且测试体是同步的，bun 无法中断——超预算的运行**照样做完全部工作并打完统计**才被判 TimeoutError，输出与通过的运行一模一样。
- **门禁自身的假绿**（`e24de3a1`）：`parallel-test` 的 tally 原本从各 shard 的 stdout 解析。shard 在打印 summary 时死掉，`N fail` 那行就永远不落，而失败的 testcase 行早已 flush 进 XML——于是门禁在一条真失败之上打印绿色的 `0 fail`。这不是假设：本次合并门禁打印 `3337 tests · 3337 pass · 0 fail`，而 shard-06 的 XML 里躺着上面那条 TimeoutError；同一次运行还把总数少报了一半以上（3337 vs 7529 executed）。改为 `parseJUnit` 统计 `<failure>`／`<error>`，pass 由 `executed - failed` 派生，失败逐条具名，`failSum` 进退出条件。

### 证据

- 修复后官方门禁：`bun run test:backend` → **7532 tests · 7532 pass · 0 fail · 7532 executed · 35 skipped**，无 shard crashed，退出码 0。
- tally 修复的鉴别力：在触发本次问题的那批真实产物上，新解析器给出 `7529 executed / 1 failed / 7528 pass` 并点名超时的那条；把 failure 捕获分支置空后回到 `failed=0`（复现旧假绿），两条新正向判据变红，而「skipped 不算 failed」那条按设计保持绿——两个方向都有对照。
- `typecheck`、`lint:all` 均零 error。

### 裁决结果（2026-08-09 收口，两份评审均已闭合）

上一版这里写的是「待裁决」，现已裁决完毕，逐条留痕：

- **CAS 超时放宽 —— 裁定处置正确、未被证伪。** 评审实测把内容寻址去重关掉后 `physicalRatio` 掉到 9.51、判据确实变红，说明放宽超时没有让 guard 失去裁决力；字节比与本文件引述的 109x/218x 逐位吻合，无实现退化证据。报告：`docs/tmp/2026-08-09-merge-state-review-claims.md`。
- **但同一裁决顺带证出一条真缺口（已修，`27113ce4`）**：`liveRatio` 在去重**完全**失效时仍是 10.79、照样过原来 10x 的门 ⇒ **该断言原本毫无鉴别力**，任何部分退化按构造全绿。阈值已按两端实测重标为 30 / 50（健康 109.68/218.58，故障 9.51/10.79，取几何均值附近、两侧各留约 3x）。
- **合并态接缝评审 —— 本次合并范围内 BLOCKER 0 / MAJOR 0。** 它原报的 1 条 MAJOR（`initHistory()` 重入不协调 terminal persistence lifecycle）机制成立，但**根因归属被证伪**：`git show 57208559:src/lib/history/state.ts` 显示 master 侧本来就没有 pause/quiescence/drain，合并只**增加**了 backfill 协调。评审接受更正并改判。该缺陷已转入 `docs/todo/deferred-backlog.md` 独立条目（含证据链与回归测试建议）。报告：`docs/tmp/2026-08-09-merge-state-review-seams.md`。
- **判据评审另抓到一条我漏掉的 MAJOR（已修，`0144edcb`）**：改用 junit 后仍有同形缺口——测试文件在**加载期抛错**时不产生任何 junit 行，而 bun 照样打印 `N fail`，于是 crash 分类器不触发、该文件的用例与失败静默蒸发。退出码本就 fail-closed（`compareFileIdentities` 兜底），漏的是 tally 行的可信度；已让「口径不完整」直接骑在 tally 行上，并把 `formatTallyLine` 抽成可测函数 + 变异对照。
- **三处证据等级更正**（评审给出，已采纳）：① 本合并线是 **10 个提交**不是 11（此前把合并的第二父 `57208559` 误计）；② `3337` 这个旧口径数字**当时无法核实**（原始 stdout 日志在临时目录），随后已把决定性的两行固化进 `exp/junit-tally-false-green/README.md`；③ `109.85 / 218.71` 是单次读数、每次小幅浮动，**不得当可复现常量引用**。

**Task 9 的完成判定不由本节给出**——本节只记录合并与门禁这条线已闭合。Task 9 自身的验收仍以其冻结架构与既有验收评审为准；Task 10 未推进。

### 本轮新增的已作废路子

- 不把 shard crash 当作「环境抖动」放过：本次的 crash 底下确实压着一条真失败，而 stdout tally 正好把它盖住。判据必须取自 junit，不取自被截断的 stdout。
- 不靠减小 CAS 测试的负载来规避超时：那会同时削弱字节比的鉴别力，而问题根本不在负载。
- 不把「改用更可靠的证据源」当成问题终结：换源只把盲区挪走（stdout 截断 → junit 不写行），必须重新问一遍新源在什么情况下**一行都不写**。
- 不把阈值取整：`≥10` 看起来安全，实测故障值是 9.51 / 10.79 —— 一侧只差 0.49，另一侧全无鉴别力。阈值要按**正常值与故障值两端**标定。

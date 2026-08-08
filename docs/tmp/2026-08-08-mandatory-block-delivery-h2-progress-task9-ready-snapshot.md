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

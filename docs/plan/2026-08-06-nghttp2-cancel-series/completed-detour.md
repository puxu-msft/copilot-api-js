# NGHTTP2_CANCEL 系列：已完成偏航成果核账

> 核账日期：2026-08-06。目标仓库：`/home/xp/src/copilot-api-js`。Git 真相锚：`master=fa2bfd2d902af444517b2fed1a44428c8bb47367`。本报告只核已提交成果，不把文档中的通过声称自动升级为本轮亲自复跑；仓库无 `.codegraph/`，故使用 `git log/show/blame`、`rg` 与逐文件源码核对。

## 直接结论

“NGHTTP2_CANCEL 分析与修复”期间确有一条已落 `master` 的 History 偏航主线：A1 建立并回填窄 summary projection，A2 把 status/list/session/stats 与 session detail selection 从 canonical 大 BLOB 扫描切到 SQL／窄投影，A3 把持久 `search` 切到严格 Tantivy `list-search`。A3 同一提交还做了 telemetry join、ui-v4 path alias、History 依赖边界／SCC 配套。它们解决的是本地 History read-path 阻塞、公开查询契约假实现与配套编译／依赖问题；没有完成 H2 canonical diagnostics，也没有归因或修复 `NGHTTP2_CANCEL`。

## HANDOVER 可直接复用的语义单元表

| 单元 | `master` 可达 commits | 已落行为／主要文件 | 已核验证据 | 解决的问题 | 明确未解决 |
|---|---|---|---|---|---|
| A0 调查／计划冻结 | `b6fb0947` | 新增 `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md`；把约 6.3 万行、约 2.8GB 读取、26.54s event-loop freeze 与 23 条 `NGHTTP2_CANCEL` 记录为调查快照，并拆 A1–A5／Phase B。 | `master` 祖先检查通过；计划 `:17-19` 明确性能放大器与分阶段目标。 | 把“本地 History 扫描放大器”和“H2 CANCEL 根因”拆开，避免把调参冒充修复。 | 只是计划；没有 H2 诊断或 CANCEL 因果结论。 |
| A1.1 summary projection schema／compat bridge | `92fcc611` | `src/lib/history/v3/summary-store.ts`、`src/lib/history/sqlite/migrations/{index,run}.ts`；迁移 `001-operation-summary-projection` 创建 `v3_operation_summaries`、索引与 insert／summary-update／pin-update triggers。 | 源码：`src/lib/history/sqlite/migrations/index.ts:62-64`，`src/lib/history/v3/summary-schema.ts:17-90`；测试：`tests/history/v3/summary-projection-migration.it.test.ts:76-121` 验 insert、pin、delete 同库投影。 | 为 list/session/stats 建立不含 `manifest_gz` 的窄读面，同时允许旧 writer 继续写旧列。 | 未做停服 002、跨进程独占 writer、旧列删除与最终单写。 |
| A1.2 bounded backfill／ready gate／状态可见性 | `a8a9475c`，后续 `77cc765f`、`fa2bfd2d` | `src/lib/history/v3/{store,summary-store}.ts`；后台修复历史 projection，pending／poisoned 可见；readiness 整体验证只在 drain 后做一次；backfill 从重复头扫改为 `(created_at,operation_id)` keyset。 | 源码：`summary-store.ts:448-575`、`store.ts:1083-1146`；测试：`summary-projection-migration.it.test.ts:124-225`，尤其 `:145-188` 验 readiness 单次检查与索引 keyset。 | 修复 A1 初版每 batch 全量 readiness scan 与反复从头找缺行，避免迁移自身成为新的主线程 O(n²)／大表放大器。 | 仍会 hydrate `summary_json IS NULL` 的 canonical manifest；未做真实约 6.3 万行副本 dry-run／WAL、磁盘峰值与 max-gap 验收。 |
| A2.1 status 专用 count | `8afd3c26` | `/api/status` 改用 `countV3Operations()` 对 `v3_operations` 专用 `COUNT(*)`，不再经 summary list／manifest scan；projection readiness／pending／poisoned 同时进 status memory。 | `src/routes/status/route.ts:128-136,254-259`；`tests/history/v3/summary-query-performance.it.test.ts:128-162` 把 status 与 256KiB×512 manifest 反样本对照。 | 去掉 3s health poll 触发全库宽行扫描的确定性放大器。 | 不证明 4141 实例 wall time；未改 H2。 |
| A2.2 typed SQL list／双向 keyset／filter-cursor | `7140d160`、`29d58b77`、`0db2592d` | `summary-store.ts::querySummaryPage`；`queries.ts` 合并 persisted／recent／in-flight；cursor 必须满足当前 filter；overlay 与 SQL filter 对齐。 | `src/lib/history/v3/summary-store.ts:40-150`、`src/lib/history/queries.ts:88-252`；`tests/history/v3/summary-query.it.test.ts`、`tests/history/history-api.it.test.ts` 为提交内直接测试证据。 | `direction` 从公开但未真正持久执行的假契约变为双向稳定 keyset；避免分页、filter 与 in-flight 语义漂移。 | `search` 当时仍未闭合，后由 A3 解决。 |
| A2.3 sessions／stats SQL 聚合与窄 hydrate | `1cdd8160`、`29b05f34`、`2ac33963` | sessions 与 stats 从 ready projection SQL 聚合；session detail 先取窄表 IDs，再只 hydrate 选中 canonical entries。 | `src/lib/history/sessions.ts:26-35,145-153`；`src/lib/history/stats.ts:84-153`；`summary-store.ts:201-443`。 | 消除 JS 全量持有／遍历 summary 与 session 页全量 detail hydrate。 | ready marker 前仍保留 legacy fallback；002 未完成。 |
| A2.4 性能护栏 | `70b7f1c0` | 新增 `summary-query-performance.it.test.ts`，比较小／大 manifest 下 list、sessions、stats、status 行为与 elapsed／event-loop gap，并显式执行 canonical manifest 全扫反样本。 | 测试常量 `ROW_COUNT=512`、`LARGE_MANIFEST_BYTES=256*1024` 在 `:31-32`；断言 `:150-162`。计划记录合并态 `108 pass / 1 skip / 0 fail`、typecheck 与定向 lint，但本轮未复跑，故只记为文档证据。 | 给“读路径与约 128MiB manifest 解耦”一个自动 guard，并证明反样本确实读到 BLOB。 | 不等价于生产 6.3 万行、冷缓存、WAL 或真实 HTTP max-gap。 |
| A2.5 recent durability | `ea6bd957`、`50941d32` | recent terminal overlay 暴露 `durability: pending|failed`；conflict 结果不被持久化失败覆盖。 | `src/lib/history/queries.ts:71-84`、`src/lib/history/v3/store.ts:937-978`；`tests/history/v3/durability-overlay.it.test.ts`、`persist-guard-wiring.it.test.ts`。 | recent 记录不再静默冒充已落盘；冲突与 SQLite persistence failure 保持两类结果。 | 不提升持久化成功率，不处理 CANCEL。 |
| A2 live-doc cutover | `0a84bbb3` | 同步 `docs/{history,API,DESIGN}.md` 与 schema；同时修正 pin／V2 reaper／scoped-delete 陈旧说明。 | 当前 `docs/history.md:77,106,114`、`docs/API.md:125`、`docs/DESIGN.md:170` 与代码路径相符。 | 让 live docs 反映 ready-marker 后窄读与真实删除面。 | 该 commit 名为 `docs(history)`，但包含 3 个生产源码注释／类型注释修改，成果核账不能把它当纯文档提交。 |
| A3 strict persisted list-search | `08046d5c`，文档 `c23ed804` | native Tantivy／daemon／UDS 新增 `list-search`：完整全文＋结构 filters、精确 total、`(startedAt,id)` 双向 keyset；主进程冻结 canonical freshness target，核同毫秒 boundary IDs 与 poison；只按返回 IDs 批量读 ready summaries；不可达／旧协议／lag／poison／stale reference → 503。 | 代码：`src/lib/history/queries.ts:326-427`、`handler.ts:67-77`、`search/protocol.ts:97-150`、`search/daemon.ts:508-554`、`native/history-search/src/lib.rs:255-447`。测试：`daemon.it.test.ts:148-279` 覆盖 exact total／filters／freshness／poison；`search-rest-cutover.it.test.ts:126-155` 有真 HTTP→UDS→Tantivy，但 `skipIf(!NATIVE)`，需先 build native 才实际执行。计划 `:10` 声称 backend、ui-v4 tests、typecheck、build、lint 与三项 mutation 通过，本轮未复跑。 | 修掉“持久 search 只靠 recent cache 假绿／preview LIKE 不等价全文”的契约缺口；不完整时 fail-loud，不返回假空集。 | 独立 reviewer／verifier 与真实约 6.3 万行副本验收仍缺；`/history/api/search` 兼容端点仍有其原有 partial 语义，严格 503 只指 entries list 的 `search=`。 |
| A3 配套：History SCC／依赖边界 | `08046d5c` | 新增 `core-types.ts` 承载窄 read types、`v3/summary-schema.ts` 承载 migration/runtime 共享字段图、`search/client-registry.ts` 持 UDS client；`summary-store` 不再 import 巨型 `history/types.ts`，query 不再从 lifecycle `state.ts` 取 client。 | diff 与源码：`core-types.ts:1-112`、`summary-schema.ts:17-90`、`client-registry.ts:1-18`；`docs/DESIGN.md:170` 明记目的。当前 SCC baseline 仍含 `queries.ts`、`state.ts`、`types.ts`，所以这是“避免把新边拉回／减依赖”，不是声称 core SCC 已消失。 | 让 A3 可接线而不新增 query→lifecycle 或 summary-store→rich types 环边。 | 没有更新 circular-deps baseline，也没有证明 SCC 数量下降；不得转述成“SCC 已解”。 |
| A3 配套：telemetry／UI | `08046d5c` | `ui-v4/src/lib/model-telemetry.ts` 新增 join-only `telemetryJoinKey`：去 route suffix，并把 dated dashed Claude alias 折回 catalog key；`ui-v4/tsconfig.json` 补 foundation state／error alias。 | `git blame` 锚定 `model-telemetry.ts:124-176` 全属该 commit；代码注释明确只修 telemetry join、不恢复已删除的全局 dated routing。仓库未找到专门 `model-telemetry` 测试；计划仅记录 ui-v4 tests／typecheck／build 已通过。 | 保住成功腿 canonical key 与失败腿客户端 alias 的 UI 汇合；使 ui-v4 后端 re-export 在 foundation state 搬迁后可解析。 | 没改 telemetry 持久存储／registry，也没有专门回归用例证明 dated alias join；这是 A3 配套修复，不是 CANCEL telemetry。 |
| 非 master 旁支测试成果 | `5c5a6dcb`、`b1327da2`，**master 不可达**，只在 `command-algebra-commit-minus-1` 等分支 | 把 in-flight summary memoization 的 `<50ms` 脆弱计时断言改成 traversal observer，并补 200×10 全遍历正样本。 | `git merge-base --is-ancestor <commit> master` 均 rc=1；patch 记录 mutation 将 2000 visits 放大到 2,000,000。 | 改善 summary memoization 测试判别力。 | 不是已落 master 成果，不应在 HANDOVER 中写成已交付。 |

## 文档漂移与边界

1. **已确认漂移：计划 A1 状态落后于 master。** `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md:8` 仍只列 `92fcc611`／`a8a9475c`，未计 `77cc765f` 的“仅 drain 后 readiness scan”与 `fa2bfd2d` 的 keyset backfill；后两者已在 `master`。A1 仍只能叫“部分完成”，但已完成面应扩充。
2. **已确认漂移：计划 A5 的“仍需全 backend”与同段“全 backend 已通过”互相矛盾。** `:12` 先称全 backend 已通过，后又说“仍需……CI 的 PTY/E2E 档位”；准确待办是 `test:ci` 的 PTY/E2E 与独立验收，不是 backend 本身。`docs/history.md`／`docs/API.md`／`docs/DESIGN.md` 已同步 A3 行为，未发现同类状态漂移。
3. **已确认漂移：History 类型 SSOT 说明过度绝对。** `docs/history.md:35,65` 仍称完整权威定义是 `src/lib/history/types.ts`；A3 已把 `QueryOptions`／`EntrySummary`／`SummaryResult` 等窄读类型定义移到 `src/lib/history/core-types.ts` 并由 `types.ts` re-export。若“HistoryEntry rich record”则 `types.ts` 仍对；若“全部 History 类型”则已不准确。`docs/DESIGN.md:170` 已正确记录 `core-types.ts`。
4. **已确认措辞冲突：V3 “无任何 backfill”不再是无条件真。** `docs/history.md:9` 与 `docs/DESIGN.md:170` 的 V2-removal 总述称 V3 无事后／增量 backfill，但当前 A1 明确运行 `startV3SummaryBackfill`。可成立的窄解释是“无 V2 业务语义 backfill 等价物”；按字面全称则与代码、同文 `docs/history.md:77` 的 bounded backfill 冲突。
5. **API 文档缺口。** `/api/status` 实际通过 `memory.summaryProjectionReady|Pending|Poisoned` 暴露 A1 状态（`src/routes/status/route.ts:254-259`）；`docs/history.md:77` 提到它，但 `docs/API.md` 的 `/api/status` 大表未明确列出这三个字段。不是行为错误，但 API SSOT 字段级备注未完全同步。
6. **验证口径限制。** 计划中的 test counts／mutation／build 是仓库文档声称，不是本核账会话亲自复跑；本轮独立复核的是 commit 可达性、patch、当前源码与测试断言。A3 native E2E 有 `skipIf(!NATIVE)`，只看到“测试存在”不能证明某次实际执行，计划声称已 build native 后通过但缺本轮命令输出。

## CANCEL 主线仍明确未完成

- A4 H2 canonical transport diagnostics 未开始：没有新增 stream／session／local-abort canonical 事件、稳定 session ref、RST／GOAWAY／PING ACK 时序、quiescence barrier 或 History 持久诊断。计划 `:11,141-176`。
- Phase B 未开始：没有把 23 条 `NGHTTP2_CANCEL` 分成 peer RST、session close／GOAWAY、local abort、event-loop starvation、clean EOF missing terminator，也没有固定负载的 PING enabled／disabled 因果实验。计划 `:13,185-215`。
- 因而没有证明 History 阻塞就是 CANCEL 根因；只确认它是本地确定性放大器。没有实现 generic CANCEL retry、fresh-session retry、PING cadence 调参或任何产品侧 CANCEL 缓解。自计划提交后，`master` 的 transport／transport-reason／transport tests 无相关提交。
- 仍缺真实生产库副本验收与运行态 4141 之外的隔离 HTTP max-gap；不得把 512×256KiB 自动 guard 外推为生产延迟结论。

## 实际搜索／核账命令

- `git log master --first-parent --reverse ... b6fb0947^..master`；`git log --all --grep='history|telemetry|summary|SQL|SCC|CANCEL|NGHTTP2|persisted|list-search'`。
- `git merge-base --is-ancestor <commit> master`；`git show --stat/--patch <commit>`；`git blame master -L 110,180 -- ui-v4/src/lib/model-telemetry.ts`。
- `git show master:<file> | nl -ba | rg ...`，覆盖计划、`docs/history.md`、`docs/API.md`、`docs/DESIGN.md` 及上述实现／测试文件。
- 未命中范围：自 `2026-08-06 09:00Z` 起 `master` 的 `src/lib/transport`、`src/lib/error/transport-reason.ts`、`src/lib/upstream-stream-diagnostics.ts`、`tests/transport` 无提交，支持“A4／CANCEL 产品修复未落地”。

## 结构怪味与调查方法反思

- `docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md:8`：状态账本漂移——后续 A1 修复已落 master 但状态表不知情；处置：本轮只标漂移，交主会话同步 live plan。
- `docs/history.md:9,77`：同文全称“V3 无 backfill”与 A1 bounded backfill 冲突；处置：本轮只核账，建议把前者限缩为“无 V2 业务语义 backfill 等价物”。
- `08046d5c` 同时承载 A3、SCC 边界、telemetry/UI alias：提交职责混合，核账时易把配套漏掉；处置：本报告按语义拆行，不建议回写历史。
- 更好的项目内替代调查法：以 plan A0–A5 为 ledger，再用 `git log --all` 找“计划后续修复”和旁支未合并成果；本轮已采用，优于只看 first-parent。
- 判据判别力：commit 可达性与当前源码是强判据；计划里的绿色测试只是二手证据，已明确降级。未运行测试是因为任务是只读核账且用户要既有验证证据，不是重新验收。
- 成熟第三方方案：本任务是 Git／源码事实核账，没有需要引入第三方库的实现边界；原生 `git merge-base/log/show/blame` 是权威来源。

## 证据分级与 TBD

- **本轮实测**：仅 Git 可达性、`master` 锚点、工作树只读状态、文件存在性与报告 hash；未访问／等待 4141，未重跑测试、build、benchmark 或真实数据库探针。
- **源码读证**：上表所有当前行为、文件／行号、A4 未落地及 transport 路径未命中，均由 `git show/log/blame/merge-base` 与当前 `master` 源码／测试断言复核。
- **文档证据**：`108 pass / 1 skip / 0 fail`、A3 backend／UI／build／mutation 全绿，以及 6.3 万行／2.8GB／26.54s／23 条 CANCEL 均是计划内既有记录，本轮没有独立复跑，禁止表述为本轮实测。
- **假设**：History stall 可能放大 CANCEL 只是一条待验证因果假设；当前证据只确认慢 read-path 存在并已重构，不能证明它导致或修复 CANCEL。
- **TBD**：A3 独立 reviewer／verifier、native suite 确认非 skip、`test:ci` PTY/E2E、真实约 6.3 万行副本与隔离 HTTP max-gap、A4 canonical diagnostics、Phase B 分型及 PING 对照实验。

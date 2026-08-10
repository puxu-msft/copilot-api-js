# A3 六条 finding 合并态复评 — 派活简报

**状态**：待派发。本文件是派活件，不是评审报告；评审报告写到 `docs/tmp/2026-08-08-a3-merged-state-review.md`。

**评审对象**：`master@9fad0bdf`（A3 六条 finding 的**合并态**）。六条的原始报告是 `docs/plan/2026-08-06-nghttp2-cancel-series/review-core-a3.md`（时点记录，不随修复改写，行号对应旧 commit，**不要拿它的行号去核当前代码**）。

**为什么需要这一轮**：六条 finding 分三个批次实现，每条各自有目标回归与 mutation 对照，但**从未有一次独立复评覆盖它们的合并态**。按 `review-merged-state`，逐项审过 ≠ 合并态审过——集成缝只在合并态可见。这是 A3 关闭前唯一未闭合的 gate（见 HANDOVER §A.2）。

## 判据轴（务必按此，不要按默认价值观）

- 判断标准是**长远正确 + 完整**，**不是** ROI / YAGNI / 改动量最小。不得以「成本高」「范围大」「当前没出问题」为由建议砍功能或降级修复。可以质疑做法，不要质疑要不要做。
- 本项目**无向后兼容负担**：破坏性改动若是长远正确的形状，是可接受的。
- 事实权威：**最终代码**是实现事实；冻结 spec `docs/spec/2026-07-28-history-filter-semantics.md` 是行为 oracle；用户裁决 > 代码现状。
- **双向检查**：既查「错误状态能否通过」（false-green），也查「正确状态会不会被误拒」（false-red）。只查一个方向的评审在本项目已经出过事。

## 可核验的当前状态断言（逐条回应，给 `file:line` 或命令输出）

C1. `freezeHistorySearchTarget`（定义 `src/lib/history/v3/summary-store.ts:102`，唯一调用点 `src/lib/history/queries.ts:380`）是 strict list-search 归属与目标的**单一快照来源**；`await` 两侧不存在第二次取快照，因此不会出现 `entries.length=1,total=0` 这类 entries 与 total 不一致。

C2. `lifecycleStatesForQuery`（`src/lib/history/lifecycle-state.ts:90`）是 `state ∧ success` 的**唯一判定源**，且冲突谓词返回**空集**（匹配不到任何记录）而不是 `undefined`（无过滤）。这个区别是承重的：sidecar wire 上空 `states` 表示「所有状态」，把冲突退化成 `undefined` 会把「应为空」变成「返回全部」。请核所有消费者是否都经由它：`queries.ts`、`v3/summary-store.ts`、`v3/projection.ts`、`stats.ts`。

C3. `rejectsInvalidListQuery`（`src/routes/history/handler.ts:72`，接线于 `:111`）对枚举外取值、非安全整数/负数、`limit` 越界、`from > to` 统一返回 400。**作用域按用户 2026-08-08 裁决只限 `/api/entries`**；`/api/search` 保持既有「不支持的 facet 降级为空结果 200」宽松契约。请确认这条作用域边界没有被无意扩大到 `/api/search`。

C4. tail cursor 绑定 index generation：cursor 记录 `indexOpstamp`（`src/lib/history/search/daemon.ts:146`），`validateCursorAgainstIndex`（`:356`）在 `tailOnce`（`:441`）与 `listSearch`（`:577`）之前比对，不匹配（含旧的无 opstamp cursor）即弃用并重新 tail；`flush` 发布时写入当前 opstamp（`:562`）。

C5. native `list_search_blocking`（`native/history-search/src/lib.rs:480`）改写后，**五项冻结契约逐条不变**：精确 `total`、`(created_at desc, operation_id desc)` 顺序、keyset 语义、`hasOlder`/`hasNewer`、`invalidCursor`。

C6. 等值过滤被同时（a）下推进 `BooleanQuery` 收窄 docset 与（b）在列式 fast field 上逐文档求值，且**下推只允许比逐文档过滤更松**（空字符串不下推）。请构造反例检验这条不变量是否真的成立——若某个下推子句比逐文档过滤更严，结果集会静默变小。

C7. `alive_bitset` 分支（`native/history-search/src/lib.rs:567`）被标注为「实测不可达、因而无测试覆盖，但保留」。请判断这个处置是否恰当：探针结论是 tantivy 0.26.1 在本项目写法（`delete_term` + `add_document` 后 commit）下 commit 时即物化删除、存活 segment 均为 `deletes: null`（复跑 `bun run exp/history-search-list-perf/supersede-probe.ts`）。**这是一条自评的处置，正是需要未卷入方裁决的那类。**

C8. `FORMAT_MARKER` v3→v4 使既有索引走 `assert_identity` 的 wipe-and-rebuild 自愈；tail cursor 文件位于索引目录内（`cursorPath`，`src/lib/history/search/daemon.ts:151`），因此一并被清除，不会有陈旧 cursor 在重建后幸存。

## 除清单外还要做的事

1. **找 finding 之间的集成缝**：六条分别改了 queries 层、lifecycle 判定、HTTP 校验层、sidecar cursor、native 读路径。请第一人称走一遍完整请求路径（HTTP → queries → sidecar wire → native），点名每条路径上各修复的交接点，找「每条单看都对、合起来漏一类」的缝。
2. **找 false-red**：正确输入会不会被新校验误拒？合法但少见的 query（空字符串、`limit=1`、`from == to`、cursor 恰在边界）走一遍。
3. **性能主张的判别力**：`exp/history-search-list-perf/README.md` 的数字与「它没有证明什么」是否诚实、是否有被数字掩盖的劣化场景（尤其多 segment、删除密集、真实语料形态）。

## 分段要求

本轮**只报 blocker 与 major**，最多 6 条、每条不超过 6 行；**先写报告文件再回话**，回话只给结论行 + 文件路径，不要复述正文。只剩 minor 就直说可以收口，不要在没有 major 的情况下拖着。

## 只读纪律

仓库只读——不要修改/新建/删除仓库内任何文件（报告文件除外），不要 `git add`/`commit`/`checkout`/`stash`。native 产物已构建；需要实跑时用 `bun test tests/history/search/`、`bun test tests/history/history-api.it.test.ts`，或 `exp/history-search-list-perf/` 下的探针。

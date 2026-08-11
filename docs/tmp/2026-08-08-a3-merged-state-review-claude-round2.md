# A3 合并态复评 round 2 — Claude 侧报告（转录件）

**这是转录件**：该 reviewer（`reviewer`，Claude 驱动）工具集里没有 `Write`，报告经回话正文返回，由主会话逐字转录。我自己的复核结论不写在这里，在 `2026-08-08-a3-merged-state-review-dispositions.md`。

**verdict**：无 blocker；3 条 major。它自报的三条 round-1 发现中 **2 条完全闭合、1 条部分闭合**（native 层闭合，HTTP 层无证据）。

**双视角覆盖**（它自述）：机械核对＝逐条 diff 六个 commit、`rg` 全仓查 `invalid-query`／`InvalidSearchQueryError` 在 `tests/` 的命中（零）、跑 `bun test tests/history/search/daemon.it.test.ts`（20 pass／0 fail／6.21s，并读其覆盖率未覆盖行）；第一人称执行＝对重建后的 native 产物跑三组探针（错误码分类、空串过滤正负对照、tokenize vs substring），并沿 native→daemon→uds→handler 走了 400／503 两条分支。

---

## 事实性发现

**[major] `src/lib/history/search/daemon.ts:166`** — `code === "InvalidArg"` 判据过宽，napi 用同一个码报「字段缺失/类型不符」，基础设施故障被误报成客户端错误（false-green）

- 证据（实跑，当前重建产物）：`listSearch({...base, limit: undefined})` → `code="InvalidArg" Missing field \`limit\``；`direction: undefined`、`operationKinds: undefined` 同样是 `InvalidArg`。语法错误 `foo:` 也是 `InvalidArg`——两者无法区分。
- 失败场景：主进程与 sidecar 版本漂移（旧客户端发的 list-search 帧少一个字段），或 daemon 侧字段映射写错，现在返回 400「Unsupported search query: Missing field \`limit\`」，而不是设计里的 503——「不完整就 fail-loud」的契约被一个假 400 绕过，ui-v4 也不会按不可用降级。
- 修复建议：不要从 napi `Status` 反推语义。native 已有 `ListSearchResult.invalid_cursor: bool` 这个现成范式，把 parse 失败同样降为**返回值**（`invalid_query: bool`），其余一律仍是 throw；daemon 只对该字段贴 `invalid-query` 线码。

**[major] `src/lib/history/queries.ts:507` + `:420-425` 注释** — 「entries 有行而 total 不计」这个形态并未被排除，且现在可**确定性**复现（不再需要竞态）

- 证据（实跑）：索引内容 `hello world`，`query="orld"` → tantivy `total=0`，而 JS 子串判定为 `true`（`:189` `corpusMatchesSearch`）。另一半：`overlayPersistedAtFreeze`（`:426`）走 `hasPersistedSummaryMatching` → `compileSummaryWhere`（`summary-store.ts:40-88`）**完全不含 search 项**。
- 失败场景：一条已落盘且已被索引的 recent 记录，overlay 按子串命中（进 `visible`／`entries`），sidecar 按分词不命中（不进 `persistedTotal`），又因「已落盘」被排除出 `transientCount` → `?search=orld&terminalOnly=true` 返回 `entries.length=1, total=0`。`:420` 那段新注释写着本次修复「rule out」了这个形态，该断言不成立。
- 说明（不夸大）：形态本身**先于本批次存在**，但 fix #3 把 recent 的语料扩到 request+response，使「只出现在回答里的子串」成为新的触发面，而新注释把它声明成了已消除。
- 修复建议：归属判据应是「persisted 一路会不会计它」，而不是「它是否已落盘」——三选一：overlay 对已落盘行改用与索引同源的分词判定；或把 overlay 的 id 交 sidecar 做一次成员判定；或把「已落盘却未被 sidecar 返回」的行同时移出 `visible`，让 entries 与 total 至少自洽。

**[major] `tests/` 全域** — 三条行为修复零回归测试，唯一新增测试是给另一位 reviewer 的 tombstone 那条；400/503 这条最需要端到端的链路恰恰完全未执行

- 证据：`rg 'invalid-query|InvalidSearchQueryError'` 在 `tests/` 零命中；本批次改到的测试文件只有 `tests/history/search/daemon.it.test.ts`（diffstat 唯一 test 条目）。跑该文件覆盖率输出把 `src/lib/history/search/daemon.ts` 的 **165-169** 列为未覆盖行——正是 `listSearchOrInvalidQuery` 的整个 catch 分支。
- 失败场景：400↔503 的映射跨 native→daemon→uds-server→handler 四个模块，任一环退化（native 改回 GenericFailure、uds-server 漏转码、handler 漏 catch 分支）都不会有任何测试变红；空串与 recent 语料两条同理。
- 修复建议：补三条最小断言即可，不必扩面——① `search-rest-cutover.it.test.ts` 里真 HTTP 打 `?search=foo:` 断言 400、打 sidecar 不可达断言 503（正负对照同时钉住第一条想区分的两侧）；② daemon 层 `?endpoint=` 与 `endpoint=不存在值` 的正负对照；③ recent 记录仅回答命中的一条 `recentMatchesSearch` 回归。

## 它对自己 round-1 三条的闭合判定

- **解析错误 503 → 部分闭合。** 可复跑：`listSearch({query:"foo:"})` → `code="InvalidArg"`（已跑）；`-`／`(x`／未闭合引号同形。**但没有任何命令能证明 HTTP 真返回 400**，且判据过宽（见上一条）。
- **空串 `endpoint=` → 闭合。** 可复跑正负对照（已跑）：`endpoint:""` → `total=1`（修前 0），`endpoint:"nope"` → `total=0`（负控未被放松）；`states:[""]` → 1、`states:["failed",""]` → 0，说明混合列表里空串被丢弃、真实值仍然生效。
- **两套 search 定义 → 它报的两个症状闭合。** `recentMatchesSearch` 已是 `queries.ts:225／281／412` 三处唯一入口，`resolveSummaryCursor` 与合并页用同一函数、同一份语料，**两条分页路径一致**。残差（子串 vs 分词）被显式保留并写进注释，但它的**第二个后果**没有被记下来——就是上面第二条。

其余只剩 minor（如 `recentMatchesSearch` 在 `needle === undefined` 时仍会先求值 `projectSearchableText`），不构成收口障碍。

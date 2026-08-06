# 待办：让列表端点的 `search` 真正生效（扩展 Tantivy sidecar）

> **归档状态：已完成。** 本文保留 2026-07-28 拆出的原始缺口与方案比较；实现已由 [`docs/plan/2026-08-06-history-read-path-and-h2-diagnostics.md` A3](../../plan/2026-08-06-history-read-path-and-h2-diagnostics.md#a3-修复持久全文-search-契约) 落地，当前契约见 [`docs/API.md`](../../API.md) 的 `/history/api/entries` 行。

- 原状态：backlog，独立立项，未排期
- 日期：2026-07-28
- 来源：[Spec B：History 过滤语义收敛](../../spec/2026-07-28-history-filter-semantics.md) §6-1 的裁决把此项拆出

## 根因

`GET /history/api/entries` 接受 `search` 参数（`routes/history/handler.ts:20-44` 的 `parseListFilters` 会解析它），但 **persisted 一路从不过滤它**。

`queries.ts:84-88` 的注释写着「persisted list path filters `search` in SQL (`preview_text LIKE`)」——该注释指向的是**已退役的 V2 SQL 路径**。当前 persisted 路径是 `visitV3Summaries`，SQL 里没有任何 LIKE。

于是现状是最糟的形态：带 `search` 的请求返回**未经过滤的全部 persisted 结果**，冒充搜索命中。

## 当前行为（Spec B 落地后）

Spec B §6-1 已把它改成诚实的降级：

- 带 `search` 时 **persisted 一路返回空集**，`total` 只计 in-flight 侧匹配数
- in-flight 一路仍按 `extractInboundSearchText` 全文匹配
- 响应带可识别标记，说明 persisted 全文搜索请改用 `/history/api/search`
- 陈旧注释删除

即：参数保留、形状不变、不再误导，但**列表端点上的历史全文搜索确实不可用**。

## 为何不能简单转发给现有 sidecar

评审实测确认，现有 Tantivy sidecar 的能力撑不起列表端点的契约：

| 列表端点需要 | sidecar 现状 |
|---|---|
| stable keyset 游标 | 只有 `TopDocs::with_limit(limit).order_by_score()`，BM25 分数不是可持久化的单调键 |
| exact total | 无 |
| 列表 filters（endpoint / session / agent / pid / from / to） | UDS query 只有 `queryText, operationKind, limit`（`uds-client.ts:132-145`） |
| 双向分页 | 无（`search.ts:20-24` 明确无 pagination） |
| 区分「零结果」与「sidecar 不可达」 | 不能——空 hits 一律返回 `partial: true`（`search.ts:59-73`） |
| 与列表一致的排序域 | 不同：`SearchResult` 按 score，`SummaryResult` 按 `startedAt` |

## 理想架构（若做）

两条路线，二选一：

- **扩展 sidecar wire 与 index**：支持完整 filters、稳定排序键与 keyset、exact total、显式 availability（区分空结果与不可达）。改动集中在 sidecar 侧，但 wire 协议与索引 schema 都要动。
- **让 sidecar 只回 ID 集合**：返回完整匹配的 operation ID 流或 bitmap，交由 SQLite 做排序、与其它 filter 求交、以及 `COUNT`。sidecar 侧改动小，但要处理大结果集的传输与内存，且与 [待办 C](../../todo/history-filtered-exact-total.md) 的 bitmap 方案天然契合——**若 C 采用 bitmap 形状，这条路线可复用同一套基础设施**。

## 若做需改什么

- sidecar UDS 协议（`search/protocol.ts`、`uds-client.ts`）与 daemon 查询实现（`search/daemon.ts`）
- `persistedSummaryCandidates` 增加「search 命中集合」与 SQL 谓词求交的路径
- `SummaryResult` 的 availability 语义：sidecar 不可达时是报错还是降级返回 partial，须与 Spec B §6-1 的标记字段统一
- 两个 UI 的搜索框行为（`ui/` 的 Activity 页搜索框、ui-v4 对应组件）
- 与 Spec B 的 `search` 降级标记的迁移：从「persisted 返回空」切换回「真正过滤」时，标记应消失

## 启动时机

- ui-v4 增强需要在列表视图内做历史全文检索（而非跳转到专用搜索页）
- 或 [待办 C](history-filtered-exact-total.md) 采用 bitmap 形状、可顺带复用其基础设施时

# History strict list-search：recent／persisted overlay 来源边界

- 状态：待验证假设，第二批迭代候选
- 发现基线：`master@c23ed804`，2026-08-06
- 第一批关系：strict persisted list-search 已合入；本项不阻塞该批恢复历史全文列表功能

## 待验证问题

`getHistorySummariesAsync()` 将 in-flight、recent terminal 与 sidecar 返回的 persisted IDs 合并。recent terminal 持久成功后，其 durability 标记被清除，但 record 仍留在 recent cache；当前 async facade 仍用本地 `inFlightMatchesSearch(recordToHistoryEntry(...))` 把它加入 overlay。

sidecar 的 Tantivy query 语义与本地 substring 语义不完全相同。若一个已持久 recent record 被本地规则判命中、却未出现在 sidecar 的严格 persisted ID 集中，它可能作为 overlay 泄入结果，并让 `entries` 与 sidecar `total` 失配。

这只是源码路径推导，尚未运行目标复现；不得在复现前将其写成已确认缺陷。

## 最小复现与验收

1. 通过生产 terminal bus 发布一个 record，使它进入 recent cache。
2. 排空 subscriber／V3 writer，确认 record 已持久且 `getRecentModelOperationDurability(id) === undefined`，但 recent cache 仍持有该 record。
3. 标记 summary projection ready；注入 strict sidecar client，使 `listSearch()` 返回覆盖冻结 target 的空 `operationIds`、`total: 0`。
4. 选择一个本地 substring 会命中、Tantivy token query 不命中的 query 形状，调用 `getHistorySummariesAsync({search})`。

正确结果：该已持久 recent record 不得绕过 sidecar ID 集；`entries=[]` 且 `total=0`。pending／failed recent 和真正 in-flight 仍按 rich in-memory text 作为 transient overlay 可见。

证伪方式：若上述生产接线复现仍返回空，说明当前 dedup／过滤已有另一机制承担性质，应撤回该假设并记录实际机制。

## 修复候选

优先在 recent cache 的来源身份层修：只把 `durability === "pending" | "failed"` 的 recent record 当 transient overlay；已持久 recent 由 sidecar persisted ID 集单一决定。请求开始时冻结 transient ID 集，避免 sidecar await 期间持久化状态变化导致 total／entries 读不同快照。

不要通过扩大 sidecar返回集合、把 query 降级成 substring，或在 merge 后重新查询 DB 来掩盖来源身份问题。

## 判别力正控

实现后注入 mutation：恢复“所有 recent records 无条件进入 overlay”。目标测试必须因已持久 recent 泄入或 `entries.length > total` 精确转红；恢复实现后回绿。另保留 pending／failed recent 正样本，防修复过严而误删真正 transient overlay。

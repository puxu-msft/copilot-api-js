# A3 合并态独立复评 round 3

- **评审范围**：`008e1a31..13ceb91d8d77825db770a716136107df9ef6bf9f`，重点检查新 ownership、计数、分页与 durability。
- **已读取／执行的证据**：读取处置表、全部 round-3 diff 与最终代码；实跑 ownership＋native 36 pass／0 fail；另用同步注入探针把 commit 精确放在 target 读取与 ownership 读取之间。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。另有 1 条 major。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/lib/history/queries.ts:419-448` — `target` 与 `indexOwnedOverlayIds` 仍不是同一 SQLite 快照，新 ownership 会 false-red 丢掉窗口内落盘的正确 overlay 行。
证据／失败场景：419 先读 target，443–447 随后逐行重新读 live DB；探针在 `SELECT MAX(committed_at)` 返回后提交 recent `race-recent`，ownership 将它移出 overlay，而 frozen target／sidecar 均看不到它，实跑得到 `{"injected":true,"ids":[],"total":0}`，原本匹配的行消失。
结构怪味：split snapshot／同一归属判据分两次 live read；处置：本轮修，不能只补测试。
修复建议：在一个 SQLite read transaction／versioned snapshot 内同时冻结 target 与 overlay ownership，或让冻结结果直接携带可判定 ownership 的 frontier；补 commit-before／between／after 三时点正负控，并覆盖 terminalOnly 与双向 cursor。

## 其余重点结论

- ownership 选择本身成立：对 frozen target 内、sidecar 已可见的行由 sidecar独家裁决，避免在 JS 重实现 Tantivy 分词；已落盘但分页窗口外的匹配行由 exact total 与 `hasOlder/hasNewer` 表达，不应靠 overlay 回填。
- `transientCount` 在 ownership 真正同快照的前提下成立；`target===null` 时 persisted ownership 应为空，sidecar ID 缺少 ready summary 时 `getPersistedSummariesByIds` 会抛并映射 503，不会伪造自洽页面。
- `durability` 只由 recent overlay 添加（`queries.ts:94-95`），index-owned 后确实不再出现在 hydrated summary；但正常 persisted outcome 会同步清掉 pending，未找到产品消费者或可持续的 `failed + persisted` 状态，故不升 major。
- `hasOlder/hasNewer`、next/prev cursor、terminalOnly 与双向分页未发现其他 blocker／major；现有 round-3 测试未覆盖上述两次读取之间的窗口，所以 36 pass 不否定该反例。

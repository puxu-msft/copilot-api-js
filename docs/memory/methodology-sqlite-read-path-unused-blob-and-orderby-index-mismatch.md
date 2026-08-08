---
name: methodology-sqlite-read-path-unused-blob-and-orderby-index-mismatch
description: "端点慢先看 SQL 层两个高频结构缺陷：SELECT 带着从不使用的大 BLOB 列（I/O 放大）+ ORDER BY 末项不在索引里导致每页重建 temp B-tree（被 LIMIT/OFFSET 翻页放大 N 倍）；EXPLAIN QUERY PLAN 的 temp B-tree 是负载无关的结构证据；修法必须扩索引而非砍 ORDER BY 末项"
metadata:
  type: project
---

History 端点慢（`/history/api/sessions` 57s、`/history/api/entries?limit=1` 4s，而 `/health` 7ms）时，**先查 SQL 层这两个结构缺陷，再谈缓存/物化/架构改造**。两者都能用只读探针在生产库上定量，且与并发写争用无关。

**缺陷一：`SELECT` 带着从不使用的大 BLOB 列。** `visitV3Summaries`（`v3/store.ts:1008-1016`）两条 SQL 都无条件 `SELECT manifest_gz`，但 `summaryFromRow`（同文件 `983-996`）的快路径 `if (row.summary_json) return JSON.parse(...)` 根本不碰它——`manifest_gz` 只在 `summary_json IS NULL` 走 `hydrateManifest` 时才用。实测生产库该分支占比 **0%**（`summary_json IS NULL` = 0 行、`v3_summary_backlog` = 0）。量级：`summary_json` 均 790 B vs `manifest_gz` 均 60,717 B（最大 6.6 MB）→ 全扫白读 **1.8 GB** 只为拼出 25 MB，**77× I/O 放大**。

**缺陷二：ORDER BY 末项不在索引里 + `LIMIT/OFFSET` 叠加。** 索引 `(kind, created_at DESC)` 对查询 `WHERE kind=? ORDER BY created_at DESC, operation_id DESC` 只覆盖到 `created_at`；`EXPLAIN QUERY PLAN` 直接说出来：

```
SEARCH v3_operations USING INDEX idx_v3_operations_kind (kind=?)
USE TEMP B-TREE FOR LAST TERM OF ORDER BY
```

**机制要读准（我第一次读错了）：** "LAST TERM" 意味着 **block sort / partial sort**——前导列的序由索引提供，只有末项在同值块内排序（bytecode 形态 `Compare → Jump → ResetSorter → Sort`）。**不要读成"每页把全部匹配行整体重排"**：本案生产库 `created_at` 31403 行 / 31403 个不同值、**零并列**，每块只有 1 行，排序本身平凡。

**真正的放大链是 OFFSET + 回表：** `LIMIT ? OFFSET ?` 使第 k 页重新走过前 k×256 行（聚合 O(N²)）；索引缺末项使 SQLite 无法只靠索引满足 ORDER BY，于是**连将被跳过的行也要回表读 sort key**，且在当前 SELECT shape 下把这些行的大 BLOB 一并放进 ephemeral record——两个缺陷在此相乘。扩索引后被跳过的前缀可全程走索引，只有输出行才回表。**推论：keyset 分页不是"以后再说"的优化，而是同一根因的彻底解。**

**实测修复（生产库全表扫描，非外推）：** 现状 **73.0s**（峰值 RSS 1014 MB）→ 仅去 `manifest_gz` **12.2s** → 再消除临时 B-tree **0.53s**，合计 **≈138×**。两项贡献可分离。对照：单条聚合 SQL 全表扫仅 190ms，说明修复后剩余成本是 OFFSET 翻页 + 逐行对象转换 + 31k 次 `JSON.parse`。

**扩索引修法已在合成库证明**（31,780 行、复制生产库真实分布、**保持正确的双列 ORDER BY 不变**）：现有索引 `(kind, created_at DESC)` → temp B-tree、2.36s；扩展为 `(kind, created_at DESC, operation_id DESC)` → 计划变干净 `SEARCH ... USING INDEX`、**0.20s**。

**外推陷阱（我在本案踩了）：** 初版从最新 20 页线性外推得"34×（9.2s→0.3s）"，与全表实测的 138× 差 4 倍。两个原因叠加：① **均值偏倚**——最新页 manifest 均 25 KB，全表均 60.7 KB；② **非线性成本**——`LIMIT/OFFSET` 的翻页开销随 offset 增长，线性外推吃不到。**分页样本外推必须同时防这两条，能跑全表就别外推。**

**修法陷阱（承重）：** 消除 temp B-tree 有两条路，只有一条对。
- ❌ 砍掉 `ORDER BY` 末项 `operation_id`——探针里为验证机制可以这么做，但**上线不行**：破坏同 `created_at` 行的 tie-break 确定性，在 `LIMIT/OFFSET` 翻页下并列行跨页顺序不稳 → **静默丢行/重复**，与 [[methodology-append-log-tail-cursor-silent-loss-traps]] 同型。
- ✅ 扩索引为 `(kind, created_at DESC, operation_id DESC)`——保留确定序 + 索引全覆盖 ORDER BY。

**How to apply:**
- 端点慢先用 `/health` 做基线隔离「进程/事件循环慢」与「该查询慢」；再对慢端点做 `EXPLAIN QUERY PLAN`。**`USE TEMP B-TREE` 是负载无关的结构证据**，比计时更可信（计时受 page cache 与并发写影响）。
- 判断某列是否白读：找到消费该行的函数，看它在**实际命中的分支**里用不用这列；再用只读探针数该分支占比（本例慢路径 0%）。别凭 schema 猜。
- 只读探针安全：`new Database(path, {readonly:true})` + 只跑 `SELECT`/`EXPLAIN`，WAL 下不阻塞写者。**绝不在生产库上 `CREATE INDEX`** 验证——那是写操作。索引修复效果可用「去掉不被索引覆盖的 ORDER BY 末项」间接验证机制（计划里 temp B-tree 消失即证），再据此推荐扩索引。
- A/B 计时两侧必须同条件同批运行；外推全表时注意分页样本的均值偏倚（本例前 20 页 manifest 均 25 KB，低于全表均值 60.7 KB，故外推是低估）。
- 相关：[[project-history-search-out-of-process]] 是同一读路径压力的另一侧；schema 权威见 skill `history-sqlite-schema`。

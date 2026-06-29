---
name: reference-bun-sqlite-get-null-and-trigger-changes
description: "REFERENCE：bun:sqlite 与 node:sqlite 的两个分歧——.get() 无匹配 bun 返 null/node 返 undefined（破 `!== undefined`），触发器写入被 bun 计入 .run().changes（破计数）；外加 external-content FTS5 的 COUNT 穿透与 'delete' 腐败陷阱"
metadata:
  node_type: memory
  type: reference
---

本项目 history 走 bun:sqlite（一等）/ node:sqlite（兼容）双驱动。三个非直觉陷阱，全部实测确认（exp/fts-audit/）：

**1. `.get()` 无匹配的哨兵值跨运行时分歧**：bun:sqlite 返回 **`null`**，node:sqlite 返回 **`undefined`**。于是 `prepare(...).get() !== undefined` 在 Bun 下对“无行”恒为 `true`（`null !== undefined`）——曾用它做 FTS 表存在性判定，导致 backfill 永不触发。**判存在一律用真值检查 `Boolean(row)` / `if (!row)`，绝不用 `=== undefined`/`!== undefined`**（项目 eslint `eqeqeq` 还禁 `!= null`）。codebase 既有代码多用 `row ? ... : undefined` 归一化或 `if (!row)`，是对的；strict undefined 比较是 outlier。

**2. 触发器写入被 bun:sqlite 计入 `.run().changes`**：一条 UPDATE/DELETE 若触发 AFTER 触发器写别的表，bun 的 `.run().changes` 把触发器侧写入也算进去（实测 1 行真实 UPDATE + FTS 触发器 → changes=9/19；node:sqlite 只算 1）。`evictBucket` 早因 `ON DELETE CASCADE` 同理避开 `.changes`。**凡是带触发器/级联的表，行数用 `SELECT COUNT(*)` 单独数，别读 `.changes`**（`reclaimStaleActiveRows`/`reclaimOrphanedActiveRows` 已改 COUNT+UPDATE 同事务）。

**3. external-content FTS5 两个腐败/穿透陷阱**：
- `SELECT COUNT(*) FROM entries_fts`（external-content）**穿透读 content 表**（entries_v2），即使索引为空也返回内容行数——不能用它判索引是否已 build（否则升级时 backfill 被跳过、老数据搜不到）。判 build 用“表是否存在 + 一次性 'rebuild'”，gate 在表存在性而非行数。
- 对**从未 insert 过的内容**发 `'delete'` 会 `SQLITE_CORRUPT_VTAB`。AFTER INSERT/UPDATE/DELETE 三触发器必须严格配对（delete 用 old 值、insert 用 new 值），任何路径不得漏发 insert 就 delete。
- entries_v2 是 TEXT PK→隐式 rowid，full `VACUUM` 可能 renumber rowid，使 keyed-on-rowid 的 external-content 索引失配——故启动 VACUUM 后须 'rebuild'（incremental_vacuum 不 renumber，安全）。

trigram tokenizer 让 `MATCH '"子串"'` 等价 `LIKE '%子串%'`（≥3 字符，子串非 token），但**大小写折叠是全 Unicode**（LIKE 只折 ASCII）——非 ASCII 文本 FTS 是 LIKE 的超集，属改进非回归。

参见 [[methodology-sqlite-bloat-check-freelist-first]]、[[reference-bun-undici-hangs-use-node-http2]]、[[feedback-bun-first-dependency-selection]]。

# A3 合并态独立复评 round 4

- **评审范围**：`13ceb91d..17b33b67996e467d56f581510d0d2cda64754d25`，重点检查原子 freeze、overlay tokenizer 与 perf-flake 归因。
- **已读取／执行的证据**：读取处置与全部 diff；核对 Tantivy 0.26.1 `SimpleTokenizer` 源码；ownership 回归连续 25 次全绿；分别实跑 native 与 overlay CJK 探针。
- **总体 verdict**：**修复 major 后可进入下一阶段**。
- **blocker 数量**：0。另有 1 条 major。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/.worktree/nghttp2-cancel-5/src/lib/history/queries.ts:193-201` — ASCII-only 近似会 false-red 丢掉未索引的 CJK 多词查询。
证据／失败场景：Tantivy `SimpleTokenizer` 用 Unicode `char::is_alphanumeric` 切词；JS 却用 `/[^a-z0-9]+/`，`你好 世界` 被切成零个 terms，随后走 `haystack.includes("你好 世界")`。native 对 corpus `你好，世界` 返回 total=1，而同 corpus 的未落盘 recent overlay 实跑返回 `ids=[],total=0`。
修复建议：不要手写 ASCII tokenizer；至少改用 Unicode property escapes `/[^\p{L}\p{N}]+/u` 并用与 Tantivy 对照的表驱动测试覆盖 CJK、重音字母、数字、下划线、大小写。长期最佳是把 tokenizer 契约做成同源 primitive／native 查询能力。

## Round-3 finding 闭合判据

- **已闭合**：`tests/history/v3/search-target-ownership.it.test.ts:88-139` 用第二 SQLite 连接在 target query 后真实提交，并同时证明本次 freeze 不 disown、下一次 clean freeze 会 own；本轮 `--rerun-each 25` 为 25 pass／0 fail。去事务变红的 mutation 记录与目标机制一致。
- `db.transaction()` 只包同步的 MAX、boundary IDs 与至多 overlay-cache 规模的点查，没有跨 `await`；WAL 下读者不阻写者，持有期很短。本轮没有证据支持 SQLITE_BUSY／checkpoint 饥饿为 major，建议保留并发写探针作为回归。

## Perf-flake 归因裁决

- **结论成立，但范围应限定为“这些观测到的失败不是本轮 search 修复造成”**：红灯每次换 perf 文件、隔离复跑均绿、耗时随并发翻倍，且 round-4 diff 未触及两个 perf 测试；`getHistorySummariesAsync` 的新 transaction 只在 `options.search` 路径调用，所述 perf 用例走同步无-search 路径。
- 这不证明测试本身可以永久忽略；它仍是现有并发预算／全局负载 oracle 的 flake，应单独由 `perf-engineer` 用基线与分片负载重定预算，而不是把一次隔离绿当成测试健康证明。

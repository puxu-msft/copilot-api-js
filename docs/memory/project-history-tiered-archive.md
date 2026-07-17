---
name: project-history-tiered-archive
description: History 三层降温归档（HOT→tier-1→tier-2）已合并 master；格式、可恢复 worker 与承重教训入口
metadata: 
  node_type: memory
  type: project
  originSessionId: e6ffc6de-df8f-4158-a8a1-dda3da2e818c
---

History 三层降温归档特性：`history.db`（HOT，近 hot_days=3d + pinned 永驻）→ `archive.db`（TIER-1，SQLite 同 schema、ATTACH 主连接）→ `archive-t{1,2}-<session>-g<generation>.db`（不可变 session-generation sealed units）三层单向降温、**产品面无删除**、按视图分域（`?tier=hot|archive`）访问。

**状态（2026-07-16）**：已合并 master；lifecycle follow-up `27b65b89`。用户重启实例日志实证 `pid=1762072 sha=27b65b89-dirty`，`/health` 与 HOT History API 正常。运行配置可显式关闭 Archive；关闭时 Archive API 返回 `409 archive_unavailable`。权威：spec `docs/spec/2026-07-14-history-tiered-archive.md`、ADR `docs/decisions/2026-07-14-tiered-archive-cold-format.md`、plan `docs/plan/2026-07-14-history-tiered-archive/`、PoC `exp/tiered-archive-format/FINDINGS.md`、DESIGN.md「活的架构现状」行。

**承重教训（都实证背书）：**
- **tier-2 格式 = SQLite sealed + session-group，否决 Parquet**（用户初选 Parquet、PoC 实测翻案）。Parquet 零列式收益（payload 是单个已 zstd 压缩大 BLOB、访问是 manifest 定位单条读、列存卖点全失效）+ 慢 1.56× + 多依赖多陷阱。**session-group 是 9× 压缩杠杆**（用户洞察）：CC 每轮重发增长对话、per-entry 独立压缩各压一遍共享前缀、session-group 进单 zstd 流坍缩跨请求冗余（28.2→3.16MB）；supersede 内容寻址 dedup（真正字节主体是 entry_stages 不是消息）。→ [[feedback-verify-facts-before-superlative-completeness-verdict]] 同族（凭直觉选 Parquet、实测才对）。
- **跨库 move 2 个 BLOCKER（GPT reviewer 用真实 32GB 库实测复现、我对照核实成立）**：① `INSERT INTO archive.T SELECT * FROM main.T` 的**列序假设对真实 ALTER-升级库不成立**（fresh archive CREATE 序 ≠ 真库 ALTER-追加序、`agent_id` fresh 位3/真库位24）→值错位/FK violation→每 reaper tick 反复抛、降温流水线永久卡死。修=**显式列名**（PRAGMA 动态派生、按名对齐）。② verify 只比计数不比内容 + INSERT OR IGNORE 跳过重写→崩溃恢复窗口内 backfill 修正 HOT 后陈旧 archive 行被静默保留、HOT 更新丢失（撞永不真删红线）。修=**删-再-写覆盖语义**。→ [[methodology-broken-reference-supply-vs-delete]] 同域（别反射式信 SELECT *「应该对齐」）、[[feedback-fix-all-comparison-sites]]。
- **move 原子性**：WAL 无跨文件原子性、但设计安全的充要条件是「每事务只改一个文件数据页」——archive ATTACH 主连接、tx1 只写 archive.*（单文件原子）+ verify + tx2 只删 main.*。**stat（size/mtime）测 WAL 不可靠是假警报，数据级测量（page_count/行数）才是 ground truth**（reviewer stat 探针失败、我 page_count 探针证 history.db 数据页 UNCHANGED）。→ [[feedback-pass-null-clean-not-self-validating]]。
- **接线泄漏**：`ensureArchiveAttachedToMain` 读 `state.historyDbPath` 直接解析——`""`（生产默认、实际 HOT=PATHS.HISTORY_DB）→ `dirname("")="."` → archive.db 写 cwd（生产 bug）；`:memory:` → 同样 cwd（测试污染工作树根）。修=effective HOT 路径（`|| PATHS.HISTORY_DB`）+ 显式 dir 优先 + `:memory:` 无 dir 跳过归档。→ [[feedback_tests_never_touch_real_env]]。
- **msg_blob 跨 tier**：move 时**复制非移动**（内容寻址共享 hash 落两侧、archive INNER JOIN 不丢搜索）、两侧独立孤儿 GC。
- **产品面删除移除**（用户裁定）：`DELETE /api/entries` + `/api/sessions/:id` → `POST /api/archive-now`；`deleteEntries`/`clearAllEntries`/`deleteSession` 保留 test-only（resetTestRuntime 依赖 13+ 集成测试）。视图分域使 reviewer 上轮 H4（迁移窗口同 id 重复）天然消解（两视图不同库、绝不同列）。
- **后台维护的 shutdown 边界**：Archive backlog 不属于 shutdown durability。首信号只 seal producer；已领取的 migration batch / compact session / seal session-generation 完成 durable commit 后 yield/check stop，shutdown 只等待这些 owned units，绝不继续排空 backlog。并发 unit 禁用 fail-fast，否则 sibling 仍写 DB 时外层 promise 已结束会触发 closed-db race。
- **不可变 generation**：T1/T2 同一 session 后续新增 entry 必须产生新 generation 文件，不能覆盖旧 locator/manifest。generation identity 用 entry-id 集合的 SHA-256 截断；同一未提交 unit 重试复用 orphan 名。发布协议=file fsync→rename→directory fsync→locator/manifest transaction；legacy rename 用 copy→fsync→manifest update→删旧文件实现可重放。

**流程价值**：三轮 spec 对抗评审（3B+8H+2M+2LOW）+ Phase 3 承重代码对抗评审（2 BLOCKER 实测复现）——**异模型 reviewer 用真实生产库文件复现缺陷、比合成测试强**（fresh-fresh 夹具掩盖 ALTER-列序真缺陷，同 [[methodology-migration-audit-raw-fields-not-just-projection-oracle]]）。

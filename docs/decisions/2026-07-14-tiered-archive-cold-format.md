# ADR: tier-2 冷归档格式 —— SQLite sealed + session-group（否决 Parquet）

- **状态**：Accepted
- **日期**：2026-07-14
- **决策人**：用户（2026-07-14 会话，格式初选 Parquet → PoC 实测后采 SQLite sealed；session-group 粒度为用户洞察）
- **相关**：spec [docs/spec/2026-07-14-history-tiered-archive.md](../spec/2026-07-14-history-tiered-archive.md) §3.2；PoC [exp/tiered-archive-format/FINDINGS.md](../../exp/tiered-archive-format/FINDINGS.md)（权威数据）；CLAUDE.md `empirical-verification` / `long-term-wins`；ADR [2026-07-05-dependency-selection-bun-first](2026-07-05-dependency-selection-bun-first.md)（否决 Parquet 的合规依据）、[2026-07-05-richest-data-flow](2026-07-05-richest-data-flow.md)；DESIGN.md「活的架构现状」History 三层降温归档行。

## 背景

History 三层降温归档（HOT `history.db` → TIER-1 `archive.db` → TIER-2 封存冷单元）需为最深冷层（tier-2）选一个「支持的最好、高压缩比、富可索引、低访问代价」的格式。用户初选**列式（Parquet/DuckDB）**。设计阶段发现两处张力，用 Phase 0 PoC 以**真实 history blob**（150 条巨型 agent 对话 entry、均 2.88MB；真库 32GB 锚点）实测裁决，而非凭直觉。

## 决策

**tier-2 冷单元 = SQLite sealed 文件，封存粒度按 `session_id` 分组、每次领取的 session generation 一个 max-zstd（L19）不可变 unit。文件名为 `archive-t2-<session>-g<generation>.db`，generation 由本轮 entry ids 的 SHA-256 截断派生：相同未提交 unit 重试复用 orphan 名，同一 session 后续新增请求产生新 unit，绝不覆盖旧 manifest。否决 Parquet。**

两条实测依据（FINDINGS.md）：

1. **格式：SQLite sealed 完胜 Parquet。** 同一批真实 blob 落盘——压缩**统计等同**（Parquet/SQLite = 0.994）、单条读 SQLite **快 1.56×**、Parquet 多两个依赖（`hyparquet`+`hyparquet-writer`）+ 三个陷阱（读须 `utf8:false`、Buffer 池化偏移、INT64 须 BigInt）。**根因**：tier-2 payload 是单个**已 zstd 压缩的大 BLOB**（占 99.4% 字节），访问模式是「manifest 精确定位 → 读单条」，从不按列范围扫描/聚合——Parquet 列存的核心卖点（row-group 剪枝、列裁剪、字典编码）在此全部失效，只剩「更差的二进制容器」。

2. **粒度：按 session-group = 9× 压缩杠杆。** per-entry 独立压缩 28.20MB → **按 session 分组单 zstd 流 3.16MB（省 88.8%）**。根因：Claude Code 每轮重发增长对话（请求 N 含消息 1..N，且 clientRequest + effectiveSource + upstream_request 三处各带完整消息体），per-entry 把共享前缀在每个独立流各压一遍；session-group 进单一压缩窗口后跨请求冗余坍缩到近零。这**同时收割消息 AND stage 冗余**，远优于只去重消息的内容寻址（distinct 消息 zstd 后仅 1.67MB，真正的字节主体是 `entry_stages` 的 sse_events/upstream 帧）。

**读代价权衡**：session-group 单条读 665ms（解压整 session blob，16.6× 慢于 per-entry）——对**冷归档可接受**（罕访问 + 按 session 浏览一次解压展示整组、摊薄）。**大 session 有界**：单 seal unit 上限约 50MB 解压后 / N≈100 条，超则同 session 拆多子单元（manifest 仍按 session 分组）。

## 备选方案（未采纳）

- **Parquet（纯 JS hyparquet，用户初选）**：PoC 证零列式收益 + 慢 1.56× + 多依赖多陷阱，且违反 bun-first ADR（`@duckdb/node-api` 走原生绑定；纯 JS hyparquet 虽合规但无 SQL 引擎）。记录不采纳。
- **DuckDB**：原生绑定，直接违反 bun-first「零 node-gyp 运行时依赖」。设计阶段即否决（未进 PoC）。
- **tier-2 保留内容寻址 dedup**（spec 原设想「放弃 dedup 是可接受成本」）：PoC 推翻其前提——session-group 已 supersede，且更简单。tier-1（SQLite 同 schema、warm 层 per-entry 快查）**仍保留**内容寻址。

## 后果

- **正向**：零新运行时依赖（复用 `compression.ts` zstd / `serialize.ts` / `driver.ts`）；9× 压缩直击「高压缩比」诉求；`tier2_manifest`（SQLite，存 archive.db）冗余全 meta + preview_text，使归档视图 list/search 只命中 manifest（富可索引）、detail 才解压单 session（低访问代价）。
- **代价**：session-group 单条读 665ms（冷数据可接受）；tier-2 放弃跨 session 全局 dedup（封存单元自足、不可变、读罕见）；大 session 需有界拆分逻辑。
- **生命周期**：归档编码只在后台运行；shutdown seal producer，仅等待已领取 durable unit 完成并提交后停止。并发 sibling 即使一条失败，也必须全部 settle 后才能关闭 archive DB；剩余 backlog 下次启动续跑。

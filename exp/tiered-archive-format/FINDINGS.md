# Phase 0 PoC — tier-2 归档格式与粒度裁决（FINDINGS）

- **日期**：2026-07-14
- **样本**：150 条真实 history entry（4141 History API `assembleFullEntry` 全量拉取，`samples.json`），巨型 anthropic-messages agent 对话（messageCount~70、均 2.88 MB JSON、最大 10.8 MB），跨 7 个 session。
- **真库锚点**：`/home/xp/.local/share/copilot-api/history.db` = **32 GB**（只读快照查询），35,074 entries，其中 `entry_stages` blob 占 **22.7 GB**（重 payload 主体，head blob 仅 27.6 MB）；近 3d 终态非 pinned **26,778 行**（76.4%）；0 pinned。
- **驱动**：`probe.ts` + 一组一次性 bun 探针。

## 裁决 1：格式 = **SQLite sealed（候选 B）**，否决 Parquet（候选 A）

| 指标 | 候选 B（SQLite sealed，VACUUM + zstd L19） | 候选 A（Parquet，meta 列 + BYTE_ARRAY full_gz，zstd L19） |
|---|---|---|
| 文件大小 | 28.37 MB（1.006× payload floor） | 28.20 MB（1.000× floor） |
| 压缩比 | 5.8% of raw | 5.8% of raw（**A/B = 0.994，统计等同**） |
| 单条读延迟 | **40 ms** | 62.5 ms（**慢 1.56×**） |
| round-trip | 50/50 ✓ | 50/50 ✓ |
| 新依赖 | 零（复用 `compression.ts`/`serialize.ts`/`driver.ts`） | `hyparquet` + `hyparquet-writer` |
| 陷阱 | 无 | ① 读须 `utf8:false`（否则 BYTE_ARRAY 被 UTF-8 解码、二进制损坏 `b5`→U+FFFD）② `Buffer.buffer` 池化偏移须 `.slice(byteOffset,…)`③ INT64 须 BigInt |

**根因（坐实 reviewer H5）**：tier-2 payload 是**单个已 zstd 压缩的大 BLOB**（占 99.4% 字节），Parquet 列存的核心卖点（row-group min/max 剪枝、列投影、字典编码）在「manifest 精确定位 + 单条读」访问模式下全部失效——Parquet 只是个更差的容器（读更慢 + 多依赖 + 多陷阱）。**采候选 B**。

## 裁决 2：封存粒度 = **按 session_id 分组**（用户洞察，9× 压缩杠杆）

per-entry 独立压缩没吃到**跨请求冗余**：Claude Code 每轮重发整个增长对话（请求 N 含消息 1..N、且 clientRequest + effectiveSource + upstream_request 三处各带一份完整消息体），per-entry 把共享前缀在每个独立 zstd 流里各压一遍。按 session 分组进**单一 zstd 流**后，跨请求的消息前缀 + 相似 upstream 帧冗余坍缩到近零。

| 策略（150 entry / 7 session） | 大小 | 单条读 | vs per-entry |
|---|---|---|---|
| **S1 per-entry 独立压缩**（原 spec §3.2 设想） | 28.20 MB | 40 ms | 基线 |
| **S3 按 session-group 压缩** | **3.16 MB** | 665 ms | **省 88.8%（9×）** |
| S4 全体单流（上界参考） | 15.10 MB | — | 省 46.5% |

**读代价权衡**：session-group 单条读 665 ms（解压整 session blob 取一条，16.6× 慢于 per-entry SQLite）——对**冷归档可接受**（罕访问 + 按 session 浏览时一次解压展示整组、摊薄）。9× 压缩直击核心诉求「高压缩比」。round-trip 50/50 保真。

**推翻 spec §3.5 假设**：spec 把「tier-2 放弃跨 entry 内容寻址 dedup」当可接受成本。实测发现：① 跨 entry 消息 dedup 比 **10.98×**（21,878 实例 → 1,992 distinct）；② 但 distinct 消息 zstd 后仅 **1.67 MB**——**消息不是存储瓶颈，`entry_stages`（sse_events + upstream 帧）才是（28.96 MB）**。内容寻址只去重消息、对 stage 无能为力（per-entry ~29 MB）；而 **session-group zstd 同时收割消息 AND stage 的跨请求冗余（3.16 MB）**，远优于内容寻址。故 tier-2 **不需要**内容寻址表，session-group 单流 zstd 即可，且更简单。

## 裁决 3：容量校准（reviewer M2 预警坐实，默认值须调）

真库 32 GB 揭示 `hot_days=3` / `tier1_size_cap=500MB` 默认对重度用户偏小：
- 近 3d 26,778 终态行 ≈ 该用户 ~9k 请求/天；按当前均 ~650 KB/entry（压缩后含 stage）估，**hot_days=3 → HOT 约 17 GB**（仍大但可接受，热层本就要全保真快查）。
- **`tier1_size_cap=500MB` 太小**：>3d 的 8,292 行 ≈ 5 GB 待降温，会瞬间撑爆并触发 ~10 个 tier-2 封存。**建议提高 tier1_size_cap 默认到 2–4 GB**（tier-1 是 SQLite、ATTACH 查询、大些无妨），或改为「按行数 + 字节」双阈。
- `tier2_warn_count` 默认：按 session-group 后每 session seal ~0.5 MB（本样本 7 session/3.16MB），500MB 告警 ≈ 1000 个 session seal；**`tier2_warn_count` 默认 200、`tier2_warn_bytes` 500MB** 合理起点。

## 对 spec / plan 的修订（本 PoC 触发）

1. **spec §3.2**：tier-2 格式定 **SQLite sealed**（否决 Parquet，记 ADR）；封存粒度改 **按 session_id 分组**（非任意 N entry）。
2. **spec §3.5**：tier-2 **不做**内容寻址 dedup（session-group zstd 已 supersede）；删「放弃 dedup 是可接受成本」措辞，改「session-group 收割跨请求冗余，优于内容寻址」。tier-1（SQLite 同 schema）仍保留内容寻址（warm 层 per-entry 快查）。
3. **spec §3.7 / 配置默认**：`tier1_size_cap` 提高到 2–4 GB（待定，见下）；`tier2_warn_count`=200。
4. **plan P6**：封存单元 = session-grouped zstd blob 存 SQLite sealed；manifest `entry_id → (seal_file, session_id, index_in_session)`；读=解压 session blob 索引取条；**大 session 须有界**（单 session 过大时按 N 条子分块，防单次解压 >100MB）。
5. **依赖**：不引入 hyparquet（采 B）；已 `bun remove`。

## 未决（留 plan 实现期定）

- **tier1_size_cap 具体默认值**（2 GB vs 4 GB）：取决于用户对 tier-1 ATTACH 查询延迟容忍——留配置、默认取 2 GB 起。
- **单 session 有界阈值**（多少条/多少 MB 一个子封存单元）：防超大 session 单次解压爆内存，建议单 seal unit 上限 ~50 MB 解压后 / 或 N=100 条，超则同 session 拆多单元（manifest 仍按 session 分组浏览）。
</content>

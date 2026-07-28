# History read path SQLite PoC

## 结论摘要

**结论：R3 物化 `v3_sessions` 表是长远正确且完整的主路线；R2 generated columns + SQL `GROUP BY` 可行，但不能满足 Q2 第三条的无临时排序硬判据，也远慢于 R3；R1 现状有致命读放大。**

- **R1 权威数字已更正**：生产库完全相同 SQL 形状的既有实测为 **33,511 行 / 67,880 ms / 峰值 RSS 992 MB**；本 PoC 最终直接只读生产库复跑为 **34,896 行 / 88,353.8 ms / 峰值 RSS 1.138 GB**。合成库恢复生产索引集合后为 **33,909 行 / 72,497.5 ms**。首版报告的 **1,392,164 ms（23.20 分钟）是实验污染，禁止引用**：Q1/Q2 遗留的 `idx_poc_session_started` 改变了 R1 优化器选路，令其对完整 ORDER BY 建临时 B-tree；生产仅对 ORDER BY 最后一项建临时 B-tree。
- R2 正确聚合 101 个 session，7 次为 **1,155–1,445 ms，中位数 1,303 ms**；结果逐字段与独立 JS oracle 一致。它仍需 `USE TEMP B-TREE FOR ORDER BY`，distinct agent/model 还各自需临时 B-tree。
- R3 读取 101 个 session，7 次为 **0.323–0.737 ms，中位数 0.365 ms**；一次性 backfill **1,225.9 ms**。原先独立 upsert 的 3.923 ms 中位数不是写路径增量成本，已降级为隔离组件数字；500 条真实大小 BLOB 的配对事务实验中，operation insert 单独中位数 **2.41–2.94 ms**，insert+upsert 中位数 **2.58–3.06 ms**，五轮“中位数之差”为 **0.105–0.176 ms**。物化表+排序索引实测约 **73,728 B**。
- R3 增量 upsert 在 **append-only + exactly-once** 前提下可仅靠新行完整维护当前 `SessionSummary` 全字段，包括 distinct models/agents、first/last preview 和 min/max；但 replay 不是幂等的，故必须在同一事务中以 `operation_id` 去重。update/delete/撤销时，count/sum/state 可用 old row 做逆运算，distinct set 与被删 first/last 行不可仅靠聚合行恢复，必须维护成员引用计数/候选结构或回扫该 session。

## 实验边界、轮次与安全

- 日期：2026-07-28。
- 运行时：`bun 1.3.14`，`bun:sqlite` 的 `SELECT sqlite_version()` 为 **3.53.0**。
- 生产库仅由 `new Database(path, { readonly: true, strict: true })` 打开且只执行 SELECT。未执行任何生产库 DDL/DML/VACUUM；未访问、启动或终止 4141 服务。
- 生产库在实验期间持续增长：背景为 33,980 行；首轮观测 34,201→34,202 行；合成快照捕获 34,404 行；中途核对为 34,602 行，最终新鲜核对已为 35,211 行。因此 builder 用**单条 SELECT**取得 summary 文本和 BLOB 长度，`.all()` 返回后立刻关闭生产连接；随机 BLOB 构建期不持有生产读事务。
- 轮次 1：临时库 Q1 探针；轮次 2：34,404 行合成快照、Q1/Q2；轮次 3：Q3/Q4/Q5、正对照。所有计时来自同一合成库，但 R1、R2/R3、Q4 是独立 Bun 进程、受 OS page cache 热度影响；这不是严格受控 benchmark。Q1 单行临时探针只用于错误形态，不参与性能比较。
- 首轮合成库：`/tmp/copilot-history-read-path-poc/synthetic.db`；ordered control：`/tmp/copilot-history-read-path-poc-ordered/synthetic.db`。PoC 脚本可重入；builder v2 仅在 `build_version=2` 时跳过重建。原始日志在 `/tmp/copilot-history-read-path-poc/*.log`。

## 复跑命令

```bash
bun exp/history-read-path/build-synthetic.ts
bun exp/history-read-path/poc.ts q1
bun exp/history-read-path/poc.ts q2
bun exp/history-read-path/poc.ts q3-r1
bun exp/history-read-path/poc.ts q3-fast
bun exp/history-read-path/poc.ts q4
bun exp/history-read-path/poc.ts q5
bun exp/history-read-path/verify-source.ts
```

## Q1 — SQLite / bun:sqlite 能力边界

### 实测

1. `ALTER TABLE ... ADD COLUMN session_id TEXT GENERATED ALWAYS AS (json_extract(summary_json,'$.sessionId')) VIRTUAL` 成功。保真库上增加 10 个 VIRTUAL generated columns 各耗 **44.4–112.5 ms**。
2. 嵌套路径 `$.usage.input_tokens` 成功；样本读回 `input_tokens=10181`。这直接证明本 SQLite 构建接受 `json_extract` 作为 generated column 的 deterministic expression。
3. VIRTUAL generated column 可建索引。为排除 DROP 后 freelist 复用导致“文件大小没变”的假象，索引体积按 `(page_count-freelist_count)` 建前/建后增量计算：

| 索引 | DDL | 建索引耗时 | 占用页增量 |
|---|---|---:|---:|
| session list | `(session_id,kind,created_at DESC,operation_id DESC)` | 2,036.4 ms | 2,940,928 B |
| kind/state list | `(kind,state,created_at DESC,operation_id DESC)` | 1,191.4 ms | 2,011,136 B |
| session aggregate/preview | `(kind,session_id,started_at DESC,operation_id DESC)` | 1,173.1 ms | 2,940,928 B |

首次冷运行相应为 2,357.6 ms、2,342.3 ms、1,696.8 ms，故正式实现应按约 1–2.4 秒/索引规划迁移锁持有期。
4. `ALTER TABLE ... ADD COLUMN ... STORED` 负向实证失败，原始错误：

```text
SQLiteError: cannot add a STORED column
```

5. Bun 内置 SQLite 未暴露 `dbstat`，原始错误：

```text
SQLiteError: no such table: dbstat
```

因此本 PoC 用 page/freelist 增量而非伪造“精确 dbstat 大小”。

### 结论

Q1 路线可行：ALTER 只能加 VIRTUAL，嵌套 JSON 路径与索引均可用。正式迁移应显式采用 VIRTUAL；若要 STORED，必须重建表而非 ALTER ADD。

## Q2 — 查询计划是否命中索引

### 实测计划

会话内请求列表：

```text
SEARCH v3_operations USING INDEX idx_poc_session_list (session_id=? AND kind=?)
```

全局列表带 state 过滤：

```text
SEARCH v3_operations USING INDEX idx_poc_kind_state_list (kind=? AND state=?)
```

二者均无 `SCAN`、无 `USE TEMP B-TREE`，满足判据。故索引必须把排序尾键 `operation_id DESC` 纳入；已有 `(kind,created_at DESC)` 缺该尾键，不足以保证 keyset/list 排序。

会话聚合 `GROUP BY session_id ORDER BY MAX(started_at) DESC LIMIT 200`：

- session-first 候选 `(kind,session_id,started_at DESC,operation_id DESC)`：

```text
SEARCH v3_operations USING INDEX idx_poc_session_started (kind=? AND session_id>?)
USE TEMP B-TREE FOR ORDER BY
```

- started-first 候选 `(kind,started_at DESC,session_id,operation_id DESC)`：优化器选其他 kind-leading 索引，结果为：

```text
SEARCH v3_operations USING INDEX idx_poc_kind_state_list (kind=?)
USE TEMP B-TREE FOR GROUP BY
USE TEMP B-TREE FOR ORDER BY
```

恢复 session-first 后结果仍是 `USE TEMP B-TREE FOR ORDER BY`。

### 正对照

故意删除会话索引后，会话列表计划出现 `USE TEMP B-TREE FOR ORDER BY`；故意删除 state 索引后，state 列表也出现同样红信号。恢复索引后计划回绿，证明计划检查确实咬到目标机制。

### 结论

Q2 第三条**不满足硬判据**。单一普通 B-tree 不能同时把输入按 `session_id` 相邻供 GROUP BY，又把各组按计算后的 `MAX(started_at)` 全局降序输出。started-first 也不能让 SQLite在流过各 session 的第一行后安全跳过该 session 后续非相邻行。因此 R2 无法消除聚合结果排序；这是支持 R3 的结构性证据，不是通过 SQL 改写规避的结果。

注意：R3 的 `EXPLAIN` 是 `SCAN v3_sessions USING INDEX idx_v3_sessions_last_started`。SQLite 对“按排序索引顺序遍历整张 101 行物化表”用词就是 `SCAN`；它无 TEMP B-tree 且 0.3–0.7 ms，但**不冒充 Q2 第三条通过**。Q2 的原查询仍失败。

## Q3 — R1/R2/R3 定量对比

### 正确性 oracle

独立 JS oracle 直接解析所有真实 `summary_json`，复现当前 `getSessionSummaries()` 的排序、token、state、agent/model set 与首尾 preview 语义。R2 七轮和 R3 backfill 均为 `101 expected / 101 actual / mismatchCount=0`。随后故意把一个 R3 `request_count + 1`，oracle 立即报 1 个 mismatch；恢复后回到 0，排除“比较器没咬到”的假绿。

### 性能

| 路线 | 完整路径 | 实测 |
|---|---|---:|
| R1 生产权威既有实测 | 每 256 行 `SELECT manifest_gz,summary_json,... LIMIT/OFFSET` + JS parse/group/sort | **33,511 行 / 67,880 ms / RSS 992 MB** |
| R1 生产新鲜只读复跑 | 同上；生产继续增长 | **34,896 行 / 88,353.8 ms / RSS 1.138 GB** |
| R1 合成库，生产索引集合 | 同上 | **33,909 行 / 72,497.5 ms** |
| R1 首版污染结果，禁止引用 | 合成库残留 Q1/Q2 索引，优化器错误选路 | ~~1,392,164 ms（23.20 分钟）~~ |
| 诊断对照，不是 R1 | 一次只投影 `summary_json` + 同一 JS 聚合 | **1,486–5,806 ms**；最终轮 2,005 ms |
| R2 | generated columns + SQL GROUP BY + DISTINCT + 两个 preview 索引回查 | **1,155–1,445 ms，中位数 1,303 ms，7 次** |
| R3 | `SELECT * FROM v3_sessions ORDER BY last_started_at DESC,session_id DESC LIMIT 200` | **0.323–0.737 ms，中位数 0.365 ms，7 次** |
| R3 backfill | 33,896 个有 sessionId 的 generation 聚合成 101 行 | **1,225.9 ms** |
| R3 独立 upsert，非真实增量 | autocommit，WAL，`synchronous=FULL`，250 次 | 中位数 3.923 ms；**不得当作 operation 写路径增量** |
| R3 真实配对增量 | `insert+upsert` 同事务减 `insert` 同事务，500 条、交替顺序、5 轮 | **difference-of-medians 0.105–0.176 ms；paired-delta median 0.080–0.137 ms** |

### R1 观测冲突更正

首版 23.20 分钟不是 rowid 插入顺序或冷 page cache 的生产形状，而是**实验顺序污染**。Q1/Q2 先在同一合成库创建了 `idx_poc_session_started(kind,session_id,started_at,operation_id)`；R1 随后计划变为：

```text
SEARCH v3_operations USING INDEX idx_poc_session_started (kind=?)
USE TEMP B-TREE FOR ORDER BY
```

生产索引集合的计划是：

```text
SEARCH v3_operations USING INDEX idx_v3_operations_kind (kind=?)
USE TEMP B-TREE FOR LAST TERM OF ORDER BY
```

删除全部 `idx_poc_*` 后，合成库完整 R1 降为 72.50 秒，与两次生产实测 67.88 秒/88.35 秒同量级。因此判定明确：**1,392,164 ms 是 PoC 构建/实验 artifact，不得用于对外陈述现状；67,880 ms 是协调者给出的同批次权威基线，本 PoC 的 88,353.8 ms 是持续增长负载上的独立复核。**

行物理顺序确有差异但不是 20.5 倍主因：生产全表 `corr(rowid,created_at)` 的 Pearson 近似值为 0.9867、相邻 createdAt 上升/下降为 28,049/7,266；首版合成库为 0.9550、34,167/236（前 2,000 行因按 operation_id snapshot 出现 -0.5765）。独立 ordered control 又按 `created_at,operation_id` 插入 35,581 行，在生产索引集合上完整 R1 为 **73,697.9 ms**，逐行核对 35,581/35,581、长度/summary mismatch 均为 0；它与首版合成库恢复生产索引后的 72,497.5 ms 基本相同，进一步证伪“插入顺序造成 20.5 倍”的假设。page cache 热度仍会影响 67.88 与 88.35 秒的波动，故 R1 数字不是严格 benchmark；但恢复相同索引计划后已无数量级冲突。builder v2 已改为 `ORDER BY created_at,operation_id` 插入，并用 build version 防止旧库被误当新库；`q3-r1` 也会在发现 `idx_poc_*` 时拒绝运行，防止复发。

### R2 能做与不能做

- 单次 SQL 可正确做：count、min/max startedAt、token sums、state counts、distinct agents、distinct models。
- models 可由 `json_group_array(DISTINCT effective_model)` 返回集合，但顺序不是业务契约，消费前应排序；它需要临时 distinct B-tree。
- first/last preview 不能从普通 `MIN/MAX(preview_text)` 得到，因为那是字典序，不是首尾请求。PoC 用每 session 两个 correlated scalar subquery，靠 `(kind,session_id,started_at DESC,operation_id DESC)` 正/反向索引回查；这不是读取大 manifest 的“回表”，但仍是二次索引查询。
- 完整 R2 计划另有 `USE TEMP B-TREE FOR count(DISTINCT)`、`json_group_array(DISTINCT)` 和 ORDER BY，故即使 correctness 通过，也不是完全流式聚合。

### R3 体积

`dbstat` 不可用。独立建一份 101 行物化表及排序索引，occupied-page 增量为 **73,728 B**；逻辑字段长度估算 37,758 B。相对 2.071 GB 合成库可忽略。

## Q4 — R3 增量维护正确性边界

### append-only + exactly-once 下的字段判定

| 字段 | 仅靠新提交 summary 增量维护？ | 方法与边界 |
|---|---|---|
| requestCount | 是 | `+1`；duplicate replay 会重复计数。 |
| input/output tokens | 是 | 加上新行；需要与当前语义一致，把 cache read/create 加入 input。 |
| completed/failed/aborted | 是 | 对新 state 对应计数 `+1`。 |
| agentCount | 是 | 物化 `agent_ids_json` 集合，union 新 `agentId`，count=集合长度；不能只存 count。 |
| models | 是 | 物化完整 model set，union `responseModel ?? requestModel`；不能只存 distinct count。 |
| firstStartedAt/firstPreview | 是 | 存 `(first_started_at,first_operation_id)`；新行元组更小时同时替换 preview。 |
| lastStartedAt/preview | 是 | 存 `(last_started_at,last_operation_id)`；新行元组更大时同时替换 preview。 |

“distinct models、firstPreview、min(startedAt) 不能增量维护”只在**聚合表没有保留足够状态**或允许任意 update/delete 时成立。在 append-only 新提交模型中，它们都可只靠新行维护。PoC 用 250 条真实 summary 分布、10 个合成 session 做 incremental upsert，再与独立全量 JS 重算比较：`10/10 rows, mismatchCount=0`。

### replay / update / delete

- **Replay**：当前 upsert 仅按 `session_id` conflict，不按 `operation_id` 去重。把同一 operation 再喂一次，`request_count` 实测从 250 变 251，正对照 delta=1。故致命边界是：R3 写入必须与 operation insert 在**同一 SQLite 事务**，并只在 `INSERT ... ON CONFLICT(operation_id) DO NOTHING` 确实插入新 operation 时更新 session；或维护 `session_operation_membership(operation_id PRIMARY KEY, session_id, contribution...)`。否则 crash replay/重复 terminal 会永久双计。
- **Update**：若有 old row，count/sum/state 可先减旧贡献再加新贡献；model/agent distinct set 需要每值引用计数，否则无法知道移除旧值后是否仍被其他 operation 使用；first/last 元组被更新离开边界时也需候选结构或回扫。
- **Delete**：count/sum/state 可用被删 row 逆运算；model/agent 与 first/last 同上不可仅由聚合行恢复。若连被删 row 都不可得，则所有贡献都不可逆。

### delete/move 推荐

先纠正当前代码事实：2026-07-28 主树的 V3 产品面**不存在** `deleteEntries`、`deleteSession` 或三层降温 move。`docs/history.md:9,109` 明确记录它们随 V2 removal 退役；live route 也拒绝 `tier=archive`，V3 只剩 test-only `clearV3Store()` 全清。因此不应为了已退役路径立即扩 schema。

若产品需求恢复 scoped delete/session delete，或未来重新引入 operation move，三种应对中推荐 **“回扫受影响 session 并在同一事务中原子重建该 session 聚合行”**，而不是把 JSON set 改成引用计数或维护完整成员候选表：

1. **完整性**：删除/move 先完成源/目标 operation 变更，再从 canonical `v3_operations` 对受影响 session 重算所有字段，天然覆盖 count/sum/state、distinct models/agents、first/last tuple/preview，不会让增量逆运算与主聚合 SQL 漂移。
2. **move 正确性**：move 是跨存储事务边界问题。应采用 durable move journal/outbox，把源和目标的 session aggregate 都视为 canonical operations 的可重建投影；完成每个阶段后重扫对应 session。引用计数只能解决 distinct 集合，不能单独解决 first/last 候选或跨库 crash consistency。
3. **成本与负载形状**：平均 319 行回扫中位数 8.84 ms，最大 3,356 行中位数 58.75 ms；delete/move 是低频批量维护，不是每请求热路径。应一次收集受影响 sessionId、每 session 只重扫一次，而不是每删除一行重扫一次。
4. **长远可修复性**：聚合是 derived projection，可随 schema/语义升级全量或单 session 重建。refcount/候选成员表会新增第二套需要迁移、校验、修复的权威状态；只有未来实测 delete/move 高频到回扫不达标时，才升级为 normalized per-session membership/contribution table，并仍保留重建 oracle。

因此推荐不是“为了省实现而回扫”，而是明确选择 **canonical operations 为唯一真相、session 表为可重建物化投影**。这对 append、delete、session delete、move、crash recovery 和语义迁移是同一个完整模型。test-only 全清则在同一事务直接清空 `v3_sessions`，无需逐 session 回扫。

### 同事务真实写入增量

原 3.923 ms 数字测的是 `v3_sessions` upsert 独立 autocommit，不能回答真实 operation 写路径增量，现已明确撤回该解释。新增 `write-cost.ts` 创建两张 schema 相同的隔离库，以 500 条生产只读 summary 和同长度随机 manifest 做交替顺序配对：baseline 每事务只 insert operation，treatment 每事务 insert operation 后 upsert session，均为 WAL + `synchronous=FULL`。

五轮结果：

| 轮 | insert 中位数 | insert+upsert 中位数 | 两中位数之差 | paired delta 中位数 |
|---:|---:|---:|---:|---:|
| 1 | 2.944 ms | 3.060 ms | 0.116 ms | 0.093 ms |
| 2 | 2.559 ms | 2.682 ms | 0.123 ms | 0.137 ms |
| 3 | 2.412 ms | 2.588 ms | 0.176 ms | 0.113 ms |
| 4 | 2.439 ms | 2.583 ms | 0.144 ms | 0.117 ms |
| 5 | 2.503 ms | 2.608 ms | 0.105 ms | 0.080 ms |

因此在该隔离 PoC 中，真实中位写路径增量约 **0.08–0.18 ms/operation**，而非 3.923 ms。p95/均值被 WAL checkpoint 与调度噪声主导，paired delta 甚至会出现负值，不能把单次相减当精确 CPU 成本；中位数与五轮复现只支持“约 0.1 ms、远小于 fsync 主成本”的量级判断。正式实现仍应在真实 `commitPreparedOperation` 事务中做基准，因为当前 PoC 没复制 CAS/object/track/journal 全写链。

### 回扫代价

当前 101 个有 session 的 generation 平均 **335.6 行/session**。最接近平均的 319 行 session 回扫 7 次为 **8.04–15.53 ms，中位数 8.84 ms**；最大 3,356 行 session 为 **54.72–95.11 ms，中位数 58.75 ms**。因此低频修复/删除回扫可接受，但不应放在每次正常提交热路径。

## Q5 — 合成库保真度

### 快照与核对

| 项 | 合成快照 |
|---|---:|
| 总行数 | 34,404 |
| generation | 33,909 |
| count_tokens | 495 |
| distinct sessionId | 101 |
| generation 中无 sessionId | 13 |
| manifest 总长度 | 1,997,242,062 B |
| manifest 平均长度 | 58,052.6 B |
| manifest 最大长度 | 6,618,212 B |
| summary SQLite `length()` 总和 | 27,196,486 B |
| 合成 DB 文件 | 2,070,966,272 B |

builder 对每行执行 `randomBytes(real_manifest_length)`；没有复制生产 manifest 内容。`verify-source.ts` 的最终新鲜核对在生产库增长到 35,211 行后，以 operation_id 对原快照 34,404 行逐行核对：**matched=34,404、missing=0、manifestLengthMismatches=0、summaryMismatches=0**。另对 `(operation_id,length)` 序列做 SHA-256，source snapshot 与 synthetic 均为：

```text
221531d110159ac1d5bda7e7725e36bcc21da1c312851b351654f58fc3c8b81d
```

注意 builder 初始日志的 `summaryBytes=27,633,559` 用了 UTF-8 byte length，而 SQLite `length(TEXT)` 是字符数；这两个数口径不同。逐行 `summary_json !== source.summary_json` 为 0 才是逐字复制的权威证据。

### 8.3 GB “同量级”判据的诚实结论

**按用户给出的“复制 `v3_operations` 每行 manifest 长度分布”定义，合成库保真；按“整个生产 DB 文件必须也约 8.3 GB”字面定义，不满足。**生产只读观测时文件约 8.37 GB、`page_count≈2.04M`，但当时 `v3_operations` 活行 manifest 总长度只有约 1.99 GB；后续 `freelist_count=61`，所以差额也不是 freelist。说明生产库另有大量其他 V3 CAS/track/timeline 表。该 PoC 只复制了题目指定的 `v3_operations`，合成文件约 2.07 GB，不可能凭空达到 8.3 GB。

这不是可以粉饰的细节：R1/R2/R3 的 session 查询均只访问 `v3_operations`，故本表 overflow-page/BLOB 读放大结论有效；但“与整个多表生产库相同的页缓存竞争/文件级 I/O 布局”**未验证**。若后续要做生产级性能基准，应另做全 schema 保真副本或在只读生产库上跑 SELECT；本 PoC 数字只能作路线量级裁决，不能冒充完整生产 benchmark。

## 正式实现建议

1. 选择 R3，并把 `v3_sessions` 更新和首次成功插入 `v3_operations` 放在同一事务；operation_id 去重是硬门，不是可选优化。
2. 保留 generated columns/复合索引作为 session entry list、state-filter list 和按 session 回扫基础设施；不要期待它们消除全局 GROUP BY 的排序。
3. 物化表保留完整 models/agent sets 和 first/last operation tuple。若未来允许 operation update/delete，升级为 refcount/成员表或明确触发单 session 重建。
4. 无论是否立刻上 R3，都应从当前 summary visitor SQL 删除 `manifest_gz` 投影并淘汰 OFFSET 分页，改 keyset；权威现状是约 68–88 秒而非错误的 23.2 分钟，但仍比 summary-only / R2 / R3 慢两个到五个数量级。
5. scoped delete/move 若未来恢复，采用“canonical operations 单一真相 + 受影响 session 原子回扫重建”；move 配 durable journal/outbox，不把 refcount 当跨库一致性的替代品。
6. 正式 migration/backfill 应分批、可恢复并记录 schema/version；本 PoC 的 1.2 秒一次性 backfill证明计算可行，不证明线上锁时长与并发写者安全。

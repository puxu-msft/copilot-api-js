# 对抗性复审报告 — v2 计划（token usage 净值化 + 历史 backfill）

审查对象：`/home/xp/.claude/plans/vectorized-spinning-cherny.md`（v2，已吸收上轮 CRITICAL+HIGH）
裁判轴：长远正确 + 完整 + 数据无声丢失零容忍。已亲自读引用的 file:line，未照搬计划断言。

## 总评

v2 的两个已吸收修复（usage 落 `outbound_response` stage 行、per-row 标记列幂等）方向**均已核验正确**。第三部分 backfill 重设计的核心正确性成立。但复审发现 **1 个 HIGH（schema 接线自相矛盾会误导实现者走错机制）**、**2 个 MEDIUM（多 attempt 前提虚构→测试夹具落空；write-path 幂等语义未点破真陷阱）**、**3 个 LOW（EntryRow 读崩断言过激、批级 tx 阻塞的机理误框、行号漂移）**。逐条附证。

---

## 已验证无虞（放行）

- **O(1) ADD COLUMN 断言 TRUE。** `usage_normalized INTEGER NOT NULL DEFAULT 0` 是常量 DEFAULT 的普通列，SQLite 官方文档明确：仅 CHECK 约束 / 生成列 NOT NULL / DROP COLUMN 触发全表重写；`NOT NULL DEFAULT 0` 是纯 metadata-only，与表大小无关（sqlite.org/lang_altertable.html 实证）。且 `pinned INTEGER NOT NULL DEFAULT 0` 用**逐字相同**的 DDL 已在生产跑（connection.ts:285），是活的先例。
- **生产端 bug 真实存在、修复站点覆盖正确。** C 非流式 chat `input_tokens: usage?.prompt_tokens ?? 0` + cache_read 作子集（handler-v4.ts:249,251）；D responses（handler-v4.ts:218,220）；E gemini（handler-v4.ts:210,212）——三腿都把含缓存总输入当 net。abort/fail 路径（chat:368/381、responses:308/320、ws:335/348）确实只传 `{input_tokens, output_tokens}` 无 cache_read，计划「全改经 helper 带 cache_read」正确。
- **成本双计 bug 真实。** request-telemetry.ts:383+385：`costInputTokens += input_tokens*mult` 与 `costCacheReadInputTokens += cache_read*mult` 分别累加；若 input 含 cache_read，缓存部分billed 两次。净值化修好。
- **sessions-agg 双计真实。** sessions-agg.ts:30 `SUM(input)+SUM(cache_read)+SUM(cache_creation)`；input 含 cache_read 时该行被双计。计划「backfill 后 inputTokens 变小、测试用独立期望值」正确。
- **L1 via-responses 丢 cached 真实。** `ccUsageToResponsesUsage`（responses-to-cc-request.ts:527-533）只映射 prompt/completion/total，**完全不含** `input_tokens_details`——计划补透传 cached 正确。
- **单帧往返保真成立。** 每 stage 行是 `compress(payload)` 单帧（write.ts:99），zstd L3 确定性（compression.ts:29,52 注释「byte-equal」），magic 判别 gzip 1f8b / zstd 28b52ffd（compression.ts:80-87）；decompress→patch→compress 逐字保真无虞。
- **并发安全成立（但机理与计划表述不同，见 LOW-2）。** 单进程单 `db` 句柄（connection.ts:56，`getDatabase` 返回唯一 db），所有写 + backfill 共享它；JS 单线程 + 同步 `db.transaction()` 回调原子跑完不交错（driver.ts:85-95 BEGIN/COMMIT/ROLLBACK）。re-finalize 与 backfill 不会真交错，标记列=1 跳过逻辑成立。

---

## HIGH-1 — schema 接线自相矛盾，会把实现者引向错误机制

**证据：** 项目有**两条**独立的加列路径，`usage_normalized` 只该走其一：

1. **reconcile 地板**：`migrateEntriesColumns`（connection.ts:273-320），在 `openDatabase` 内跑（connection.ts:82），用 `PRAGMA table_info` 探针 + `ALTER TABLE ADD COLUMN`。**`pinned INTEGER NOT NULL DEFAULT 0` 正是走这条**（connection.ts:285，与 `usage_normalized` DDL 逐字同构）。
2. **Umzug forward migrations**：`MIGRATIONS` 数组（migrations/index.ts:64，**当前为空**），由 `applyForwardMigrations`（start.ts:348）跑，是给「001+ 的 forward DDL」用的。

计划 3.2（:73）说「走 schema reconcile 地板 **+** Umzug forward migration」——**这是两个互斥机制，不是叠加**。同一列不能既由 reconcile 地板 `ADD COLUMN` 又由 Umzug migration `ADD COLUMN`（第二个会因列已存在而抛「duplicate column」，恰是 migrations/index.ts:30-38 警告的 partial-DDL wedge）。

3.3（:84）又说「不走 Umzug MIGRATIONS 数组（数据回填是 background re-entrant），只有 3.2 的 ADD COLUMN 走 DDL migration」——这与 3.2 的「+ Umzug」一致地指向 Umzug，但**与生产先例（pinned 走 reconcile 地板）矛盾**。

**裁定：** 最强正确形状是**加列走 reconcile 地板 `migrateEntriesColumns` 的 `wanted` 数组**（与 pinned 完全一致，一行 `{ name: "usage_normalized", type: "INTEGER NOT NULL DEFAULT 0" }`），**不新建 Umzug migration**。理由：(a) 与既有同型列（pinned）先例一致，可维护性最高；(b) reconcile 地板在 `openDatabase` 内、早于 `applyForwardMigrations`（start.ts:348）跑，加列可用性更早；(c) Umzug 空数组是「首个真实 schema change 落这里」的占位（index.ts:56-64），但既有 additive-column 惯例明确是 reconcile 地板（index.ts:61 注释「additive columns probe PRAGMA table_info first; see migrateEntriesColumns」）。计划须删掉「+ Umzug forward migration」的自相矛盾表述，明确单一走 reconcile 地板。

> 注：若实现者按字面「走 Umzug」新建 migration，虽然功能上也能加列，但与项目既定的 additive-column 惯例分叉，制造两套并存机制——违背 single-source / 可维护性优先。这是**该问清楚的接线歧义**，不是无害措辞。

---

## MEDIUM-1 — 多 attempt「多条 outbound_response 行 usage 发散」前提虚构，导致 §4 测试夹具落空

**证据（subagent 独立核验 + 我复核关键站点）：**
- `attempts[].response`（含 usage）**唯一**写入点 `setAttemptResponse`（context/request.ts:410-416），**唯一**调用点 `complete()`（request.ts:483），受 `settled` guard（:469）——每请求只跑一次，只在**成功的 final attempt** 上。
- 失败的非 final attempt 走 `setAttemptError`（driver.ts:289 / pipeline.ts:299）只写 `error`；L2 buffered-retry 失败 attempt 走 `commitAttemptSseEvents`（driver.ts:616）只快照 sseEvents，**都不写 response**。
- 故 `toHistoryEntry` 里非 final 的 `response: a.response ?? undefined`（request.ts:684）恒 undefined → `extractStagePayloads` 的 `if (a.response)`（serialize.ts:493）**守卫恒 false** → **非 final 的 outbound_response stage 行根本不写**。

**结论：** 生产路径下一个 entry **只有 1 条** outbound_response stage 行（final 那条），且与 head 列同源。因此：
- per-row 减法（计划 3.1:67「patch 该行自己的 usage」）**结果正确**（无发散可腐蚀）——这点无风险。
- 但计划 3.1（:64）引 serialize.ts:493-509 论证「一个 entry 可有多条 outbound_response 行」在生产**不成立**；§4 测试（:94）「多 attempt 行断言各 outbound_response 行都被改」**无法构造真实夹具**（只有 1 条行），实现者可能去手造并不存在的 stage 布局，或误以为漏改。

**建议：** 计划把该前提修正为「多 attempt entry 仅 final 1 条 outbound_response 行；per-row 写法是对未来 fail-safe 的正确形状，非当前有多行」。§4 对应测试改为「多 attempt entry 断言其**唯一** outbound_response 行被正确 patch」。richest-data-flow 角度：per-row 写法保留（未来若非 final 也存 usage 则自动正确），只是别在测试里假设当前有多行。

---

## MEDIUM-2 — write-path 幂等的真陷阱（共享内存对象双减）未点破

**证据：** head 列（serialize.ts:222-225）与 final outbound_response blob（serialize.ts:506）落盘是两处独立存储（裸 number 列 vs 独立压缩 JSON 帧），at-rest 无共享引用。**但 backfill 若用 `assembleFullEntry` 得到一个 usage 对象、再把它同时当 head 源和 stage 源各减一次，会因内存共享引用双减腐蚀**（`assembleFullEntry` 的 base.outboundResponse 与列读的是同一逻辑 usage）。

计划 3.1/3.3「分别 patch 列 + blob、靶向解压」措辞**方向正确但未显式点破这个红线**。实现须落实为：**head 腿读列数值（number）自己减；stage 腿 decompress blob 得到独立 JSON 对象自己减；两腿绝不复用同一内存对象**。否则 `input -= cache_read` 在共享对象上跑两次 → net 被减两次 cache_read。

**建议：** 计划实现注释里明写「head 与 stage 两腿各自独立读取/减法，禁止共享同一 usage 对象引用」，并在 §4 加一个断言：backfill 后 `列.input_tokens === getEntryById(id).outboundResponse.usage.input_tokens`（独立 oracle，同时钉死两腿都恰好减一次、且彼此一致）。计划 §4 已有类似断言（:94「列 + blob 同时为净值」），补上「值相等」即可覆盖此陷阱。

---

## MEDIUM-3 — write-path 置标记的语义须明确「总是写 1」，避免 re-upsert 竞态

**证据：** in-flight 行经**多次** head upsert：eager-head（entries.ts:307，pending）、head-status（:315，executing/streaming 转换）、stage（:329）、finalize（write.ts:135/141）、tombstone（entries.ts:266/268）。全部走 `INSERT_ENTRY_SQL` 的 `ON CONFLICT DO UPDATE`（write.ts:34-57）。

计划 1b 担忧「re-upsert 会不会把 usage_normalized 覆盖回 0 或漏置 1」——这是**真问题**。两种正确解：
- **方案 A（推荐，与 pinned 先例一致）**：`usage_normalized` **不进** `INSERT_ENTRY_SQL` 的列清单（像 pinned 一样 write.ts:34 省略它），靠 `ADD COLUMN` 的 `DEFAULT 0` 落新行=0，再由一条 finalize 专属 UPDATE（或 buildHeadRow 后单独 set）在**终态**置 1。但这引入「新行生来 0、终态才 1」的窗口，backfill `WHERE usage_normalized=0` 会扫到未终态的 in-flight 行——需 `AND status NOT IN (active)` 排除，或接受 in-flight 行被 backfill 跳过（它们 usage 尚 null，减法 no-op 安全）。
- **方案 B（计划当前隐含）**：`usage_normalized` 进 INSERT 列清单，`buildHeadRow` 恒给 1，每次 upsert 都写 1。**只要生产码所有 usage 写入点都产净值**（part1 保证），恒写 1 正确。但须注意：eager/pending 阶段 usage 可能 null（无 usage），此时置 1 也安全（无 cache 可双减）。

**裁定：** 计划 3.2（:74）「所有新行 usage_normalized=1（生来即净值）——改 INSERT_ENTRY_SQL + buildHeadRow」是**方案 B**，正确但**必须显式说清**：(a) buildHeadRow 恒设 1（不是条件设）；(b) INSERT 的 DO UPDATE SET 子句也要含 `usage_normalized = excluded.usage_normalized`（否则 re-upsert 时 DO UPDATE 不更新它——虽然恒 1 时无害，但语义要闭环）；(c) part1 生产净值化必须先于/同 commit 落地，否则「标记 1 但值仍是含缓存」会让 backfill 跳过一个未净值的行（真数据错误）。计划 Commit 顺序约束（:117）「schema 列 → 生产端+写路径置标记 → backfill」**已覆盖 (c)**，但 (a)(b) 的 SQL 细节须写进计划避免实现漏 DO UPDATE 子句。

---

## LOW-1 — 「EntryRow + 所有 SELECT * 需加列否则读崩」断言过激

**证据：** `SELECT *`（read.ts:103,200；search-index-backfill.ts:141）经 bun:sqlite `.all()/.get()` 返回**按列名 keyed 的对象**；DB 多一个 `usage_normalized` 列只会让返回对象多一个未用属性，`EntryRow` 接口没声明它是纯 TS 编译期问题，**运行时不会读崩**。计划 1c「否则读崩」不成立。

真实需要的是**反向**：`buildHeadRow` 构造 `EntryRow` 字面量 + `INSERT_ENTRY_SQL` 列清单是**显式**的，所以（方案 B 下）`usage_normalized` 必须加进 EntryRow 接口（serialize.ts:13）+ INSERT 列清单 + VALUES 占位 + `runHeadInsert` 绑定（write.ts:67-94），否则新行**写不进** 1。这是「写侧必须加」，不是「读侧不加会崩」。计划应把 1c 表述改为「写侧 EntryRow/INSERT/bind 三处同步加列」。

---

## LOW-2 — 批级 tx「阻塞正常请求」的机理误框

**证据：** 单进程单连接单线程（见「已验证无虞」）。同步 `db.transaction()` 回调期间**不存在别的 handler 并发跑**——JS 事件循环被这个同步回调独占。所以风险**不是**「持写锁使 handler 的 history 写卡在 SQLITE_BUSY」（计划 #3 表述），而是**事件循环 stall**：若解压/压缩（CPU 重）跑在 tx 同步回调**内**，整个 server 在这段时间不响应任何请求。

计划 3.3「靶向解压应事务外解压/压缩、事务内只 UPDATE」**结论正确且是关键**——但理由该是「避免事件循环 stall」而非「避免持锁跑 CPU」。既有 search-index-backfill 正是这么做：`assembleFullEntry`（:193）+ `buildSearchIndexForEntry`（:195）在 `db.transaction`（:196）**之外**，tx 体只 UPDATE + persist。usage backfill 必须照抄：decompress→patch→compress 全在 tx 外，tx 内只 `UPDATE 列 + UPDATE stage blob + 置标记`。

**另注（批级 vs per-entry tx）：** 计划 3.3「批级原子事务（一批所有行 + cursor 同 tx，任一行失败整批回滚）」**偏离**了 search-index 的 **per-entry tx** 模式（backfill line 196 每 entry 一个 tx）。批级大 tx 的代价：一批 50 行的 UPDATE 在一个同步回调里跑，若某行的压缩已在 tx 外备好，tx 内纯 UPDATE 很快，批级原子可接受；但「任一行失败整批回滚」意味着一个坏 blob 会拖垮整批 49 个好行的进度（虽标记列保证重试安全，但会反复卡在同一坏批）。search-index 用 per-entry tx + per-entry try/catch（:181-206）正是为**隔离单个坏 blob**。建议 usage backfill **沿用 per-entry tx**（每行独立 tx + try/catch 隔离），cursor 每批末尾存一次即可——既得隔离性，又不需要「整批回滚」。若坚持批级原子，须说明如何避免坏行毒批（如坏行标记 skip 而非 rollback）。这点计划把「批级原子」当改进，实则**偏离了既有更健壮的 per-entry 隔离**，属该复核的设计选择。

---

## LOW-3 — 行号漂移（不影响正确性，实现前须重新定位）

- 计划 A「流式 OpenAI recording.ts:132-142」：recording.ts 仅 200 行，OpenAI builder usage 实际在 **135-142**（`buildOpenAIResponseData`）；B「responses:178-189」实际 **182-189**（`buildResponsesResponseData`）。目标函数对，行号偏 3-4 行。
- state.ts:141 计划说加 `startUsageNormalizeBackfill`——实际 141 行是 `startSearchIndexBackfill` 定义处（state.ts:141），计划意图是「在其旁新增」，表述 OK 但「:141 加」易读成「改 141 行」。
- start.ts:542 确为 `startSearchIndexBackfill()` 调用点（已核实），计划「只启 usage、内部 .then 串 search-index」接线正确。

---

## §5 串联时序 — 核验通过

- `stopHistoryBackgroundWork`（state.ts:101-108）先 `stopReaper` + `stopSearchIndexBackfill`（设 flag），**不关 DB**；`closeDatabase` 在 `shutdownHistory`（state.ts:118-126）drain 之后才跑（:124）。计划加 `stopUsageNormalizeBackfill()` 到 stopHistoryBackgroundWork 正确——backfill 检查 flag 于批边界退出、cursor 已存，close 时不会 hit 死句柄（前提：usage backfill 照抄 search-index 的「不订阅 abort signal、每 DB op try/catch」模式，backfill.ts:27-35,247-253）。
- 串联「usage 先跑 .then(search-index)」：两者都 fire-and-forget never-throw，串联合理（usage 快、先跑）。但须确认 `startUsageNormalizeBackfill` 的 `.then(startSearchIndexBackfill)` 里，即便 usage backfill 被 cooperative-stop 中途退出，search-index 仍应启动（stop 是「本次退出」非「永久禁用」）——计划须明确 .then 在 stop 场景下的行为（search-index 自己也会 resume，无害，但语义要清）。

---

## 结论

**放行前必须处理：HIGH-1**（schema 接线二选一，推荐 reconcile 地板；否则实现者制造双机制或撞 duplicate-column wedge）。

**建议吸收：MEDIUM-1/2/3**（虚构多行前提→测试夹具落空；共享内存对象双减红线；write-path 恒写 1 的 SQL 细节 + DO UPDATE 子句）。

**修表述即可：LOW-1/2/3**（读崩断言反了→改写侧加列；批级 tx 机理→事件循环 stall + 建议沿用 per-entry tx 隔离；行号漂移）。

核心正确性（usage 落 stage 行、per-row 标记幂等、净值化算术、O(1) 加列、单帧保真、并发安全）**均已实证成立**。计划 v2 是可执行的，上述为收口项。

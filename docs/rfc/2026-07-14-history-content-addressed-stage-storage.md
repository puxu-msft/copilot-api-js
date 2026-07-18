> **📦 已废弃 / SUPERSEDED（History V2 removal，2026-07-18）** —— 本 RFC 针对 History **V2** 的 `entry_stages` 内联 blob 载体做内容寻址 + coalescing writer 队列改造。该工作从未落地，且随 master 的 History V3 切换（内容寻址 CAS 已是 V3 内建）而整体过时——V2 及其 `entry_stages` 存储于 2026-07-18 移除。本文仅作设计探索历史保留，**不描述任何当前代码**。当前 History V3 内容寻址存储见 skill `history-sqlite-schema`。

# RFC: History content-addressed stage 载体 + per-entry coalescing writer 队列

**状态**: 草案(待 ≥3 轮对抗 subagent review + 用户审阅)
**日期**: 2026-07-14
**作者**: 主会话 + 双异模型 reviewer(热路径审计)
**关联**: 热路径性能审计(2026-07-14,`docs/todo/deferred-backlog.md`「热路径并发/性能审计」节)、skill `history-sqlite-schema` / `history-backfill` / `persistence-async-invariants` / `large-refactor` / `telemetry-architecture`
**前序 RFC**: [2026-07-07-history-data-model-restructure.md](2026-07-07-history-data-model-restructure.md)(client/upstream 双腿 + 逐 attempt 轨,本 RFC 在其载体层之上)

---

## 0. 对抗 review 并入记录

### R1(2026-07-14,双异模型并行:Claude 载体正确性 + GPT 异步不变量/完整性)

主线亲自复核每个 BLOCK 引用的 file:line,全部证实。合计 3 BLOCK + 4 HIGH + 2 MEDIUM,**全部采纳**(均有实测或双 reviewer 独立命中支撑,无不采纳项):

- **BLOCK-A(载体身份,Claude BLOCK + GPT MEDIUM 独立命中)**:stage_blob 若复用 msg_blob 的「config-无关 canonical(剥 cache_control)」边界,会把只差 cache_control 位置的 body(Claude Code 跨 turn 前移场景)误去重成同 hash、只存一份 → read 还原不出各自原位 = 静默数据丢失,违反 §4 byte-equivalence。**根因**:msg_blob 是**有损搜索身份**([normalize-message.ts:146](../../src/lib/history/normalize-message.ts#L146)「hash input AND stored search text」+ `canonicalize` 剥 VOLATILE_KEYS),stage_blob 是**无损存储身份**([compression.ts:63](../../src/lib/history/sqlite/compression.ts#L63) 纯 JSON round-trip),二者身份契约根本不同。**采纳**:stage_blob 用**无损稳定键序 JSON(仅递归键排序、不剥任何字段)** + **全宽 256-bit sha256**(主存储碰撞=静默服务错误 blob,不复用搜索层 128-bit 截断);被 hash 的字节 == 被存储的字节(一处产物);oracle 加「cache_control 前移 twin entries 必须无损还原、绝不 dedup」负样本回归。**收益复核**:主线补证——per-attempt body 只在 cache_control-rejection 反应式腿才改([request-preparation.ts:146](../../src/lib/anthropic/request-preparation.ts#L146)),绝大多数 retry(server-error/429/thinking)各 attempt wire body 逐字节相同,故无损 hash 照样折叠主流 retry 冗余,**根因主体收益(双重压缩根除 + 同 entry retry 去重)全保留**,仅放弃本就不该要的跨 entry 有损折叠(§3.4/§9 tripwire 阈值改无损口径)。
- **BLOCK-B(阶段 2 producer O(1) vs mailbox 存 hash 矛盾,GPT)**:hash 要 canonical+sha256 大 payload;若 producer 在 `upsert` 算 hash 就落在同步 bus 路径([bus.ts:94](../../src/lib/observability/bus.ts#L94) 同步 fan-out)、违反「永不阻塞」。**采纳**:mailbox 存 **`Map<StageKey,{version,payload snapshot}>`**(StageKey=stage+attemptIndex,非 hash set);canonicalize+hash+压缩全在 **writer 侧**;producer 只传 immutable snapshot ref = 真 O(1)。
- **BLOCK-C(无背压 vs 终态驻留有界不可兼得,GPT)**:终态 entry 不再可合并,高到达率下每个新终态新增一个 pending slot、`Map<id,mailbox>` 无界增长(正是 §1.4 现状问题),coalescing 只消同 entry 高频更新放大、消不了高基数终态洪峰。「最小档」验收自相矛盾。**采纳**(用户 2026-07-14 翻转 Q3):overflow **保真优先**——固定并发 writer + resident-byte/entry-count soft limit + 超阈**主动降级 current tombstone 协议**(结构化记 dropped/degraded reason,队列本体有界,terminal 终受 tombstone 保护不丢)+ **三背压信号(queue depth / resident bytes / oldest pending age)不后置**(是「确认 writer 是否落后」的最低必需,非可选遥测);durable journal 仍为过度设计(SQLite 已持久底、单实例内部工具、进程崩溃中途丢在途终态可接受、现状 SIGKILL 亦然),记 backlog。
- **HIGH-1(stage 版本收敛,GPT)**:hash set 无法表达「同一 StageKey 多版本演进 + 旧版过时」(eager `upstream_response` 后 terminal 补 headers/sseEvents,[history.ts:319](../../src/lib/observability/sinks/history.ts#L319))。**采纳**:mailbox stage 用 `Map<StageKey,{version,payload}>`,writer **snapshot-and-swap**(取旧 map 后立即让 mailbox 接新 map)、写成功只确认 snapshot 的 version、绝不删已被新版替换的 StageKey。
- **HIGH-2(in-flight 移除提交点,GPT)**:读路径 in-flight-first([queries.ts:89](../../src/lib/history/queries.ts#L89)),若 enqueue/dequeue/开始 finalize 时就 removeInFlight 而 SQLite 未 commit,`getEntry` 落到不存在/残缺行。**采纳**:terminal entry 直到「final terminal stage + head + search index 已 durable commit」才 removeInFlight;transient 失败保留重排;exhausted/permanent 仅 tombstone/head-only 降级写后移除;summary 加 `persistenceState`(pending 指示,不把「已终态未 durable」伪装成已持久化)。
- **HIGH-3(失败回收 + drain 闭包,GPT)**:现有 `finalizeEntry` 是一整套状态机(finalizing 防重入 + pendingFinalizations 自有 drain + finalizeRetries + tombstone + reaper hook,[entries.ts:136-302](../../src/lib/history/entries.ts#L136)),不能只换 Promise。**采纳**:阶段 2 定明确状态机 `queued→writing(version)→committed`;transient fold-back 到当前 mailbox + 递增 retry + 保持 in-flight;permanent/exhausted/shutdown tombstone barrier;self-owned drain 等「mailbox 空 + active writers 零 + retry/tombstone settle」while 至静止;shutdown 后仍可入队 → admission/closing 状态 + 末次 quiescence loop;reaper hook 迁移保留重入守卫 + DI seam。
- **HIGH-4(阶段 2 只留 class 名)→ 采纳**:阶段 1 实测前就补一份阶段 2**协议级** spec(数据所有权/slot snapshot/成功提交点/失败重试/tombstone/drain/overflow 全定,仅 writer 并发度等参数延后标定),避免阶段 1 API 无法为 queue 提供无同步 CPU 输入而返工。
- **MEDIUM(载体等价规则开放却已承担正确性,GPT)→ 采纳**(并入 BLOCK-A):hash 输入必须可逆无损 canonical serialization、为等价 serialization 定 version/domain prefix 防未来 canonicalization 演进混入同一 hash namespace。
- **MEDIUM(去重收益叙述偏乐观,Claude)→ 采纳**:§3.4/§9 按无损口径陈述预期去重率,tripwire 以「同 entry retry 折叠」为主证据、不以跨 entry 共享为达标条件。
- **主观建议(Claude/GPT)→ 采纳**:§2.1 加身份契约边界声明(msg_blob 有损搜索身份 / stage_blob 无损存储身份,只共享机制不共享 normalize 边界)+ skill `history-sqlite-schema` 留教训钩子;§4/§9 加 cache_control 前移负样本回归;删「终态 40ms 在 settle 后故无害」的分片拒绝理由(仍与同一 event loop/WS/查询竞争,是否分片由实测定)。

---

## 1. 问题陈述(带 file:line 证据)

来源:2026-07-14 热路径性能审计,双异模型 reviewer(Claude 并发 + GPT 性能)+ 主线亲自复核。5 条 HIGH 中 4 条同根——**history 持久化路径的同步 CPU/I-O 阻塞全并发事件循环**。

### 1.1 同一份数据被序列化压缩 2~N 次(根因)

`insertCompletedEntry`([sqlite/write.ts:138-164](../../src/lib/history/sqlite/write.ts#L138))在 finalize 时:

- **L148** `extractStagePayloads(entry)` 从整个 entry **重新提取所有 stage**;
- **L158** `DELETE FROM entry_stages WHERE entry_id = ?` **删掉 eager/attempt 已写过的全部 stage 行**;
- **L150/159** 全部 stage **重新 `compressAsync` + 重新 INSERT**。

即:eager 压过的 `client_request`、每个 attempt 压过的 stages,在 finalize 被**整体 DELETE 后重新序列化+压缩+重写一遍**。增量写(`persistEntryEager`/`persistEntryStages`,[entries.ts:311/331](../../src/lib/history/entries.ts#L311))的成果在 finalize 被完全丢弃重做。**同一份 blob 被 stringify+zstd 了 2 次(eager+finalize),retry 下更多。**

### 1.2 `request_group` 折叠是「累积大 entry」载体的 finalize-time 产物

`partitionStagesForWrite`([serialize.ts:858](../../src/lib/history/sqlite/serialize.ts#L858))把 >90% 冗余的重复 request bodies 折进一个 `request_group` 大 JSON array frame([serialize.ts:865](../../src/lib/history/sqlite/serialize.ts#L865)),单 zstd 帧存。它减少 frame **数**,但:①`JSON.stringify(request_group)` 输入仍是全量(审计实测 10.4MB request_group ≈ 40ms 单块);②必须**看到所有 attempt 才能折**,天生是 finalize-time 重活;③读路径 `decodeStageRows`([serialize.ts:833](../../src/lib/history/sqlite/serialize.ts#L833))要展开还原,增复杂度。

### 1.3 残留同步 CPU + 同步 SQLite 写阻塞全并发

- finalize 前置 `JSON.stringify`(~40ms)+ `buildAux` jsdiff(~23ms)仍在主线程([compression.ts:49-54](../../src/lib/history/sqlite/compression.ts#L49) 注释自证只 offload zstd);8 并发 finalize 事件循环 max-gap ≈ 614ms(`docs/spec/history-finalize-async-offload.md`)。
- eager/attempt/status 三条写**在请求生命周期内同步**压缩+写([sinks/history.ts:216/222/142](../../src/lib/observability/sinks/history.ts#L216))。微基准(2MB payload,隔离 in-memory SQLite):eager 14.9–22.9ms / attempt 15.6–23.3ms / status 3.6–29.2ms,全连续主线程停顿。
- `busy_timeout=5000`([connection.ts:32,67](../../src/lib/history/sqlite/connection.ts#L32))把 SQLite 锁等待变成最长 5s 同步冻结(仅外部持锁时触发,非稳态)。

### 1.4 未决 finalize 无界内存(关联)

`pendingFinalizations`([entries.ts:151](../../src/lib/history/entries.ts#L151))无并发上限/背压,每个 pending 闭包持有完整多 MB `HistoryEntry`;终态到达率超四线程 libuv 压缩吞吐时驻留线性增长。

**总结**:根不是「JSON 是坏载体」,而是**累积完整 entry → finalize 全量重序列化**这个载体策略。项目已有 `msg_blob` content-addressing(message 层去重,[schema.ts:99](../../src/lib/history/sqlite/schema.ts#L99)),但 stage 层仍是「内联 blob + finalize 全删重压」。

---

## 2. 设计决策

### 2.1 content-addressed stage 载体(阶段 1,根因主体)

把 content-addressing **机制**(内容寻址 + `INSERT OR IGNORE` + orphan GC)从 message 层推广到 stage 层:stage payload 内容寻址,同 hash 只存一份 blob、一生只压一次,增量以终态形态写、finalize 不再全删重压。

**承重边界声明(R1 BLOCK-A)**:stage_blob **只共享 msg_blob 的机制,绝不共享其 normalize 边界**。二者是根本不同的身份契约——
- `msg_blob` = **有损搜索身份**:存 normalize 后的搜索文本(剥 `VOLATILE_KEYS`/cache_control、`undefined→null`、键排序),从不用于还原原文,碰撞仅致搜索噪声可容忍。
- `stage_blob` = **无损存储身份**:存原始 payload 的无损 JSON round-trip([compression.ts:63](../../src/lib/history/sqlite/compression.ts#L63)),是 `assembleFullEntry` byte-equivalence 还原的**主载体**,碰撞=静默服务错误 blob。

故 stage_blob 用**无损稳定键序 JSON(仅递归键排序保证 order-independent、不剥任何字段)** + **全宽 256-bit sha256**,`被 hash 的字节 == 被存储的字节`(一处产物,杜绝 hash/store 形态漂移)。skill `history-sqlite-schema` 留钩子:「content-addressing 复用要区分有损搜索身份 vs 无损存储身份」。

### 2.2 per-entry coalescing writer 队列(阶段 2,既定交付)

producer(同步 bus handle)只做 O(1) 内存 slot 合并,永不阻塞/压缩/写盘;独立 async writer loop 串行取 dirty slot 写库。**无条件做**——producer 永不阻塞是正确架构本身,不以「实测是否显著」为 go/no-go 门(用户 2026-07-14 明确);实测只标定并发度/是否分片。

### 2.3 阶段边界与依赖

阶段 1 是根因、独立可交付,先落地并实测;阶段 2 在 content-addressed 载体之上做 coalescing(在旧「全删重写」载体上做 coalescing 会打架)。阶段 2 spec 在阶段 1 实测数据出来后写(参数标定),但**交付确定性不依赖实测**。

---

## 3. 阶段 1 架构:content-addressed stage 载体

### 3.1 Schema(Umzug migration,forward-only)

```sql
-- 新表:content-addressed stage blob 池(共享 msg_blob 机制,不共享其 normalize 边界)
CREATE TABLE stage_blob (
  hash    TEXT PRIMARY KEY,   -- FULL-WIDTH sha256(losslessStableStringify(payload)) — 256-bit(64 hex),不截断
  blob_gz BLOB NOT NULL       -- zstd(losslessStableStringify(payload))。一生只压一次;被 hash 的字节==被存储的字节
);

-- entry_stages:blob_gz 内联 → hash 引用
-- (迁移经新列 + backfill + 旧列保留读时兜底,见 §5)
ALTER TABLE entry_stages ADD COLUMN hash TEXT;   -- backfill 后成为主载体
CREATE INDEX idx_entry_stages_hash ON entry_stages(hash);   -- orphan GC 反查
```

**`losslessStableStringify`(R1 BLOCK-A / MEDIUM)**:仅递归**键排序**保证 order-independent 序列化,**不剥任何字段**(不引 msg_blob 的 `VOLATILE_KEYS`/cache_control strip、不做 `undefined→null` 语义偏移)。为等价 serialization 定 **version/domain prefix**(如 hash 输入前缀 `stagev1:`),避免未来 canonicalization 演进将不同规则混入同一 hash namespace。stage 层需要「同 hash ⟺ 同值」**双向**成立(无损存储身份),这是它与 msg_blob(有损搜索身份、单向)的根本区别。

### 3.2 写路径(增量、幂等、只压一次)

```
产生 stage payload(eager client_request / attempt 各 stage / 终态 upstream_response)
  → canonical = losslessStableStringify(payload)      仅键排序,不剥任何字段(无损)
  → hash = sha256(domainPrefix + canonical)           全宽 256-bit
  → INSERT OR IGNORE stage_blob(hash, zstd(canonical)) 已存在同 hash → 零压缩、零写(去重命中)
  → INSERT OR REPLACE entry_stages(entry_id, stage, attempt_index, hash)   只写引用行(极小)
```

**关键:被 hash 的 canonical 字节 == 被 zstd 存储的字节**(一处 `losslessStableStringify` 产物,hash 与 store 共用),故 read 解引用 `decompress(stage_blob.blob_gz)` = `JSON.parse(canonical)` 与原 payload **值等价**(键序在 read 侧不可观测,assembleFullEntry 输出逐字节等价)。

### 3.3 finalize 的根本简化(对比 write.ts:148-162)

- **删除** `extractStagePayloads` 全量重提 + `DELETE FROM entry_stages` 全删 + 全量 `compressAsync` 重压。
- finalize 只:①补写终态才有的 stage(最后 upstream_response 若未写、`_index`)②upsert head 终态列 + head-meta blob。已写过的 client_request/attempt stages **原地不动**(hash 引用已在)。
- **消除** `partitionStagesForWrite` / `request_group` 折叠整条路径——content-addressing 已从根去重,retry 重复 body 同 hash 自动共享一份 stage_blob。

### 3.4 去重收益(无损口径,R1 MEDIUM)

按**无损 hash** 口径陈述(不剥 cache_control):

- **同 entry retry(主收益,无损可得)**:N 个 attempt 的 request body 逐字节相同(cache_control 由 client 每请求设定一次、绝大多数 retry 腿间不变——仅 cache_control-rejection 反应式腿改 body,[request-preparation.ts:146](../../src/lib/anthropic/request-preparation.ts#L146))→ **同 hash 只存一份、一生只压一次**,entry_stages 只多 N 行小引用。
- **双重压缩根除(不依赖跨条去重)**:eager 写的 hash 在 finalize 复用,不重压([§3.4 与 §1.1 根因直接对应])。
- **跨请求(次级,无损下降级)**:相同 system prompt / tools 定义**逐字节相同**才共享 stage_blob;若仅差 cache_control 位置则**不再命中**(客观上就是不同 body,把它们当同一份存本身即数据丢失)——这是正确的降级,不是收益损失。
- **dedup-ratio tripwire(§9)阈值以「同 entry retry 折叠」为主证据**,不以跨 entry 共享为达标条件,避免把「正确的较低去重率」误判为回归。

### 3.5 orphan GC(复用 msg_blob 成熟模式)

`stage_blob` 无 FK。任何 delete(reaper / deleteSession / deleteEntries / clearAll,[write.ts:217-278](../../src/lib/history/sqlite/write.ts#L217))后跑:

```sql
DELETE FROM stage_blob WHERE NOT EXISTS (SELECT 1 FROM entry_stages WHERE entry_stages.hash = stage_blob.hash)
```

必须 hook **每个** delete 站点(skill `history-sqlite-schema` C3 教训:漏一处则 freed blob 永久泄漏)。`clearAllEntries` 用裸 `DELETE FROM stage_blob`(全清,免 NOT EXISTS 扫)。

---

## 4. 读路径 byte-equivalence(验收核心)

`decodeStageRows`([serialize.ts:833](../../src/lib/history/sqlite/serialize.ts#L833))+ `loadStagesFor`([read.ts:25](../../src/lib/history/sqlite/read.ts#L25))改为从 `entry_stages.hash` JOIN `stage_blob` 解引用:

```sql
SELECT es.entry_id, es.stage, es.attempt_index, es.created_at, sb.blob_gz
FROM entry_stages es JOIN stage_blob sb ON sb.hash = es.hash
WHERE es.entry_id IN (...)
```

**承重不变量(skill `large-refactor` byte-equivalence)**:`assembleFullEntry` 对新旧行输出**逐字节等价**。旧行(内联 blob / request_group 折叠)经读时兜底(旧列或 request_group 展开分支保留)、新行经 hash 解引用,两路输出同一 `HistoryEntry`。独立 oracle = 改动前锁旧代码的 golden fixture(对真实 history.db 抽样 entry 组装结果)。

---

## 5. 迁移 + backfill(skill `history-sqlite-schema` / `history-backfill`)

- **migration**(Umzug hybrid forward-runner):加 `stage_blob` 表 + `entry_stages.hash` 列。幂等地板不动、只追新 migration。
- **backfill**(可恢复、非阻塞、never-throw):遍历旧 entry_stages 行 → decompress 内联 blob(或展开 request_group)→ 重新 canonical-json + hash → `INSERT OR IGNORE stage_blob` + 回填 `entry_stages.hash`。
  - `history_meta` version 守卫 + `(started_at,id)` keyset 续跑 + 协作 stop 匹配 shutdown phase(skill `history-backfill`)。
  - per-row 标记幂等(已回填 hash 的行跳过)。
  - dedup-ratio tripwire:backfill 后 stage_blob 行数应显著 < entry_stages 行数(去重生效的正样本)。
- **双轨读**:backfill 未跑完期间,读路径对 `hash IS NULL` 的旧行走内联 `blob_gz`(或 request_group 展开),`hash` 非空走 stage_blob。backfill 完成 + meta-flag 置位后可删旧列(独立收尾,no-auto-server)。

---

## 6. 阶段 2 架构:per-entry coalescing writer 队列(协议级,R1 BLOCK-B/C + HIGH-1~4)

_(数据所有权/slot snapshot/成功提交点/失败重试/tombstone/drain/overflow 在此定死;仅 writer 并发度 N、是否分片等**参数**在阶段 1 实测后标定。完整 spec 在阶段 1 落地前另出 `docs/spec/`,本节是其协议骨架。)_

### 6.1 数据结构(BLOCK-B / HIGH-1:存 payload snapshot 非 hash)

```
EntryMailbox {
  head:      HeadPatch                              // 覆盖写:最新期望态(status/timing/legs)
  stages:    Map<StageKey, { version, payload }>    // StageKey = `${stage}:${attemptIndex}`;payload=immutable snapshot ref
  finalize?: { entry: HistoryEntry, version }        // 终态 barrier 标记(见 6.3)
  state:     "queued" | "writing" | "committed"
}
HistoryWriteQueue { mailboxes: Map<id, EntryMailbox>; residentBytes; oldestPendingAt; ... }
```

- **producer 侧真 O(1)**(BLOCK-B):`queue.upsert(id, {head?, stage?})` / `queue.markFinalize(id, entry)` 只做 `Map` slot 合并 + 存 **immutable payload snapshot 引用**,**canonicalize + sha256 + zstd 全在 writer 侧**——producer 永不算 hash/不压缩/不写盘。`putInFlight` + WS publish 保持同步即时(UI/Live 零回归)。
- **stage 覆盖是 Map 非 Set**(HIGH-1):同一 StageKey 的新版就地替换旧版 + 递增 `version`(eager `upstream_response` 后 terminal 补 headers/sseEvents 属同 StageKey 演进,[history.ts:319](../../src/lib/observability/sinks/history.ts#L319))。

### 6.2 writer 提交语义(HIGH-1 snapshot-and-swap)

writer 取 slot 时**先 snapshot-and-swap**:取出当前 `stages` map + `head` + `finalize`,立即让 mailbox 接收新的空 map(后续 producer update 进新 map);writer 异步 canonicalize+hash+压缩+SQLite tx;**写成功只确认本次 snapshot 的 version**,绝不删已被新版替换的 StageKey(写期间入队的新版留给下一轮)。finalize 是同一序列上的 **barrier**:仅当该 entry 的 terminal head + 所需 terminal stages + search index 全部 durable commit,才进入 finalize outcome。

### 6.3 in-flight 移除提交点(HIGH-2:防「内存已删、SQLite 未可读」)

读路径 in-flight-first([queries.ts:89](../../src/lib/history/queries.ts#L89)),故:
- terminal entry **直到 durable commit 成功**才 `removeInFlight`(不在 enqueue/dequeue/开始 finalize 时删)。
- transient 失败**保留 in-flight** + 重排(沿用 `finalizeRetries` 语义)。
- permanent/exhausted 仅在 tombstone / head-only 降级写尝试**结束后**移除。
- `getEntry` 在 terminal-queued 状态仍返回完整 in-flight snapshot;summary 增 **`persistenceState`**(pending 指示),不把「已终态未 durable」伪装成已持久化。

### 6.4 失败回收状态机 + drain 闭包(HIGH-3:整体迁移非丢失协议)

- 状态机 `queued → writing(snapshot version) → committed`;transient failure → snapshot **fold-back** 到当前 mailbox(与写期间新 patch 合并)+ 递增 retry + 保持 in-flight;permanent/exhausted/shutdown last-chance → tombstone barrier(同步或独立可 drain),仅其完成后释放 in-flight。
- **self-owned drain**(复用 `persistence-async-invariants` §1 精神)必须 `while` 至静止:等「mailbox 为空 + active writers 为零 + retry/tombstone 均已 settle」。shutdown 开始后仍可由正在 drain 的 request 入队 → 需 **admission/closing 状态** + 末次 quiescence loop(不能只 await 当时捕获的 promise 集,drainPendingFinalizations 现仅覆盖已启动 promise)。
- reaper hook 从 `retryPendingFinalizations` 迁移到 queue 后**保留重入不双写守卫 + 可测 DI seam**([entries.ts:136-302](../../src/lib/history/entries.ts#L136))。

### 6.5 overflow / 背压(BLOCK-C:保真优先,用户 2026-07-14 翻转 Q3)

- 固定并发 writer + **resident-byte / entry-count soft limit**;超阈**主动降级为 current tombstone 协议**(写 head + 小 essential stages,结构化记 `dropped/degraded reason`)→ 队列本体有界,terminal 终受 tombstone 保护不丢。
- **三背压信号不后置(本阶段必交付,非可选遥测)**:`queue depth` / `resident bytes` / `oldest pending age`——是「确认 writer 是否落后 / 是否永久积压」的最低必需。经 telemetry registry 暴露(skill `telemetry-architecture`)。
- 可丢边界:允许丢弃低价值 **非终态** eager/status patch(明确定义哪些 stage 可丢),**terminal finalization 绝不静默覆盖**、始终受 tombstone 保护。

### 6.6 承重不变量

①producer 永不阻塞(hash/压缩全 writer 侧)②in-flight 与 writer 解耦但移除点=durable commit ③coalescing 保序(finalize barrier,不另开 `void finalizeEntry`)④stage Map 版本收敛、head 覆盖写 ⑤复用 `persistence-async-invariants` 骨架(self-owned drain / never-throw / re-entrancy / tombstone,整体迁移非替换单 Promise)⑥队列有界(soft limit + 降级)。

---

## 7. Rejected alternatives / deferred

- **worker 线程卸载 CPU(B/C 方向)** — 已拒(用户 Q1 选 A)。理由:`worker_threads` 跨线程共享 bun:sqlite DB 句柄能力存疑(`bun-node-runtime-gotchas` 雷区),多 MB entry structured-clone 进 worker 有拷贝成本,ROI 存疑;单线程 + content-addressing 已崩塌同步成本。记 backlog:若阶段 1+2 后终态单块仍是实测瓶颈,再评估 worker CPU 卸载。
- **durable journal/outbox(BLOCK-C 强档)** — 阶段 2 取「保真优先」(用户 2026-07-14)。若要「无损 + 内存有界」兼得,journal 是所需持久化边界;但 SQLite 已是持久底、单实例内部工具、进程崩溃中途丢在途终态可接受(现状 SIGKILL 亦然,eager 已留 pending 行),故 soft-limit-降级已够,journal 记 backlog。
- **分片序列化器**(阶段 2 内,消终态 40ms 单块) — 取「接受单块 + 实测再定」(用户 Q4,R1 建议修正)。**注**:终态 40ms 虽在客户端请求 settle 后,但仍与同一 Bun event loop / WS 广播 / history 查询 / 后续请求**竞争执行资源**——是否分片**由实测决定**,不据「已 settle」推导无影响。记 backlog,实测触发再做。

---

## 8. Open questions(给用户 / 待实测,正确性问题已在 §0 定案)

_(R1 后原 OQ1「hash 边界」、OQ2「hash 截断」已被 byte-equivalence 钉死为正确性问题、定案无损全宽,移出 open questions。)_

1. **旧列删除时机**:backfill 完成后删 `entry_stages.blob_gz` + 退役 request_group 读分支,等运行期 backfill 跑完(no-auto-server,仿前序 P6b)?
2. **dedup-ratio 实测阈值**:无损口径下同 entry retry 折叠率的实测基线(设 tripwire 用),待真实 history.db 采样。
3. **阶段 2 writer 并发度 N + soft limit 阈值**:待阶段 1 实测终态写耗时 + 终态到达率分布后标定。

---

## 9. 验证

- **阶段 1**:read 路径 byte-equivalence golden(真实 history.db 抽样)+ **cache_control 前移 twin entries 必须无损还原、绝不 dedup 的负样本回归**(R1 BLOCK-A,命名 `cache_control-shifted twin entries reconstruct losslessly`)+ 「字段顺序不同 hash 相同且 round-trip 原值相同」正样本 + backfill dedup-ratio tripwire(无损口径,同 entry retry 为主证据)+ orphan GC **每站点**覆盖(deleteSession/deleteEntries/clearAllEntries/reaper 全清单,含 clearAllEntries 补 `DELETE FROM stage_blob`)+ migration 跨 runtime(Bun/Node)e2e。
- **阶段 2**:`persistence-async-invariants` 全不变量(drain-before-close / never-throw / re-entrancy)+ producer 永不阻塞 metronome oracle + **writer snapshot race**(写旧 snapshot 时 producer 合并新版,验不丢新版)+ **in-flight 可见性**(writer 被 gate 时发起 terminal、并发查单条/列表、再放行,验不返残缺)+ **writer 失败 fold-back** + **shutdown 期间 terminal 到达** + **overflow 降级**(超 soft limit 走 tombstone、terminal 不丢)+ 三背压信号断言。
- **实测标定**:阶段 1 前后事件循环 max-gap 对比(metronome)、双重压缩消除的 CPU 节省、无损去重率;阶段 2 writer 并发度 + soft limit 阈值。

---

## 10. Cutover 计划(commit invariants,skill `large-refactor`)

_(待填:每 commit 终态不变量,过渡态显式无害。阶段 1 迁移→双轨读→backfill→收尾删旧列,各 commit 独立可交付、中间态绝不半坏。)_

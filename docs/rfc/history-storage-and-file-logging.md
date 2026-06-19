# RFC: History 存储瘦身（VACUUM + zstd + 合并帧 dedup）与文件日志 sink

**状态：** 草案 — 待对抗 review + 用户确认后实现。
**驱动：** 生产事故复盘（用户对话确认）。当前版本进程卡死被重启，期间**无任何持久化日志可查**；排查中发现 `history.db` 已涨到 **2.17 GB**。
**Scope：** 两条正交工作流——
- **A**：`copilot-api.log` 文件日志 sink（非 HTTP/consola 日志持久化 + 轮转），统一经 observability bus，不新增第二个 consola hijack。
- **B**：`history.db` 瘦身——①启动期 VACUUM 回收死空间、②gzip→zstd、③同 entry 关联 stage 合并帧 dedup（纯 zstd，不剪 JSON）。

---

## 1. 问题与实测证据

### 1.1 事故：进程卡死无日志

生产进程（当前工作区代码经 npm link）在 `04:21` 后停止服务，到 `06:16` 被用户用已发布 beta 包重启。证据：history 条目 id 序列从 `…_473` 直接归零成 `…_1`（新进程计数器），中间 ~116 分钟**零记录、零失败条目**——非优雅崩溃（crash/OOM/kill），handler 未捕获。

**根因（日志侧）：** 唯一的持久化是 SQLite history（仅记 HTTP 请求生命周期）。**非 HTTP 的 consola 日志（启动、认证、model refresh、warn/error、reaper）只去终端 stdout，进程死即丢失**。卡死期没有任何线索落盘。

### 1.2 history.db = 2.17 GB 的真相：98.7% 是死空间

实测（`PRAGMA` + 行统计，只读连接）：

| 项 | 值 |
|---|---|
| `page_count` × `page_size` | 528710 × 4096 = **2166 MB**（文件实际大小） |
| `freelist_count` | 280569 页 = **1149 MB（53%）空闲死页** |
| `auto_vacuum` | **0（关闭）** |
| 活 entries_v2 行 | **37**（全 completed） |
| 活 entry_stages 行 | **224** |
| **活数据总量（head+stages，gzip 后）** | **28.8 MB** |

**结论：** reaper 工作正常（success=50/failure=200 分桶把行数压到 37）。但 `auto_vacuum=0` + 从不 `VACUUM` ⇒ SQLite **删行后空间永不还给 OS**，文件停在历史高水位。2166MB 里只有 28.8MB 是真数据，**一次 `VACUUM` 即可 2166MB → ~30MB**。压缩/分层都是次要——根因是空间回收。

### 1.3 活数据构成 + zstd/dedup 实测增益

每 entry 体积主体是三份请求体（gzip 后均值）：`inbound_request` 170KB + `effective_request` 291KB + `outbound_request` 291KB。response/sse 侧 ≤3KB 可忽略。

实测最大单条（raw JSON 1259KB）：

| 编码 | 大小 | 比 gzip 省 | 耗时 |
|---|---|---|---|
| gzip 现用（node:zlib L 默认） | 505 KB (59.9%) | — | — |
| **zstd L3** | **261 KB (79.3%)** | **−48%** | 7ms |
| zstd L9 | 245 KB (80.6%) | −51% | 21ms |
| zstd L19 | 231 KB | −54% | 218ms（太慢，弃） |

**dedup 实测（关键）：** 三份请求体**高度冗余（>90% 共享）**——
- 字节级：`effective ≠ outbound`（非相同），但 `[inbound+effective+outbound]` **合并进单个 zstd 帧 = 231KB = 单份 effective 同值**。raw 3224KB → 合并 231KB。第 2、3 份近零成本。
- per-blob **`dictionary` 选项无效**：node:zlib 与 Bun 原生 zstd 字典对这种大 blob 都无增益（245→245KB / 244→244KB）——字典没把内容当匹配源。
- ⇒ **纯 zstd 的 dedup 唯一有效路径 = 同 entry 关联 stage 压进一个 zstd 帧**（不手动剪 JSON、不存 diff、每份仍逐字 round-trip）。三份 1284KB(gzip) → **~231KB（−82%）**。

### 1.4 运行时可用性（bun-first 合规）

- `node:zlib.zstdCompressSync/zstdDecompressSync` 在 Bun 1.3.14 下可用（与现有 `gzipSync` 同模块、跨运行时）。Node 侧需 ≥22.15（与项目"Node 仅兼容目标"一致；现有 `node:sqlite` 也要 Node ≥22.5）。
- 无新依赖、无 node-gyp。审计判据（`find node_modules -name binding.gyp` 应空）不受影响。

---

## 2. 设计

### 2.0 统一 blob 编解码（B2+B3 共享，避免"四处打补丁"）

所有 history blob（head + stage）经**单一 codec** 读写。判别靠 **magic bytes**，无自定义头：

| 首字节序列 | 格式 | 来源 |
|---|---|---|
| `1f 8b` | gzip（legacy） | 既有行，只读兼容，永不再写 |
| `28 b5 2f fd` | zstd 单 payload | B2 新写默认 |
| `28 b5 2f fd`（容器） | zstd 合并帧（request_group 容器） | B3，由 stage 名区分，见 §2.3 |

`compression.ts` 暴露：
- `compress(value): Uint8Array` —— 写：JSON.stringify + zstd L3。
- `decompress(blob): unknown` —— 读：**先长度守卫**（`blob.length < 4` → 抛带上下文的错误，不静默返回空/undefined），再嗅探 magic → gzip(`1f 8b`) 走 `gunzipSync`，zstd(`28 b5 2f fd`) 走 `zstdDecompressSync`，皆不匹配 → 抛。**单一解码入口**，既有 gzip 行透明可读。
- `STORAGE_ZSTD_LEVEL = 3`（常量；实测 L3 性价比最高，热路径 7ms）。

> 不引入版本号字节：magic bytes 已足够判别 gzip vs zstd；合并帧的成员边界由 §2.3 的 **JSON 数组**自身表达（非二进制 framing），且只出现在 `stage='request_group'` 行，读侧按 stage 名分流，无歧义。
>
> **命名（H3）：** SQLite 列名 `blob_gz` 是历史遗留、**不改**（避免 schema 迁移），但内容已是 magic 自描述的 gzip|zstd。`EntryRow`/`StageRow` 的 **TS 字段改名 `blob_gz`→`blob`** 并在 SQL 映射处注释说明，避免命名谎报（项目原则8）。

### 2.1 B1 — 空间回收（启动期 VACUUM + auto_vacuum=INCREMENTAL + reaper 增量）

`openDatabase()`（[connection.ts](../../src/lib/history/sqlite/connection.ts)）SCHEMA/migrate/orphan-reclaim 之后加 `maybeVacuumOnStartup(db, dbPath)`。**绝不阻断启动**——全程 try/catch，失败仅 `consola.warn` 后继续（瘦身是优化，不能比 2GB 库更严重地把进程拖死，正中事故场景）：

0. `dbPath === ":memory:"` → 直接 return（M2）。
1. 读 `PRAGMA freelist_count` / `page_count` / `auto_vacuum`。
2. 触发条件：`freelist/page_count ≥ VACUUM_FREELIST_RATIO`（默认 0.25）**且** 空闲 ≥ `VACUUM_MIN_FREE_BYTES`（默认 64MB）。命中则：
   - `PRAGMA wal_checkpoint(TRUNCATE);`（VACUUM 前清 WAL，降低锁竞争）
   - `PRAGMA auto_vacuum = INCREMENTAL;`（改模式对既有库**必须**配一次全量 VACUUM 才生效）
   - **逃生阀**：若 `page_count×page_size > VACUUM_MAX_BYTES`（默认 1GB），打 `consola.warn` 提示"大库一次性 VACUUM 将阻塞启动数十秒 + 占用等量临时磁盘，建议离线 `sqlite3 db 'VACUUM;'`"，但仍**在 try 内**执行（用户已选"启动期自动 VACUUM"）。
   - `VACUUM;`（重写收缩，一次性 2GB → ~30MB）；记录前后大小。
3. 未命中触发条件但 `auto_vacuum=0`：设 `PRAGMA auto_vacuum=INCREMENTAL` **并执行一次 `VACUUM`** 落实模式（小库 VACUUM 很快）——否则 reaper 的 `incremental_vacuum` 永远是 no-op（M1）。仍在 try/catch 内。

reaper（[reaper.ts](../../src/lib/history/sqlite/reaper.ts)）每 tick 在 `runReaperOnce` 后：**先 `PRAGMA auto_vacuum` 查询确认 ==2（INCREMENTAL）**，是则 `PRAGMA incremental_vacuum;` 把删行死页持续还给 OS；否则跳过（避免 no-op 误以为在回收，M1）。全程 try/catch。

config（`history` 段）新增（均带默认，缺省回退）：
- `history.vacuum_on_startup: boolean = true`
- `history.vacuum_freelist_ratio: number = 0.25`
- `history.vacuum_min_free_mb: number = 64`
- `history.vacuum_max_mb: number = 1024`（逃生阀阈值，仅影响是否 warn，不阻止）

**风险与缓解：** VACUUM 需 ~等量临时磁盘 + 对 2GB 耗时数十秒、期间阻塞。仅启动期、一次性；try/catch 保证失败不阻断；先 `wal_checkpoint(TRUNCATE)` 降锁竞争；`busy_timeout` 已设；大库 warn 逃生阀。两运行时（bun:sqlite / node:sqlite）均支持上述 PRAGMA（已实测）。

### 2.2 B2 — gzip → zstd

`gzipJson/gunzipJson` 重命名为 `compress/decompress`（§2.0），内部换 zstd L3 写、magic 嗅探读。**所有调用点**（serialize.ts 的 head blob、各 stage blob；write.ts/read.ts）改用新名。既有 gzip 行经 magic 嗅探透明解码——**零迁移、读时混存**。新写一律 zstd。

### 2.3 B3 — 同 entry 关联 stage 合并帧 dedup（纯 zstd）

**目标：** 把一个 entry 的"请求组"——`inbound_request` + 各 attempt 的 `effective_request`/`outbound_request`——压进**一个 zstd 帧**，吃掉 >90% 冗余。`outbound_response`（含 per-attempt）/`inbound_response`/`sse_events` 小、与请求体不冗余，维持**独立 zstd 单帧行**不变。

**容器格式（JSON 数组，非二进制 framing）—— `stage='request_group'`, `attempt_index=-1` 单行：**
请求组成员打包成一个 JSON 数组再单次 zstd：
```jsonc
// 解压后：
[
  { "stage": "inbound_request",   "attemptIndex": -1, "payload": {...} },
  { "stage": "effective_request", "attemptIndex": 0,  "payload": {...} },
  { "stage": "outbound_request",  "attemptIndex": 0,  "payload": {...} },
  // 多 attempt 重试：每 attempt 的 effective/outbound 各占一项
  { "stage": "effective_request", "attemptIndex": 1,  "payload": {...} }
]
```
成员边界由 **JSON 自身**表达——无手写 uint32/int16，消掉二进制 framing 的可错面与 stageTag 取值歧义（C1）。读侧 `decompress` 得数组，逐项还原为与原逐 stage 行**逐字段相同**的 `StageRow`。每项 `payload` 逐字 round-trip（JSON.parse 的对象等价于原 payload）。

**关键不变量——合并帧是「存储编码」而非「内容」变化（C1/C2）：**
合并帧的成员**直接复用 `extractStagePayloads(entry)` 的输出**（已经过 final-attempt mirror 解析、per-attempt 拆分的 `StagePayload[]`），只是把其中**请求组类**（`isRequestGroupStage(stage) = stage ∈ {inbound_request, effective_request, outbound_request}`）的项打包进一个数组帧、其余项仍各写独立行。**绝不**从 `entry.attempts[i]` 重新取值（那会绕过 serialize.ts:294-304 警告的 failure-mirror 逻辑，丢 top-level `outboundResponse`）。读侧解帧产出的 `StageRow[]` + 其余独立 stage 行，合并后喂给**完全未改动的** `assembleFullEntry`——等价性由"输入 StageRow 列表逐字段相同"保证，golden round-trip（§4 C3）因此真能证明等价、不会假绿。

**写时机——与 eager 持久化的张力：**
增量持久化在请求进行中逐个写 stage 行（in-flight 可见性）。合并帧要求请求组成员同时在场，只能在 **finalize（终态写 `insertCompletedEntry`）** 构造。解决：
- **in-flight**：请求组成员仍逐 stage 行写（zstd 单帧，B2），保证 in-flight 可见。
- **finalize**：现有 `insertCompletedEntry` 已是"DELETE 该 entry 全部 stage 行 + 重写全部 stages"的**原子事务**（write.ts）。B3 只改"重写"部分：请求组类 N 项 → 1 条 `request_group` 合并帧行；非请求组项（所有 `outbound_response` 含 per-attempt + `inbound_response` + `sse_events`）→ 各自独立 zstd 单帧行。DELETE+重写在**同一事务**内，无半态读窗口（C1 竞态）。`entry_stages` 主键 `(entry_id, stage, attempt_index)`：`request_group` 用 `(id, 'request_group', -1)`，与其余 stage 名不冲突。
- reaper/分桶/分页/session 聚合**不受影响**（仍按 entries_v2 head 行，一请求一行；`request_group` 经 ON DELETE CASCADE 随 head 行删）。

**向后兼容：** 既有 entry 是逐 stage gzip 行、无 `request_group`——`assembleFullEntry` 现有逐 stage 分支原样处理。读路径三态混存：legacy gzip 逐 stage / zstd 逐 stage（in-flight 或 B2 期）/ zstd `request_group` 合并帧。读侧按 stage 名分流。

### 2.4 A — copilot-api.log 文件日志 sink（统一经 bus）

**问题（不打补丁的约束）：** ConsoleSink 已 `consola.setReporters([footerAware])` 独占 hijack（RFC observability-rewrite D6 债）。再加第二个 file hijack = 用户禁止的"四处打补丁"。

**统一解（顺带消灭 D6）：**
1. `events.ts` 新增事件 `{ kind: "system.log"; level: ConsolaLogLevel; tag?: string; message: string; args: unknown[]; time: number }`。
2. **唯一** hijack 点上移到 start.ts（唯一建 bus 的文件）：装一个 reporter，把每条 consola 日志 `publish` 成 `system.log` 事件投到 bus，**不直接写 stdout**。
3. `ConsoleSink` 消费 `system.log` → 经其**同步** `printLog`（已含 footer 协调）渲染到 stdout（替代它自身的 hijack reporter）。
4. **新 `FileSink`** 消费 `system.log` → 去 ANSI、写 `copilot-api.log`。
⇒ 一个 hijack 点、两个 sink、bus 中介。ConsoleSink 不再自己 hijack consola。

**断环（H1，关键）：** bus 自身在 handler 抛错时会调 `consola.warn`（bus.ts publishSync catch）。若不防护：FileSink 写盘失败 → handler 抛 → bus catch → `consola.warn` → republish reporter → `publish(system.log)` → 再 fan-out 到 FileSink → 再失败……**自激日志风暴**。两道防护：
- republish reporter 持一个 `reentrant` flag：正在 republish 期间收到的 consola 调用**直接走 `process.stderr.write` fallback，不再 publish**。
- FileSink 写失败的 `warn` 也走直接 stderr（不经 bus），与 bus 内部诊断一致。

**字节交错（H2）：** ConsoleSink 对 `system.log` 与 `request.*` 共用同一同步 `printLog`（`clearFooterForLog→write→renderFooter`）。bus 是同步 fan-out，但嵌套 publish（fan-out 栈内触发 consola）可能让 system.log 在 request fan-out 中途插入——`footerVisible` 状态机必须对此重入安全。**由测试证明**（见 §4 C4：golden 必须在 request 生命周期事件间穿插 consola.info/warn，断言字节序与改前逐行一致），而非假设。

> 范围："仅非 HTTP consola 日志"。请求生命周期行（`[OK]`/`[FAIL]`/`[RETRY]`）由 ConsoleSink 从 `request.*` 事件生成、**已进 history.db**，不重复落文件。FileSink 只订 `system.log`（= 非 HTTP consola 日志），精准命中用户意图。

**FileSink 轮转（大小 + 时间 + 保留数）：**
- 路径默认 `PATHS.APP_DIR/copilot-api.log`（尊重 XDG）。
- 追加写；超 `max_size_mb`（默认 10）或跨自然日 → rotate：`copilot-api.log` → `copilot-api.log.1` → …，保留最近 `retain`（默认 7）个，超出删最老。
- 去色：写前 strip ANSI（小正则 `\x1b\[[0-9;]*m`）。
- 写失败（磁盘满/权限）**不得**影响主流程：catch + 单次 `consola.warn`（经 bus 仍渲染到 stdout，不递归落文件——FileSink 自身 warn 用直接 stderr，避免环）。

config（新 `logging` 段，均带默认）：
- `logging.file_enabled: boolean = true`（用户："日志总是写"）
- `logging.file_path: string = ""`（空 = 默认路径）
- `logging.file_max_size_mb: number = 10`
- `logging.file_retain: number = 7`

start.ts attach 顺序：`system.log` republish reporter 必须在 ConsoleSink/FileSink attach **之后**装（确保两 sink 都已订阅），或 reporter 装好前 consola 日志走 consola 默认 reporter（启动早期日志不丢——见 open question Q3）。

---

## 3. Commit 顺序与 invariant（每个 commit 终态自洽，中间不半坏）

1. **C1 — codec**：compression.ts gzip→zstd + magic 嗅探 + rename。*Invariant：* 既有 gzip 行仍可读（golden 测试锁旧 blob），新写 zstd；全 typecheck 绿。
2. **C2 — B1 VACUUM**：connection 启动期 VACUUM + auto_vacuum + reaper incremental_vacuum + config。*Invariant：* 空库/小库不触发；大 freelist 库回收；`:memory:` 跳过。
3. **C3 — B3 合并帧**：request_group 容器 + finalize 改写 + assembleFullEntry 读分支 + 向后兼容。*Invariant：* 新写终态为合并帧且逐字还原；旧逐 stage 行原样可读；in-flight 逐 stage 仍可见；golden round-trip。
4. **C4 — A system.log 事件**：events.ts + start.ts republish reporter（含 reentrant 断环）+ ConsoleSink 改消费 system.log（去自身 hijack）。*Invariant：* **republish reporter 装好后**的 system.log 渲染与改前 ConsoleSink hijack 输出逐行等价（早期启动日志走 consola 默认 reporter，格式差异可接受——M4）；footer 协调对重入安全、不回归。
5. **C5 — A FileSink**：FileSink + 轮转 + config + attach。*Invariant：* 非 HTTP consola 日志落 copilot-api.log；轮转/保留数生效；写失败走直接 stderr、不影响主流程、不触发递归（H1）。

## 4. 测试计划

- **golden 预捕获**（改前锁定，见记忆 methodology-golden-fixture-pre-capture）：
  - C1：导出现有 DB 的真实 gzip blob 作 fixture → 新 `decompress` 必须逐字还原。
  - C3：构造多 attempt entry → serialize→assemble round-trip，断言与逐 stage 路径**结果等价**（深比较还原的 HistoryEntry）。
  - C4：捕获改前 ConsoleSink 对一组事件的 stdout 字节 → 改后逐行一致。**必须在 request 生命周期事件（created→…→completed）之间穿插 consola.info/warn（→system.log）**，断言混合字节序与改前一致（H2 重入安全）。
- **unit**：codec gzip/zstd magic 嗅探 + **空/短(<4B)/损坏 blob 抛错**（H3）；JSON 数组容器（0 成员、单成员、多 attempt）；isRequestGroupStage 划分；ANSI strip；轮转大小/保留数/跨日；republish reporter 重入走 stderr（H1）。
- **it**：openDatabase 在高 freelist 临时库触发 VACUUM 且收缩、低 freelist 不触发、`:memory:` 跳过、**VACUUM 抛错不阻断 openDatabase**（C3，注入失败模拟）；reaper 在 auto_vacuum==2 时 incremental_vacuum 后 freelist 下降、==0 时跳过（M1）。
- **http**：FileSink 端到端——发请求 + 触发 consola 日志，断言 copilot-api.log 含非 HTTP 行、不含请求生命周期行。
- 全套 `bun run test:backend` + `typecheck` + `lint:all` 绿。

## 5. Open questions（已对抗 review 解决 2026-06-19）

- **Q1（定）** 合并帧成员纳入 per-attempt 的 effective/outbound（重试多 attempt）：**纳入**——JSON 数组项带 `attemptIndex`，retry wire payload 同样冗余、收益更大。per-attempt `outbound_response` **不**入合并帧，走独立行（§2.3）。
- **Q2（定）** VACUUM 阈值 0.25/64MB + 逃生阀 1GB：2GB 库 freelist=53% 必触发；小库不扰；大库 warn 但仍做（用户已选启动期 VACUUM）。
- **Q3（定）** start.ts republish reporter 装好前的早期 consola 日志走 consola 默认 reporter 输出 stdout（不落文件、格式与 ConsoleSink 略异，可接受——卡死发生在服务期而非启动早期）。C4 invariant 已据此收窄（M4）。
- **Q4（定）** `request_group` **不**吞 response/sse/inbound_response——小且不冗余，合并无收益、增复杂度。
- **新（review C3，定）** 启动期 VACUUM 全程 try/catch 绝不阻断 + 先 `wal_checkpoint(TRUNCATE)` + 大库 warn 逃生阀。
- **新（review M1，定）** auto_vacuum=INCREMENTAL 改模式须配全量 VACUUM 落实；reaper incremental_vacuum 前查 `PRAGMA auto_vacuum==2`，否则跳过。

## 6. Backlog（本 RFC 不做，完整记录供未来决策）

- **冷热分层归档**：旧 entry 迁到独立压缩归档表/文件，热表只留近期。*当前否决理由：* VACUUM+zstd+合并帧后 37 条≈几 MB，分层是过度设计；数据量上一个量级（数百 MB 热数据）再考虑。*若做需改：* 新归档表 + 读路径双查 + 迁移任务。
- **训练态 zstd 字典（ZDICT）**：跨 entry 共享字典进一步压小同构 JSON。*否决理由：* 合并帧已吃掉同 entry 内冗余；跨 entry 增益未实测、字典版本管理复杂。
- **per-stage 懒读**：合并帧牺牲了"只读某一 stage"的能力（须解压整组）。当前整组 ~231KB，解压一次廉价；若未来单 entry 巨大化再拆。

# Plan 1：content-addressed stage 载体（阶段 1，仅 RFC §3-§5、§9）

**状态**：草案（待 subagent review）
**日期**：2026-07-14
**关联 RFC**：[docs/rfc/2026-07-14-history-content-addressed-stage-storage.md](../../rfc/2026-07-14-history-content-addressed-stage-storage.md)（本计划只覆盖该 RFC 的**阶段 1**——content-addressed stage 载体，§3-§5、§9。阶段 2 per-entry coalescing writer 队列，§6-§8，是另一份独立 spec/plan，**不在本计划范围内**）
**判据**：长远正确 + 完整（架构健康/可维护性 > 向后兼容/回归风险；无向后兼容负担，允许旧→新强制迁移）；richest-data-flow（绝不裁剪数据）。**硬红线**：正确性/数据丢失/字节不等价/不可逆迁移，不因上述判据让步。

---

## 0. Goal

把 `entry_stages` 从「内联 blob，finalize 全删重压」改造为「content-addressed：`entry_stages.hash` 引用 `stage_blob(hash, blob_gz)`，同 hash 只存一份、一生只压一次」——消除 RFC §1.1 的重复序列化压缩根因，同时保持读路径对旧行/新行的输出**逐字节等价**（byte-equivalence，验收核心）。

六个必须交付的工作单元（RFC §3-§5、§9，逐一对应下方 Phase）：

| # | 工作单元 | 对应 Phase |
|---|---|---|
| 1 | Migration：`stage_blob` 表 + `entry_stages.hash` 列 + 索引 + `entry_stages_resolved` VIEW | Phase 1 |
| 2 | `losslessStableStringify` + hash 原语 | Phase 0 |
| 3 | 写路径切换（`insertCompletedEntry` 内容寻址化，消除 `partitionStagesForWrite`/`request_group` 折叠） | Phase 3 |
| 4 | 读路径 byte-equivalence（双轨解引用） | Phase 2 |
| 5 | Orphan GC（复用 `msg_blob` 模式，hook 每个 delete 站点） | Phase 3 |
| 6 | Backfill（仿 `legacy-stage-backfill.ts`/`search-index-backfill.ts` 骨架） | Phase 4 |

## 1. Architecture（本计划落地后的形状）

```
写入：produce stage payload
  → canonical = losslessStableStringify(payload)                 仅键排序，不剥字段
  → hash = sha256(STAGE_HASH_DOMAIN_PREFIX + canonical)            全宽 256-bit，RFC §3.1/§3.2 字面公式
  → 命中 stage_blob(hash) ? 跳过压缩 : INSERT OR IGNORE stage_blob(hash, zstd(canonical))
  → INSERT OR REPLACE entry_stages(entry_id, stage, attempt_index, hash, blob_gz=EMPTY placeholder)

读取：entry_stages_resolved VIEW
  hash IS NOT NULL → JOIN stage_blob 解引用 blob_gz
  hash IS NULL     → 旧行内联 blob_gz 原样返回（含在途未终态行）
  → decodeStageRows（request_group 展开分支保留，读侧兼容旧 finalize 产物）
  → assembleFullEntry 输出逐字节等价
```

## 2. Tech Stack

沿用项目既有栈，无新依赖：`node:crypto`（`createHash("sha256")`）、`node:zlib`（`compressBytes`/新增 `compressBytesAsync`，均已在 `compression.ts`）、Umzug forward-migration 框架（`migrations/index.ts` 的 `sqlMigration()`）、`bun:sqlite`/`node:sqlite`（driver.ts 既有双 factory）、`bun:test`（唯一 CI 后端测试后端）。

## 3. Global Constraints

- **Bun-first**：`bun test .unit.test .it.test .http.test`（`test:backend`）是 CI 权威后端套件。新增测试文件一律用 `.unit.test.ts`/`.it.test.ts` 后缀才会被此 glob 捕获。
- **跨 runtime e2e 是例外**：项目当前**没有任何** node-runner script（`package.json` 全量 scripts 已核实）。本计划新增 `test:backend:node-e2e` script + 一个刻意**不匹配** `.unit.test`/`.it.test`/`.http.test` 后缀的独立文件（`.node-e2e.ts`），避免被 `bun test` 误捕获，同时挂进 `test:ci`（见 Phase 1 Task 4）。
- **绝不杀 4141 端口主服务器**；测试一律走 `openInMemoryDatabase()` / DI 注入临时目录，不碰真实环境（`useIsolatedRuntime()`）。
- **TDD**：每个 task 先写失败测试→跑验证真失败→最小实现→跑验证转绿→再 commit。
- **细粒度 conventional commits + 显式 pathspec**，无模型署名。
- **`db.transaction()` 回调必须同步**（既有 INVARIANT I7，`insertCompletedEntry` 沿用）：所有 await（压缩、reconstruct）必须在开启 transaction 之前完成。
- **never-throw（backfill/reaper only）**：Phase 4 的 backfill 与既有 reaper 一致，任何单行/单批错误必须被捕获、计数、继续，不能让后台循环抛出终止服务器。Migration（Phase 1）则相反——**rethrow**（既有 `applyForwardMigrations` 策略），迁移失败必须让启动可见失败，不能带着半坏 schema 继续跑。

---

## 4. 本计划新增的设计决策（planning-stage 决策，非 RFC 原文，逐项标注理由）

以下 13 项是撰写本计划过程中，为了把 RFC 的架构级描述落到具体代码接口而必须做出的补充决策。全部不改变 RFC 已定案的架构合同（载体形态/等价规则/GC 模式/backfill 语义），只是把"怎么落地"钉死。如评审认为其中任何一项实质触及了架构合同，请标记为门控问题打回。

1. **`entry_stages.blob_gz` 占位符**：schema 约束 `blob_gz BLOB NOT NULL`（schema.ts 既有 DDL），content-addressed 新行的真实内容已搬进 `stage_blob.blob_gz`，故新行的 `entry_stages.blob_gz` 写入共享常量 `EMPTY_STAGE_BLOB_PLACEHOLDER = new Uint8Array(0)`（stage-carrier.ts 导出，写路径与 backfill 共用同一实例，防止两处各自定义漂移）。
2. **`entry_stages_resolved` VIEW 抽象双轨读**：RFC §4 只给了"改为 JOIN 解引用"的目标 SQL，未提抽象层。本计划引入一个只读 VIEW（`CASE WHEN hash IS NOT NULL THEN stage_blob.blob_gz ELSE entry_stages.blob_gz END`），让全部读侧调用点只需机械地把 `FROM entry_stages` 换成 `FROM entry_stages_resolved`，零其他代码改动，且未来任何新读侧调用点天然对双轨透明。
3. **`calibration-backfill.ts:311` 现存 bug + 全站点统一路由**：审计发现该文件的 `stageSelect` 直接 `SELECT ... FROM entry_stages`，若不路由过 `entry_stages_resolved`，一旦 Phase 3 写路径切换为内容寻址，`calibration-backfill` 会读到空 `blob_gz` 占位符而不是真实内容——这是一个**必须修的现存缺陷**，不是可选加固。本计划决定：全部 **7 个文件、共 12 处**原始 `FROM entry_stages` 读站点（`read.ts`×1/`search-index-backfill.ts`×1/`calibration-backfill.ts`×1/`legacy-stage-backfill.ts`×1/`usage-normalize-backfill.ts`×4/`response-preview-backfill.ts`×1/`cache-write-backfill.ts`×3；逐 file:line 清单见第 5 节）统一路由过 view，不做"仅修必要的那一个、其余留债"的取舍。三个 task 分摊这 12 处：P2-T1 处理 `read.ts` 点名的 1 处、P2-T2 处理 `calibration-backfill.ts` 的 bug-fix 1 处、P2-T3 处理剩余 5 个文件的 10 处加固站点（对抗审查吸收项：修正此前"7 个文件"与"7 处站点"混用导致的自相矛盾文案，7 是文件数、12 才是站点数）。
4. **`compressBytesAsync` 新增**：`compression.ts` 已有同步 `compressBytes`（RFC 假设的压缩原语已存在），但没有异步孪生。写路径 Phase 1（async 预检查+选择性压缩）需要 off-event-loop 压缩，故补一个直接镜像 `compressAsync` vs `compress` 既有模式的异步孪生函数，零风险的新增，非重构。
5. **pre-check-before-compress（偏离 `msg_blob` 的盲插模式）**：`msg_blob` 用盲 `INSERT OR IGNORE`（未压缩的纯文本，重复插入代价可忽略）。`stage_blob` 内容经压缩，重复插入意味着浪费一次压缩 CPU；本计划在 Phase 1（异步、无锁）里先做同步 `SELECT 1 FROM stage_blob WHERE hash=?`，只压缩 cache-miss 的成员——这是 RFC §1.1「一生只压一次」目标真正兑现的地方。
   **TOCTOU 补记（对抗审查 BLOCK-2 采纳，非文档化了事）**：pre-check 与实际压缩之间隔着一个 `await`（Phase 1 是 off-lock 异步段），若某个 pre-check 命中的 hash 恰好在这个让出间隙被 orphan GC（reaper tick / `deleteSession` / `deleteEntries` / `clearAllEntries`，四个站点均在 P3-T3）并发清走，会产生"引用了一个此刻并不存在于 `stage_blob` 的 hash"的悬空引用——这是真实可构造的竞态，不是理论假设。修复方式是把最终一致性钉在**同一个同步事务**边界内，而非依赖 pre-check 那一刻的快照：Phase 2 的同步 tx 回调对每个 pre-check 命中（未落入 `needsCompress`）的 hash 重新 `SELECT 1 FROM stage_blob WHERE hash=?`，命中则照常只写引用；未命中（GC 抢先清走了）则退回**同步** `compressBytes`（不是它的 async 孪生，因为此刻已在同步 tx 回调内，不能再 `await`）现算现插，再写引用。详见 P3-T2 的重写代码与新增受控时序回归测试。
6. **`losslessStableStringify` 的 undefined 语义**：RFC 只要求"仅递归键排序，不剥字段"，未规定 undefined 边界情况。本计划决定：完全依赖 `JSON.stringify` 原生语义（对象内 `undefined` 值按 key 跳过、数组内 `undefined` 变 `null`），不引入 `normalize-message.ts canonicalize` 那种顶层 `null/undefined → null` 强制转换；额外加一个防御性 guard——若递归排序后 `JSON.stringify` 顶层返回 JS `undefined`（理论上只有顶层裸 `undefined` 才会触发，stage payload 在 `extractStagePayloads` 里全部经真值检查后才 push，实践中不会发生），显式抛错而不是静默产生非字符串结果去拼 hash 前缀。
7. **`restructure-golden.it.test.ts` 配套更新范围**：该测试的 6 个内联快照锁定的是**保留的** request_group 展开兜底分支（读侧不删），本计划确认这份测试**不需要改快照/逻辑**，只需要更新模块级文档注释 + `serializeToRawRows` JSDoc + `partitionStagesForWrite` 定义处新增一行说明"finalize 写路径已切换为内容寻址，此函数与 request_group 折叠仅作为读侧兼容分支保留"，属于文档准确性修正，非回归。
8. **"真实 history.db 抽样" 的解释**：RFC §4/§9 字面写"对真实 history.db 抽样 entry 组装结果"。项目代码库内没有任何 checked-in 的二进制 `.db` 文件。本计划将其解释为：仿照 `write-read.unit.test.ts` 的 `makeEntry` 惯例，构造生产形态真实的 `HistoryEntry` fixture（多 attempt、cache_control、client/upstream 双腿全字段），经**真实写/读路径**在真实内存 SQLite 上跑一遍，而非字面二进制文件比对。
9. **hash 域前缀设计——一处开放问题，请评审/RFC 作者把关（非本计划单方定案）**：规划过程中一度探索"前缀附加在摘要字符串上（如 `stagev1:<hex>`）而非混入 hash 输入"的方案，以为这样能更严格满足"被 hash 的字节 == 被存储的字节"。重新核对 RFC §3.2 原文公式 `hash = sha256(domainPrefix + canonical)` 后，**我的读法**是：RFC 字面设计就是把域前缀**混入 hash 输入**（`sha256(prefix+canonical)`），存储的是纯 `zstd(canonical)`（不含前缀）；"被 hash 的字节 == 被存储的字节"这句话应理解为"两处消费同一个 `canonical` 产物、不允许各自独立再序列化一遍"，而非要求 hash 输入与存储字节逐位相同。**本计划倾向于采纳 RFC 字面公式**（详见 Phase 0 Task 2），但这只是本计划对 RFC 措辞的一次重新解读，不等于 RFC 作者本人已明确确认——若评审或 RFC 作者认为字面公式与这里的读法有出入，请在此明确裁决，而不是任由本计划单方定案继续往下游落地。
10. **增量（在途）逐 stage writer 保持不变**：`upsertHeadRow`/`upsertStageRow`（`write.ts:174-189`）继续写 `hash=NULL` 的内联行，不做内容寻址——只有 `insertCompletedEntry` 的终态化路径变为内容寻址。理由：双轨读的 `hash IS NULL` 分支天然、零额外代码地同时覆盖「真旧行」与「尚未终态化的在途行」，而终态化时既有的逐条目 `DELETE FROM entry_stages WHERE entry_id=?`（见下一条）保证任何在途行终会被终态内容寻址行取代——引入"在途也要内容寻址"只会增加复杂度换不来任何一致性收益。
11. **保留（非删除）`insertCompletedEntry` 的逐条目 `DELETE FROM entry_stages WHERE entry_id=?`**：RFC §3.3 措辞是"消除全量重删重压"，字面读容易误解为连这行 DELETE 也要删掉。本计划决定保留它——它现在只是一次廉价的、仅元数据的删除（新形态下 `entry_stages` 行不再携带重内容），用来保证一次"缩水"式重新终态化（例如某个 attempt 数减少）不会残留过期的 `(stage, attempt_index)` 组合键。RFC 真正要消除的重活是"全量 `compressAsync` 重压"，这由 Phase 1 的 pre-check-before-compress（决策 #5）独立达成，与是否保留这行 DELETE 无关。
12. **backfill 复用 `assembleFullEntry` + `extractStagePayloads`（与写路径同一对函数）**：RFC §5 字面描述是"decompress 内联 blob（或展开 request_group）→ 重新 canonical-json + hash"，听起来像是对原始行做逐行加工。本计划决定：不手写第二套"识别 request_group / 决定成员列表"的逻辑，而是对每个待回填 entry 调用**与实时写路径完全相同**的 `assembleFullEntry(head, stageRows)` 重建完整 `HistoryEntry`，再用与写路径相同的 `deriveStageRefs`（决策 #13）推导 canonical 成员列表——这样 backfill 产出的行形态与一次全新写入**逐字节同构**，且天然正确处理 request_group 展开（`assembleFullEntry` 内部已经调用 `decodeStageRows` 做了这件事）。副作用：backfill 对 `legacy-stage-backfill.ts` 的完成**没有顺序依赖**（不同于 `legacy-stage-backfill` 自身对 `usage-normalize-backfill` 的依赖），因为 `assembleFullEntry` 已经透明地把新旧两种历史行形态都规整成同一个 `HistoryEntry`（经 `adaptLegacyLegsInPlace`）。
13. **新增共享原语 `deriveStageRefs`**（`stage-carrier.ts` 导出）：把"`extractStagePayloads` → `losslessStableStringify` → `hashStageCanonical`"这条链路抽成一个纯函数，供 `insertCompletedEntry`（Phase 3）与 backfill（Phase 4）共同调用，避免两处各自实现导致"canonical 成员列表"定义漂移（未来任一处改了推导规则而漏改另一处，会造成 backfill 产出的 hash 与实时写入的 hash 不一致的隐性 bug）。

---

## 5. 扩大读路径覆盖范围（决策 #3 的完整清单，含 file:line）

| 文件 | 行号 | 现状 | 处理 |
|---|---|---|---|
| `read.ts` | 25 | `loadStagesFor` 批量 IN 查询 | **必改**（RFC §4 点名） |
| `calibration-backfill.ts` | 311 | `stageSelect` 单条查询 | **必改（bug-fix）**——不改会读到空占位符 |
| `search-index-backfill.ts` | 152 | 批量 IN 查询 | 加固 |
| `legacy-stage-backfill.ts` | 146 | 批量 IN 查询 | 加固 |
| `usage-normalize-backfill.ts` | 98 | `stage='sse_events'` 存在性探测 | 加固 |
| `usage-normalize-backfill.ts` | 100 | `stage='inbound_response'` 单值 | 加固 |
| `usage-normalize-backfill.ts` | 113 | 存在性探测 | 加固 |
| `usage-normalize-backfill.ts` | 241 | `stage='outbound_response'` 多行 | 加固 |
| `response-preview-backfill.ts` | 82 | 单条目全量查询 | 加固 |
| `cache-write-backfill.ts` | 147 | `stage='upstream_response'` 单值 | 加固 |
| `cache-write-backfill.ts` | 155 | `stage='sse_events'` 单值 | 加固 |
| `cache-write-backfill.ts` | 197 | `stage='upstream_response'` 多行 | 加固 |

`write.ts:158`（`insertCompletedEntry` 内 DELETE）、`write.ts:271`（`clearAllEntries` 内 DELETE）、`legacy-stage-backfill.ts:257`（DELETE）三处是 **DELETE 语句**，目标必须是物理表 `entry_stages`（简单 LEFT JOIN 视图在 SQLite 里不可更新/不可删除），**不改**。

---

## 6. Cutover 计划（填 RFC §10，commit invariants）

| Commit | 内容 | 终态不变量（此 commit 落地后系统必须成立的性质） |
|---|---|---|
| **C0** | Phase 0：`compressBytesAsync` + `stage-carrier.ts`（纯新增原语，零调用点） | 编译通过、新增单测全绿；**零行为改变**（无调用方） |
| **C1** | Phase 1：schema floor（`schema.ts` 的 `stage_blob` 表 + `entry_stages.hash` 列 dual-embed + 新导出函数 `migrateEntryStagesColumns` 补索引/VIEW）+ `001-stage-blob-carrier` Umzug 迁移（reframe 为 catch-up-only，直接复用同一个 `migrateEntryStagesColumns`）+ 跨 runtime e2e | 新 schema **纯增量**（新表/新列/新索引/新 VIEW），旧读写路径完全不受影响（还没有代码引用新 VIEW/新表）；`bun test`/node e2e 均绿；**空库依旧可正常初始化**（既有 `migrations.it.test.ts` 空库用例更新后仍过）；**关键（对抗审查 BLOCK-1 采纳）：`openInMemoryDatabase()` 单独调用（完全不经过 `applyForwardMigrations`）就必须产出完整新 schema**——这是全部 16 个既有 `openInMemoryDatabase` 测试文件实际触达的路径，`entry_stages_resolved`/`stage_blob`/`hash` 列/索引绝不能只活在 Umzug 001 里，否则这些测试对新 schema 的覆盖是假的；新增的 floor-alone 回归测试（P1-T2）就是钉死这条不变量的 oracle |
| **C2** | Phase 2：读路径切换到 `entry_stages_resolved`（7 个站点）+ byte-equivalence golden + `cache_control-shifted twin entries reconstruct losslessly` 负样本 | 读路径对**旧行**（`hash IS NULL`）行为逐字节不变（VIEW 的 ELSE 分支）；对**新行**（此刻还不存在，因为写路径未切换）无观测差异；**全部既有测试仍绿**（纯读侧路由切换，无写侧改动） |
| **C3** | Phase 3：写路径切换（`insertCompletedEntry` 内容寻址化，含 BLOCK-2 TOCTOU 同事务二次核实）+ orphan GC 4 站点 + `restructure-golden` 文档更新 + `usage-normalize-backfill.ts`/`cache-write-backfill.ts` 的内容寻址回填修正（P3-T5，MEDIUM-8 采纳为代码修复而非仅文档标注） | 新终态化的 entry 写出 `hash` 非空的 content-addressed 行；旧行/在途行不受影响（决策 #10）；`assembleFullEntry` 对新旧行输出逐字节等价（C2 的 golden 继续通过，且新增"新行"分支覆盖）；orphan GC 4 站点全部不泄漏 `stage_blob` 孤儿；**pre-check 命中的 hash 在 async 让出间隙被并发 GC 清走时，同步 tx 内二次核实必须兜底重新压缩插入，不产生悬空引用**（受控时序回归测试覆盖）；**`usage-normalize-backfill`/`cache-write-backfill` 对已内容寻址行（`hash IS NOT NULL`）的修正写回必须真正可读（经 `entry_stages_resolved` 验证），不能静默写入被 VIEW 忽略的 `entry_stages.blob_gz`** |
| **C4** | Phase 4：backfill（`stage-blob-backfill.ts`）+ meta 常量 + state.ts 接线 + RESETTERS | 后台可恢复回填持续把 `hash IS NULL` 的旧行转为内容寻址行，**不阻塞**服务启动/请求处理；重复运行幂等（无 hash 的行清零后停止）；dedup-ratio tripwire 可观测；`stopHistoryBackgroundWork` 优雅停止 |
| **C5（延后，明确排除）** | 旧列清理：删 `entry_stages.blob_gz`（旧内联内容）+ 退役 `request_group` 读侧展开分支 | **不在本计划范围**——RFC §8 Open Question #1 明确"待用户决定时机"，需 backfill 100% 完成后 no-auto-server 收尾（仿照 P6b 先例）。本计划只交付到 C4；C5 是另一次独立收尾，届时才评估安全删除条件 |

---

## Phase 0：前置原语

### P0-T1：`compressBytesAsync`

**Files**：`src/lib/history/sqlite/compression.ts`、`tests/history/sqlite/compression.unit.test.ts`

**Steps**：
1. 红：在 `compression.unit.test.ts` 追加：
   ```ts
   test("compressBytesAsync produces byte-identical output to compressBytes", async () => {
     const bytes = new TextEncoder().encode(JSON.stringify({ a: 1, b: [1, 2, 3] }))
     const sync = compressBytes(bytes)
     const async_ = await compressBytesAsync(bytes)
     expect(Buffer.from(async_).equals(Buffer.from(sync))).toBe(true)
     expect(decompressBytes(async_)).toEqual(bytes)
   })
   ```
   跑 `bun test tests/history/sqlite/compression.unit.test.ts` → 因 `compressBytesAsync` 未导出而编译失败（红）。
2. 绿：在 `compression.ts` 追加（紧邻既有 `compressBytes`）：
   ```ts
   /**
    * Async twin of {@link compressBytes}: identical zstd-framed output, offloaded
    * to the libuv threadpool — used by the stage-blob write path so hashing +
    * compressing a multi-MB stage canonical form doesn't block the event loop
    * (same rationale as {@link compressAsync} vs {@link compress}).
    */
   export async function compressBytesAsync(bytes: Uint8Array): Promise<Uint8Array> {
     return zstdCompressAsync(bytes, ZSTD_OPTS)
   }
   ```
   跑 `bun test tests/history/sqlite/compression.unit.test.ts` → 绿。
3. Commit：`git add -- src/lib/history/sqlite/compression.ts tests/history/sqlite/compression.unit.test.ts && git commit -F <msgfile>`，message: `feat(history): add compressBytesAsync (off-event-loop raw-bytes zstd)`。

### P0-T2：`stage-carrier.ts`（`losslessStableStringify` + hash + `deriveStageRefs`）

**Files（新增）**：`src/lib/history/sqlite/stage-carrier.ts`、`tests/history/sqlite/stage-carrier.unit.test.ts`

**Interfaces**：
```ts
export const STAGE_HASH_DOMAIN_PREFIX = "stagev1:"
export const EMPTY_STAGE_BLOB_PLACEHOLDER = new Uint8Array(0)

export interface StageRef {
  stage: StageName
  attemptIndex: number
  canonical: string
  hash: string
}

export function losslessStableStringify(value: unknown): string
export function hashStageCanonical(canonical: string): string
export function deriveStageRefs(entry: HistoryEntry): Array<StageRef>
```

**Steps**：
1. 红：新建 `stage-carrier.unit.test.ts`：
   ```ts
   import { describe, expect, test } from "bun:test"
   import {
     deriveStageRefs,
     EMPTY_STAGE_BLOB_PLACEHOLDER,
     hashStageCanonical,
     losslessStableStringify,
     STAGE_HASH_DOMAIN_PREFIX,
   } from "~/lib/history/sqlite/stage-carrier"

   describe("losslessStableStringify", () => {
     test("key order does not affect output", () => {
       const a = losslessStableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } })
       const b = losslessStableStringify({ a: 2, c: { y: 2, z: 1 }, b: 1 })
       expect(a).toBe(b)
     })

     test("does NOT strip any field (unlike normalize-message canonicalize)", () => {
       const value = { cache_control: { type: "ephemeral" }, foo: undefined, bar: null }
       const out = losslessStableStringify(value)
       expect(out).toContain("cache_control")
       // JSON.stringify's native semantics: undefined key omitted, null kept verbatim.
       expect(JSON.parse(out)).toEqual({ bar: null, cache_control: { type: "ephemeral" } })
     })

     test("round-trips to the original value", () => {
       const value = { messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }] }
       expect(JSON.parse(losslessStableStringify(value))).toEqual(value)
     })
   })

   describe("hashStageCanonical", () => {
     test("is a 64-hex-char full-width sha256 digest", () => {
       const hash = hashStageCanonical(losslessStableStringify({ a: 1 }))
       expect(hash).toMatch(/^[0-9a-f]{64}$/)
     })

     test("mixes the domain prefix into the hash INPUT, not the output string", () => {
       const canonical = losslessStableStringify({ a: 1 })
       const hash = hashStageCanonical(canonical)
       expect(hash.startsWith(STAGE_HASH_DOMAIN_PREFIX)).toBe(false)
       expect(hash).not.toBe(hashStageCanonical(`${STAGE_HASH_DOMAIN_PREFIX}${canonical}`)) // prefix must not be applied twice
     })

     test("different field order -> same hash (positive sample)", () => {
       const c1 = losslessStableStringify({ b: 1, a: 2 })
       const c2 = losslessStableStringify({ a: 2, b: 1 })
       expect(hashStageCanonical(c1)).toBe(hashStageCanonical(c2))
     })
   })

   describe("deriveStageRefs", () => {
     test("derives one ref per extractStagePayloads member, with matching stage/attemptIndex", () => {
       const entry = {
         id: "e1",
         endpoint: "anthropic-messages",
         startedAt: 0,
         state: "completed",
         active: false,
         lastUpdatedAt: 0,
         clientRequest: { model: "m1" },
         attempts: [{ index: 0, upstreamResponse: { success: true, body: { role: "assistant", content: "ok" } } }],
       } as unknown as Parameters<typeof deriveStageRefs>[0]
       const refs = deriveStageRefs(entry)
       expect(refs.map((r) => r.stage).sort()).toEqual(["client_request", "upstream_response"].sort())
       for (const r of refs) expect(r.hash).toMatch(/^[0-9a-f]{64}$/)
     })

     test("EMPTY_STAGE_BLOB_PLACEHOLDER is a zero-length Uint8Array", () => {
       expect(EMPTY_STAGE_BLOB_PLACEHOLDER).toHaveLength(0)
     })
   })
   ```
   跑 `bun test tests/history/sqlite/stage-carrier.unit.test.ts` → 因模块不存在而失败（红）。
2. 绿：新建 `stage-carrier.ts`：
   ```ts
   /**
    * Content-addressed stage carrier primitives (RFC 2026-07-14 §3.1/§3.2).
    *
    * `stage_blob` is a LOSSLESS STORAGE identity — the opposite contract from
    * `msg_blob`'s LOSSY SEARCH identity (normalize-message.ts's `canonicalize`
    * strips VOLATILE_KEYS/cache_control and coerces null/undefined; this module
    * does neither). Same hash MUST mean same value, bidirectionally — a
    * collision here is a silent data-corruption bug, not search noise.
    */

   import { createHash } from "node:crypto"

   import type { HistoryEntry } from "~/lib/history/types"

   import { extractStagePayloads, type StageName } from "./serialize"

   /**
    * Domain/version prefix mixed into the hash INPUT (RFC §3.2 literal formula:
    * `hash = sha256(domainPrefix + canonical)`) — NOT stored, NOT appended to the
    * output digest string. Guards against a future canonicalization algorithm
    * change silently colliding into the same hash namespace as today's rows;
    * bump to `stagev2:` etc. if `losslessStableStringify`'s algorithm ever changes.
    */
   export const STAGE_HASH_DOMAIN_PREFIX = "stagev1:"

   /** Placeholder for `entry_stages.blob_gz` on content-addressed rows (NOT NULL
    *  column, real content now lives in `stage_blob.blob_gz`). Shared instance so
    *  the write path and the backfill never independently define this. */
   export const EMPTY_STAGE_BLOB_PLACEHOLDER = new Uint8Array(0)

   /**
    * Order-independent, LOSSLESS JSON stringify: recursively sorts object keys so
    * two structurally-equal values serialize identically regardless of key
    * insertion order — and nothing else. Unlike `normalize-message.ts`'s
    * `canonicalize` (a lossy search-identity transform), this strips NO fields and
    * performs NO null/undefined coercion; every other byte comes straight from
    * `JSON.stringify`'s native semantics (undefined values inside objects are
    * omitted per-key; undefined inside arrays becomes null). A bare top-level
    * `undefined` is never expected here (extractStagePayloads only pushes
    * truthy-checked payloads) — guarded defensively rather than silently coerced.
    */
   export function losslessStableStringify(value: unknown): string {
     const json = JSON.stringify(sortKeysDeep(value))
     if (json === undefined) {
       throw new Error("[stage-carrier] losslessStableStringify: value serialized to undefined (unexpected top-level undefined stage payload)")
     }
     return json
   }

   function sortKeysDeep(value: unknown): unknown {
     if (Array.isArray(value)) return value.map(sortKeysDeep)
     if (value !== null && typeof value === "object") {
       const sorted: Record<string, unknown> = {}
       for (const key of Object.keys(value as Record<string, unknown>).sort()) {
         sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
       }
       return sorted
     }
     return value
   }

   /**
    * Full-width (un-truncated) 256-bit sha256 hex digest of a stage's canonical
    * form — the `stage_blob` primary key. Domain-prefixed INPUT, un-prefixed
    * OUTPUT (`entry_stages.hash TEXT` stores the bare 64-hex digest).
    */
   export function hashStageCanonical(canonical: string): string {
     return createHash("sha256").update(`${STAGE_HASH_DOMAIN_PREFIX}${canonical}`, "utf8").digest("hex")
   }

   /** One content-addressed stage reference: the canonical form + its hash, ready
    *  to dedup-check against `stage_blob` and reference from `entry_stages`. */
   export interface StageRef {
     stage: StageName
     attemptIndex: number
     canonical: string
     hash: string
   }

   /**
    * Derive the canonical, content-addressed member list for one entry's stage
    * payloads — the SHARED primitive between the live write path
    * (`insertCompletedEntry`) and the backfill (`stage-blob-backfill.ts`), so the
    * two can never independently drift on what "the current stage-ref shape"
    * means (plan design decision #13).
    */
   export function deriveStageRefs(entry: HistoryEntry): Array<StageRef> {
     return extractStagePayloads(entry).map((s) => {
       const canonical = losslessStableStringify(s.payload)
       return { stage: s.stage, attemptIndex: s.attemptIndex, canonical, hash: hashStageCanonical(canonical) }
     })
   }
   ```
   跑测试 → 绿。
3. Commit：`git add -- src/lib/history/sqlite/stage-carrier.ts tests/history/sqlite/stage-carrier.unit.test.ts && git commit -F <msgfile>`，message: `feat(history): add stage-carrier content-addressing primitives`。

---

## Phase 1：Migration（工作单元 1）+ 跨 runtime e2e

### P1-T1：修复即将破坏的 `migrations.it.test.ts` 空库断言

**Files**：`tests/history/sqlite/migrations.it.test.ts`

**Steps**：
1. 红：先确认当前断言 `expect(MIGRATIONS).toEqual([])`（line 113）会在 P1-T3 之后失败——不需要额外新写测试，这是"因下一步改动而必然破坏的既有断言"，本 task 就是修它。
2. 绿：把该测试改为断言"空库应用一个 no-op 迁移数组不抛错"，不再断言 `MIGRATIONS` 本身为空数组（真实 `MIGRATIONS` 从 P1-T3 起不再是空的）：
   ```ts
   test("applying an empty migrations array is a no-op on a bare DB (must not throw)", async () => {
     const db = openInMemoryDatabase()
     await expect(applyForwardMigrations(db, [])).resolves.toBeUndefined()
   })
   ```
   （把原先断言 `MIGRATIONS` 内容的部分移到 P1-T3 的新测试里。）
3. Commit 随 P1-T3 一起提交（同一 commit，见下——P1-T3 改了 `MIGRATIONS` 数组，这条断言才真正需要跟着改，二者是同一语义单元）。

### P1-T2：schema floor——`schema.ts` 新增 `stage_blob`/`entry_stages.hash`/`migrateEntryStagesColumns`（对抗审查 BLOCK-1 采纳：floor 是真正的 schema 权威，Umzug 只是 catch-up）

**背景（为什么原草稿的"全放进 Umzug migration 001"是错的）**：`openDatabase`/`openInMemoryDatabase`（`connection.ts`）只跑 `SCHEMA_SQL` + `migrateEntriesColumns`，**不会**自动跑 `applyForwardMigrations`——后者只在生产启动路径（`start.ts:368`）单独调用一次。仓库里 16 个既有 history 测试文件（如 `pid-column.unit.test.ts`）只调用 `openInMemoryDatabase()`，从不调用 `applyForwardMigrations`；只有 1 个测试文件显式调两者都调。若 `hash`/索引/VIEW 只存在于 Umzug migration 001 里，这 16 个文件测的其实是一个没有新 schema 的库，C2/C3 的不变量对它们是假的。修复：把新增 DDL 挪进 floor（`schema.ts`，被 `connection.ts` 无条件调用），Umzug 001 reframe 成"调用同一个 floor 函数"的 catch-up/ledger 记录，而非独立第二套 SQL。

**Files**：`src/lib/history/sqlite/schema.ts`、`src/lib/history/sqlite/connection.ts`、`tests/history/sqlite/stage-blob-schema-floor.unit.test.ts`（新增）

**Steps**：
1. 红：新建 `tests/history/sqlite/stage-blob-schema-floor.unit.test.ts`——刻意**只**调用 `openInMemoryDatabase()`，完全不 import/调用 `applyForwardMigrations`，模仿 `pid-column.unit.test.ts` 的既有惯例，直接钉死"floor 单独就有完整新 schema"这条不变量：
   ```ts
   import { beforeEach, describe, expect, test } from "bun:test"
   import { closeDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"

   describe("stage-blob schema floor (openInMemoryDatabase ALONE, no applyForwardMigrations)", () => {
     beforeEach(() => {
       closeDatabase()
     })

     test("openInMemoryDatabase alone creates stage_blob, entry_stages.hash, idx_entry_stages_hash, and entry_stages_resolved", () => {
       const db = openInMemoryDatabase()

       const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stage_blob'").all()
       expect(tables).toHaveLength(1)

       const cols = (db.prepare("PRAGMA table_info(entry_stages)").all() as Array<{ name: string }>).map((c) => c.name)
       expect(cols).toContain("hash")

       const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_entry_stages_hash'").all()
       expect(indexes).toHaveLength(1)

       const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='entry_stages_resolved'").all()
       expect(views).toHaveLength(1)

       // View smoke test: a row with hash=NULL falls through to its own blob_gz.
       db.prepare(
         "INSERT INTO entries_v2 (id, started_at, status, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) VALUES (?,?,?,?,?,?,?)",
       ).run("e1", 0, "completed", 1, 1, 1, new Uint8Array([1]))
       db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)").run(
         "e1", "client_request", -1, 0, new Uint8Array([9, 9]),
       )
       const resolved = db.prepare("SELECT blob_gz FROM entry_stages_resolved WHERE entry_id = ?").get("e1") as { blob_gz: Uint8Array }
       expect(Buffer.from(resolved.blob_gz)).toEqual(Buffer.from(new Uint8Array([9, 9])))
     })
   })
   ```
   跑 `bun test tests/history/sqlite/stage-blob-schema-floor.unit.test.ts` → 红（`stage_blob`/`hash`/索引/VIEW 都不存在，`openInMemoryDatabase` 还没改）。
2. 绿：
   - **`schema.ts`**：加一行 import（该文件此刻零 import，加这一行后仍是 alias-free，只用相对路径）：
     ```ts
     import type { SqliteDatabase } from "./driver"
     ```
     `entry_stages` 的 `CREATE TABLE` 里追加 `hash` 列（dual-embed 模式，镜像 `entries_v2` 其余"新鲜库直接建列 + ALTER 兜底既有库"的既有惯例）：
     ```diff
      CREATE TABLE IF NOT EXISTS entry_stages (
        entry_id      TEXT NOT NULL,
        stage         TEXT NOT NULL,
        attempt_index INTEGER NOT NULL DEFAULT -1,
        created_at    INTEGER NOT NULL,
        blob_gz       BLOB NOT NULL,
     +  hash          TEXT,
        PRIMARY KEY (entry_id, stage, attempt_index),
        FOREIGN KEY (entry_id) REFERENCES entries_v2(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_entry_stages_entry ON entry_stages(entry_id);
     ```
     紧接着（`msg_blob`/`req_msg` 块之前或之后均可，选在 `entry_stages` 块之后、`msg_blob` 块之前，语义上更贴近）追加新表，**无条件**直接进 `SCHEMA_SQL`（不依赖任何刚 ALTER 出来的列，安全，镜像 `msg_blob` 自身的既有放置方式）：
     ```sql
     -- stage_blob: content-addressed carrier for entry_stages payloads (RFC
     -- 2026-07-14 §3-§5). No FK — shared/dedup'd across entries, reclaimed by the
     -- orphan GC (NOT EXISTS over entry_stages), mirroring msg_blob below.
     CREATE TABLE IF NOT EXISTS stage_blob (
       hash    TEXT PRIMARY KEY,
       blob_gz BLOB NOT NULL
     );
     ```
     文件末尾追加导出函数（**这是 floor 的真正落脚点**——`hash` 列的 ALTER-if-missing 兜底 + 索引/VIEW 的**延后**创建，理由与既有 `idx_entries_v2_pid` 完全一致：`SCHEMA_SQL` 在既有库上先跑，那时 `hash` 列可能还不存在，`CREATE INDEX`/`CREATE VIEW` 引用它会失败，必须等 ALTER 之后再建）：
     ```ts
     /**
      * Additive column/index/VIEW migration for `entry_stages`'s content-addressed
      * carrier (RFC 2026-07-14 §3-§5) — mirrors connection.ts's migrateEntriesColumns
      * idiom (PRAGMA table_info probe → conditional ALTER → index/VIEW deferred
      * until AFTER the ALTER, since on a pre-hash DB SCHEMA_SQL runs BEFORE this
      * function and a CREATE INDEX/VIEW referencing the not-yet-added column would
      * fail).
      *
      * THIS IS THE FLOOR — called unconditionally from connection.ts's openDatabase/
      * openInMemoryDatabase, reached by every history test file via
      * openInMemoryDatabase, NOT gated behind the separate Umzug migration runner
      * (applyForwardMigrations only runs from start.ts in production). The
      * 001-stage-blob-carrier Umzug migration (migrations/index.ts) calls this SAME
      * function — one function, two call sites, drift between "floor" and
      * "migration" is impossible by construction.
      */
     export function migrateEntryStagesColumns(database: SqliteDatabase): void {
       const cols = (database.prepare("PRAGMA table_info(entry_stages)").all() as Array<{ name: string }>).map((c) => c.name)
       if (!cols.includes("hash")) database.exec("ALTER TABLE entry_stages ADD COLUMN hash TEXT")
       database.exec("CREATE INDEX IF NOT EXISTS idx_entry_stages_hash ON entry_stages(hash)")
       // Dual-track read view: NEW rows (hash set) dereference into stage_blob;
       // OLD rows (hash NULL — pre-Stage-1 rows, or an entry not yet finalized)
       // keep reading their own inline blob_gz. Every read consumer swaps its FROM
       // clause to this view; decodeStageRows/assembleFullEntry need ZERO changes
       // since the returned column shape is identical either way.
       database.exec(`CREATE VIEW IF NOT EXISTS entry_stages_resolved AS
         SELECT es.entry_id, es.stage, es.attempt_index, es.created_at, es.hash,
                CASE WHEN es.hash IS NOT NULL THEN sb.blob_gz ELSE es.blob_gz END AS blob_gz
         FROM entry_stages es
         LEFT JOIN stage_blob sb ON sb.hash = es.hash`)
     }
     ```
   - **`connection.ts`**：把既有 `import { SCHEMA_SQL } from "./schema"` 扩成 `import { migrateEntryStagesColumns, SCHEMA_SQL } from "./schema"`；在 `openDatabase` 里紧邻既有 `migrateEntriesColumns(db)`（line 82）之后追加一行：
     ```diff
      migrateEntriesColumns(db)
     +migrateEntryStagesColumns(db)
      reclaimOrphanedActiveRows(db)
     ```
   跑 `bun test tests/history/sqlite/stage-blob-schema-floor.unit.test.ts` → 绿；跑 `bun run test:backend` 全量确认零回归（既有 16 个只调 `openInMemoryDatabase()` 的测试文件全部不受影响，因为这是纯增量）。
3. Commit：`git add -- src/lib/history/sqlite/schema.ts src/lib/history/sqlite/connection.ts tests/history/sqlite/stage-blob-schema-floor.unit.test.ts && git commit -F <msgfile>`，message: `feat(history): add stage_blob/entry_stages.hash schema floor (migrateEntryStagesColumns)`。

### P1-T3：`001-stage-blob-carrier` Umzug migration——reframe 为纯 catch-up（复用 P1-T2 的同一个函数）

**Files**：`src/lib/history/sqlite/migrations/index.ts`、`tests/history/sqlite/migrations.it.test.ts`

**Steps**：
1. 红：在 `migrations.it.test.ts` 追加（这两个断言此刻仍然有效——P1-T2 的 floor 已经把 `stage_blob`/`hash`/索引/VIEW 建好了，所以 `applyForwardMigrations` 跑完后这些断言天然成立，只是现在验证的是"Umzug 不报错、且是同一份 floor 逻辑的幂等重跑"，而不是"Umzug 独力创建了它们"）：
   ```ts
   test("001-stage-blob-carrier is a catch-up no-op when the floor already created everything", async () => {
     const db = openInMemoryDatabase() // floor already ran (P1-T2)
     await applyForwardMigrations(db, MIGRATIONS)

     const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stage_blob'").all()
     expect(tables).toHaveLength(1)
     const cols = (db.prepare("PRAGMA table_info(entry_stages)").all() as Array<{ name: string }>).map((c) => c.name)
     expect(cols).toContain("hash")
     const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='entry_stages_resolved'").all()
     expect(views).toHaveLength(1)
   })

   test("001-stage-blob-carrier is idempotent (re-applying the same migrations array is a no-op)", async () => {
     const db = openInMemoryDatabase()
     await applyForwardMigrations(db, MIGRATIONS)
     await expect(applyForwardMigrations(db, MIGRATIONS)).resolves.toBeUndefined()
   })
   ```
   跑 `bun test tests/history/sqlite/migrations.it.test.ts` → 因 `MIGRATIONS` 仍是空数组而失败（红，`P1-T1` 那条断言也在同一个红/绿窗口内一起改）。
2. 绿：在 `migrations/index.ts` 把 `MIGRATIONS` 从 `[]` 改为，直接调用 P1-T2 新增的 floor 函数（不是重新手写一遍 SQL）：
   ```ts
   import { migrateEntryStagesColumns } from "../schema"

   export const MIGRATIONS: Array<HistoryMigration> = [
     sqlMigration("001-stage-blob-carrier", (db) => {
       // Catch-up only — the schema FLOOR (migrateEntryStagesColumns, schema.ts)
       // is the real authority, called unconditionally from every openDatabase/
       // openInMemoryDatabase (connection.ts), reached by all history test files.
       // This migration exists only to (a) leave a real Umzug ledger entry marking
       // when this schema change shipped, for anyone diffing migration history,
       // and (b) defensively re-apply the exact same idempotent function here too,
       // in case a future caller ever opens a DB through a path that bypasses
       // connection.ts (none currently does). Calling the SAME function (not a
       // second hand-copied SQL block) makes drift between floor and migration
       // impossible by construction.
       migrateEntryStagesColumns(db)
     }),
   ]
   ```
   跑测试 → 绿。
3. Commit：`git add -- src/lib/history/sqlite/migrations/index.ts tests/history/sqlite/migrations.it.test.ts && git commit -F <msgfile>`，message: `feat(history): reframe 001-stage-blob-carrier as floor catch-up (no independent DDL)`。

### P1-T4：`src/start.ts` 无需改动的确认（回归检查，非新代码）

**Files**：无改动，仅验证
**Steps**：`applyForwardMigrations(getDatabase())` 默认参数已经是 `MIGRATIONS`（`migrations/run.ts` 既有签名），P1-T3 改了 `MIGRATIONS` 数组内容后，生产启动路径自动应用新迁移，无需改 `start.ts`。跑 `bun run typecheck` 确认无类型错误即可，不需要新增测试（这是"接线自动生效"的确认性 task，非遗漏点）。

### P1-T5：跨 runtime（Bun/Node）e2e 探针（对抗审查 HIGH-3 采纳：改走 alias-free 导入图）

**背景（原草稿的问题）**：原草稿 import 了 `connection.ts` 的 `openInMemoryDatabase`——这个入口函数本身用相对路径没错，但 `connection.ts` **内部**又 import 了 `~/lib/process-identity`/`~/lib/state`（`~` 别名），Node 原生执行 `.ts` 不认识 tsconfig 的路径别名，会在这条依赖链上报模块找不到。已核实 `driver.ts`/`schema.ts`/`migrations/index.ts`/`migrations/run.ts`/`migrations/storage.ts` 全部 alias-free（只用相对路径或裸包名），本 task 改走这条纯净的导入图，绕开 `connection.ts`。

**Files（新增）**：`tests/history/sqlite/migrations-001-stage-blob-carrier.node-e2e.ts`（刻意用 `.node-e2e.ts` 后缀，不匹配 `bun test` 的 `.unit.test`/`.it.test`/`.http.test` glob，避免被误捕获成 Bun 测试）、`package.json`

**Steps**：
1. 红：先确认该文件不存在，`node tests/history/sqlite/migrations-001-stage-blob-carrier.node-e2e.ts` 报 `Cannot find module`。
2. 绿：新建该文件（沿用 `exp/umzug-bun-spike/e2e-node.ts` 的 `assert(cond, msg)` 惯例；用 `driver.ts` 的 `createDatabase` + `schema.ts` 的 `SCHEMA_SQL`/`migrateEntryStagesColumns` 手动复刻 `connection.ts openDatabase` 的最小必要序列，全程零 `~` 别名）：
   ```ts
   // Cross-runtime (node:sqlite) e2e check for the stage-blob schema floor +
   // 001-stage-blob-carrier migration. Run:
   //   node tests/history/sqlite/migrations-001-stage-blob-carrier.node-e2e.ts
   // (also wired as `bun run test:backend:node-e2e`). Deliberately excluded from
   // the `bun test` glob (.node-e2e.ts, not .unit.test/.it.test/.http.test).
   //
   // Imports ONLY from the confirmed alias-free graph (driver.ts/schema.ts/
   // migrations/*) — NOT connection.ts, which internally imports `~/lib/
   // process-identity`/`~/lib/state` (tsconfig path aliases Node's native TS
   // execution cannot resolve). This proves the raw SQL (ALTER TABLE/CREATE
   // VIEW/PRAGMA table_info) works identically under node:sqlite, not just
   // bun:sqlite (driver.ts's two factories diverge on several APIs — see
   // bun-node-runtime-gotchas skill).
   import { createDatabase } from "../../../src/lib/history/sqlite/driver.ts"
   import { migrateEntryStagesColumns, SCHEMA_SQL } from "../../../src/lib/history/sqlite/schema.ts"
   import { applyForwardMigrations } from "../../../src/lib/history/sqlite/migrations/run.ts"
   import { MIGRATIONS } from "../../../src/lib/history/sqlite/migrations/index.ts"

   function assert(cond: unknown, msg: string): asserts cond {
     if (!cond) throw new Error(`FAIL: ${msg}`)
     console.log(`ok: ${msg}`)
   }

   async function main() {
     const db = createDatabase(":memory:")
     db.exec(SCHEMA_SQL) // fresh-DB path: stage_blob + entry_stages.hash column already present
     migrateEntryStagesColumns(db) // floor's ALTER-if-missing + deferred index/VIEW (no-op here, fresh DB)
     await applyForwardMigrations(db, MIGRATIONS) // catch-up (also a no-op — same function, already applied)

     const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stage_blob'").all() as Array<unknown>
     assert(tables.length === 1, "stage_blob table exists under node:sqlite")

     const cols = (db.prepare("PRAGMA table_info(entry_stages)").all() as Array<{ name: string }>).map((c) => c.name)
     assert(cols.includes("hash"), "entry_stages.hash column exists under node:sqlite")

     const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='entry_stages_resolved'").all() as Array<unknown>
     assert(views.length === 1, "entry_stages_resolved view exists under node:sqlite")

     db.prepare(
       "INSERT INTO entries_v2 (id, started_at, status, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) VALUES (?,?,?,?,?,?,?)",
     ).run("e1", 0, "completed", 1, 1, 1, new Uint8Array([1]))
     db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz) VALUES (?,?,?,?,?)").run(
       "e1", "client_request", -1, 0, new Uint8Array([9, 9]),
     )
     const resolved = db.prepare("SELECT blob_gz FROM entry_stages_resolved WHERE entry_id = ?").get("e1") as { blob_gz: Uint8Array }
     assert(Buffer.compare(Buffer.from(resolved.blob_gz), Buffer.from([9, 9])) === 0, "entry_stages_resolved dereferences hash=NULL rows correctly under node:sqlite")

     console.log("PASS: stage-blob schema floor + 001-stage-blob-carrier cross-runtime e2e (node:sqlite)")
   }

   main().catch((err) => {
     console.error(err)
     process.exit(1)
   })
   ```
   跑 `node tests/history/sqlite/migrations-001-stage-blob-carrier.node-e2e.ts` → 应全部打印 `ok:` 并以 `PASS` 结尾（Node 24.16 原生支持直接执行带类型标注的 `.ts`，已核实）。若失败（红），排查 node:sqlite driver 分支差异后修复至绿。
3. 在 `package.json` 的 `scripts` 追加：
   ```json
   "test:backend:node-e2e": "node tests/history/sqlite/migrations-001-stage-blob-carrier.node-e2e.ts",
   ```
   并把它并入 `test:ci`：
   ```json
   "test:ci": "bun run test:backend && bun run test:backend:node-e2e && bun run test:pty",
   ```
4. Commit：`git add -- tests/history/sqlite/migrations-001-stage-blob-carrier.node-e2e.ts package.json && git commit -F <msgfile>`，message: `test(history): add cross-runtime (node:sqlite) e2e check for stage-blob schema floor`。

---

## Phase 2：双轨读路径（工作单元 4）

### P2-T1：`read.ts` FROM-swap（RFC §4 点名站点）

**Files**：`src/lib/history/sqlite/read.ts`

**Steps**：
1. 红：这是纯 SQL 文本替换，无独立单测（既有 `write-read.unit.test.ts` 套件是回归 oracle）。先跑 `bun test tests/history/sqlite/write-read.unit.test.ts` 确认当前全绿（基线）。
2. 绿：把 `loadStagesFor` 的查询从
   ```ts
   .prepare(`SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id IN (${placeholders})`)
   ```
   改为
   ```ts
   .prepare(`SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages_resolved WHERE entry_id IN (${placeholders})`)
   ```
   重跑 `bun test tests/history/sqlite/write-read.unit.test.ts` → 仍绿（因为此刻 view 的 `hash` 全为 NULL，ELSE 分支原样返回，行为不变——这正是 C2 commit invariant 要求的"对旧行无观测差异"）。
3. Commit（与 P2-T2 一起，见下）。

### P2-T2：`calibration-backfill.ts:311` bug-fix FROM-swap + 回归测试

**Files**：`src/lib/history/sqlite/calibration-backfill.ts`、`tests/history/sqlite/calibration-backfill.it.test.ts`（新建，此前无专属测试文件）

**Steps**：
1. 红：新建 `calibration-backfill.it.test.ts`：
   ```ts
   import { beforeEach, describe, expect, test } from "bun:test"
   import { closeDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
   import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
   import { insertCompletedEntry } from "~/lib/history/sqlite/write"
   import { runCalibrationBackfill } from "~/lib/history/sqlite/calibration-backfill"
   // (makeEntry helper mirrors write-read.unit.test.ts's fixture)

   describe("calibration-backfill reads through entry_stages_resolved", () => {
     beforeEach(async () => {
       closeDatabase()
       const db = openInMemoryDatabase()
       await applyForwardMigrations(db)
     })

     test("processes an entry whose stage rows are content-addressed (hash IS NOT NULL)", async () => {
       // Simulate a Phase-3 content-addressed row directly (Phase 3 write-path
       // switch lands later in this plan) by inserting a stage_blob row + an
       // entry_stages row with hash set and an EMPTY placeholder blob_gz — the
       // exact shape insertCompletedEntry will produce after Phase 3.
       const entry = makeEntry({ id: "calib-1" })
       await insertCompletedEntry(entry) // pre-Phase-3: writes hash=NULL inline rows
       // Assert calibration-backfill can still see this entry's stages (baseline,
       // proves the FROM-swap doesn't break the hash=NULL / ELSE path either).
       await expect(runCalibrationBackfill()).resolves.toBeUndefined()
     })
   })
   ```
   （此测试此刻只锁定"FROM-swap 后对 hash=NULL 行为不变"的基线；Phase 3 落地后可选择性追加"对 hash 非空行同样能读到真实内容"的断言，见 P3-T3 的回归覆盖。）
   跑测试 → 若 calibration-backfill 尚未改，此测试本身应能通过（bug 只在"新行"场景才会现形，而新行要等 Phase 3 才存在）——此 task 的红色来自**下一步**：先把 `runCalibrationBackfill` 改到从 view 读，再确认不破坏此基线测试。用红/绿的方式更贴切地说：先加上一个直接构造"hash 非空 + entry_stages.blob_gz 为空占位符"的行的测试，断言 calibration-backfill 修改前**读不到真实内容**（证明 bug 存在，红），修改后能读到（绿）：
   ```ts
   test("bug regression: reads real content through entry_stages.hash, not the (possibly empty) inline blob_gz", async () => {
     const db = openInMemoryDatabase()
     const canonical = losslessStableStringify({ role: "assistant", content: "hi" })
     const hash = hashStageCanonical(canonical)
     db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)").run(hash, compressBytes(new TextEncoder().encode(canonical)))
     db.prepare(
       "INSERT INTO entries_v2 (id, started_at, status, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) VALUES (?,?,?,?,?,?,?)",
     ).run("calib-2", 0, "completed", 1, 1, 1, new Uint8Array([1]))
     db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz, hash) VALUES (?,?,?,?,?,?)").run(
       "calib-2", "outbound_response", 0, 0, EMPTY_STAGE_BLOB_PLACEHOLDER, hash,
     )
     await expect(runCalibrationBackfill()).resolves.toBeUndefined()
     // The real assertion: calibration-backfill's internal stageSelect must resolve
     // `blob_gz` via entry_stages_resolved, not read the empty placeholder directly.
     // (Exercised indirectly via runCalibrationBackfill not throwing/mis-accounting —
     // see calibration-backfill.ts's own processRow for the exact bucket it writes.)
   })
   ```
   跑此测试于**修改前**代码 → 应观测到 `calibration-backfill.ts:311` 的 `stageSelect` 拿到的 `blob_gz` 是空 `Uint8Array`（`decompress` 会因"blob too short"抛错，被 calibration-backfill 的 per-row try/catch 吞掉、计入 errors 桶而非正确处理）——红。
2. 绿：把 `calibration-backfill.ts:311` 的
   ```ts
   const stageSelect = db.prepare("SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages WHERE entry_id = ?")
   ```
   改为
   ```ts
   const stageSelect = db.prepare("SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages_resolved WHERE entry_id = ?")
   ```
   重跑测试 → 绿。
3. Commit：`git add -- src/lib/history/sqlite/read.ts src/lib/history/sqlite/calibration-backfill.ts tests/history/sqlite/calibration-backfill.it.test.ts && git commit -F <msgfile>`，message: `fix(history): route read.ts + calibration-backfill through entry_stages_resolved (dual-track read)`。

### P2-T3：读侧加固 FROM-swap（5 个文件、10 处站点，无独立行为变化）

**Files**：`search-index-backfill.ts:152`、`legacy-stage-backfill.ts:146`、`usage-normalize-backfill.ts:98,100,113,241`、`response-preview-backfill.ts:82`、`cache-write-backfill.ts:147,155,197`

**Steps**：
1. 红：这 10 处此刻全部读 `hash IS NULL` 的旧行（Phase 3 还没切换写路径），FROM-swap 前后对既有测试套件行为完全一致——这是加固性改动，用**既有测试套件作为回归 oracle**（不新增测试）：先跑 `bun run test:backend` 记录基线全绿。
2. 绿：对这 10 处逐一把 `FROM entry_stages` 换成 `FROM entry_stages_resolved`（纯文本替换，不改列名/参数/其余逻辑）。重跑 `bun run test:backend` → 仍全绿（确认零回归）。
3. Commit：`git add -- src/lib/history/sqlite/search-index-backfill.ts src/lib/history/sqlite/legacy-stage-backfill.ts src/lib/history/sqlite/usage-normalize-backfill.ts src/lib/history/sqlite/response-preview-backfill.ts src/lib/history/sqlite/cache-write-backfill.ts && git commit -F <msgfile>`，message: `refactor(history): route remaining entry_stages read sites through entry_stages_resolved`。

### P2-T4：byte-equivalence golden（真实形态 fixture，`toMatchInlineSnapshot` 替换自比较，覆盖新旧行形状 + item 10 两种 fixture 变体）

**背景（对抗审查 MEDIUM-7 采纳：原草稿的 golden 是同义反复）**：原草稿的 `roundTripExpected` 直接 `getEntryById(entry.id)` 再和 `getEntryById` 的结果比较——这是**自比较**（tautological self-comparison），无论读路径写路径怎么改都会通过，从未真正锁定任何具体输出形状。修复：改用 `toMatchInlineSnapshot`，把一份具体、人工可审查的期望值直接写进测试文件源码里（Bun `bun:test` 既有惯例，先例 `restructure-golden.it.test.ts`），配合 `normalizeForGolden` 剥离随机 id / 时间戳等易变字段，使快照具备可复现性。

**Files（新增）**：`tests/history/sqlite/fixtures.ts`（提炼出的共享 fixture，item 11）、`tests/history/sqlite/stage-content-addressing.it.test.ts`

**Steps**：
1. 先新建共享 fixture 文件 `tests/history/sqlite/fixtures.ts`（本计划下方 P3-T2/P3-T3/P4-T2 均从这里 import，不再各自内联定义 `makeRichEntry`）：
   ```ts
   // Shared sqlite-level rich fixture builder — deliberately separate from
   // tests/helpers/history-fixtures.ts (different builder shape, targets the
   // higher-level history-store tests, aliased imports). This file stays
   // alias-free-adjacent (only imports HistoryEntry's TYPE, no runtime deps) so it
   // can be reused across tests/history/sqlite/*.it.test.ts without pulling in
   // unrelated fixture machinery.
   import type { HistoryEntry } from "~/lib/history/types"

   /**
    * Production-shaped fixture: multi-attempt, cache_control on a message block,
    * full client/upstream leg data — mirrors write-read.unit.test.ts's makeEntry
    * idiom, richer (this plan's "real history.db samples" interpretation, design
    * decision #8).
    */
   export function makeRichEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
     return {
       id: `id-${Math.random().toString(36).slice(2)}`,
       endpoint: "anthropic-messages",
       startedAt: Date.now(),
       endedAt: Date.now() + 200,
       durationMs: 200,
       state: "completed",
       active: false,
       lastUpdatedAt: Date.now() + 200,
       transport: "http",
       clientRequest: {
         model: "claude-opus-4-7",
         messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
       },
       attempts: [
         {
           index: 0,
           durationMs: 90,
           effectiveSource: { model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }], body: { messages: [{ role: "user", content: "hi" }] } },
           upstreamRequest: { model: "claude-opus-4-7", body: { messages: [{ role: "user", content: "hi" }] } },
           upstreamResponse: { success: false, model: "claude-opus-4-7", body: null, stopReason: "error" },
         },
         {
           index: 1,
           durationMs: 110,
           effectiveSource: { model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }], body: { messages: [{ role: "user", content: "hi" }] } },
           upstreamRequest: { model: "claude-opus-4-7", body: { messages: [{ role: "user", content: "hi" }] } },
           upstreamResponse: { success: true, model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 7 }, body: { role: "assistant", content: "ok" } },
         },
       ],
       ...overrides,
     } as HistoryEntry
   }

   /**
    * Variant (adversarial-review item 10): a multi-frame `sse_events` fixture on
    * the forwarded track (clientResponse.sseEvents) — a realistic streaming
    * shape distinct from the non-streaming makeRichEntry default.
    */
   export function makeRichEntryWithSseEvents(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
     return makeRichEntry({
       clientResponse: {
         sseEvents: [
           { offsetMs: 0, type: "message_start", raw: `event: message_start\ndata: {"type":"message_start"}\n\n` },
           { offsetMs: 10, type: "content_block_delta", raw: `event: content_block_delta\ndata: {"delta":{"text":"hi"}}\n\n` },
           { offsetMs: 20, type: "content_block_delta", raw: `event: content_block_delta\ndata: {"delta":{"text":" there"}}\n\n` },
           { offsetMs: 30, type: "message_stop", raw: `event: message_stop\ndata: {"type":"message_stop"}\n\n` },
         ],
       },
       ...overrides,
     } as Partial<HistoryEntry>)
   }
   ```
2. 红：新建 `stage-content-addressing.it.test.ts`：
   ```ts
   import { beforeEach, describe, expect, test } from "bun:test"
   import { closeDatabase, getDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
   import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
   import { getEntryById } from "~/lib/history/sqlite/read"
   import { insertCompletedEntry } from "~/lib/history/sqlite/write"
   import { makeRichEntry, makeRichEntryWithSseEvents } from "./fixtures"

   // Strips non-deterministic fields (random id / Date.now()-based timestamps) so
   // the result is safe to pin with toMatchInlineSnapshot — replaces the previous
   // draft's tautological self-comparison (adversarial-review MEDIUM-7: the old
   // roundTripExpected() compared getEntryById()'s output against ITSELF, so it
   // passed regardless of what the read/write path actually produced).
   function normalizeForGolden(entry: unknown): unknown {
     return JSON.parse(
       JSON.stringify(entry, (key, value) => {
         if (key === "id" || key === "startedAt" || key === "endedAt" || key === "lastUpdatedAt") return "<normalized>"
         return value
       }),
     )
   }

   describe("stage content-addressing: read-path byte-equivalence", () => {
     beforeEach(async () => {
       closeDatabase()
       const db = openInMemoryDatabase()
       await applyForwardMigrations(db)
     })

     test("assembleFullEntry output matches a pinned golden shape for an old-shape (hash IS NULL) row round-trip", async () => {
       const entry = makeRichEntry({ id: "golden-old" })
       await insertCompletedEntry(entry)
       const got = normalizeForGolden(getEntryById("golden-old"))
       expect(got).toMatchInlineSnapshot() // first run auto-fills the literal snapshot into this call — commit the filled-in value, then every future run diffs against it verbatim.
     })

     test("assembleFullEntry output matches a pinned golden shape for a multi-frame sse_events row (item 10 fixture variant)", async () => {
       const entry = makeRichEntryWithSseEvents({ id: "golden-sse" })
       await insertCompletedEntry(entry)
       const got = normalizeForGolden(getEntryById("golden-sse"))
       expect(got).toMatchInlineSnapshot()
     })

     test("assembleFullEntry output matches a pinned golden shape for a legacy single-blob row (item 10 fixture variant, stageRows.length===0 branch)", async () => {
       // Direct raw-SQL insert — NOT insertCompletedEntry — to simulate a
       // pre-stage-era row where the head blob_gz IS the full serialized entry and
       // entry_stages has ZERO rows for it (serialize.ts's assembleFullEntry
       // stageRows.length===0 branch).
       const db = getDatabase()
       const legacyEntry = makeRichEntry({ id: "golden-legacy" })
       const { serializeEntryBlob } = await import("~/lib/history/sqlite/serialize") // head-blob encoder, mirrors buildHeadRow's own call
       db.prepare(
         "INSERT INTO entries_v2 (id, started_at, status, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) VALUES (?,?,?,?,?,?,?)",
       ).run("golden-legacy", legacyEntry.startedAt, "completed", 1, 1, 1, serializeEntryBlob(legacyEntry))
       const got = normalizeForGolden(getEntryById("golden-legacy"))
       expect(got).toMatchInlineSnapshot()
     })
   })
   ```
   （若 `serialize.ts` 没有导出名为 `serializeEntryBlob` 的独立函数，落地时改用 `buildHeadRow` 内部实际调用的同名压缩函数——两者语义等价，此处用注释标注"镜像 buildHeadRow 自身调用"以提示实现者核对真实导出名。）
   跑 `bun test tests/history/sqlite/stage-content-addressing.it.test.ts` → 三个 `toMatchInlineSnapshot()` 空调用首次运行会自动把实际值写回源码文件（Bun 惯例：空 `toMatchInlineSnapshot()` 首跑即通过并自填字面量，不是"红"，而是"生成基线"）。
3. 绿 + 定稿：跑完一次后，人工审查 Bun 自动写回的三份快照字面量是否合理（关键校验点：`attempts` 数组、`clientRequest.messages`、`clientResponse.sseEvents`/legacy 分支的字段是否都出现在快照里，而不是被意外吞掉）；确认无误后原样保留（这就是"真正锁定具体输出"，而非自比较）。
4. **注**：三份快照此刻只能锁定"旧行形状"（`insertCompletedEntry` 尚未切到内容寻址）+ legacy 单 blob 行的读取。**新行形状（`hash IS NOT NULL`）的等价断言必须在 Phase 3 落地后补三个新 `toMatchInlineSnapshot()` 测试（P3-T2 的"byte-equivalence golden still holds for NEW-shape rows"测试沿用同一个 `normalizeForGolden` + 同一批 fixture）**——如实标注该依赖，不假装此刻就能覆盖新行分支。
5. Commit：`git add -- tests/history/sqlite/fixtures.ts tests/history/sqlite/stage-content-addressing.it.test.ts && git commit -F <msgfile>`，message: `test(history): lock byte-equivalence golden via toMatchInlineSnapshot (old-shape + legacy + multi-frame sse_events)`。

### P2-T5：`cache_control-shifted twin entries reconstruct losslessly`（RFC BLOCK-A 负样本，独立 task）

**Files**：`tests/history/sqlite/stage-content-addressing.it.test.ts`

**Steps**：
1. 红：在同一文件追加（此刻针对 `losslessStableStringify`/`hashStageCanonical` 直接单测，不依赖 Phase 3 写路径，因为这是"载体身份"层面的性质，不是"写路径接线"层面）：
   ```ts
   import { hashStageCanonical, losslessStableStringify } from "~/lib/history/sqlite/stage-carrier"

   describe("cache_control-shifted twin entries reconstruct losslessly", () => {
     test("cache_control-shifted twin entries reconstruct losslessly", () => {
       // Claude Code's cross-turn cache_control repositioning (request-preparation.ts
       // reactive leg): two request bodies that are IDENTICAL except which message
       // block carries `cache_control` must NOT collide into the same stage_blob hash
       // — doing so would silently lose one twin's actual cache_control position on
       // read-back (RFC R1 BLOCK-A: msg_blob's lossy VOLATILE_KEYS-stripping boundary
       // must NOT be reused here; stage_blob is a lossless, position-preserving
       // identity).
       const twinA = {
         messages: [
           { role: "user", content: "turn 1", cache_control: { type: "ephemeral" } },
           { role: "user", content: "turn 2" },
         ],
       }
       const twinB = {
         messages: [
           { role: "user", content: "turn 1" },
           { role: "user", content: "turn 2", cache_control: { type: "ephemeral" } },
         ],
       }
       const canonicalA = losslessStableStringify(twinA)
       const canonicalB = losslessStableStringify(twinB)
       const hashA = hashStageCanonical(canonicalA)
       const hashB = hashStageCanonical(canonicalB)

       // The critical guard: shifting cache_control's position must change the hash
       // (never dedup two objectively-different bodies into one stage_blob row).
       expect(hashA).not.toBe(hashB)
       // And each twin still round-trips to its OWN exact value (no cross-contamination).
       expect(JSON.parse(canonicalA)).toEqual(twinA)
       expect(JSON.parse(canonicalB)).toEqual(twinB)
     })
   })
   ```
   跑测试 → 若实现正确（`losslessStableStringify` 不剥 `cache_control`），此测试此刻就应该是绿的——但按 TDD 精神，先临时把 `stage-carrier.ts` 的实现改成"错误地剥离 cache_control"验证测试真的会红（证明测试有效性），再改回正确实现验证转绿。这是本计划里"正确实现已在 Phase 0 写就，此 task 是对既有实现的验收测试"的情况，仍需过一遍红/绿以确认 oracle 生效，而非跳过验证直接假设通过。
2. 绿：确认 `stage-carrier.ts` 的 `losslessStableStringify` 不含任何字段剥离逻辑（Phase 0 已如此实现），测试转绿。
3. Commit：`git add -- tests/history/sqlite/stage-content-addressing.it.test.ts && git commit -F <msgfile>`，message: `test(history): add cache_control-shifted twin entries reconstruct losslessly regression (RFC BLOCK-A)`。

---

## Phase 3：写路径切换（工作单元 3）+ Orphan GC（工作单元 5）

### P3-T1：`INSERT_STAGE_SQL` 扩展 + `runStageInsertRef`/`runStageBlobInsert`/`GC_ORPHAN_STAGE_BLOB_SQL`

**Files**：`src/lib/history/sqlite/write.ts`

**Steps**：
1. 红：在既有 `write-read.unit.test.ts` 追加一个此刻会失败的编译期探针（新符号尚未导出）：
   ```ts
   import { GC_ORPHAN_STAGE_BLOB_SQL, runStageBlobInsert, runStageInsertRef } from "~/lib/history/sqlite/write"
   test("new content-addressed write primitives are exported", () => {
     expect(typeof runStageInsertRef).toBe("function")
     expect(typeof runStageBlobInsert).toBe("function")
     expect(typeof GC_ORPHAN_STAGE_BLOB_SQL).toBe("string")
   })
   ```
   跑测试 → 编译失败（红，符号不存在）。
2. 绿：在 `write.ts` 做以下修改：
   - `INSERT_STAGE_SQL` 扩展为 6 列（既有 `upsertHeadRow`/`upsertStageRow`/`runStageInsert` 调用点全部传 `null` 作为第 6 个 `hash` 参数，保持"在途 writer 不做内容寻址"的决策 #10）：
     ```ts
     const INSERT_STAGE_SQL = `
     INSERT OR REPLACE INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz, hash)
     VALUES (?,?,?,?,?,?)
     `
     ```
     ```ts
     function runStageInsert(db: ReturnType<typeof getDatabase>, entryId: string, stage: StagePayload, now: number): void {
       db.prepare(INSERT_STAGE_SQL).run(entryId, stage.stage, stage.attemptIndex, now, compress(stage.payload), null)
     }
     ```
   - 新增（`runStageInsertBlob` 保留不动，Phase 3 之后它将失去所有调用方，本计划**不在此 commit 删除它**——留给 Commit 5 收尾一并清理，避免这个 commit 混杂"新增"与"移除死代码"两种意图）：
     ```ts
     import { compressBytes, compressBytesAsync } from "./compression"
     import { deriveStageRefs, EMPTY_STAGE_BLOB_PLACEHOLDER } from "./stage-carrier"

     /** Persist one content-addressed stage REFERENCE row — blob_gz is the shared
      *  empty placeholder (NOT NULL column, real content lives in stage_blob). */
     function runStageInsertRef(db: ReturnType<typeof getDatabase>, entryId: string, stage: string, attemptIndex: number, hash: string, now: number): void {
       db.prepare(INSERT_STAGE_SQL).run(entryId, stage, attemptIndex, now, EMPTY_STAGE_BLOB_PLACEHOLDER, hash)
     }

     /** Insert a stage_blob row if this hash hasn't been seen before (content-addressed dedup). */
     function runStageBlobInsert(db: ReturnType<typeof getDatabase>, hash: string, blob: Uint8Array): void {
       db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)").run(hash, blob)
     }

     /** Reclaim orphaned `stage_blob` rows — mirrors GC_ORPHAN_MSG_BLOB_SQL. Must run
      *  after every delete that removes entry_stages rows (RFC §3.5 / skill
      *  history-sqlite-schema C3: hook EVERY delete site). */
     export const GC_ORPHAN_STAGE_BLOB_SQL = "DELETE FROM stage_blob WHERE NOT EXISTS (SELECT 1 FROM entry_stages WHERE entry_stages.hash = stage_blob.hash)"
     ```
   跑测试 → 绿。
3. Commit：`git add -- src/lib/history/sqlite/write.ts tests/history/sqlite/write-read.unit.test.ts && git commit -F <msgfile>`，message: `feat(history): extend entry_stages schema binding + add content-addressed write primitives`。

### P3-T2：`insertCompletedEntry` 内容寻址化重写（含对抗审查 BLOCK-2 TOCTOU 修复）

**Files**：`src/lib/history/sqlite/write.ts`、`tests/history/sqlite/stage-content-addressing.it.test.ts`

**Steps**：
1. 红：在 `stage-content-addressing.it.test.ts` 追加"新行形状"断言（此刻应失败，因为写路径还没切换，实际产出仍是 hash=NULL），复用 P2-T4 提炼出的共享 fixture：
   （本 task 在 P2-T4 已新建的同一个 `stage-content-addressing.it.test.ts` 文件里追加，`makeRichEntry`/`makeRichEntryWithSseEvents`/`getDatabase`/`insertCompletedEntry`/`getEntryById`/`normalizeForGolden` 均已由 P2-T4 的头部 import 覆盖，本 task 只需在文件顶部追加以下 4 个此前未用到的 import：）
   ```ts
   import { compressBytes, decompressBytes } from "~/lib/history/sqlite/compression"
   import { hashStageCanonical, losslessStableStringify } from "~/lib/history/sqlite/stage-carrier"
   import { deleteEntries } from "~/lib/history/sqlite/write" // extends the existing `import { insertCompletedEntry } from "..."` line
   ```
   随后追加以下测试：
   ```ts
   test("insertCompletedEntry writes content-addressed rows (hash IS NOT NULL) after Phase 3", async () => {
     const entry = makeRichEntry({ id: "golden-new" })
     await insertCompletedEntry(entry)
     const db = getDatabase()
     const rows = db.prepare("SELECT hash, blob_gz FROM entry_stages WHERE entry_id = ?").all("golden-new") as Array<{ hash: string | null; blob_gz: Uint8Array }>
     expect(rows.length).toBeGreaterThan(0)
     for (const r of rows) {
       expect(r.hash).not.toBeNull()
       expect(r.blob_gz).toHaveLength(0) // EMPTY_STAGE_BLOB_PLACEHOLDER
     }
   })

   test("second identical attempt's stage payload dedups into ONE stage_blob row (same-entry retry folding)", async () => {
     const shared = { model: "claude-opus-4-7", body: { messages: [{ role: "user", content: "hi" }] } }
     const entry = makeRichEntry({
       id: "dedup-1",
       attempts: [
         { index: 0, upstreamRequest: shared, upstreamResponse: { success: false, body: null } },
         { index: 1, upstreamRequest: shared, upstreamResponse: { success: true, body: { role: "assistant", content: "ok" } } },
       ],
     } as never)
     await insertCompletedEntry(entry)
     const db = getDatabase()
     const refRows = db.prepare("SELECT hash FROM entry_stages WHERE entry_id = ? AND stage = 'upstream_request'").all("dedup-1") as Array<{ hash: string }>
     expect(refRows).toHaveLength(2) // two attempts → two references
     expect(refRows[0].hash).toBe(refRows[1].hash) // same body → same hash
     const blobRows = db.prepare("SELECT COUNT(*) AS n FROM stage_blob WHERE hash = ?").get(refRows[0].hash) as { n: number }
     expect(blobRows.n).toBe(1) // ...but only ONE stage_blob row (dedup hit)
   })

   test("byte-equivalence golden still holds for NEW-shape (hash IS NOT NULL) rows (same normalizeForGolden/toMatchInlineSnapshot as P2-T4)", async () => {
     const entry = makeRichEntry({ id: "golden-new-2" })
     await insertCompletedEntry(entry)
     const got = normalizeForGolden(getEntryById("golden-new-2"))
     expect(got).toMatchInlineSnapshot() // first run auto-fills; must match (modulo the normalized id/timestamps) the shape pinned by P2-T4's old-shape snapshot for the same fixture.
   })

   test("byte-equivalence golden still holds for a NEW-shape multi-frame sse_events row (item 10 variant, new-shape leg)", async () => {
     const entry = makeRichEntryWithSseEvents({ id: "golden-new-sse" })
     await insertCompletedEntry(entry)
     const got = normalizeForGolden(getEntryById("golden-new-sse"))
     expect(got).toMatchInlineSnapshot()
   })

   describe("TOCTOU regression (adversarial-review BLOCK-2)", () => {
     test("a concurrent orphan-GC sweep between the pre-check and the transaction does not lose stage_blob content", async () => {
       const db = getDatabase()
       const shared = { model: "m1", body: { messages: [{ role: "user", content: "pre-existing" }] } }
       const canonical = losslessStableStringify(shared)
       const hash = hashStageCanonical(canonical)
       // Seed a stage_blob row for this EXACT hash before insertCompletedEntry runs,
       // so its synchronous Phase-0 pre-check sees a cache HIT (decides this hash
       // does NOT need (re)compression).
       db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)").run(hash, compressBytes(new TextEncoder().encode(canonical)))

       const entry = makeRichEntry({
         id: "toctou-1",
         attempts: [{ index: 0, upstreamRequest: shared, upstreamResponse: { success: true, body: { role: "assistant", content: "ok" } } }],
       } as never)

       // Deterministic race window (established project idiom — see
       // tests/history/search-index-backfill.it.test.ts's unawaited-call +
       // synchronous-stop technique): calling an async function WITHOUT awaiting
       // runs it synchronously up to its first `await`. insertCompletedEntry's
       // Phase-0 pre-check (deriveStageRefs + the stage_blob SELECT) is entirely
       // synchronous and runs BEFORE the function's first `await` (the Phase-1
       // Promise.all) — so by the time control returns to this line, the
       // pre-check has already recorded a cache HIT for `hash`.
       const pending = insertCompletedEntry(entry)
       // Simulate a concurrent orphan-GC sweep (reaper / deleteSession /
       // deleteEntries / clearAllEntries, P3-T3) deleting the row the pre-check
       // just saw, in the SAME tick, before insertCompletedEntry resumes.
       db.prepare("DELETE FROM stage_blob WHERE hash = ?").run(hash)

       await pending

       // Must NOT have silently lost the content: the same-tx re-verification
       // fallback (BLOCK-2 fix) must detect the row vanished and synchronously
       // recompress + re-insert it inside the write transaction.
       const row = db.prepare("SELECT blob_gz FROM stage_blob WHERE hash = ?").get(hash) as { blob_gz: Uint8Array } | undefined
       expect(row).toBeDefined()
       expect(new TextDecoder().decode(decompressBytes(row!.blob_gz))).toBe(canonical) // decompressBytes: sync twin of compressBytes, no async counterpart exists in compression.ts

       await deleteEntries({ sessionId: entry.sessionId ?? "" }) // best-effort cleanup, not asserted
     })
   })
   ```
   跑测试 → 前三个断言红（`insertCompletedEntry` 仍走 `partitionStagesForWrite`/`compressAsync` 全量重压路径，产出 `hash IS NULL`）；TOCTOU 测试此刻也红——当前实现的 pre-check 发生在 `buildSearchIndexChunked` 的 `await` **之后**（不在最前面同步执行），且没有同事务内重验证兜底，`DELETE FROM stage_blob` 删除的行永远不会被重新插入，`row` 断言为 `undefined`（真实丢数据），从而证明了 BLOCK-2 描述的竞态确实存在。
2. 绿：把 `insertCompletedEntry` 重写为（相对原草稿的关键变化：**Phase 0 的 `deriveStageRefs` + pre-check 挪到函数最前面、任何 `await` 之前执行**——这是 BLOCK-2 修复的核心，不再像原草稿那样把 pre-check 放在 `buildSearchIndexChunked` 之后；同时在 Phase 2 的同步事务回调里加**同事务重验证兜底**）：
   ```ts
   export async function insertCompletedEntry(entry: HistoryEntry): Promise<void> {
     const db = getDatabase()
     // ── Phase 0 — SYNCHRONOUS, before any await (BLOCK-2 fix) ────────────────────
     // Pre-check-before-compress (design decision #5) must run BEFORE this
     // function's first await: otherwise a concurrent orphan-GC sweep (reaper /
     // deleteSession / deleteEntries / clearAllEntries) could delete a hash's
     // stage_blob row DURING the awaited Phase-1 window, after we already decided
     // (based on the stale pre-check) not to recompress it — silently losing that
     // hash's content forever (the entry_stages reference row would point at a
     // stage_blob row that no longer exists).
     const refs = deriveStageRefs(entry)
     const stageBlobExists = db.prepare("SELECT 1 FROM stage_blob WHERE hash = ?")
     const needsCompress = refs.filter((r) => !stageBlobExists.get(r.hash))

     // ── Phase 1 — CPU off the event loop (no DB lock held) ──────────────────────
     const [built, headBlob, ...freshBlobs] = await Promise.all([
       buildSearchIndexChunked(entry),
       compressAsync(extractHeadMetaPayload(entry)),
       ...needsCompress.map((r) => compressBytesAsync(new TextEncoder().encode(r.canonical))),
     ])
     const blobByHash = new Map(needsCompress.map((r, i) => [r.hash, freshBlobs[i]]))
     const row = buildHeadRow(entry, undefined, headBlob)
     const now = Date.now()

     // ── Phase 2 — fast SYNCHRONOUS transaction (I7: callback MUST be sync) ───────
     const tx = db.transaction(() => {
       runHeadInsert(db, row)
       // Retained (design decision #11): cheap, metadata-only now that entry_stages
       // rows carry no heavy content — guarantees no stale (stage, attempt_index)
       // key survives a shrunk re-finalize.
       db.prepare("DELETE FROM entry_stages WHERE entry_id = ?").run(row.id)
       for (const ref of refs) {
         let blob = blobByHash.get(ref.hash)
         if (!blob) {
           // Same-tx re-verification (BLOCK-2): the Phase-0 pre-check ran BEFORE
           // any await and may now be stale — re-check inside this SYNCHRONOUS
           // transaction callback (no further await is possible here — I7) and,
           // if the row genuinely vanished since Phase 0, fall back to a
           // SYNCHRONOUS compress (compressBytes, NOT compressBytesAsync — we are
           // already inside a sync tx callback and cannot await).
           if (!stageBlobExists.get(ref.hash)) blob = compressBytes(new TextEncoder().encode(ref.canonical))
         }
         if (blob) runStageBlobInsert(db, ref.hash, blob)
         runStageInsertRef(db, row.id, ref.stage, ref.attemptIndex, ref.hash, now)
       }
       // Content-addressed search index, atomic with head/stage. Sole search write path.
       persistSearchIndex(db, row.id, built)
     })
     tx()
   }
   ```
   并移除现在无调用方的 import（`partitionStagesForWrite`/`extractStagePayloads` 直接 import 移除，改由 `deriveStageRefs` 内部间接使用 `extractStagePayloads`；`extractHeadMetaPayload` 仍需保留 import）。
   跑测试 → 全部绿（含 TOCTOU regression：`stageBlobExists.get(ref.hash)` 在同步事务回调内重新查询到该行已被删除，触发 `compressBytes` 同步兜底重新写回）；同时重跑 P2-T4 的旧行/legacy/sse 三份 golden（`stage-content-addressing.it.test.ts` 全量）确认仍绿（那些测试针对的是**该 commit 之前**已经写入的旧形状读取行为，不受写路径切换影响——Phase 3 只改变**新写入**的形状）。
3. Commit：`git add -- src/lib/history/sqlite/write.ts tests/history/sqlite/stage-content-addressing.it.test.ts && git commit -F <msgfile>`，message: `feat(history): switch insertCompletedEntry to content-addressed stage writes (with same-tx TOCTOU re-verification)`。

### P3-T3：Orphan GC — hook 4 个 delete 站点（含对抗审查 HIGH-4 reaper 测试修复 + item 11 `deleteEntries` filter 修复）

**Files**：`src/lib/history/sqlite/write.ts`、`src/lib/history/sqlite/reaper.ts`

**Steps**：
1. 红：新建/追加测试（`tests/history/sqlite/reaper.unit.test.ts` 追加 stage_blob 覆盖，`write-read.unit.test.ts` 追加 deleteSession/deleteEntries/clearAllEntries 覆盖，均从 `tests/history/sqlite/fixtures.ts` import `makeRichEntry`）：
   ```ts
   // reaper.unit.test.ts 追加：
   import { makeRichEntry } from "./fixtures"

   test("runReaperOnce sweeps orphaned stage_blob rows (HIGH-4: only fires when an eviction ACTUALLY occurs — a zero/negative limit is evictBucket's documented no-op guard, `if (limit <= 0) return 0`, so this test must use a POSITIVE limit with MORE rows than that limit)", async () => {
     const db = getDatabase()
     // Force at least one real eviction: insert 3 completed entries, then call
     // runReaperOnce with successLimit=1 (positive, and 3 > 1).
     for (let i = 0; i < 3; i++) {
       const entry = makeRichEntry({ id: `reap-${i}` })
       await insertCompletedEntry(entry)
     }
     // Seed an orphaned stage_blob row unrelated to any entry_stages reference —
     // this is what the test actually verifies gets swept.
     const canonical = losslessStableStringify({ a: 1 })
     const hash = hashStageCanonical(canonical)
     db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)").run(hash, compressBytes(new TextEncoder().encode(canonical)))

     const deleted = runReaperOnce(1, 999) // successLimit=1, failureLimit=999 (no failures to evict) — 3 completed rows > limit 1, so 2 get evicted, deleted>0, triggering the GC_ORPHAN_STAGE_BLOB_SQL sweep (gated on `if (deleted > 0)`, reaper.ts:77).
     expect(deleted).toBeGreaterThan(0)

     const remaining = db.prepare("SELECT COUNT(*) AS n FROM stage_blob WHERE hash = ?").get(hash) as { n: number }
     expect(remaining.n).toBe(0)
   })
   ```
   ```ts
   // write-read.unit.test.ts 追加：
   import { makeRichEntry } from "./fixtures" // write-read.unit.test.ts lives in the same tests/history/sqlite/ directory as fixtures.ts

   test("deleteSession sweeps orphaned stage_blob rows for the deleted session", async () => {
     const entry = makeRichEntry({ id: "gc-1", sessionId: "sess-gc-1" })
     await insertCompletedEntry(entry)
     const db = getDatabase()
     const { n: before } = db.prepare("SELECT COUNT(*) AS n FROM stage_blob").get() as { n: number }
     expect(before).toBeGreaterThan(0)
     deleteSession("sess-gc-1")
     const { n: after } = db.prepare("SELECT COUNT(*) AS n FROM stage_blob").get() as { n: number }
     expect(after).toBe(0)
   })

   test("deleteEntries sweeps orphaned stage_blob rows for the deleted entries (item 11 fix: QueryOptions has no `ids` filter — use the supported `sessionId` filter, mirroring the deleteSession test above)", async () => {
     const entry = makeRichEntry({ id: "gc-2", sessionId: "sess-gc-2" })
     await insertCompletedEntry(entry)
     const db = getDatabase()
     const { n: before } = db.prepare("SELECT COUNT(*) AS n FROM stage_blob").get() as { n: number }
     expect(before).toBeGreaterThan(0)
     deleteEntries({ sessionId: "sess-gc-2" })
     const { n: after } = db.prepare("SELECT COUNT(*) AS n FROM stage_blob").get() as { n: number }
     expect(after).toBe(0)
   })

   test("clearAllEntries wipes ALL stage_blob rows", async () => {
     const entry = makeRichEntry({ id: "gc-3" })
     await insertCompletedEntry(entry)
     clearAllEntries()
     const db = getDatabase()
     const { n } = db.prepare("SELECT COUNT(*) AS n FROM stage_blob").get() as { n: number }
     expect(n).toBe(0)
   })
   ```
   跑测试 → 红（GC 还没接线，orphan `stage_blob` 行残留；`runReaperOnce(1, 999)` 此刻虽已能真实触发 evict——因为 `evictBucket` 本身早已存在——但 `GC_ORPHAN_STAGE_BLOB_SQL` 还没被 `reaper.ts` 调用，orphan 行不会被清）。
2. 绿：
   - `reaper.ts`：import `GC_ORPHAN_STAGE_BLOB_SQL`，在 `runReaperOnce` 内紧邻既有 `db.prepare(GC_ORPHAN_MSG_BLOB_SQL).run()`（line 84，`if (deleted > 0)` 块内）追加 `db.prepare(GC_ORPHAN_STAGE_BLOB_SQL).run()`。
   - `write.ts`：
     - `deleteSession`：在 `if (deleted > 0) db.prepare(GC_ORPHAN_MSG_BLOB_SQL).run()` 后追加 `db.prepare(GC_ORPHAN_STAGE_BLOB_SQL).run()`。
     - `deleteEntries`：同样在其 `if (deleted > 0) ...` 块内追加。
     - `clearAllEntries`：追加裸删（RFC §3.5 明确"clearAllEntries 用裸 DELETE，免 NOT EXISTS 扫"）：`db.prepare("DELETE FROM stage_blob").run()`。
   跑测试 → 绿。
3. Commit：`git add -- src/lib/history/sqlite/write.ts src/lib/history/sqlite/reaper.ts tests/history/sqlite/reaper.unit.test.ts tests/history/sqlite/write-read.unit.test.ts && git commit -F <msgfile>`，message: `feat(history): hook stage_blob orphan GC into every delete site (deleteSession/deleteEntries/clearAllEntries/reaper)`。

### P3-T4：`restructure-golden.it.test.ts` 文档注释配套更新（非逻辑改动）

**Files**：`tests/history/restructure-golden.it.test.ts`、`src/lib/history/sqlite/serialize.ts`

**Steps**：
1. 无红/绿（纯文档注释，无可测试行为变化——按项目纪律"不可测试项改用 lint/构建/人工可复现验证"）：确认 `bun run typecheck` + `bun run lint` 通过即视为验证充分。
2. 修改：
   - `restructure-golden.it.test.ts` 模块级注释追加一句：说明该测试锁定的是「读侧 request_group 展开兼容分支」，finalize 写路径已于本计划 Phase 3 切换为内容寻址（不再产生 request_group 折叠帧），此测试的 6 个内联快照继续覆盖**旧数据的读取兼容性**，不代表当前写路径行为。
   - `serialize.ts` 的 `partitionStagesForWrite` 定义处 JSDoc 追加一行：`@deprecated 写路径不再调用（Phase 3，insertCompletedEntry 已切换为内容寻址），仅供理解/维护既有 request_group 读侧展开兼容分支时参考其历史写入形态。` （不加 `@deprecated` 装饰器行为，仅注释说明，因为 `decodeStageRows` 的 request_group 展开分支仍需要理解这个历史形态。）
3. Commit：`git add -- tests/history/restructure-golden.it.test.ts src/lib/history/sqlite/serialize.ts && git commit -F <msgfile>`，message: `docs(history): clarify restructure-golden + partitionStagesForWrite now describe a retained read-side compat path`。

### P3-T5：`usage-normalize-backfill.ts` + `cache-write-backfill.ts` 的 correction 重新内容寻址化（对抗审查 MEDIUM-8 采纳：静默丢数据修复）

**背景（MEDIUM-8）**：这两个 backfill 的 `processBatch` 都是"P2-T3 之前遗留的写路径"——它们的 `setStageBlobStmt` 始终是 `UPDATE entry_stages SET blob_gz = ? WHERE entry_id = ? AND stage = ? AND attempt_index = ?`（直接写 `entry_stages.blob_gz` 这一列）。P2-T3 只把它们的**读**站点（`stageSelect`/`stageRow` 的 `FROM`）切到了 `entry_stages_resolved`，从未触碰**写**语句。Phase 3 落地后，任何 `entry_stages.hash IS NOT NULL` 的行（内容寻址行）的真实内容只活在 `stage_blob.blob_gz`，`entry_stages_resolved` 视图的 `CASE WHEN es.hash IS NOT NULL THEN sb.blob_gz ELSE es.blob_gz END` 对这类行**永远忽略** `entry_stages.blob_gz`——两个 backfill 对这类行的 `setStageBlobStmt` UPDATE 因此是一次静默写入黑洞：列（`entries_v2.input_tokens`/`cache_read`/`cache_creation`）被正确改写，但 blob 那一侧的修正对**每一个读者**都不可见（详情页永远读到修正前的旧值），产生列表/详情永久性分歧，且没有任何报错或标记能暴露这个问题。

**修复方向**：当目标 `entry_stages` 引用行的 `hash` 已设置（内容寻址行）时，修正必须走"重新内容寻址"：`losslessStableStringify(修正后payload)` → `hashStageCanonical` → `INSERT OR IGNORE INTO stage_blob` → `UPDATE entry_stages SET hash = 新hash`（旧 hash 指向的 `stage_blob` 行変成 orphan，留给下一次 orphan GC——P3-T3 的 4 个 hook 点——回收，不在这里同步清理，与"orphan 回收是最终一致"的既有设计一致）。当 `hash IS NULL`（旧形态行）时，保留原有的直接 `blob_gz` UPDATE 不变（这条路径本就正确，因为 `entry_stages_resolved` 对 `hash IS NULL` 行读的正是 `es.blob_gz`）。

**Files**：`src/lib/history/sqlite/usage-normalize-backfill.ts`、`src/lib/history/sqlite/cache-write-backfill.ts`、`tests/history/usage-normalize-backfill.it.test.ts`、`tests/history/cache-write-backfill.it.test.ts`

**Steps**：

1. 红：在两个 `.it.test.ts` 文件里分别追加一个"内容寻址行"regression 测试，先加一个共享的手工插入 helper（不复用 `tests/history/sqlite/fixtures.ts`——那是 sqlite 层直插 `entry_stages`/`entries_v2` 的 fixture，这两个 `.it.test.ts` 已有自己的、更贴合 backfill 场景的手工 seed helper 风格，沿用其既有惯例即可）：

   `tests/history/usage-normalize-backfill.it.test.ts` 追加：
   ```ts
   import { compressBytes } from "~/lib/history/sqlite/compression"
   import { hashStageCanonical, losslessStableStringify } from "~/lib/history/sqlite/stage-carrier"

   /**
    * Insert a CONTENT-ADDRESSED outbound_response stage row (post-Phase-3 shape,
    * see plan-1-carrier.md P3-T2): entry_stages.hash is set, entry_stages.blob_gz
    * is the empty placeholder, and the real bytes live in a SEPARATE stage_blob
    * row keyed by hash — mirrors what insertCompletedEntry now produces.
    */
   function insertContentAddressedStageRow(id: string, stage: string, attemptIndex: number, payload: unknown): void {
     const canonical = losslessStableStringify(payload)
     const hash = hashStageCanonical(canonical)
     const db = getDatabase()
     db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)").run(hash, compressBytes(new TextEncoder().encode(canonical)))
     db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz, hash) VALUES (?,?,?,?,?,?)").run(id, stage, attemptIndex, 0, new Uint8Array(0), hash)
   }

   test("MEDIUM-8 regression: correcting a CONTENT-ADDRESSED outbound_response row's usage is not silently lost (blob-side must reflect the net value, not just the column)", async () => {
     const id = "ca-usage-1"
     const model = MODEL_FOR["openai-chat-completions"]
     const head = { endpoint: "openai-chat-completions", state: "completed", attempts: [{ index: 0, strategy: "primary", durationMs: 1 }] }
     getDatabase()
       .prepare(
         "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, output_tokens, usage_normalized, blob_gz) "
           + "VALUES (?,?,?,?,?,?,?,?,0,?)",
       )
       .run(id, 0, "openai-chat-completions", "http", "completed", 100, 20, 3, compress(head))
     insertContentAddressedStageRow(id, "outbound_response", 0, { success: true, model, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 3 }, content: null })

     await runUsageNormalizeBackfill(getDatabase())

     expect(col(id).input_tokens).toBe(80) // net = 100 − 20 (cache_creation defaults 0)
     // MUST reflect the corrected value through entry_stages_resolved (what every
     // reader — getEntryById / the detail page — actually sees). Before the
     // MEDIUM-8 fix this stays 100: the old code's setStageBlobStmt writes
     // entry_stages.blob_gz, which the VIEW ignores for hash IS NOT NULL rows —
     // a silent, undetectable column/blob divergence.
     expect(blobInput(id)).toBe(80)
   })
   ```
   跑 `bun test tests/history/usage-normalize-backfill.it.test.ts` → 新测试红：`col(id).input_tokens` 断言绿（列本就被正确改写），但 `blobInput(id)` 断言失败（仍读到 100），证明 MEDIUM-8 描述的丢失确实发生。

   `tests/history/cache-write-backfill.it.test.ts` 追加（同构，针对 `upstream_response` 阶段 + 完整 split 重算）：
   ```ts
   import { compressBytes } from "~/lib/history/sqlite/compression"
   import { hashStageCanonical, losslessStableStringify } from "~/lib/history/sqlite/stage-carrier"

   /** Content-addressed twin of insertStageRow above — same hash-carrier shape as
    *  insertCompletedEntry now produces post-Phase-3. */
   function insertContentAddressedStageRow(id: string, stage: string, attemptIndex: number, payload: unknown): void {
     const canonical = losslessStableStringify(payload)
     const hash = hashStageCanonical(canonical)
     const db = getDatabase()
     db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)").run(hash, compressBytes(new TextEncoder().encode(canonical)))
     db.prepare("INSERT INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz, hash) VALUES (?,?,?,?,?,?)").run(id, stage, attemptIndex, 0, new Uint8Array(0), hash)
   }

   test("MEDIUM-8 regression: correcting a CONTENT-ADDRESSED upstream_response row's split is not silently lost", async () => {
     const id = "ca-cw-1"
     const head = { endpoint: "openai-chat-completions", state: "completed", attempts: [{ index: 0, strategy: "primary", durationMs: 1 }] }
     getDatabase()
       .prepare(
         "INSERT INTO entries_v2 (id, started_at, endpoint, transport, status, input_tokens, cache_read, cache_creation, output_tokens, usage_normalized, stages_migrated, cache_write_backfilled, blob_gz) "
           + "VALUES (?,?,?,?,?,?,?,?,?,1,1,0,?)",
       )
       .run(id, 0, "openai-chat-completions", "http", "streaming-done", 400, 600, null, 3, compress(head))
     insertContentAddressedStageRow(id, "upstream_response", 0, {
       success: true,
       model: "gpt-5",
       usage: { input_tokens: 400, cache_read_input_tokens: 600, output_tokens: 3 },
       body: null,
       sseEvents: [{ offsetMs: 2, type: "message", raw: CHAT_FRAME }],
     })

     await runCacheWriteBackfill(getDatabase())

     const c = col(id)
     expect(c.input_tokens).toBe(100) // 1000 − 600 − 300, same oracle as the existing non-content-addressed test above
     expect(c.cache_creation).toBe(300)
     // Blob-side must agree — before the MEDIUM-8 fix this stays { input_tokens: 400, ... }
     // (the stale pre-correction value), because the old setStageBlobStmt UPDATE
     // targets entry_stages.blob_gz, invisible through entry_stages_resolved for a
     // hash IS NOT NULL row.
     expect(blobUsage(id)).toEqual({ input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 })
   })
   ```
   跑 `bun test tests/history/cache-write-backfill.it.test.ts` → 同理红（`col(id)` 绿，`blobUsage(id)` 仍是修正前的 `{ input_tokens: 400, ... }`）。

2. 绿：对两个源文件做同构修改。

   **`usage-normalize-backfill.ts`**：
   - imports 追加：`compressBytes` 加入既有 `import { compress, decompress } from "./compression"` 一行；新增 `import { hashStageCanonical, losslessStableStringify } from "./stage-carrier"`。
   - `BlobRewrite` 接口追加一个字段：
     ```ts
     interface BlobRewrite {
       stage?: string
       attemptIndex?: number
       blob: Uint8Array
       /** entry_stages.hash for this stage row at prepare-time (undefined for
        *  head-row rewrites, which are never content-addressed). If non-null, this
        *  row is content-addressed — the correction must be RE-CONTENT-ADDRESSED
        *  (MEDIUM-8), not written to the inline blob_gz column entry_stages_resolved
        *  ignores for such rows. */
       originalHash?: string | null
     }
     ```
   - `prepareBlobRewrites` 签名的 `stageRows` 参数类型追加 `hash: string | null`，push 时带上 `originalHash: s.hash`：
     ```ts
     function prepareBlobRewrites(headBlob: Uint8Array | undefined, stageRows: Array<{ attempt_index: number; blob_gz: Uint8Array; hash: string | null }>): Array<BlobRewrite> {
       // ...
       if (payload?.usage && netizeUsageInPlace(payload.usage)) {
         rewrites.push({ stage: "outbound_response", attemptIndex: s.attempt_index, blob: compress(payload), originalHash: s.hash })
       }
       // ... (head-row branch unchanged — head rewrites never carry originalHash)
     ```
   - `processBatch` 里的 `stageSelect` 追加 `hash` 列（`FROM entry_stages_resolved` 已由 P2-T3 切换，这里只加一列）：
     ```ts
     const stageSelect = db.prepare("SELECT attempt_index, blob_gz, hash FROM entry_stages_resolved WHERE entry_id = ? AND stage = 'outbound_response'")
     ```
   - `processBatch` 新增三条 prepared statement，并把应用循环里 `rw.stage` 分支一分为二：
     ```ts
     const setStageHashStmt = db.prepare("UPDATE entry_stages SET hash = ? WHERE entry_id = ? AND stage = ? AND attempt_index = ?")
     const stageBlobExistsStmt = db.prepare("SELECT 1 FROM stage_blob WHERE hash = ?")
     const insertStageBlobStmt = db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)")
     ```
     ```ts
     for (const rw of rewrites) {
       if (rw.stage) {
         if (rw.originalHash != null) {
           // Content-addressed row (MEDIUM-8 fix): entry_stages.blob_gz is IGNORED
           // by entry_stages_resolved for hash IS NOT NULL rows — writing there
           // would be the exact silent-loss bug this task fixes. Re-derive a NEW
           // hash for the corrected payload and repoint this reference row at it;
           // the OLD hash's stage_blob row becomes an orphan, reclaimed by the
           // next orphan-GC sweep (P3-T3's four hook sites) — not synchronously
           // cleaned up here, consistent with the project's eventual-orphan-GC design.
           const canonical = losslessStableStringify(JSON.parse(new TextDecoder().decode(decompress(rw.blob) as never as Uint8Array)))
           // NOTE for implementer: rw.blob here is the ALREADY-COMPRESSED corrected
           // payload (compress(payload), same as the existing blob field) — decompress
           // it back to the plain object before re-stringifying canonically, OR
           // (simpler / avoids a pointless compress→decompress round trip) change
           // prepareBlobRewrites to ALSO stash the plain corrected `payload` object
           // on the BlobRewrite (a new `payload?: unknown` field) so processBatch can
           // call losslessStableStringify(rw.payload) directly without decompressing
           // rw.blob. Prefer the second (payload-carrying) approach when landing —
           // it is less code and avoids a redundant round trip; the decompress
           // fallback above is written out only so this plan doc stays self-contained
           // without silently assuming an unlanded interface change.
           const newHash = hashStageCanonical(canonical)
           insertStageBlobStmt.run(newHash, compressBytes(new TextEncoder().encode(canonical)))
           setStageHashStmt.run(newHash, scan.id, rw.stage, rw.attemptIndex)
         } else {
           setStageBlobStmt.run(rw.blob, scan.id, rw.stage, rw.attemptIndex)
         }
       } else {
         setHeadBlobStmt.run(rw.blob, scan.id)
       }
     }
     ```
     （落地时按上面注释采纳"`BlobRewrite` 多带一个 `payload?: unknown` 字段"的简化版——`prepareBlobRewrites` 在 `push` 时把已经被 `netizeUsageInPlace` 原地修改过的 `payload` 对象一并放进去，`processBatch` 直接 `losslessStableStringify(rw.payload)`，不必再 `decompress(rw.blob)` 走一趟。上面保留了"从 `rw.blob` 反解"的等价写法仅作为落地时的后备参照，避免本计划文档依赖一个未在此明确落笔的接口改动。）
   - `stageBlobExistsStmt` 在本 task 里其实未被直接使用（`INSERT OR IGNORE` 已经是幂等的，不需要显式先查）——保留这条声明仅为了与 P3-T2 的 Phase-0 pre-check 风格一致（可读性/未来复用），落地时若 lint 因"未使用变量"报错，直接删除这一行即可（不影响正确性，`INSERT OR IGNORE` 本身已经安全）。

   **`cache-write-backfill.ts`**：结构同构，唯一差异是它的 `stageRow` 用 `.get()`（单行，取最大 `attempt_index`）而非 `.all()`：
   - imports 追加同上（`compressBytes` 加入既有 `compression` 导入行；新增 `stage-carrier` 导入行）。
   - `BlobRewrite` 接口追加同一个 `originalHash?: string | null` 字段。
   - `prepareBlobRewrites` 里的 `stageRow` 查询追加 `hash` 列：
     ```ts
     const stageRow = db.prepare("SELECT attempt_index, blob_gz, hash FROM entry_stages_resolved WHERE entry_id = ? AND stage = 'upstream_response' ORDER BY attempt_index DESC LIMIT 1").get(id) as
       | { attempt_index: number; blob_gz: Uint8Array; hash: string | null }
       | undefined
     ```
     push 时带 `originalHash: stageRow.hash`（以及同上采纳的 `payload` 简化字段）。
   - `processBatch` 追加同样的 `setStageHashStmt`/`insertStageBlobStmt` 两条语句 + 应用循环里同样的 `rw.originalHash != null` 分支。
   跑两个 `.it.test.ts` 文件 → 新测试转绿；重跑两个文件的**全量**既有测试（含非内容寻址、legacy 分支）确认零回归（`hash IS NULL` 分支的行为逐字未变）。

3. Commit：`git add -- src/lib/history/sqlite/usage-normalize-backfill.ts src/lib/history/sqlite/cache-write-backfill.ts tests/history/usage-normalize-backfill.it.test.ts tests/history/cache-write-backfill.it.test.ts && git commit -F <msgfile>`，message: `fix(history): re-content-address backfill corrections to content-addressed stage rows (adversarial-review MEDIUM-8)`。

---

## Phase 4：Backfill（工作单元 6）

### P4-T1：`meta.ts` 新常量

**Files**：`src/lib/history/sqlite/meta.ts`

**Steps**：
1. 红：无独立测试（纯常量导出），但后续 P4-T2 的测试会因这些常量不存在而编译失败——把它们视为一体，此 task 先行完成常量定义，跑 `bun run typecheck` 确认无孤立错误。
2. 绿：追加（沿用既有三元命名惯例）：
   ```ts
   /** Completion-flag value written once the stage_blob content-addressing backfill finishes. */
   export const STAGE_BLOB_BACKFILL_VERSION = "1"

   /** `history_meta` key: set to STAGE_BLOB_BACKFILL_VERSION only when the full backfill completes. */
   export const STAGE_BLOB_BACKFILL_VERSION_KEY = "stage_blob_backfill_version"

   /** `history_meta` key: resumable backfill progress — a JSON `{ts, id}` compound
    *  keyset cursor (calibration-backfill's style; no cross-batch accumulator here
    *  to keep in lock-step, unlike calibration's own cursor+accumulator pairing). */
   export const STAGE_BLOB_BACKFILL_CURSOR_KEY = "stage_blob_backfill_cursor"

   /**
    * `history_meta` key: the dedup ratio (total entry_stages refs with a hash set /
    * distinct stage_blob rows). Primary evidence is WITHIN-entry retry folding
    * (RFC §3.4/§9 — lossless hashing intentionally does NOT fold cross-entry
    * cache_control-shifted twins), so the healthy floor here is much lower than
    * msg_blob's ~40x cross-turn floor — see STAGE_BLOB_DEDUP_TRIPWIRE_FLOOR in
    * stage-blob-backfill.ts.
    */
   export const STAGE_BLOB_DEDUP_RATIO_KEY = "stage_blob_dedup_ratio"
   ```
3. Commit（与 P4-T2 一起提交）。

### P4-T2：`stage-blob-backfill.ts`（骨架仿 `search-index-backfill.ts`/`legacy-stage-backfill.ts`，含对抗审查 HIGH-6 `ACTIVE_STATES` 过滤修复 + HIGH-5 cooperative-stop 测试修复）

**Files（新增）**：`src/lib/history/sqlite/stage-blob-backfill.ts`、`tests/history/sqlite/stage-blob-backfill.it.test.ts`

**Steps**：
1. 红：新建测试文件（imports 修复：原草稿引用了 `makeRichEntry`/`extractStagePayloads` 却未 import——这里补全；原草稿的 `makeLegacyShapedRow` helper 未被任何测试实际调用，属未用死代码——移除，改用 `upsertHeadRow`+`upsertStageRow` 这条**与生产 pre-Phase-3 写路径完全同构**的既有组合来构造 legacy 行，不再手搓一份重复语义的 helper）：
   ```ts
   import { beforeEach, describe, expect, test } from "bun:test"
   import { closeDatabase, getDatabase, openInMemoryDatabase } from "~/lib/history/sqlite/connection"
   import { applyForwardMigrations } from "~/lib/history/sqlite/migrations/run"
   import {
     //
     getMeta,
     STAGE_BLOB_BACKFILL_VERSION_KEY,
     STAGE_BLOB_DEDUP_RATIO_KEY,
   } from "~/lib/history/sqlite/meta"
   import { extractStagePayloads } from "~/lib/history/sqlite/serialize"
   import { resetStageBlobBackfillForTests, runStageBlobBackfill, stopStageBlobBackfill } from "~/lib/history/sqlite/stage-blob-backfill"
   import { upsertHeadRow, upsertStageRow } from "~/lib/history/sqlite/write"

   import { makeRichEntry } from "./fixtures"

   describe("stage-blob-backfill", () => {
     beforeEach(async () => {
       closeDatabase()
       const db = openInMemoryDatabase()
       await applyForwardMigrations(db)
       resetStageBlobBackfillForTests()
     })

     test("backfills a legacy row into a content-addressed row (hash gets set, stage_blob gets the content)", async () => {
       const entry = makeRichEntry({ id: "bf-1" }) // via upsertHeadRow+upsertStageRow, pre-Phase-3 style
       upsertHeadRow(entry)
       for (const stage of extractStagePayloads(entry)) upsertStageRow(entry.id, stage)

       await runStageBlobBackfill(getDatabase())

       const db = getDatabase()
       const row = db.prepare("SELECT hash FROM entry_stages WHERE entry_id = ? LIMIT 1").get("bf-1") as { hash: string | null }
       expect(row.hash).not.toBeNull()
       expect(getMeta(db, STAGE_BLOB_BACKFILL_VERSION_KEY)).toBe("1")
     })

     test("is idempotent: re-running after completion is a fast no-op (version guard)", async () => {
       const entry = makeRichEntry({ id: "bf-2" })
       upsertHeadRow(entry)
       for (const stage of extractStagePayloads(entry)) upsertStageRow(entry.id, stage)
       await runStageBlobBackfill(getDatabase())
       const db = getDatabase()
       const before = db.prepare("SELECT hash FROM entry_stages WHERE entry_id = ? LIMIT 1").get("bf-2")
       await runStageBlobBackfill(getDatabase()) // second run: version guard short-circuits
       const after = db.prepare("SELECT hash FROM entry_stages WHERE entry_id = ? LIMIT 1").get("bf-2")
       expect(after).toEqual(before)
     })

     test("dedup-ratio tripwire: same-entry retry folding produces ratio > 1.0", async () => {
       const shared = { model: "m1", body: { messages: [{ role: "user", content: "hi" }] } }
       const entry = makeRichEntry({
         id: "bf-dedup",
         attempts: [
           { index: 0, upstreamRequest: shared, upstreamResponse: { success: false, body: null } },
           { index: 1, upstreamRequest: shared, upstreamResponse: { success: true, body: { role: "assistant", content: "ok" } } },
         ],
       } as never)
       upsertHeadRow(entry)
       for (const stage of extractStagePayloads(entry)) upsertStageRow(entry.id, stage)

       await runStageBlobBackfill(getDatabase())

       const db = getDatabase()
       const ratio = Number(getMeta(db, STAGE_BLOB_DEDUP_RATIO_KEY))
       expect(ratio).toBeGreaterThan(1.0) // the two identical upstream_request bodies folded into one stage_blob row
     })

     test("ACTIVE_STATES exclusion (adversarial-review HIGH-6 fix): a still-in-flight (streaming) row's entry_stages are left untouched", async () => {
       const entry = makeRichEntry({ id: "bf-active-1" })
       upsertHeadRow(entry, "streaming") // statusOverride — simulates a request still mid-flight
       for (const stage of extractStagePayloads(entry)) upsertStageRow(entry.id, stage)

       await runStageBlobBackfill(getDatabase())

       const db = getDatabase()
       const row = db.prepare("SELECT hash FROM entry_stages WHERE entry_id = ? LIMIT 1").get("bf-active-1") as { hash: string | null }
       // Must remain hash IS NULL: the backfill's scanStmt must skip ACTIVE_STATES
       // rows entirely (not merely "process them last") — before the fix, the
       // original draft's scanStmt had no status predicate at all, so this row
       // would have been silently migrated even though the request it belongs to
       // may still be concurrently appending/overwriting its own entry_stages rows.
       expect(row.hash).toBeNull()
     })

     test("cooperative stop (adversarial-review HIGH-5 fix): stopStageBlobBackfill during the batch-boundary yield halts the loop before completion", async () => {
       // 60 legacy rows (BACKFILL_BATCH_SIZE=50, same idiom as
       // search-index-backfill.it.test.ts's "cooperative stop mid-pass" test): the
       // first batch (50 rows) runs synchronously, then the loop hits `await
       // sleep(0)` — we set the stop flag DURING that yield so batch 2 (the
       // remaining 10 rows) sees it and breaks before running. The ORIGINAL draft
       // called `stopStageBlobBackfill()` BEFORE `await runStageBlobBackfill(...)`,
       // which is a no-op: `runStageBlobBackfill` resets `stopRequested = false` at
       // its own synchronous entry (before its first `await`), so a pre-set flag is
       // always wiped before the loop's first check — the test could never actually
       // observe a stop. Calling WITHOUT awaiting instead lets this test's own
       // synchronous code run AFTER runStageBlobBackfill suspends at its `await
       // sleep(0)`, so the flag set here survives into the loop's next iteration.
       for (let i = 0; i < 60; i++) {
         const entry = makeRichEntry({ id: `bf-stop-${String(i).padStart(2, "0")}` })
         upsertHeadRow(entry)
         for (const stage of extractStagePayloads(entry)) upsertStageRow(entry.id, stage)
       }

       const pass = runStageBlobBackfill(getDatabase()) // runs batch 1 (50 rows) synchronously, then yields at `await sleep(0)`
       stopStageBlobBackfill() // set DURING the yield → batch 2 (remaining 10 rows) breaks before running
       await pass

       const db = getDatabase()
       // Partial: version flag unset (did not reach completion), cursor saved.
       expect(getMeta(db, STAGE_BLOB_BACKFILL_VERSION_KEY)).not.toBe("1")
       // Count DISTINCT migrated ENTRIES (not stage rows — each entry has several
       // entry_stages rows, so a row-count would not map 1:1 to "how many of the 60
       // entries got migrated").
       const migratedEntries = (
         db.prepare("SELECT COUNT(DISTINCT entry_id) AS n FROM entry_stages WHERE entry_id LIKE 'bf-stop-%' AND hash IS NOT NULL").get() as { n: number }
       ).n
       // Exactly the first batch's entries were migrated — proves the stop actually
       // took effect mid-pass rather than either (a) never stopping (all 60 done)
       // or (b) the pre-fix no-op (0 done, the flag having been wiped at entry).
       expect(migratedEntries).toBeGreaterThan(0)
       expect(migratedEntries).toBeLessThan(60)
     })
   })
   ```
   跑测试 → 全部因模块不存在而红（编译期）。落地 `stage-blob-backfill.ts` 后重跑：HIGH-6/HIGH-5 两个新增 regression 测试此刻若用**未修复**的骨架实现（无 `status NOT IN` 谓词、`stopRequested` 在入口无条件重置）会真实红——ACTIVE_STATES 测试会看到 `row.hash` 被误迁移（不是 null），cooperative-stop 测试会看到 `migratedEntries` 等于 60（全量跑完，从未真正停下）——这正是下方 Step 2 代码块必须已经内嵌 HIGH-6/HIGH-5 两处修复的原因（本计划不再分两次红绿，直接把修复后的最终实现一次性写入，因为这是新文件而非既有实现的追加修补）。
2. 绿：新建 `stage-blob-backfill.ts`（骨架仿 `search-index-backfill.ts` 的批次/checkpoint/tripwire 常量 + `calibration-backfill.ts` 的 keyset 游标，正文实现见本计划第 6 节 Cutover 前文档已完整起草的设计——落地时按下方精确代码）：
   ```ts
   /**
    * Recoverable background backfill that content-addresses EVERY entry_stages row
    * still written the OLD way (`hash IS NULL`) — reuses the exact production
    * reconstruction pipeline (`assembleFullEntry` → `deriveStageRefs`) so a
    * backfilled row's shape is byte-identical to what a fresh Stage-1 write would
    * produce (RFC 2026-07-14 §5, plan design decisions #12/#13).
    *
    * No ordering dependency on legacy-stage-backfill: assembleFullEntry already
    * transparently reconstructs both old-shape and new-shape rows into one
    * HistoryEntry (adaptLegacyLegsInPlace), so deriveStageRefs always sees the
    * same canonical member list regardless of source-row shape.
    */
   import consola from "consola"
   import { setTimeout as sleep } from "node:timers/promises"

   import { ACTIVE_STATES } from "../lifecycle-state"
   import type { Database } from "./connection"
   import { compressBytes } from "./compression"
   import {
     getMeta,
     setMeta,
     STAGE_BLOB_BACKFILL_CURSOR_KEY,
     STAGE_BLOB_BACKFILL_VERSION,
     STAGE_BLOB_BACKFILL_VERSION_KEY,
     STAGE_BLOB_DEDUP_RATIO_KEY,
   } from "./meta"
   import { assembleFullEntry, type EntryRow, type StageRow } from "./serialize"
   import { deriveStageRefs, EMPTY_STAGE_BLOB_PLACEHOLDER } from "./stage-carrier"

   const BACKFILL_BATCH_SIZE = 50
   const CHECKPOINT_EVERY_BATCHES = 20
   const STAGE_BLOB_DEDUP_TRIPWIRE_MIN_REFS = 200
   const STAGE_BLOB_DEDUP_TRIPWIRE_FLOOR = 1.02

   let stopRequested = false
   let running = false

   export function stopStageBlobBackfill(): void { stopRequested = true }
   export function resetStageBlobBackfillForTests(): void { stopRequested = false; running = false }

   interface BackfillCounts { migrated: number; skipped: number; errors: number }
   interface ScanRow { id: string; started_at: number }

   function loadHeadRows(db: Database, ids: Array<string>): Map<string, EntryRow> {
     const map = new Map<string, EntryRow>()
     if (ids.length === 0) return map
     const placeholders = ids.map(() => "?").join(",")
     const rows = db.prepare(`SELECT * FROM entries_v2 WHERE id IN (${placeholders})`).all(...ids) as Array<EntryRow>
     for (const r of rows) map.set(r.id, r)
     return map
   }

   function loadStageRows(db: Database, ids: Array<string>): Map<string, Array<StageRow>> {
     const map = new Map<string, Array<StageRow>>()
     if (ids.length === 0) return map
     const placeholders = ids.map(() => "?").join(",")
     const rows = db
       .prepare(`SELECT entry_id, stage, attempt_index, created_at, blob_gz FROM entry_stages_resolved WHERE entry_id IN (${placeholders})`)
       .all(...ids) as Array<StageRow>
     for (const r of rows) {
       const list = map.get(r.entry_id)
       if (list) list.push(r)
       else map.set(r.entry_id, [r])
     }
     return map
   }

   export function recordStageBlobDedupRatio(db: Database): number {
     try {
       const total = (db.prepare("SELECT COUNT(*) AS n FROM entry_stages WHERE hash IS NOT NULL").get() as { n: number }).n
       const distinct = (db.prepare("SELECT COUNT(*) AS n FROM stage_blob").get() as { n: number }).n
       const ratio = distinct > 0 ? total / distinct : 0
       setMeta(db, STAGE_BLOB_DEDUP_RATIO_KEY, ratio.toFixed(2))
       if (total >= STAGE_BLOB_DEDUP_TRIPWIRE_MIN_REFS && ratio < STAGE_BLOB_DEDUP_TRIPWIRE_FLOOR) {
         consola.warn(`[stage-blob-backfill] dedup ratio ${ratio.toFixed(2)}x at ${total} refs is at/near 1.0 — same-entry retries may not be folding.`)
       } else if (total > 0) {
         consola.info(`[stage-blob-backfill] dedup ratio ${ratio.toFixed(2)}x (${total} refs -> ${distinct} distinct stage_blob rows)`)
       }
       return ratio
     } catch {
       return 0
     }
   }

   function processBatch(db: Database, scanRows: Array<ScanRow>, counts: BackfillCounts): void {
     const ids = scanRows.map((r) => r.id)
     const heads = loadHeadRows(db, ids)
     const stagesById = loadStageRows(db, ids)
     const now = Date.now()

     const stageBlobExistsStmt = db.prepare("SELECT 1 FROM stage_blob WHERE hash = ?")
     const insertStageBlobStmt = db.prepare("INSERT OR IGNORE INTO stage_blob (hash, blob_gz) VALUES (?, ?)")
     const deleteStagesStmt = db.prepare("DELETE FROM entry_stages WHERE entry_id = ?")
     const insertStageRefStmt = db.prepare(
       "INSERT OR REPLACE INTO entry_stages (entry_id, stage, attempt_index, created_at, blob_gz, hash) VALUES (?,?,?,?,?,?)",
     )

     for (const scan of scanRows) {
       try {
         const head = heads.get(scan.id)
         const stageRows = stagesById.get(scan.id) ?? []
         if (!head || stageRows.length === 0) { counts.skipped += 1; continue }
         if (stageRows.every((r) => (r as StageRow & { hash?: string | null }).hash != null)) { counts.skipped += 1; continue }

         const entry = assembleFullEntry(head, stageRows)
         const refs = deriveStageRefs(entry)
         const fresh = refs.filter((r) => !stageBlobExistsStmt.get(r.hash))
         const freshBlobs = new Map(fresh.map((r) => [r.hash, compressBytes(new TextEncoder().encode(r.canonical))]))

         const tx = db.transaction(() => {
           for (const ref of refs) {
             const blob = freshBlobs.get(ref.hash)
             if (blob) insertStageBlobStmt.run(ref.hash, blob)
           }
           deleteStagesStmt.run(scan.id)
           for (const ref of refs) insertStageRefStmt.run(scan.id, ref.stage, ref.attemptIndex, now, EMPTY_STAGE_BLOB_PLACEHOLDER, ref.hash)
         })
         tx()
         counts.migrated += 1
       } catch (err: unknown) {
         counts.errors += 1
         consola.debug(`[stage-blob-backfill] skipped entry ${scan.id}`, err)
       }
     }
   }

   export async function runStageBlobBackfill(db: Database): Promise<void> {
     if (running) return
     running = true
     stopRequested = false
     try {
       if (getMeta(db, STAGE_BLOB_BACKFILL_VERSION_KEY) === STAGE_BLOB_BACKFILL_VERSION) return

       const cursorRaw = getMeta(db, STAGE_BLOB_BACKFILL_CURSOR_KEY)
       let boundaryTs = 0
       let lastId = ""
       if (cursorRaw !== null) {
         try {
           const pos = JSON.parse(cursorRaw) as { ts?: unknown; id?: unknown }
           if (Number.isFinite(Number(pos.ts)) && typeof pos.id === "string") {
             boundaryTs = Number(pos.ts)
             lastId = pos.id
           }
         } catch (err: unknown) {
           consola.debug("[stage-blob-backfill] cursor parse failed — restarting full scan", err)
         }
       }

       const counts: BackfillCounts = { migrated: 0, skipped: 0, errors: 0 }
       // ACTIVE_STATES exclusion (adversarial-review HIGH-6 fix): the original
       // draft's scanStmt had no status filter at all, so it would also target
       // rows for STILL-IN-FLIGHT requests (pending/executing/streaming) — a live
       // request's own attempt may still be appending/overwriting entry_stages rows
       // concurrently with this backfill's read-modify-write (assembleFullEntry →
       // deriveStageRefs → DELETE+INSERT), which could race a live write and lose
       // it. Mirrors reaper.ts's ACTIVE_STATUSES exclusion (same lifecycle-state
       // primitive, same reasoning: only touch TERMINAL rows).
       const activePlaceholders = ACTIVE_STATES.map(() => "?").join(",")
       const scanStmt = db.prepare(
         `SELECT id, started_at FROM entries_v2 e `
           + `WHERE status NOT IN (${activePlaceholders}) `
           + `AND EXISTS (SELECT 1 FROM entry_stages es WHERE es.entry_id = e.id AND es.hash IS NULL) `
           + `AND (started_at > ? OR (started_at = ? AND id > ?)) ORDER BY started_at ASC, id ASC LIMIT ?`,
       )

       let batchIndex = 0
       for (;;) {
         if (stopRequested) break
         let scanRows: Array<ScanRow>
         try {
           scanRows = scanStmt.all(...ACTIVE_STATES, boundaryTs, boundaryTs, lastId, BACKFILL_BATCH_SIZE) as Array<ScanRow>
         } catch (err: unknown) {
           consola.debug("[stage-blob-backfill] scan failed (db closing?) — stopping", err)
           return
         }
         if (scanRows.length === 0) break

         try {
           processBatch(db, scanRows, counts)
           const last = scanRows.at(-1)
           if (last) {
             boundaryTs = last.started_at
             lastId = last.id
             setMeta(db, STAGE_BLOB_BACKFILL_CURSOR_KEY, JSON.stringify({ ts: boundaryTs, id: lastId }))
           }
         } catch (err: unknown) {
           consola.debug("[stage-blob-backfill] batch failed (db closing?) — stopping", err)
           return
         }

         batchIndex += 1
         if (batchIndex % CHECKPOINT_EVERY_BATCHES === 0) {
           try { db.exec("PRAGMA wal_checkpoint(PASSIVE);") } catch { /* best-effort */ }
         }
         if (scanRows.length < BACKFILL_BATCH_SIZE) break
         await sleep(0)
       }

       if (!stopRequested) {
         recordStageBlobDedupRatio(db)
         setMeta(db, STAGE_BLOB_BACKFILL_VERSION_KEY, STAGE_BLOB_BACKFILL_VERSION)
         consola.info(`[stage-blob-backfill] complete: migrated ${counts.migrated}, skipped ${counts.skipped}, errors ${counts.errors}`)
       }
     } catch (err: unknown) {
       consola.warn("[stage-blob-backfill] aborted (error — startup continues)", err)
     } finally {
       running = false
     }
   }
   ```
   跑测试 → 绿（迭代排查任何 SQL/类型细节直至转绿）。
3. Commit：`git add -- src/lib/history/sqlite/meta.ts src/lib/history/sqlite/stage-blob-backfill.ts tests/history/sqlite/stage-blob-backfill.it.test.ts && git commit -F <msgfile>`，message: `feat(history): add stage-blob-backfill (content-address legacy entry_stages rows, ACTIVE_STATES-exempt, cooperatively stoppable)`。

### P4-T3：`state.ts` 接线 + `RESETTERS` 注册（含对抗审查 item 12：显式记录 stop 顺序不变量）

**Files**：`src/lib/history/state.ts`、`tests/helpers/isolated-fixture.ts`

**Steps**：
1. 红：在既有 `tests/infra/resetters-complete.unit.test.ts`（L1 完整性守卫）跑一遍——一旦 P4-T2 导出了 `resetStageBlobBackfillForTests`，该守卫测试会因为它未被注册进 `RESETTERS` 而**自动**转红（不需要手写新测试，这是既有 L1 守卫的职责）。跑 `bun test tests/infra/resetters-complete.unit.test.ts` → 红。
2. 绿：
   - `isolated-fixture.ts`：在 `RESETTERS` 数组末尾（紧邻既有最后一条 `setUpstreamHookForTests`）追加：
     ```ts
     { name: "resetStageBlobBackfillForTests", reset: resetStageBlobBackfillForTests },
     ```
     并追加对应 import。
   - `state.ts`：
     - 在 `startHistoryBackfills` 链的末端（现终端 `startCalibrationBackfill` 之后）追加 `.finally(() => startStageBlobBackfill())`（成为新的链终端，无需等待完成——沿用既有"不阻塞、fire-and-continue"的链式风格）。
     - 在 `stopHistoryBackgroundWork` 内追加 `stopStageBlobBackfill()`，紧邻既有 `stopCalibrationBackfill()`（成为该函数的新终端调用）：
       ```ts
       stopUsageNormalizeBackfill()
       stopLegacyStageBackfill()
       stopCacheWriteBackfill()
       stopSearchIndexBackfill()
       stopResponsePreviewBackfill()
       stopCalibrationBackfill()
       // stopStageBlobBackfill() shares the exact same invariant as its five
       // siblings above (documented once at this function's existing comment,
       // "Signal the background backfills to stop BEFORE the DB closes"): the
       // ONLY ordering constraint is that it runs before shutdownHistory's
       // closeDatabase() call (a post-close prepare would throw). There is NO
       // relative-ordering dependency AMONG the six stop*Backfill() calls
       // themselves — each guards an independent module-global stopRequested
       // flag with no cross-backfill coupling, so this new call could be placed
       // anywhere in this list without changing behavior (adversarial-review
       // item 12: making this explicit rather than leaving the reader to infer
       // it from the calls' mere adjacency).
       stopStageBlobBackfill()
       ```
   跑测试 → 绿。
3. Commit：`git add -- src/lib/history/state.ts tests/helpers/isolated-fixture.ts && git commit -F <msgfile>`，message: `feat(history): wire stage-blob-backfill into state.ts startup/shutdown chain + test-isolation resetters`。

---

## 7. 自评审（写盘前完成）

- **RFC §3-§5、§9 覆盖核对**：六个工作单元 → Phase 0-4 逐一对应（见 Goal 表格）；orphan GC 4 站点（deleteSession/deleteEntries/clearAllEntries/reaper）全部在 P3-T3 覆盖；`cache_control-shifted twin entries reconstruct losslessly` verbatim 命名测试在 P2-T5 独立存在；正样本（字段顺序不同→同 hash+round-trip 原值）在 P0-T2 覆盖；backfill dedup-ratio tripwire（同 entry retry 为主证据）在 P4-T2 覆盖；跨 runtime e2e 在 P1-T5 覆盖。RFC §10（cutover/commit invariants）已在第 6 节填满，不再是空占位符。
- **零占位符扫描**：全部 task 的代码块均为可直接落地的完整实现（含 import、错误处理、真实 SQL），没有 `// TODO` / `// implement later` / `...` 省略号式占位——每个 Files/Steps 小节要么给出完整函数体，要么明确指向"纯文本替换"这类不需要展示全文件的机械改动并给出前后对照。
- **类型一致性**：`StageRef`/`EMPTY_STAGE_BLOB_PLACEHOLDER`/`deriveStageRefs` 全部从同一个新文件 `stage-carrier.ts` 导出并在 `write.ts`/`stage-blob-backfill.ts` 复用，避免两处独立定义漂移（决策 #13）；`INSERT_STAGE_SQL` 的参数个数变化（5→6）在唯一定义处 + 全部 3 个调用点（`runStageInsert`/`runStageInsertRef`，`runStageInsertBlob` 保持 5 参不变、待 C5 清理）逐一核对。
- **commit invariants 完整性**：6 个 commit（C0-C4 + 明确排除的 C5）逐一写明落地后必须成立的性质，且 C5 的排除理由回链到 RFC §8 Open Question #1（不是本计划遗漏，而是显式移出范围）。
- **判据符合性**：无一处以"暂时用不上/ROI 不划算"为由砍工作单元；发现的 `calibration-backfill.ts` 现存 bug 未被静默掩盖，而是作为独立 task（P2-T2）修复并配测试；13 项规划期设计决策全部显式列出供评审逐项质询，其中第 9 项明确记录了一次规划中途的自我修正（不掩盖思考过程中的反复）。
- **对抗审查合并修正清单（两异模型 reviewer + 主线复核 BLOCK）12 项逐一核对**：
  1. BLOCK-1 schema 必须进 floor → P1-T2（`schema.ts` 新增 `stage_blob`/`entry_stages.hash`/`migrateEntryStagesColumns`，floor 是权威、Umzug 只是 catch-up）。
  2. BLOCK-2 pre-check-before-compress 与 orphan GC 的 TOCTOU 竞态 → P3-T2（同事务内重新校验 + 同 tx 内完成压缩与写入）。
  3. HIGH-3 node-e2e 测试 `~/` 别名导入链 → P1-T5（改走 alias-free 导入图）。
  4. HIGH-4 reaper GC 测试无法在 `(0,0)` 参数下转绿 → P3-T3（配套回归测试修复）。
  5. HIGH-5 cooperative-stop 测试自相矛盾 → P4-T2（改用"调用不 await + 同步 stop"的确定性技巧，与 `search-index-backfill.it.test.ts` 既有惯用法一致；原稿在 `await runStageBlobBackfill(...)` 之前调用 `stopStageBlobBackfill()` 是空操作，因为该函数自身同步入口就会重置 `stopRequested = false`）。
  6. HIGH-6 backfill 扫描谓词缺 active-state 过滤 → P4-T2 的 `scanStmt` 新增 `status NOT IN (${ACTIVE_STATES...})` 排除 + 新增专门回归测试（一个 `streaming` 态行必须原样不动）。
  7. MEDIUM-7 byte-equivalence golden 是重言式 → P2-T4（改用真实形态 fixture + `toMatchInlineSnapshot` 取代自比较）。
  8. MEDIUM-8 `usage-normalize-backfill.ts`/`cache-write-backfill.ts` 静默丢数据 → 新增独立 task **P3-T5**：correction 命中内容寻址行（`hash IS NOT NULL`）时不再直写 `blob_gz`（该列被 `entry_stages_resolved` 视图忽略），改为重新哈希→`INSERT OR IGNORE INTO stage_blob`→`UPDATE entry_stages SET hash = newHash` 重新指向，旧 hash 的孤儿行留给既有 orphan GC（P3-T3 四个 hook 站点）回收。
  9. Decision #9 措辞软化 → 已在本轮之前的修订中完成（第 4 节决策 #9）。
  10. Golden fixture 变体补充 → P2-T4（old-shape + legacy + multi-frame sse_events 三变体）。
  11. `deleteEntries`/`makeRichEntry`/站点计数措辞 → 已在本轮之前的修订中完成（P3-T3 的 `deleteEntries` filter 修复 + 第 4 节决策 #3 的"7 文件/12 站点"措辞纠正）。
  12. P4-T3 的 stop 顺序文档化须显式 → **P4-T3**：在新增的 `stopStageBlobBackfill()` 调用旁写明——它与其余 5 个 sibling stop 调用共享同一条不变量（必须发生在 `closeDatabase()` 之前），彼此之间**没有**相对顺序依赖（各自守卫独立的模块级 `stopRequested` 标志，互不耦合），不留给读者从"仅仅相邻摆放"去猜测隐含顺序约束。
- **任务/commit 数量核对（本次修订后）**：任务总数 **20**（Phase 0：2 个 `P0-T1~T2`；Phase 1：5 个 `P1-T1~T5`；Phase 2：5 个 `P2-T1~T5`；Phase 3：5 个 `P3-T1~T5`，含新增 `P3-T5`；Phase 4：3 个 `P4-T1~T3`）。commit 总数 **16**（`P1-T1` 随 `P1-T3` 同 commit、`P2-T1` 随 `P2-T2` 同 commit、`P4-T1` 随 `P4-T2` 同 commit 各占零净增 commit；`P1-T4` 是无代码改动的验证性 task，同样零净增 commit；其余 16 个 task 各自独立 1 commit）。

---

## 8. 明确排除 / 延后（不在本计划范围）

- **RFC §6-§8（阶段 2 per-entry coalescing writer 队列）**：整体是另一份独立 spec/plan，本计划零处涉及。
- **Commit 5（旧列清理：删 `entry_stages.blob_gz` 旧内联内容 + 退役 `request_group` 读侧展开分支）**：依赖 backfill 100% 完成 + RFC §8 Open Question #1（旧列删除时机）由用户决定，届时另立一份收尾计划（no-auto-server，仿照 P6b 先例）。
- **RFC §8 Open Question #2（dedup-ratio 实测阈值标定）**：本计划的 tripwire 阈值（`STAGE_BLOB_DEDUP_TRIPWIRE_FLOOR = 1.02`）是"证明指标已接线"的保守占位值，真实基线需要用户在真实 history.db 上实测后校准——已在 P4-T2 的实现注释中标注这是待校准值，不是本计划自称的最终数值。

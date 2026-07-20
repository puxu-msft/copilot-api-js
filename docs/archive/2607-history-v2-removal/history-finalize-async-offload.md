> **📦 已归档（History V2 removal，2026-07-18）** —— 本 RFC 描述的 V2 异步两相 finalize（`insertCompletedEntry`/`finalizeEntry` phase1 libuv 压缩 + phase2 同步事务）随 `entries.ts` V2 写链整体移除已不再是活代码。History V3 由终端总线单写者 + `drainV3Writer` 承担同款 drain-before-close 语义，见 [DESIGN.md](../../DESIGN.md)「活的架构现状」`src/lib/history/` 行 + skill `persistence-async-invariants`。本文仅作历史设计记录保留。

# RFC：history finalize 异步卸载（消除每请求 ~164ms 事件循环阻塞）

**状态** Landed（P0–P5 全部落地，2026-06-28；commit b509…→本系列）· **日期** 2026-06-28 · **作者** profiling-driven
**前置实测** [exp/hot-path-profile/REPORT.md](../../exp/hot-path-profile/REPORT.md)（含可复现 harness 与 Stage 0 探针）
**审查** R1（设计期对抗 review，§8）+ 实现期对抗 audit（无 CRITICAL/HIGH；I7 tx-原子性 + never-throw 经探针实证；M1 shutdown 保真度权衡见 §4.1）

## 1. 问题（profiling 实测，非推断）

`insertCompletedEntry`（[write.ts:100](../../src/lib/history/sqlite/write.ts)）在每个请求 finalize 时于**单线程事件循环上同步**执行 CPU 重活。真实 opus-4.8 大请求（504KB→2MB inbound / 1977 帧）实测：

```
buildSearchIndexForEntry (CPU, pre-tx)   56 ms   (821 条消息逐条 normalize/hash + rewrite align)
compress(request_group, 合并 ~6-10MB)    96 ms   (inbound+effective+outbound 三体一帧 zstd L3)
compress(head) + 响应 stage              12 ms
─────────────────────────────────────────────────
≈ 164 ms 同步事件循环冻结 / 请求
```

阻塞期间整个事件循环冻结——所有并发在飞流停转、心跳不发、新请求不被接受。8 并发 finalize 实测冻结 **758ms**（max-gap == wall，全程零 tick）。

**这是常态非离群**：实测 200 条 anthropic entry，**中位 inbound 1.9MB、100% 请求 >200KB**。Claude Code 几乎每请求都发 ~2MB 上下文，request_group 合并帧恒为多 MB，且成本由请求上下文大小主导（非响应大小）——即便响应只有几十字节也付 ~60-100ms。

finalize 在响应已发给客户端之后，故**不在客户端首字节延迟路径**上，但在**并发吞吐与尾延迟路径**上：它偷走所有其它在飞请求的事件循环时间。

## 2. Stage 0 探针结论（零假设，全部实测）

设计的每个关键假设都用探针在 Bun 下实测裁决（[exp/hot-path-profile/](../../exp/hot-path-profile/) 的 `probe-async-zstd.ts` / `probe-index-split.ts` / `probe-yield-build.ts`）：

| 假设 | 探针结论 |
|---|---|
| Bun 下 `node:zlib.zstdCompress` 异步版走 libuv 线程池、把压缩挪出事件循环 | ✅ 8×10MB：sync 冻结 **497ms** → async max-gap **17ms**，且并行 ~2.4× |
| 56ms 索引构建是可分片的逐消息循环（非单体操作） | ✅ `buildInboundMsgs` 逐消息 38% + rewrite align 逐消息 62%；**SSE 帧 jsdiff 仅 0.26ms 可忽略** |
| 协作式让出（`await sleep(0)` 每 K 条）保持事件循环响应 | ✅ 8 并发 yield-build+async-compress：sync 冻结 **758ms** → **max-gap 24ms**（31× 改善 + 1.8× 更快 wall） |
| Stage 3 专用 worker 是否必要 | ❌ **被证据否决**——两项重活进程内零序列化即可解决，worker 序列化（探针②）与第二 WAL 连接（探针③）因此无关 |

**核心洞察**：libuv 异步压缩**零序列化**（线程间共享内存），协作让出**单线程零序列化**——两条路都不需要 worker。Stage 3 退化为证据门控的暂缓项。

## 3. 设计

finalize 拆成两相：**先把 CPU 重活挪出事件循环（无锁），再让快速同步事务只插入已算好的结果**。

```
async insertCompletedEntry(entry):
  # 相 1 — CPU，离事件循环 / 协作让出（不持 DB 写锁）：
  built  = await buildSearchIndexChunked(entry)         # 逐消息分片，await sleep(0) 每 K 条
  blobs  = await compressStagesAsync(head, stages)      # libuv 线程池，并发压缩
  # 相 2 — 快速同步事务（只持锁做 DB 插入，无 CPU）：
  tx(() => { insert head(blob); delete+insert stages(已压缩 buffer); persistSearchIndex(built); prev_req_id })
```

相比现状的唯一结构变化：**所有 `compress()` 调用从事务内移到事务前的异步预步**，事务内只插入已压缩 buffer。`buildSearchIndexForEntry` 本就在事务外（[write.ts:104](../../src/lib/history/sqlite/write.ts)），只需改成分片异步版。

### Stage 1 — 异步压缩（libuv）

- 新增 `compressAsync(value): Promise<Buffer>` = `promisify(zlib.zstdCompress)`，与同步 `compress` 并存于 [compression.ts](../../src/lib/history/sqlite/compression.ts)（解压保持同步——读路径不在热路径）。
- `serializeHeadEntry` / stage 打包改为产出**待压缩 payload**，由 `insertCompletedEntry` 在事务前 `Promise.all` 并发压缩。
- 解压魔数判别（gzip/zstd）不变。

### Stage 2 — 协作式分片索引构建

- `buildSearchIndexForEntry` → `buildSearchIndexChunked(entry): Promise<SearchIndexBuilt>`，`buildInboundMsgs` 与 rewrite-align 的逐消息循环每 K 条（建议 K=50，探针实测 max-gap 24ms）`await sleep(0)`。
- SSE 帧 jsdiff（0.26ms）不分片——已可忽略。
- 纯函数语义、输出逐字节等价于同步版（golden 预捕获锁定，见 §6）。

### Stage 3 — 专用 writer worker（暂缓，证据门控）

完整文档化供日后决策（best-complete-solution 暂缓项约定）：

- **根因**：若高并发下 libuv 4 线程池饱和、或分片让出的累计主线程占用（实测 24ms max-gap）在更高并发下抬升到不可接受，则把"压缩+索引+落库"整体移进持自有 WAL 连接的 worker。
- **当前行为**：Stage 1+2 后 8 并发 max-gap 24ms，远未到需要 worker。
- **理想架构**：worker 持第二 bun:sqlite WAL 连接写、主线程 WAL 读（reader/writer 并发由 WAL 处理）。
- **为何暂缓**：探针证明进程内方案足够；worker 引入跨线程 SQLite + entry 序列化成本（10MB postMessage），无证据收益为正。
- **若做需改**：探针③（第二 WAL 连接 write-from-worker + 主线程读）+ 有界任务队列 + worker 生命周期接 shutdown。

## 4. 不变量（commit invariants —— 每个中间 commit 都不让系统半坏）

durability 是 finalize 的核心契约（[entries.ts:158-210](../../src/lib/history/entries.ts) `finalizeEntry`），异步化绝不能削弱它。**以下 I4/I7/I8 由对抗 review 实测核验补强——初稿 I4 的 drain 机制是虚构的，见 §4.1。**

- **I1 无损（persist-guard 契约不变）**：in-flight 条目保留到异步写**确认成功**才 `removeInFlight`；transient 失败留 in-flight 给 reaper 重试；permanent → tombstone。异步窗口期 in-flight 仍在 map 中，崩溃则 reaper 重建——比现状更强（现状同步窗口同样靠 in-flight 兜底）。
- **I2 re-entrancy 守卫（精确时点）**：finalize 异步窗口内 `finalizeEntry(id)` 被二次调用（或 reaper 重试循环 [entries.ts:225](../../src/lib/history/entries.ts) 命中）必须不双写、不双 `removeInFlight`。加 `finalizing: Set<id>` in-progress 守卫，**时点精确定义**：① 标记 `finalizing.add(id)` 必须在 `getInFlight(id)` 读取**之后、第一个 `await` 之前**（同步段内原子）；② 二次进入若 `finalizing.has(id)` 立即 no-op 返回、**不动** `finalizeRetries`；③ settle 时先完成 `removeInFlight`/`finalizeRetries.set` 再 `finalizing.delete(id)`（清守卫最后做，避免清后到 removeInFlight 之间的再进入窗口）。
- **I3 顺序/幂等（穷尽交错）—— 评估后判定 benign，无需 guard**：异步 finalize 与以下并发源交错时，已 finalize 的终态不会被倒推：① eager head upsert（[upsertHeadRow](../../src/lib/history/sqlite/write.ts)，finalize 是 DELETE+reinsert 幂等、eager 只更 head 列）；② **stale reaper 刷写**（[reaper.ts](../../src/lib/history/sqlite/reaper.ts) `reclaimStaleActiveRows` 把 `status IN(pending,executing,streaming) AND started_at<cutoff` 的持久 head 行刷 `interrupted`）——异步窗口内请求已 transition `completed` 但持久 head 行仍 `streaming`，老请求可能被 reaper 刷成 `interrupted`，但 finalize 的终态 head upsert **总会覆盖回真实终态**（finalize 读的是 in-flight 内存 entry，reaper 只动持久行）。**实测/分析结论：finalize 永远 wins，无 loss/corruption，仅一个被立即覆盖的 transient blip** → 不加 guard（architecture-health-first：无真实缺陷不加投机 surface）。reaper tick 的 `tickHook`（drain）现 fire-and-forget async，故 deferred-retry 行在**下一** tick 计入 eviction 而非本 tick（benign 一-tick 延迟，注释已订正）。
- **I4 shutdown drain（见 §4.1，硬前置、与 finalize 异步化同 commit）**。
- **I5 背压 —— 评估后判定本部署无真实风险，valve 不建（YAGNI），文档化暂缓**：未决异步 finalize 各持 entry 引用，原则上无界。但本系统是**单用户 Copilot 代理**（一个用户的 Claude Code 会话），现实并发 finalize ~1-5、libuv 4 线程消化、entry 完成即释放——backlog 自限，无界增长需持续 40+ 大请求/秒（单用户物理不可能）。故 bounded-concurrency valve（超限退回同步压缩，镜像 L2 `protect_streaming_buffer_cap_bytes` retreat）是**对本系统永不触发的负载的投机 surface**，按 YAGNI 不建。**若日后变多租户/高吞吐**：加 `pendingFinalizations.size` 闸 + 超限走同步 `compress`（即时完成释放 entry，背压传导到到达率），并加 backlog high-water 遥测；当前仅记此暂缓项。
- **I6 逐字节等价**：异步压缩 + 分片构建的**输出**逐字节等价同步版（压缩 buffer 与 SearchIndexBuilt），golden 预捕获在改动前锁定。
- **I7 事务回调必须同步（实测守卫）**：bun:sqlite `db.transaction()` **无法跨 `await` 提供原子性**（review 实测：async 回调内 throw 不回滚、半写持久化、`tx()` 返回 pending Promise 而非抛——静默丢原子性）。所有 `await`（`compressAsync`/`buildSearchIndexChunked`）必须在 `db.transaction(() => …)` **之前**；事务回调保持纯同步。**强制守卫**：测试断言 finalize 的 `tx()` 返回值非 Promise + 一个 throw-after-partial-insert 回滚测试，防实现者误把 await 留进回调。
- **I8 entry 快照（防异步窗口内突变）**：`finalizeEntry` 的 `getInFlight(id)` 返回的是 in-flight map 内**引用**；异步 CPU 相期间并发 `updateInFlight(id,…)`（如 `setPinned`→[entries.ts:315](../../src/lib/history/entries.ts)、晚到的 `context_updated`）会就地突变它，`buildSearchIndexChunked` 跨 `await` 逐消息读会读到撕裂态。进入异步相前对 entry 做一次浅/结构快照（或 freeze），异步相只读快照。

### 4.1 shutdown drain —— 真实机制（初稿虚构，对抗 review 揭露）

**核验事实**（亲读代码确认）：① `shutdownHistory()` 在 [shutdown.ts:379](../../src/lib/shutdown.ts) 的**早期同步段**调用（Phase 2 drain 之前）；② 它是**同步 void**，末尾同步 `closeDatabase()`（[history/state.ts:85-101](../../src/lib/history/state.ts)）；③ `bus.flush()` **零生产调用方**，HistorySink **只订阅 `request.*`**（不进 `publishAndFlush(system.shutdown_phase_changed)` 的 pending 集）。**故初稿 I4 "bus 追踪 finalize promise、shutdown drain" 的机制根本不存在。**

现有 `shutdownHistory` 的 last-chance `retryPendingFinalizations()` 依赖 finalize **同步**跑完落盘才 `closeDatabase()`。finalize 改 async 后：该 drain 变 fire-and-forget，DB 在异步 finalize 完成前就关 → ① Phase 2/3 drain 期间 settle 的请求（drain 只等 `getActive()` 空、不看未决 finalize）其异步 finalize 写**已关闭的 DB** → 抛 → permanent → tombstone 也写死 DB → 全失败静默丢（[[methodology-persistence-swallow-plus-lossy-fallback-loses-data]]）；② finalize 无续跑机制（in-flight 在内存、进程死即没），不同于 backfill 的 cursor 续跑——故"Phase 1 就 close"对 finalize 致命、对 backfill 才可接受（初稿把这个先例引反了）。

**修复（硬前置，必须与 finalize 异步化同 commit 落地，否则 P2-P3 区间 durability 半坏）**：
- 维护 module-level `pendingFinalizations: Set<Promise<void>>`（finalize 异步入口 add、settle remove）——**自有 drain 句柄，不依赖虚构的 `bus.flush()`**。
- `shutdownHistory` 改 `async`：`stopReaper` → `stopSearchIndexBackfill` → `await Promise.allSettled(pendingFinalizations)`（有限超时兜底）→ `retryPendingFinalizations`（此刻同步 tombstone 残留）→ **再** `closeDatabase()`。
- `gracefulShutdown` 调用点改 `await shutdownHistory()`，并把它从"早期同步段"移到 **Phase 2/3 drain 之后**（在飞请求完成才会触发其 finalize，故 DB 必须活到 drain 结束之后）——这是结构性重排，非配线。
- drain 完成判据扩展：`getActive()` 空 **且** `pendingFinalizations` 空，才算真正 drained。

**shutdown 保真度权衡（审查 M1，显式记录）**：`shutdownHistory` 先 `stopReaper` 再 drain，故 drain 期间 `isReaperRunning()===false`——若某 finalize 在 shutdown 写失败（`SQLITE_BUSY`，shutdown 时 WAL checkpoint 竞争下更可能），[entries.ts:244](../../src/lib/history/entries.ts) 的 transient-retain gate 不成立，直接走 tombstone（保 head+inbound_request+outbound_response，**丢 sseEvents/per-attempt bodies**）。这是**正确取舍**（reaper 已停，retain 会永久泄漏；tombstone 保住请求 FACT，符合 I1），仅是 shutdown 下牺牲全保真换即时落盘——非数据存在性丢失。日常路径（reaper 在跑）不受影响。

## 5. Phase 拆分

**关键排序修正（对抗 review L1）**：shutdown async drain（§4.1）必须**与 finalize 异步化同 commit 或先于它**落地——否则 finalize 异步化的 commit 自己就引入 §4.1 的丢失窗口，到后续 commit 才"修"，违反 commit-invariants。故 P2 合并了"finalize 异步 + shutdown drain 重排"为一个不可分原子 commit。

| Phase | 改动锚点 | 验收 | commit invariant |
|---|---|---|---|
| **P0** golden 预捕获 | `tests/history/finalize-async.*.test.ts`（新）：对真实 fixture entry 锁定 `compress` 输出 + `buildSearchIndexForEntry` 输出 + finalize 后 DB 行 | 在**改动前**的同步代码上跑通（golden 才有意义，见 [[methodology-golden-fixture-pre-capture]]） | 仅加测试，系统不变 |
| **P1** 异步压缩 primitive | [compression.ts](../../src/lib/history/sqlite/compression.ts)：加 `compressAsync`，同步 `compress` 保留 | 单测 `compressAsync` 输出 === `compress`（I6）；`bun run test:backend` 绿 | compress 双轨并存，无调用方切换 |
| **P2** finalize 异步 + shutdown drain（**原子，不可分**） | ① [write.ts](../../src/lib/history/sqlite/write.ts) `insertCompletedEntry`→async（事务前并发 `compressAsync`，事务内只插 buffer，I7 回调纯同步）；② [entries.ts](../../src/lib/history/entries.ts) `finalizeEntry`→async + I2 守卫 + I8 快照 + `pendingFinalizations` 集；③ [history/state.ts](../../src/lib/history/state.ts) `shutdownHistory`→async await drain；④ [shutdown.ts](../../src/lib/shutdown.ts) `await shutdownHistory()` 移到 drain 之后 | P0 golden 绿；I7 tx-同步守卫测试；I1/I2/I3/I8 竞态测试；shutdown drain 测试（未决 finalize 不丢、DB 不早关） | 压缩出事务 + shutdown 真 drain，**同 commit 故无半坏区间** |
| **P3** 分片索引构建 | [search-index-write.ts](../../src/lib/history/sqlite/search-index-write.ts) `buildSearchIndexChunked` async + 逐消息 `await sleep(0)`（M3：保持整体 all-or-nothing 空降级语义） | P0 golden 绿；metronome 断言 max-gap < 阈值 | 构建分片，输出等价 |
| **P4** reaper 交错收口（**评估后判定 I5 valve 投机不建**） | [reaper.ts](../../src/lib/history/sqlite/reaper.ts) tick 注释订正（async tickHook 非同步持久化 + I3 benign 说明）；I5 文档化暂缓（§4 I5：单用户负载自限，valve YAGNI） | history + 全套件绿；I3 benign 经分析（finalize 总覆盖 transient reclaim） | reaper 注释与 async 现实一致、I5/I3 决策文档化 |
| **P5** 收尾 | DESIGN.md「活的架构现状」history 行 + 模块图 persist-guard 契约更新；删过时 pending 记忆；本 RFC 标 landed | doc-sync grep 扫描（completion-includes-doc-sync）；`bun run typecheck`+`test:backend` 全绿 | — |

**验证命令**：`bun run test:backend`（offline 全集）/ `bun run typecheck` / `bun exp/hot-path-profile/probe-yield-build.ts`（回归实测 max-gap）。

## 6. 验证方法论

- **golden 预捕获**（P0，先于任何改动）：对真实 fixture 锁定 compress 输出 + 索引输出 + finalize 后 DB 行，证明异步化逐字节等价（I6）。只在改后才存在的 golden 证明不了等价。
- **metronome 回归**：`probe-yield-build.ts` 的事件循环 max-gap 断言进 CI——锁定"8 并发 finalize max-gap < 50ms"，防回退到同步阻塞。
- **durability 矩阵**：复用 [entries.ts](../../src/lib/history/entries.ts) 既有的 `__setTerminalWriterForTests` seam 测异步失败路径（transient 留 in-flight / permanent tombstone）在异步窗口下仍成立。
- **隔离**：新测走 `useIsolatedRuntime()`（`:memory:` history + RESETTERS reset），绝不碰真实 `$HOME`/DB。

## 7. 暂缓 / open questions

- **Q1**：分片粒度 K（建议 50）——实测 24ms max-gap 可接受；是否需自适应（按 entry 大小调 K）暂缓，先固定常量 + metronome 守卫。
- **Q2**：Stage 3 worker——§3 已完整文档化，证据门控暂缓。
- **Q3**：`structuredClone(inboundRequest)`（[handler-v4.ts:173](../../src/routes/messages/handler-v4.ts)，实测 4.5ms/请求）是独立的次要热点（profiling #2），不在本 RFC 范围——是否能去掉（若 sanitize 改非 mutating）记为后续。
- **Q4**：逐帧重复 JSON.parse（profiling #3，~4ms/流，63% 冗余）——绝对值被 finalize 压过两个数量级，独立 RFC 候选、低优先。

## 8. 审查记录

- **R1（2026-06-28，对抗 subagent + 主线独立核验）**：揭露初稿 §4 I4 的 shutdown drain 机制**虚构**（`bus.flush()` 零生产调用方、HistorySink 只订阅 `request.*`、`shutdownHistory` 早期同步 `closeDatabase`）——已亲读 [shutdown.ts:379](../../src/lib/shutdown.ts) / [history/state.ts:85](../../src/lib/history/state.ts) / [bus.ts](../../src/lib/observability/bus.ts) / [sinks/history.ts:90](../../src/lib/observability/sinks/history.ts) 核验为真，§4.1 重写为真实机制 + P2 原子化。另实测确认 bun:sqlite 事务跨 `await` 不回滚（→ I7 守卫）、补 reaper×异步窗口交错（I3 stale 刷写）、entry 突变（I8）、有界背压（I5）。CRITICAL 已闭合。
- **R2（实现期对抗 audit）**：无 CRITICAL/HIGH。I7 tx-原子性 + never-throw 经探针实证闭合；M1（shutdown 下 transient 失败 tombstone 丢 sseEvents，§4.1）判 benign 正确取舍。

## 9. 落地实测结果（end-to-end，诚实修正）

落地后用**真实 async `insertCompletedEntry`** 端到端实测（`exp/hot-path-profile/probe-real-finalize2.ts`），结果**低于 Stage-0 合成探针的 758→24ms 投影**——empirical-verification 抓出合成探针的乐观偏差：

- **单 finalize 事件循环 max-gap：~164ms 冻结 → ~79ms**；8 并发：~758ms 冻结 → ~614ms（p99 43ms）。
- **根因**：Stage-0 探针把 payload 预 `JSON.stringify` 成 Buffer 再测 zstd，**掩盖了 stringify 成本**。真实 `compressAsync(value)` 的 `JSON.stringify`（V8、主线程绑定、不可 libuv 卸载）是同步前缀，仅其后 zstd 走 libuv。每 finalize 残留同步块实测：**stringify(10.4MB request_group) ~40ms + buildAux jsdiff ~23ms**（zstd 96ms 已卸载、buildInboundMsgs 37ms 已 P3 分片）。
- **净效果**：每 finalize 不间断同步 **164ms → ~63ms（~60% 降幅）**，**主导单项 zstd（96ms）完全移出事件循环**。单用户负载（并发 1-2）下偶发 63-130ms 停顿（vs 旧 164-330ms），明确改善但非 ~90%。
- **彻底消除残留**（stringify + jsdiff）**须 Stage 3（worker 持 DB）**——§3 已文档化，证据门控暂缓。注：worker 路径也需把 entry 序列化进 worker（postMessage/structuredClone），与 stringify 同量级主线程成本，故 Stage 3 的真实收益是把**剩余全部**（stringify+jsdiff+tx）挪出主线程换一次 entry 序列化，是否净正待真做时实测。

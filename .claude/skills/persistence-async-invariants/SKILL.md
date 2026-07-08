---
name: persistence-async-invariants
description: 当在 copilot-api-js 改动 history 持久化/异步落盘/settle 时点/buffered-retry 信号记录时使用——把同步持久化路径改异步的不变量清单（drain-before-close/自有 drain 集非 bus/fixture teardown 先 drain/re-entrancy 守卫/fire-and-forget never-throw/全 test await）、ctx.fail/complete 同步冻结 history entry 快照（client-facing 数据须 settle 前 record、新顶层字段三处必改）、buffered-retry 的 per-attempt 信号须在 committed settle 点记录（onAttemptReset 清空、不丢≠不清）。是 skill empirical-verification 在持久化域的落地；漏任一条→静默数据丢失或进程崩。
---

# 持久化异步化 / settle 时点不变量

history 持久化层三类高危不变量：**同步→异步落盘的不变量清单**、**settle 同步冻结 entry 快照的时点契约**、**buffered-retry 信号的记录时点**。三者共性=异步窗口 / retry 窗口 / settle 边界把"同步隐式保证"打破，且失效**静默**（编译过、fire-and-forget 类型兼容、单测偶尔过）。改这些代码前逐条核。

## 1. 同步持久化路径改异步的不变量清单

把一条**同步持久化路径改异步**（本项目 history finalize：sync→libuv 卸载压缩 + 协作让出索引，活档 `docs/spec/history-finalize-async-offload.md`）必须守的清单。漏任一条都酿静默数据丢失或进程崩。

**Why**：异步化把"调用即落盘"变成"调用 kick 一个未决 promise"。原本靠"同步落盘"隐式保证的东西（shutdown 时数据已落、test 读到已写行、无并发重入）全部失效，且失效是**静默的**。

**逐条核**：

- **shutdown drain-before-close 是结构性前置、与异步化同 commit**：原同步 close 在早期阶段（本项目 Phase 1 同步 `closeDatabase`）会让"请求 drain 期间 settle 的异步 finalize"写**已关闭的句柄**→ 静默丢。修：拆"停后台工作(早，保 DB 开)"vs"drain 未决 + close(晚)"，close 移到请求 drain 之后的单一汇合点。**别假设已有 drain 机制存在**——初稿声称靠 bus 追踪 drain，实测 `bus.flush()` 零生产调用方、sink 不在 flush 集里 = 机制虚构（对抗 review 抓出的 CRITICAL）。
- **自有 drain 集，不靠事件总线**：维护 module-level `pending: Set<Promise>`，入口 add / settle remove，drain = `while(size>0) await allSettled(set)`（loop 到静止，捕获 drain 期间新 kick 的）。
- **test fixture teardown 先 drain 再 reset/close**：fire-and-forget 的异步落盘会**跨测试泄漏**——一个测试 kick 的 finalize 在下个测试的 DB 上跑（"Cannot use a closed database" / 污染）。在 `afterEach` reset 前 `await drain`（test 级镜像生产 shutdown drain）。
- **re-entrancy 守卫**：异步窗口跨多个 await，重入源（reaper 重试 tick / 重复终态事件 / 二次调用）会双写。`Set<id>` 守卫：标记在第一个 await **之前**且与读取原子；settle 时先做状态变更（removeInFlight/retry）再清守卫。
- **fire-and-forget 必须 never-throw**：`void asyncFn()` 的 reject → 全局 unhandledRejection → 可能 exit(1)（见 skill `debugging-server-crashes`）。确保链路每个 throw（库失败 / 序列化抛 / tx 抛）都被内层 catch 吞成分类结果，零逃逸。
- **无损契约时点不变**：成功才 removeInFlight；transient 留存待重试；permanent tombstone。async 化后逐一核这些时点没被打破（tombstone 走同步写而非又一个 async）。
- **所有调用方 await**：sync→async 改签名后，`typecheck 过 ≠ 正确`——fire-and-forget 类型兼容但运行时 race。grep 全部调用点（含 `for(...) fn()` / `.map` 等**非语句起**的内联调用，机械 await-prefix 易漏），test 调用方 await 后读。

## 2. settle 冻结 history entry 快照——client-facing 数据须 settle 前 record

History 持久化时点陷阱（2026-07-04 修 ui-v4 Response 错位时踩，实证真实 entry `req_1783070660245_128`）：

**`ctx.fail()` / `ctx.complete()` 在 `toHistoryEntry()` 里同步读快照并发 `request.failed/completed` 事件**（`src/lib/context/request.ts`），history sink `onTerminal` 持久化的是**那个冻结的 `event.entry`**，`finalizeEntry` 只压缩内存 entry、**不再回读 ctx**。故 **settle 之后**对 ctx 的任何 `setForwardedResponse` / 其它 mutation 对持久化**不可见**——trailing `finally { recordForwarded() }` 太晚。凡要把 client 实收数据（合成 error 帧等）记进 `clientResponse`（旧名 `inboundResponse`，2026-07-07 重构后仅持久化 `HistoryEntry` 改名；live ctx 的 `setForwardedResponse` getter 保留旧名），顺序必须 `write(采样进 forwardedSseEvents) → recordForwarded() → ctx.fail/complete`（合成写 best-effort `.catch` 保 settle 恒跑）。这是"忘了记录合成帧"类 bug 的根因，不是 sink 采样与否的问题。

**新增顶层 HistoryEntry 字段的三处必改**（漏一处则静默永不持久化）：
1. `toHistoryEntry()` 里算出该字段；
2. history sink `onTerminal` 的**显式字段投影**（`src/lib/observability/sinks/history.ts` 的 `updateEntry({...})`）把它从 `entryData` 带过去；
3. `updateEntry` 的 `Pick<HistoryEntry, ...>` allowlist（`src/lib/history/entries.ts`）加该键（否则靠 object-spread 的 excess-property 漏检"能跑但不类型安全"）。

`failureReason` 曾长期"投影了但从没持久化"（所有真实 failed entry 读回都 `failureReason: undefined`）正是因为漏了 ②——RFC 加了 ① 却没加 ②/③。校验：round-trip 手测（`extractHeadMetaPayload`→`deserializeEntry`）会**假绿**（手动挂字段的 entry 能过），必须用真实 http 流程 + `getHistory()` 读**持久化 entry** 才暴露（见 skill `empirical-verification` 的"通过/空不自证"）。

## 3. buffered-retry 信号在 committed settle 点记录，不在 per-attempt

L2 buffered-retry（`protect_streaming_generation`）会让 **S5 响应处理（decode rewrite 等）逐 attempt 重跑**——driver 每尝试 re-instantiate S5 chain（`handler-v4.ts` onAttemptReset 区注释自陈 "re-instantiates its own S5 chain state per attempt"）。任何在 S5 闭包内**eager 记录**的 per-request 信号 / 遥测 / feature tag，都会被**被丢弃的尝试**污染：

- **set-once 标志被丢弃尝试污染**（malformed tool-input repair 的 audit C1）：attempt 1 畸形块到 `content_block_stop` 触发 `onDecodeFailure` 置 ctx 标志、随后截断 → buffer 丢弃重试；attempt 2 干净却因**标志只挂不清**被判 FAIL + 在合法内容后补 error 帧。set-once（`??=` 从不清空）放大了"信号不丢"为"信号永不清"的 bug。
- **计数器被 retry 次数膨胀**（audit H1）：闭包内 per-attempt `recordToolInputRepair` → N 次重试记 N 次。

**正解（镜像 `protect-streaming-stats` 的 `onBufferedResolve` commit-时记录）**：
1. 信号改 **per-attempt 累积**（`ctx.repairOutcomes` 数组），`onAttemptReset` 清空之。
2. handler 在 **committed settle 点**一次性 flush（`flushToolInputRepairObservability`：遥测 + feature + 日志 + 派生 fail-gate）。flush **不清** outcomes（complete-分支随后还要读派生 `unrepairableToolInput` 做 fail 判定，ctx 本就 per-request 用完即弃）。
3. 派生量（如 `unrepairableToolInput`）从 committed 累积现算，不再独立 set-once。

**判据**：信号产生在"会逐 attempt 重跑的处理层"、消费在"committed 之后"→ 必须 per-attempt 累积 + commit-flush。注意 spec 把"挂 ctx 非 acc 故 buffered-retry 不丢"当目标本身是不完整的——**不丢 ≠ 不清**，discarded 尝试的信号必须清。

## 相关
- 崩溃防御（fire-and-forget reject → unhandledRejection → exit）：skill `debugging-server-crashes`。
- 实测裁决（真实 http entry 读回、探针复制生产接线）：skill `empirical-verification`。
- 后台 backfill 的可恢复骨架（相邻但不同域）：skill `history-backfill`。
- schema 结构 / 迁移账本：skill `history-sqlite-schema`。

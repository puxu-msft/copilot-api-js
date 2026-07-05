---
name: methodology-sync-to-async-persistence-refactor-invariants
description: 把同步持久化路径改异步的不变量清单——drain-before-close/自有drain集非bus/test fixture teardown先drain/re-entrancy守卫/fire-and-forget never-throw/全test调用方await
metadata:
  type: feedback
---

把一条**同步持久化路径改异步**（本项目 history finalize：sync→libuv 卸载压缩+协作让出索引，活档 docs/spec/history-finalize-async-offload.md）必须守的不变量清单。漏任一条都酿静默数据丢失或进程崩。扩展 skill `empirical-verification`。

**Why**：异步化把"调用即落盘"变成"调用 kick 一个未决 promise"。原本靠"同步落盘"隐式保证的东西（shutdown 时数据已落、test 读到已写行、无并发重入）全部失效，且失效是**静默的**（编译过、fire-and-forget 类型兼容、单测偶尔过）。

**How to apply（逐条核）**：
- **shutdown drain-before-close 是结构性前置、与异步化同 commit**：原同步 close 在早期阶段（本项目 Phase 1 同步 `closeDatabase`）会让"请求 drain 期间 settle 的异步 finalize"写**已关闭的句柄**→ 静默丢。修：拆"停后台工作(早，保 DB 开)"vs"drain 未决+close(晚)"，close 移到请求 drain 之后的单一汇合点。**别假设已有 drain 机制存在**——我初稿声称靠 bus 追踪 drain，实测 `bus.flush()` 零生产调用方、sink 不在 flush 集里=机制虚构（对抗 review 抓出的 CRITICAL）。
- **自有 drain 集，不靠事件总线**：维护 module-level `pending: Set<Promise>`，入口 add/settle remove，drain=`while(size>0) await allSettled(set)`（loop 到静止，捕获 drain 期间新 kick 的）。
- **test fixture teardown 先 drain 再 reset/close**：fire-and-forget 的异步落盘会**跨测试泄漏**——一个测试 kick 的 finalize 在下个测试的 DB 上跑（"Cannot use a closed database"/污染）。在 `afterEach` reset 前 `await drain`（test 级镜像生产 shutdown drain）。
- **re-entrancy 守卫**：异步窗口跨多个 await，重入源（reaper 重试 tick / 重复终态事件 / 二次调用）会双写。`Set<id>` 守卫：标记在第一个 await **之前**且与读取原子；settle 时先做状态变更(removeInFlight/retry)再清守卫。
- **fire-and-forget 必须 never-throw**：`void asyncFn()` 的 reject→全局 unhandledRejection→可能 exit(1)（见 skill `debugging-server-crashes`）。确保链路每个 throw（库失败/序列化抛/tx 抛）都被内层 catch 吞成分类结果，零逃逸。
- **无损契约时点不变**：成功才 removeInFlight；transient 留存待重试；permanent tombstone。async 化后逐一核这些时点没被打破（tombstone 走同步写而非又一个 async）。
- **所有调用方 await**：sync→async 改签名后，`typecheck 过 ≠ 正确`——fire-and-forget 类型兼容但运行时 race。grep 全部调用点（含 `for(...) fn()` / `.map` 等**非语句起**的内联调用，机械 await-prefix 易漏），test 调用方 await 后读。

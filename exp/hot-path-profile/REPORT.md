# 热路径性能 profiling 报告

**日期** 2026-06-28 · **方法** 读代码定位候选 → 在 `exp/hot-path-profile/` 用真实数据实测裁决（empirical-verification）。
**素材** 运行中 4141 history API 拉取的真实 opus-4.8 大流式响应 `req_1782616715522_803`（1977 上游帧 / 207KB 响应 / 504KB→2MB inbound）+ 200 条 anthropic entry 的请求体分布。
**harness** `exp/hot-path-profile/bench.ts`（`bun exp/hot-path-profile/bench.ts`，不启服务器）。复现 driver 的逐帧循环（driver.ts:387-411）与真实 finalize 序列（write.ts:insertCompletedEntry），调用真实函数。

## ⚠️ 落地后实测修正（end-to-end，重要——纠正 Stage-0 合成探针的过度乐观）

finalize-async 重构落地后，用**真实的 async `insertCompletedEntry`** 端到端实测（`probe-real-finalize2.ts` + `probe-finalize-sync-breakdown.ts`），结果**低于** Stage-0 合成探针的 758→24ms 投影：

| 场景 | 重构前（同步） | 重构后（实测） |
|---|---|---|
| 单 finalize 事件循环 max-gap | ~164ms 冻结 | **~79ms** |
| 8 并发 finalize max-gap | ~758ms 冻结 | **~614ms**（p99 仍 43ms） |

**为何不及合成投影**：Stage-0 探针把 payload 预先 `JSON.stringify` 成 Buffer 再测 zstd，**掩盖了 stringify 成本**。真实 `compressAsync(value)` 内部 `JSON.stringify(value)` 是**同步**的（V8、不可 libuv 卸载），仅其后的 zstd 走 libuv。每 finalize 残留**不可卸载/未分片的同步块**实测拆分：
- **`JSON.stringify`(10.4MB request_group) = ~40ms**（compressAsync 同步前缀，主线程绑定）
- **buildAux jsdiff 消息 align = ~23ms**（不可分片，Stage-3 worker 候选）
- （buildInboundMsgs ~37ms 已被 P3 分片让出、zstd ~96ms 已被 libuv 卸载）

**净效果**：每 finalize 不间断同步 164ms → **~63ms（~60% 降幅）**，**主导单项（zstd 96ms）已完全移出事件循环**。本系统单用户负载现实并发 1-2 → 偶发 63-130ms 停顿（vs 旧 164-330ms），明确改善但非合成投影的 ~90%。**彻底消除残留 stringify+jsdiff 需 Stage 3（worker 持 DB），证据门控暂缓**（见 [rfc/history-finalize-async-offload.md](../../docs/rfc/history-finalize-async-offload.md) §3 Stage 3）。

---

## 结论：profiling 反转了静态排序

静态读代码我把"逐帧重复 JSON.parse"排第一、zstd 同步压缩排第四。**实测决定性反转**：finalize 的同步 CPU 阻塞比逐帧 parse 高两个数量级。

| 排名 | 热点 | 实测成本 | 粒度 | 静态排名 |
|---|---|---|---|---|
| **1** | **finalize 同步 CPU 阻塞**（buildSearchIndex + zstd 压缩 ~6MB 合并请求帧） | **~164 ms 事件循环冻结 / 请求** | 每请求 | #4 ❌ |
| 2 | `structuredClone(inboundRequest)`（handler-v4:173） | ~4.5 ms / 请求 | 每请求 | — |
| 3 | 逐帧重复 JSON.parse（5.00×/帧，63% 冗余） | ~4–6 ms / 流（1977 帧） | 每帧×并发 | #1 |

## [1] finalize 同步阻塞 —— 主导成本（实测）

`insertCompletedEntry`（write.ts:100）每请求在单线程事件循环上同步执行：

```
buildSearchIndexForEntry (CPU, pre-tx)   56.08 ms   ← normalize/hash/jsdiff（注释自承 CPU-heavy）
compress(head)                            8.62 ms
compress(request_group, 合并 ~6MB)       95.81 ms   ← inbound+effective+outbound 三体一帧 zstd
compress(inbound_response)                1.56 ms
compress(sse_events)                      1.44 ms
compress(outbound_response)               0.21 ms
─────────────────────────────────────────────────
≈ 总同步阻塞                            163.71 ms
```

**为何是热路径而非边角**：
- 阻塞期间整个事件循环冻结——**所有并发在飞流停止转发字节、心跳不触发、新请求不被接受**。多 Claude Code 会话并发时是严重 head-of-line blocking。
- 成本由**请求上下文大小**主导（非响应大小）。实测分布：**中位 inbound 1.9MB，100% 请求 >200KB**。Claude Code 几乎每请求都发 ~2MB 上下文 → request_group 合并帧恒为多 MB → **这是常态，不是离群**。即便响应只有几十字节，也要付 ~60–100ms（buildSearchIndex + request_group 压缩）。
- `db.transaction()` 在所有同步 compress 期间持有 SQLite 写锁。

**修法方向**（待 RFC）：把 zstd 压缩与 buildSearchIndex 移出事件循环（worker thread / `zstdCompress` 异步 API）；或对超大 payload 分级（大 payload 异步、小 payload 同步）；或流式增量压缩。注意 finalize 在响应已发给客户端之后，不在客户端首字节延迟路径上，但**在并发吞吐与尾延迟路径上**。

## [2] structuredClone(inboundRequest) —— ~4.5ms/请求

handler-v4.ts:173 `const clientRaw = structuredClone(payload)` 每请求深克隆整个 ~2MB 请求 payload（history inbound 捕获）。同步、随上下文线性增长。次于 finalize，但叠加在同一事件循环预算上。

## [3] 逐帧重复 JSON.parse —— 5.00×/帧，63% 冗余（实测）

默认配置下 3 个 S5 rewrite 激活（`thinking-signature-compat` / `tool-input-decode` / `server-tool-filter`）。每上游帧同一 `data` 字符串被 parse **恰好 5 次**：

```
1× onUpstreamFrame accumulate (handler-v4.ts:784)
3× 每个 rewrite 各自 parseFrame (response-rewrite-adapters.ts)
1× sink frameType 采样 (client-sink.ts:136)
─────────────────────────────────────────
= 9886 parse / 1977 帧 = 5.00/帧
```

实测：当前逐帧链 6.7ms/流，parse-once（按 data 串记忆化）2.4ms → **冗余 re-parse 占链路 63%（~4.3ms）**。绝对值小（单流几 ms），但纯 CPU 占事件循环，随帧数×并发线性放大。

**修法方向**：driver 循环顶 parse 一次，把 parsed 对象随帧下发给 accumulate/rewrite/sink 复用（与 richest-data-flow 一致）；附带 client-sink frameType 在 `frame.event` 存在时 short-circuit、passThrough 减少逐帧数组分配。**注意约束**：rewrite 链可重写 data（thinking/filter 重新 stringify），共享 parsed 需在重写点失效缓存——属真实架构工作，非纯机械。

## 复现

```bash
bun exp/hot-path-profile/bench.ts
```

素材 `entry-803.json` / `frames-803.json` 已随 harness 留仓。

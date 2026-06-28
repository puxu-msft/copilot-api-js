---
name: methodology-event-loop-block-profiling-libuv-offload
description: 代理/服务器热路径用 metronome 探针裁决事件循环阻塞；瓶颈常是请求末同步持久化(zstd压缩+索引)非逐帧；libuv 异步卸载 + bun:sqlite tx 回调必须同步
metadata:
  type: reference
---

服务器/代理找事件循环阻塞热点的方法论与一组实证事实（本项目 history finalize 异步卸载，[[project-pre-response-abort-rfc]] 邻域；活档 docs/rfc/history-finalize-async-offload.md + exp/hot-path-profile/）。

**裁决方法（empirical-verification，静态读只给候选）**：
- **metronome 探针**：`setInterval(()=>记录 Bun.nanoseconds() 间隔, 1)` 量 tick jitter（max-gap/p99）。同步 CPU 期间 max-gap≈wall（全程零 tick=冻结）；真卸载后 max-gap 落到个位/十几 ms。这是裁决"某段 CPU 是否阻塞事件循环"的唯一可信探针——`dispatch 被调/请求 200/wall 变快`都不自证（pass-null 盲点，同 [[methodology-keepalive-needs-kernel-ss-probe]]）。
- **静态排序必被 profiling 反转**：我静态把"逐帧 JSON.parse"排第一、finalize 同步压缩排第四；实测 finalize 同步 zstd(~6MB request_group 合并帧)+搜索索引构建=**~164ms/请求事件循环冻结**，比逐帧(~6ms)高两个数量级。**代理类系统的真热点是请求结束时的同步持久化（压缩/索引/序列化），不是逐帧**——因为它在单线程上偷走所有并发在飞流的时间（8 并发实测冻结 758ms）。且成本由**请求体大小**主导（Claude Code 中位 1.9MB 上下文，100%>200KB→常态非离群）。

**实证事实（Bun，探针实测非推断）**：
- **`node:zlib.zstdCompress` 异步版 Bun 下真走 libuv 线程池**：8×10MB 并发，sync 冻结 497ms → async max-gap 17ms + 并行 ~2.4×（4 线程池）。zstd L3 确定性 → async 输出逐字节==sync（golden 锁）。`JSON.stringify` 仍在主线程（相对压缩廉价）。
- **bun:sqlite `db.transaction(cb)` 回调必须同步**：跨 `await` **无原子性**——async 回调内 throw **不回滚**、半写持久化、`tx()` 返回 pending Promise **而非抛**（静默丢原子性，探针实证）。故"异步重活→快速同步 tx"两相：所有 `await`(压缩/索引构建)放 tx 打开**之前**，tx 回调只插已算好的 buffer。
- 纯 JS CPU（normalize/hash/jsdiff 搜索索引 ~56ms）libuv 帮不上 → 协作式 `await sleep(0)` 逐批让出（per-message 循环可分片；单体 jsdiff 不可分片不强拆）。
- **⚠️ libuv 卸载只搬"库调用"那一段，喂它的 `JSON.stringify` 仍同步主线程绑定**：`compressAsync(value)` 内 `JSON.stringify(value)`（V8、不可卸载）是同步前缀，仅其后 zstd 走 libuv。本项目 10.4MB request_group 的 stringify=~40ms 同步残留——Stage-0 合成探针把 payload **预 stringify 成 Buffer 再测 zstd**，掩盖了这 40ms，把落地实测的 758→614ms(8并发)/164→79ms(单) 乐观投影成 758→24ms。**教训**（扩展 [[methodology-probe-harness-must-match-prod]]）：探针必须复现生产**全部同步前缀**（含序列化/提取），别图省事预算好喂给被测段——否则把不可卸载的主线程成本测没了。净诚实结论：libuv 异步压缩搬掉主导单项（zstd 96ms），但 stringify(40)+jsdiff(23) 残留，单 finalize 同步 164→~63ms（~60% 非 90%），彻底消除须 worker（但 worker 也要 postMessage 序列化 entry=同量级 stringify 成本，收益待真做实测）。

**How to apply**：服务器某操作疑似卡顿先上 metronome 探针定位真阻塞段（别信静态直觉）；CPU 重活分两类——可异步库调用(zstd/zlib/crypto)走 libuv 异步 API、纯 JS 循环走协作让出；落库走"异步算→同步 tx 插 buffer"，tx 回调死守同步。

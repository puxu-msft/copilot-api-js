---
name: debugging-server-crashes
description: 当 copilot-api-js 服务器意外整进程退出（一条良性取消/错误却杀掉所有并发请求）时使用——孤儿 promise（无 live awaiter）的 reject 变全局 unhandledRejection、main.ts 的 process.on("unhandledRejection")→process.exit(1) 把它放大成崩溃（生产 911s incident，http2Fetch onPreResponseAbort abort 在遗弃时）。根因修=产生点挂 withRejectionObserver no-op observer，别放宽全局 handler。跨传输/持久化/reaper 的通用崩溃防御模式。
---

# 调试服务器意外退出

服务器整进程退出、一条请求的取消/错误把所有并发请求一起杀掉——通常是**孤儿 promise 的 reject 变成全局 `unhandledRejection`**，而 `main.ts` 的 `process.on("unhandledRejection")` 调 `process.exit(1)`，把一条良性事件放大成整服务器崩溃。

**这是跨层崩溃防御模式**，不是某传输专属：实例虽出在 `http2Fetch` 的 abort（传输层），但根因模式（遗弃 promise 的 reject 逃逸到全局）会出现在 transport / 持久化 fire-and-forget / reaper 等任何「产生 promise 但调用方可能在它 settle 前停止 await」的地方。故独立成 skill，不并入 `bun-upstream-transport`。

## 症状 → 根因

`unhandledRejection → exit(1)` 崩整服务器。本项目实例：`http2Fetch` 的 `onPreResponseAbort` reject(AbortError)，当 fetch promise 在 abort 触发时**已被遗弃**（await 链经他路先 settle，如 stale reaper force-fail）→ 崩服务器（生产 911s incident）。

孤儿 promise = 创建后无 live awaiter。abort 拒绝在**被 await 时正常捕获**、在**遗弃时变 unhandled**。

## 实测裁决要点

- `exp/stale-abort-unhandled/`（真实本地 node:http2 server）：abort 拒绝在被 await 时正常捕获、在遗弃时变 unhandled（栈逐帧一致）；最小化 reject-in-abort-listener 不泄漏 → 确属**遗弃 promise 特有**、非 Bun 通病，Bun+Node 双端一致。
- **遗弃源常难纯静态定位**：主 handler/driver/retry 全 await = 安全，多轮 subagent 全栈复现仍 0 unhandled；最可能是 detached `void this.processQueue()` 或并发共享 h2 session 边角。「全栈复现 0 unhandled」不自证遗弃不存在、只证主路径安全（[[feedback-pass-null-clean-not-self-validating]]）。

## 根因修 = 产生点挂防御性 no-op observer

`withRejectionObserver`：`p.catch(() => {})` 标记已观察但**不消费**，返回原 `p` → 真实 awaiter 仍独立收到 reject。消除**整类**孤儿-fetch-abort 崩溃，**不依赖定位每个遗弃源**（belt-and-suspenders）。

**How to apply**：
1. **别放宽全局 handler** 用 `isAbortError` 豁免——它过宽（`TimeoutError` / 含 "abort" 子串 / cause 链），会静默降级真正该崩的未知 reject；根因修在产生点、全局 handler 保持严格。
2. 任何可能 reject 且调用方可能在 reject 前停止 await 的 promise 工厂，在返回点挂 observer。
3. 回归测试：abandoned 无 unhandledRejection + 真实 awaiter 仍收到 reject（`tests/transport/http2-client.it.test.ts`）。

## 相关

同类「后台任务逃逸 reject 崩进程」主题：`fire-and-forget` 必须 never-throw（后台 backfill / 异步持久化——见 skill `history-backfill` 与记忆 methodology-sync-to-async-persistence-refactor-invariants 的 fire-and-forget-never-throw 条）；本崩溃是 pre-response-abort RFC 的缺陷⑤（reaper `ctx.fail()` 不取消在飞 fetch = 缺陷④，暂缓）。探针 harness 须复制生产接线（否则「全栈复现 0 unhandled」只证主路径安全、不证遗弃不存在），见 skill `empirical-verification`。

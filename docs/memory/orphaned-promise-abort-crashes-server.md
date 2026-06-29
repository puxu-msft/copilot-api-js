---
name: orphaned-promise-abort-crashes-server
description: 孤儿(无 awaiter)promise 的 abort 拒绝会经全局 unhandledRejection→exit(1) 崩整服务器;根因修在产生点挂防御性 observer
metadata: 
  node_type: memory
  type: project
  originSessionId: 79ff48bb-02b7-4df3-a1f9-06f727721113
---

孤儿 promise(创建后无 live awaiter)的 reject 会变 process 级 `unhandledRejection`,而 `main.ts` 的 `process.on("unhandledRejection")` 调 `process.exit(1)` → 把一条良性取消放大成杀掉所有并发请求的整服务器崩溃。本项目实例:`http2Fetch` 的 `onPreResponseAbort` reject(AbortError),当 fetch promise 在 abort 触发时已被遗弃(await 链经他路先 settle,如 stale reaper force-fail)→ 崩服务器(生产 911s incident)。

**实测裁决要点**(exp/stale-abort-unhandled/,真实本地 node:http2 server):abort 拒绝在**被 await 时正常捕获**、在**遗弃时变 unhandled**(栈逐帧一致);最小化 reject-in-abort-listener 不泄漏 → 确属遗弃 promise 特有非 Bun 通病。**遗弃源常难纯静态定位**(主 handler/driver/retry 全 await=安全,多轮 subagent 全栈复现仍 0 unhandled;最可能是 detached `void this.processQueue()` 或并发共享 h2 session 边角)。

**根因修复 = 产生点挂防御性 no-op observer**(`withRejectionObserver`:`p.catch(()=>{})` 标记已观察但不消费,返回原 `p` → 真实 awaiter 仍独立收到 reject)。消除**整类**孤儿-fetch-abort 崩溃,**不依赖定位每个遗弃源**(belt-and-suspenders)。实测 Bun+Node 双端。

**Why:** 全局 `unhandledRejection→exit` 是把"未知 reject"当致命的过激策略;一条预期内的取消不该触发它。

**How to apply:** ① 别放宽全局 handler 用 `isAbortError` 豁免——它过宽(`TimeoutError`/含 "abort" 子串/cause 链),会静默降级真正该崩的未知 reject;根因修在产生点、全局 handler 保持严格。② 任何可能 reject 且调用方可能在 reject 前停止 await 的 promise 工厂,在返回点挂 observer。③ 回归测试:abandoned 无 unhandledRejection + 真实 awaiter 仍收到 reject(`tests/transport/http2-client.it.test.ts`)。

关联:[[methodology-probe-harness-must-match-prod]](全栈复现 0 unhandled 不自证遗弃不存在,只证主路径安全)、[[feedback-pass-null-clean-not-self-validating]]、[[project-pre-response-abort-rfc]](同 RFC 缺陷⑤;缺陷④=reaper `ctx.fail()` 不取消在飞 fetch 暂缓)。

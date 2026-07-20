---
name: methodology-v3-direct-driver-test-async-finalize-race-and-arena-enrichment-oracle
description: 两个 History V3 测试 gotcha——direct-driver getEntry 撞异步 finalize race（须 await whenModelOperationFinalized）、arena-value 富化于 wire 令 golden oracle 过严
metadata: 
  node_type: memory
  type: reference
  originSessionId: c200e804-07ad-4890-a36e-e297fac6f25d
  modified: 2026-07-20T16:32:57.087Z
---

调 History V3（V2-removal 后，2026-07-18 `a4f4f20f` 等）相关测试的两个复发 gotcha，2026-07-20 修 3 个 pre-existing 失败时定位：

**① direct-driver 测试 `getEntry(ctx.id)` 返 undefined = 异步持久化 race。** V3 finalize 是异步的：`ctx.finalizeModelOperationDelivery()` 只请求 finalize，真正的 seal→generation finalizer→terminal-bus persist 在 operation-scope quiesce 后异步完成（`request.ts:795` `operationScope.seal()`、`819` `generationFinalizerPromise`）。测试在 `finalizeModelOperationDelivery()` 后**同步** `getEntry` 必然扑空。修=补 `await ctx.whenModelOperationFinalized()`（`request.ts:1169`）——既有正确模式在 `tests/context/generation-recorder-lifecycle.unit.test.ts`。凡「direct `driver.runResponse` + `ctx.complete()` + 手动 finalize + getEntry」骨架都须此 await（走完整 HTTP app 的测试由 observabilityMiddleware 代驱，不受影响）。踩坑实例：`reactive-retry-leg.it` / `replay.it`。

**② arena node `value` 有意富于 wire → `value == parseWire(wire)` golden oracle 过严。** `canonicalFrameValue`（`request.ts:477`）对**携 SseEventRecord 的帧**（post-loop-flush 终点，经 `captureForwardedGenerationFrame`）富化 derived `type`/`synthetic`（`:501-502`，供 V3 projection）；而 driver-loop 帧经 `captureGenerationFrameAction`（无 record）不富化——**不对称**。但 projection 真实读的是 `observation.type ?? frameType(value)`（`projection.ts:75`）**非 `value.type`**，故富化是无害内部冗余、不影响 getHistory 输出（非功能 bug）。测试若断 `arena value === parseWire(wire)`（只有 wire 字段）会被这不对称打爆。修=比较前剥离非-wire 的 `type`/`synthetic`，保留测试「帧序+wire 内容」本意。踩坑实例：`generation-runtime-baseline.http.test.ts` P0-T1。

通用教训：**History V2→V3 大迁移会令旧测试的同步假设/golden oracle 失同步**；判 pre-existing 失败先 base-commit 对照（`64f4d01d`），再按「同步假设 vs 异步现实」「内部富化 vs wire 投影」两轴归类。相关 [[project-synthetic-frame-forwarded-track-completeness-spec]]（Unit 1 同源发现 durable projection 异步捕获）。

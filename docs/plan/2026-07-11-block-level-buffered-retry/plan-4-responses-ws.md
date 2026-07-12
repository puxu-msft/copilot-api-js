# P4 Responses-WS — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤用 `- [ ]` 跟踪。
>
> 权威 spec：[`../../spec/2026-07-11-block-level-buffered-retry.md`](../../spec/2026-07-11-block-level-buffered-retry.md) §7.3/§9。总览 [`README.md`](README.md)。**依赖 P0**（骨架 + `partial-degrade` + telemetry）**+ P2**（Responses codec 谓词，terminal-only 用法）。

**Goal:** 给 `/v1/responses` over WebSocket 净新建 **terminal-only** buffered 保护——`ws.ts` 加选路（复用 `responses.buffered_retry` 键，不新造）、close-code(1011)/commit/retreat 时序对齐、默认随 Responses 翻 true、关 backlog:300-306。

**Architecture:** WS = terminal-only（无增量块需求，边界集只含终止符 = 已证整响应形状）。复用 P2 的 Responses codec 谓词（terminal 用法）+ `buffered-config.ts`。WS 无 anchor。makeWsSink 已有 writeSynthetic/close/heartbeat（`client-sink.ts:480`）。唯一真难点 = WS 终态早停 `stopAfterFrame:isTerminal` + `sendErrorAndClose`+1011 与 buffered commit/retreat 时序。

**Tech Stack:** TypeScript / Bun / Hono WS。WS 测试夹具：Node http2/ws server（Bun WS server 行为不忠实，参照 skill `bun-upstream-transport`）。

## Global Constraints（逐字自 README）
- **复用键**：WS 不新造键，走 `responses.buffered_retry`（spec §7.3 + backlog:304）。
- **红线 R4**：默认随 responses 翻 true 前核 keepalive（WS 已有 responsesKeepaliveFrame）。
- **红线 R5**：landing 关 backlog:300-306。
- 细粒度显式 pathspec commit、conventional commits、无模型署名。

---

### Task 1: `ws.ts` 加 buffered 选路（复用 responses 配置）

**Files:**
- Modify: `src/routes/responses/ws.ts:359`（runResponseSink → 选路）
- Test: `tests/responses/ws-buffered.integration.test.ts`

**Interfaces:**
- Consumes：`resolveResponsesBufferedAndHeartbeat`（`responses/buffered-config.ts`，复用）；P2 Responses 谓词（terminal 用法）；P0 骨架 + `partial-degrade`。
- **fallback 核实（H4，已确证非占位）**：`ws.ts:279` 已有 `const viaFallback = env.targetEndpoint === ENDPOINT.CHAT_COMPLETIONS`，`ws.ts:386` 有 `if (viaFallback) codec.flushResponse` 循环外后置合成——与 P2 direct 子路径**同根因**。故 buffered 分支**直接**门控 `buffered && !viaFallback`（复用 ws.ts:279、fallback 保持 live），并加 fallback+buffered=live 回归测试（同 P2 Task 3）。

- [x] **Step 1: 写失败测试（terminal-only buffered + mid-stream drop 重试）**

```typescript
// tests/responses/ws-buffered.integration.test.ts （Bun.serve + hono/bun 夹具，同 responses-ws.http.test.ts）
test("buffered ON: mid-stream upstream drop before terminal → retried & recovered, client sees ONE complete generation", async () => {
  // buffered on：WS 上游流终止(response.completed)前掉线 → 透明重试 → 第二次收全 → 客户端拿完整。
  // 断言 stopAfterFrame:isTerminal 不在 buffered 累积期截断未提交 buffer。
})
```

- [x] **Step 2: 跑证失败** — FAIL（现仅 runResponseSink）。已用**反事实法**验证两处：① 强制 `buffered=false` → 断言 `PARTIAL_ATTEMPT_1` 泄漏到客户端，红；② 去掉 `!viaFallback` 门 → fallback 测试断言空 telemetry 失败，红。两处均已复原为正确实现并转绿。

- [x] **Step 3: ws.ts 选路** — 已落地（见下方实测代码，vendor 采 `"responses_ws"`，理由见自审）。

```typescript
// responses/ws.ts handleResponseCreateV4 替换 :359 —— 实际落地版本
const { buffered: bufferedConfigured } = resolveResponsesBufferedAndHeartbeat()
const buffered = bufferedConfigured && !viaFallback
const outcome =
  buffered ?
    await driver.runResponseBufferedSink(upstream, env, sink, {
      onRenderedFrame: restoreAccumulateCount,
      stopAfterFrame: isTerminal,
      commitBoundaries: isResponsesCommitBoundary, // P2 谓词，terminal 用法（TERMINAL_EVENTS ⊆ commit boundary types）
      sawMessageStop: () => acc.status !== "",
      sawUpstreamError: () => acc.streamError !== undefined,
      telemetryVendor: "responses_ws",            // 独立 vendor 维度（见自审）
      retryCap: resolveBufferedCaps("responses").maxRetries,
      bufferCapBytes: resolveBufferedCaps("responses").bufferCapBytes,
      onBufferedResolve: (o, retries, meta) => {
        if (o === "success" && retries === 0) return
        recordProtectStreamingOutcome(o, retries, meta)
        env.ctx.recordFeature("protect-streaming-retry", { outcome: o, retries, vendor: meta.vendor })
      },
      onAttemptReset: () => { acc = createResponsesStreamAccumulator(); eventsReceived = 0 },
    })
  : await driver.runResponseSink(upstream, env, sink, { onRenderedFrame: restoreAccumulateCount, stopAfterFrame: isTerminal })
```

- [x] **Step 4: 跑证通过 + 提交**

```bash
bun test tests/responses/ws-buffered.integration.test.ts  # 2 pass, 10/10 重跑确定性
git add src/routes/responses/ws.ts tests/responses/ws-buffered.integration.test.ts
git commit -m "feat(responses-ws): terminal-only buffered retry (reuse responses.buffered_retry key)"
```

---

### Task 2: close-code(1011)/commit/retreat 时序对齐（backlog:300-306 核心）

**Files:**
- Modify: `src/routes/responses/ws.ts`（`sendErrorAndClose`+1011 路径与 buffered commit/retreat）
- Test: `tests/responses/ws-buffered-close-timing.test.ts`

**Interfaces:** 时序不变量——(a) buffered 累积期 `stopAfterFrame:isTerminal` 早停不能截断未提交 buffer；(b) 重试期 close-code 不能过早发（重试是透明的，客户端不该在重试间隙收到 1011）；(c) partial-degrade/exhausted 时 `sendErrorAndClose`+1011 在 flush 已提交帧**之后**。

- [ ] **Step 1: 写时序测试（三不变量各一）**

```typescript
// tests/responses/ws-buffered-close-timing.test.ts
// (a) buffered 累积期收到 isTerminal → 提交整 buffer 后才终止，不半截。
// (b) attempt1 掉线 → 重试期间不发 1011；attempt2 成功 → 正常 close(1000)。
// (c) exhausted → 先 flush（无，因未提交）→ 再 sendErrorAndClose(1011)；partial-degrade → 先 flush 已提交帧 → 再 1011。
```

- [ ] **Step 2-4: 跑失败 → 实现时序守卫 → 跑通过**

buffered 分支下，`sendErrorAndClose`+1011 只在 outcome 为 stream-error（exhausted/partial-degrade）时、且在 driver 返回（已 flush 完可提交帧）之后调；重试期由 driver 内部透明处理，ws 层不介入。

- [ ] **Step 5: 提交**

```bash
git add src/routes/responses/ws.ts tests/responses/ws-buffered-close-timing.test.ts
git commit -m "fix(responses-ws): align 1011 close-code with buffered commit/retreat timing (backlog:300-306)"
```

---

### Task 3: 默认随 responses 翻 true + 关 backlog

**Files:** `src/lib/state.ts`（WS 无独立键——`responses.buffered_retry` 默认已在 P2 翻 true，WS 自动继承）、`docs/todo/deferred-backlog.md`（关 :300-306）、`docs/DESIGN.md`（WS 行同步）。

- [ ] **Step 1: 核实 WS 继承 responses 默认 + keepalive（R4）**

WS 已有 `responsesKeepaliveFrame`（`ws.ts:296-307` forward-idle heartbeat）——核其在 buffered 窗口内重置客户端 idle（按需探针 `exp/`，或复用 P2 的 Responses keepalive oracle 结论，因 WS 客户端同 Codex 语义）。R4。

- [ ] **Step 2: 关 backlog + doc-sync + 提交**

```bash
git add docs/todo/deferred-backlog.md docs/DESIGN.md
git commit -m "docs(responses-ws): buffered retry landed — close backlog:300-306, sync DESIGN"
```

---

## 自审

**spec 覆盖：** §7.3 WS terminal-only + 复用 responses 键 + close-code/commit 时序 → T1/T2；默认翻转 + backlog 关闭 → T3。✅
**vendor 维度决定（回报点）：** T1 用 `"responses_ws"` 独立 vendor 维度（telemetry 可区分 WS vs HTTP），还是复用 `"responses"`——spec §9.1 要 vendor 可区分，**倾向 `"responses_ws"`**（更细）。实施者按 P0 landed 的 vendor 分桶确认；若 P0 只认固定 vendor 集则复用 responses + endpoint 维度区分。
**fallback 核实（回报点）：** T1 Step 3 `viaFallback` 需实施者核实 WS 是否触及 via-chat-completions fallback；若不触及则恒 false、简化。
**占位扫描：** WS 集成测试须 Node ws server 夹具（Bun WS server 行为不忠实）；测试体须实施者落真断言。close-timing 三不变量具体。
**类型一致：** `responsesCommitBoundaries`（P2）/`resolveResponsesBufferedAndHeartbeat`/`resolveBufferedCaps("responses")`/`partial-degrade`/`telemetryVendor` 与 P0/P2 契约一致。
**R4/R5：** T3 S1 核 keepalive（R4）；T3 S2 关 backlog:300-306（R5）。✅

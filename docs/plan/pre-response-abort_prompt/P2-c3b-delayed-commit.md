# P2 — ③ 延迟-commit 实现（opus 长思考保活）

> 开场先读 [README.md](./README.md) 的通用红线 + 必读，**完整读 RFC §4 全部（§4.1–§4.2.7）+ §5 commit 表**。**前置硬门：P1（Q2）已出 go 结论**（否则 ③ 的 POST-COMMIT 降级未经实测裁决，不能落地）。大特性、byte-critical——走 big-feature-pipeline（先 golden 预捕获 → C3a → C3b）。

## 背景 + 为什么

incident：opus-4.8 在发出**第一个响应头之前**就 server-side adaptive thinking 静默 292s，客户端等不到任何字节放弃断开（RFC §1）。①②（已落地）只把故障**记录正确**；**③ 才真正防止断线**——对 `stream:true` 请求在 grace 窗口耗尽后提前开 200 SSE 流打 ping。

设计经 round 1/2/3/A/B/C 多轮对抗 review 收敛（RFC Changelog）。**前置已就绪**：`mapHttpErrorToEnvelope`（pre1 `3e4b3cd`，富错误帧用）+ `ClientSink.write`（已是采样写，commit 首 ping 直接用、不需 emitPingOnAttach）。

## 实现前必须先解的 2 个 CRITICAL（round-C，L2 演化引入，RFC §4.2.1 Changelog）

**C1 — pump 自建 sink、③ "复用同一 sink"破裂**：`pumpAnthropicStreamingV4`（`handler-v4.ts:616` 附近）**自建** `makeSseSink`、签名只收 `stream`（`:514` 附近）不收 sink。③ 的两段式要 commit 时先建 sink 打首 ping、再把**同一 sink** 交给 pump——但 pump 现在自建。**必须先重构 `pumpAnthropicStreamingV4` 接收注入的 sink**（而非自建），否则双 `makeSseSink` 共享同一 `SSEStreamingApi` → 两条 serializer chain 字节交错。注意 pump 现在还自决 `buffered`（L2 `runResponseBufferedSink`）+ heartbeat（`protectStreamingHeartbeat` fallback），sink 注入要与这些协调（谁拥有 heartbeat config 在 commit+buffered 同时触发时须定义）。

**C2 — decideRoute reject 是 `{ok:false}` resolve 非 throw**：`driver.runRequest` 对 decideRoute reject 走 `return { ok: false, rejection }`（`driver.ts:146`，**resolve**），只有 exchange 上游错误/abort 才 throw。§4.2.1 COMMIT 分支的 `try { await p } catch` **接不住** `{ok:false}`。**COMMIT 分支必须显式判 `result.ok === false`** 再走富错误帧，不能只靠 try/catch。

**③×④ 交互（HIGH）**：④（已落地）给 reaper 装了牙齿——reaper 会 abort 在飞 fetch。③ 的 POST-COMMIT `await p` 正是那个在飞 fetch。reaper-cancel 既非 client-gone 又非真 timeout → COMMIT catch 须把它作**第四类显式分支**（reaper-cancel → 富 error 帧 + `ctx.fail`，与 reaper 自身 `ctx.fail` 用 `settled` guard 去重）。`StreamReaperCancelError`/`classifyStreamError` 的 `reaper-cancel` kind 已存在（④ 落地）。

## 目标（按 §5 commit 表，依序）

1. **C3a golden 预捕获**（methodology-golden-fixture-pre-capture）：在**改动前**代码上锁 (i) `stream:true` 正常完成的 forwarded SSE 序列（归一化 id/timing）、(ii) 上游 400（流式）现状行为（当前出 HTTP 400，③ 后变 200+富error帧——记为**有意变化**，golden 证变化范围精确）。连跑 10-25×。
2. **C3b 前置重构**：解 C1（pump 接收注入 sink）+ C2（COMMIT 显式判 `result.ok===false`）。
3. **C3b 本体**（RFC §4.2.1 两段式 + §4.2.3 配置 + §4.2.4 状态机 + §4.2.5 富错误帧 + §4.2.6 可观测）：
   - 新配置 `anthropic.pre_stream_grace`（`preStreamGraceSec`，默认值用 P1 实测结果；`0`=禁用=完全 bypass race）。**归 `anthropic.*`**（避 `timeouts.*` 的 dispatcher 重建）。**登记 `config-hot-reload.it.test.ts` 矩阵**（硬验证门，不登记直接 fail）。
   - 两段式：`p = driver.runRequest(...)` 外置 → `Promise.race([p.then(()=>"upstream",()=>"upstream"), graceTimer])`（graceTimer 用 `setTimeout`+`clearTimeout`，**禁用 `AbortSignal.timeout`**）→ grace 内回头走现状出口（零发散）；grace 耗尽 COMMIT：`codec.getContext()?.recordFeature("pre_stream_grace_commit", {graceSec, stalledAtLeastMs})`（新 feature key 须登记 `FeatureKind`）→ `streamSSE` 开 200 → **立即 `sink.write(pingFrame)`**（采样首 ping）→ 回调内 `await p`。
   - COMMIT 后**终态全自包含在回调**（中间件对 SSE 不 finalize）：ok→pump；`{ok:false}`/HTTPError/timeout/reaper-cancel→`mapHttpErrorToEnvelope` 合成**富** SSE error 帧 + `ctx.fail`；client-abort→`ctx.abort()` 无 499。`sink.close()`+`clearTimeout` 在 finally。`if(ctx)` 守卫（client-abort 早于 parse）。
   - tie→upstream 优先；`grace<=0`/非流式完全 bypass。
4. **验收 golden**：正常流逐字节等价（C3a）；错误流变化范围精确（只动状态码层、富 error 帧保 `error.type`/`retry_after`）。

## 验收

- [ ] C1/C2/③×④ 三处都在 COMMIT 分支显式处理（subagent 复审确认无遗漏）。
- [ ] golden（C3a）：正常流逐字节等价、错误流变化范围精确。流式 fixture 连跑 10-25×。
- [ ] `bun run typecheck` + `bun test tests/anthropic tests/streaming tests/pipeline tests/config` 绿。
- [ ] config-hot-reload 矩阵登记 `pre_stream_grace`。
- [ ] **subagent 多轮对抗 review**（显式裁判轴），亲自复核引用 file:line。
- [ ] doc-sync：RFC §5 C3b 标 ✅、DESIGN 运行时选项表 + hot-reload 表 + 活的架构现状表"流式写出"行补 grace-commit 分支、memory 回填。
- [ ] **范围**：③ 仅 Anthropic `/v1/messages`（§4.2 Q6 YAGNI，不推 CC/Responses 除非有实测痛点）。

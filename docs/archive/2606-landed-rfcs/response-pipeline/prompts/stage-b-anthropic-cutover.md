# Stage B — Anthropic cut-over canary（第一个 byte-critical commit）

> **粘贴进新会话直接执行。** 这是 response-pipeline RFC **Stage B**（driver-owned-writeout）的第一个真实格式 cut-over。前面 B0/B1/B2 的 additive 脚手架已全部落地（见下「已就绪」）；本步把**活的 Anthropic 流式 handler** 切到 owns-sink，是 Stage B 最 byte-critical 的一步。
>
> 设计稿 [design.md](../design.md) §3.2/§3.3/§5；master plan [stage-b-plan.md](../stage-b-plan.md)。

## 0. 通用红线（每会话必守，见项目 CLAUDE.md + prompts 上级 README）

中文对话；不 `git checkout/reset --hard/clean/rm` 工作区文件；`git add`/本地 commit 允许、`push`/`gh pr` 需明确同意；不自动启服务器、不 `kill` 本项目进程；范围歧义先问、范围内彻底；**改写/复审永远派 subagent 多视角对抗 + 主线亲核每个 file:line**；测试用 DI/fetch-mock 不用 `mock.module`、绝不碰真实 `$HOME`；不使用分号、三元行首、`printWidth` 160；只改 `.ts/.json/.yaml` 才跑 `bun run typecheck`/`bun run test:backend`/`bunx eslint --fix`（**不是 `npm`**）。

## 1. 已就绪（B0/B1/B2 已提交，本步直接复用，**勿重做**）

| 资产 | 在哪 | 契约 |
|---|---|---|
| **`ClientSink`** | `src/lib/pipeline/types.ts` | `{ write(frame), writeSynthetic?(frame), close?() }`。单 Promise chain 串行化（真实帧+ping+error 不交错）；`write` reject（client 断连）传播给调用方、chain 不中毒 |
| **`ResponseOutcome`** | 同上 | `{kind:"complete";headers} \| {kind:"stream-error";error} \| {kind:"settled-abort"}`。**不带 accumulator**（handler 自持 acc）——只是控制信号 |
| **`makeSseSink(stream, heartbeat?)`** | `src/lib/pipeline/client-sink.ts` | 可选 `SseSinkHeartbeat{intervalSec, pingFrame, clientAbortSignal?}`：`write` 更新 `lastRealMs`，静默 `intervalSec` 后经 `writeSynthetic` 注 `pingFrame`（共用 chain，`unref` + `close()` 清 timer）。**forward-idle racer，不碰 transport 的 upstream-idle hard-kill** |
| **`driver.runResponseSink(upstream, env, sink, opts?)`** | `src/lib/pipeline/driver.ts` | wrapping shim：drain generator `runResponse` 写进 `sink.write`；**丢弃 `[DONE]` 哨兵**（per-format 尾终止符交 handler）；`finally` 必调 `sink.close?()`（防 timer 泄漏）；clean drain→`complete{headers}`，任何 throw/reject→`stream-error`（B3a 细分）。`opts.onUpstreamFrame` 透传给 generator（raw 帧 accumulate hook 不变） |
| **B0 goldens（真-renderer 字节 oracle）** | `tests/anthropic/anthropic-v4.http.test.ts`、`tests/anthropic/response-rewrite-golden.http.test.ts` | Anthropic 流式 ok/thinking/recover/decode/filter/H2/H3 + **B0-c H2/H3 采样非对称**。**这些是 cut-over 的硬 gate，逐字节必须仍绿** |

> commit 锚点：B0 `8c512ce`/`bd5626f`/`f19b9fa`、B1 `4418072`+`9cb2ace`、B2 `4085fe2`(\[DONE])+`5b59253`(heartbeat)。

## 2. 任务：把 `pumpAnthropicStreamingV4` 切到 owns-sink

**锚点（实现前 re-read，代码会漂移）**：`src/routes/messages/handler-v4.ts` 的 `pumpAnthropicStreamingV4`（现 ~`:523`）。现状结构：建 `acc`(`createAnthropicStreamAccumulator`) + `forwardedSseEvents` + `streamState` + `heartbeat`(`startForwardedSseHeartbeat`) + `onUpstreamFrame`(raw 帧 accumulate/record) → `for await(yielded of driver.runResponse(upstream, env, {onUpstreamFrame})) forwardClientFrame(...)` (写 + 采 forwarded) → `acc.streamError ? ctx.fail : ctx.complete(buildAnthropicResponseData(acc))` → catch `settleStreamingFailure` + 合成 error 帧（**经 heartbeat.writeSerialized，不采 forwarded** = H2/H3 非对称）→ finally `heartbeat.stop()`。

**目标终态**：`streamSSE(c, s => { const sink = makeSseSink(s, {heartbeat, onForwarded, streamStartMs}); const outcome = await driver.runResponseSink(upstream, env, sink, {onUpstreamFrame}); /* outcome + acc → ctx.complete/fail */ })`。

> **关键认知（B1 对抗 review）**：per-format cut-over **collapse 了 plan 的 B2-整合 + B3a + B4-Anthropic 三块**——因为 driver 一旦持写出口，forwarded 采样就**必须**同时进 sink（handler 不再逐帧见到 forwarded）。所以本步**不是**纯 B3a，而是 Anthropic 的完整 owns-sink 落地。

## 3. 必须正确处理的红线（来自 4 轮 plan review + B1 review，逐条核）

1. **真-renderer 等价 gate**：B0 的 `anthropic-v4.http` + `response-rewrite-golden.http` 用真 Anthropic codec（identity render + `[DONE]`）跑全链——**它们是 oracle**。cut-over 后逐字节必须仍绿。**别**用 identity-renderer 单测自证（B1-review：会 false-green）。
2. **forwarded 采样进 sink（B4-Anthropic piece，不可缓）**：`makeSseSink` 需扩 `onForwarded?(record)` + `streamStartMs`（sink 在 `write` 时算 `{offsetMs, type, raw}` 推给回调）。handler 传 `onForwarded: r => forwardedSseEvents.push(r)`，loop 后 `ctx.setForwardedResponse({sseEvents: forwardedSseEvents})`。**ping 经 `writeSynthetic` 采 forwarded 但跳 sseEvents**（B0 心跳隔离）。**sink 保持极薄**：只发采样事件给注入回调，不 reach `ctx`（R4 minimality）。
3. **H2/H3 采样非对称（B0-c 已锁，必保）**：H2（上游终态 `error` 帧）经正常 `sink.write` → **入** forwarded 轨；H3（handler 抛错后合成的 error 帧）须经**非采样**写出（`sink.writeSynthetic` 不推 onForwarded，或一个不采样的 raw 写）→ **不入** forwarded 轨。
4. **outcome + acc 双读决定终态**：`ResponseOutcome` 不带 streamError；`acc.streamError`（H2，clean drain 仍 complete）须由 handler 读 → `ctx.fail`。映射：outcome `complete` + `acc.streamError` → `ctx.fail`；outcome `complete` 无 streamError → `ctx.complete(buildAnthropicResponseData(acc))`；outcome `stream-error`（H3 throw）→ `settleStreamingFailure` + 合成 error 帧（非采样）；outcome `settled-abort`（client 断）→ 录 aborted、**其后零字节**（B0-d）。
5. **两-racer 整合不变量（B0-e / B2，本步首次可测）**：heartbeat 开（`anthropicFakeSseHeartbeat>0`）+ 上游静默 → 客户端**收 ping** 且流**仍按 `timeouts.stream_idle` 死**（证 sink 的 forward-idle racer 没碰 transport 的 upstream-idle hard-kill）。fake-timer 写、连跑 10-25×。
6. **close-on-all-exits 泄漏（R3 硬 gate）**：4 退出路径（normal / 上游 throw / client-abort / `sink.write` reject）后 sink 的 heartbeat timer 均已 `close()` 清除。`runResponseSink` 的 `finally` 已调 `close`；**亲验** 4 路都过该 finally。
7. **`[DONE]` 已解**：`runResponseSink` 丢弃 `[DONE]`；Anthropic 本就不发 `[DONE]`，正确。**别**在 handler 再合成。
8. **accumulate 不变**：`onUpstreamFrame` 在 **raw 帧**（pre-rewrite）accumulate/record（→ outboundResponse 上游原貌、repetition、progress、sseEvents 上游轨）——透传给 `runResponseSink(opts)` 即可，逻辑不动。
9. **dual-track 并存**：`startForwardedSseHeartbeat`（streaming-pump.ts）**仍被 web_search bypass（web-search-direct.ts）+ 未切格式用**，**绝不删**；本步只让 Anthropic 流式 handler 改用 sink heartbeat。

## 4. TDD / 步骤

1. **改前再跑 B0 goldens 全绿**（确认基线）。
2. **扩 `makeSseSink`**：加 `onForwarded?(record: SseEventRecord)` + `streamStartMs`（`write` 推采样事件、`writeSynthetic` 推 forwarded-only、对 `[ping]` 标 type:"ping"）。补 client-sink 单测（onForwarded 记录、writeSynthetic forwarded-only、H2/H3 非采样路径）。
3. **改 `pumpAnthropicStreamingV4`**：建 sink（heartbeat 配 `state.anthropicFakeSseHeartbeat` + Anthropic ping 帧 `{event:"ping", data:JSON.stringify({type:"ping"})}` + clientAbort）→ `runResponseSink(upstream, env, sink, {onUpstreamFrame})` → outcome+acc→`ctx.complete/fail` → catch/abort 按红线 4。删 handler 的 `forwardClientFrame` 逐帧写/采（移进 sink）+ `heartbeat.stop()`（sink.close 接管）。
4. **跑 B0 goldens 逐字节等价**（硬 gate）+ 新增**两-racer 不变量**测试 + **泄漏矩阵**（4 退出 × close 清除）+ **abort 零字节**。
5. `bun run typecheck` + `bun run test:backend` 全绿（唯一允许 fail = 预存 `file-sink.unit.test.ts` 的 `/tmp` ENOTDIR，无关）+ 流式/时序连跑 10-25× 确定。
6. `bunx eslint --fix`。
7. **≥2 个全量工具 subagent 对抗 review**（视角：byte-safety / 终态时序+竞态+泄漏 / forwarded 采样轨非对称），显式裁判轴=长远正确+完整；**主线亲核每个 file:line**（尤其 H2/H3 采样、outcome→fail 映射、close 4 路、ping 隔离）。
8. **Commit**（一个 byte-critical commit，细粒度暂存）：`git add -- src/lib/pipeline/client-sink.ts src/routes/messages/handler-v4.ts tests/...` `git commit -m "feat(pipeline): Stage B Anthropic cut-over — 流式 handler 切 owns-sink(runResponseSink+sink heartbeat+forwarded 采样进 sink)"`。

## 5. 验收

- B0 goldens（anthropic-v4 + response-rewrite-golden）逐字节等价、连跑确定。
- 两-racer 不变量绿（ping + 仍 idle-kill）；close 泄漏矩阵绿；abort 零字节绿；H2/H3 非对称绿。
- 三大能力守卫：`/history/api/entries/:id` 双轨（上游原始 sseEvents + forwarded）不变、`/api/status` 不变。
- 全 backend 绿（除预存 file-sink）；typecheck+eslint 绿；≥2 subagent review 无 CRITICAL/HIGH + 主线亲核。
- doc-sync：DESIGN.md「活的架构现状」加 Anthropic 流式 = owns-sink 行；stage-b-plan.md 勾 Anthropic canary + 记 B4-Anthropic 已随 cut-over 落地；docs/v4/05-progress.md 登记。

## 6. 此后（不在本步）

下一格式 cut-over：**CC**（有 verbose marker streaming + via-responses `[DONE]` 合成，比 Anthropic 多两件）→ Responses-HTTP → **Responses-WS**（须给 sink port 加**早停信号**：现 `ws.ts` 遇 terminal 事件 break；B1-review 红线）→ **Gemini**（B5：`translateOpenAIStreamToGemini` 闭包逐帧化 + 终态 meta，最硬）。全切完单独 commit 删 generator `runResponse` + 旧 heartbeat（**scope 仅 driver 消费者**，web_search bypass 仍用，别误删）。

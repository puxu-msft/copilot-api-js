# P2 + P3 — ③ pre-response 延迟-commit 保活 + keepalive 命名一族重整

## Context

opus-4.8 在发出**第一个 HTTP 响应头之前**就 server-side adaptive thinking 静默数十秒~数百秒（RFC incident，`docs/rfc/pre-response-abort-handling.md` §1）。P1 Q2 实测（`exp/q2-oracle/REPORT.md`）已 pin：**Claude Code 的请求超时是 idle 型、阈值 ≈ 60s、超时即断+自动重试**；当前代理在 pre-response 期不向客户端发任何字节 → CC 在 60s idle 后断开。①②④⑤ 已落地只把故障**记录正确**；**③ 才真正防止断线**——对 `stream:true` 请求在 grace 窗口（默认 40s，< 60s 硬约束）耗尽后提前开 200 SSE 流并周期 ping（< 60s cadence），把 opus 长思考期间的连接保活。

同时实测暴露一个既有缺陷：bundled `config.yaml` 的 mid-stream 合成心跳 `stream_fake_sse_heartbeat: 120` 对 CC 的 60s idle **无效**。借 ③ 落地一并把三个交叉的 keepalive knob 整理成一族连贯命名（P3，RFC §4.2.3.1），并把 live ping 默认降到有效值。

**Q2 裁决 GO（有条件）**：error.type 富帧保真 → CC 各类错误正确显示；401/400/不可重试类完全等价；仅 429/5xx 可重试类真发散，但被延迟-commit 收窄到"长 stall（>grace）后才到的可重试错误"病态少数。

**已决定（用户 2026-06-23）**：
- 命名统一 `stream_keepalive_*` 族；`protect_streaming_heartbeat` 留在 L2 族不动。
- mid-stream live ping 默认 **45s**（mid-stream 也保活）。

## 决定的配置分类（最终命名，P2/P3 一次定清，不二次改名）

| 新 config key | 新 runtime 字段 | 取代/新增 | 默认 | 语义 |
|---|---|---|---|---|
| `anthropic.stream_keepalive_ping_sec` | `streamKeepalivePingSec` | 取代 `stream_fake_sse_heartbeat` / `anthropicFakeSseHeartbeat` | **45**（was bundled 120 / state 0） | live Anthropic 流式合成 `event: ping` cadence（mid-stream 间隙 **+ ③ commit 后**）。③ commit ping = `值>0 ? 值 : 30` floor |
| `anthropic.stream_keepalive_grace_sec` | `streamKeepaliveGraceSec` | **新增**（③） | **40**（`< 60` 硬约束） | ③ pre-response grace：提前开 200 前等上游响应头的秒数。`0` = 禁用 ③（完全 bypass race） |
| `anthropic.protect_streaming_heartbeat` | `protectStreamingHeartbeat` | **不动**（L2 buffered 专用，留 protect_streaming_* 族） | 15 | — |

compat：`renameLeaf("anthropic.stream_fake_sse_heartbeat", "anthropic.stream_keepalive_ping_sec")`（与既有 `fake_sse_heartbeat`→`stream_fake_sse_heartbeat` 两跳链共存，各自独立 fire）。

## Commit 序列（methodology-commit-invariants，每个中间 commit 系统不半坏）

### C3a — golden 预捕获（test-only，改动前锁字节）
模板复用 `tests/anthropic/streaming-l2-baseline.http.test.ts`（purpose-built 字节锁）+ helpers `useIsolatedRuntime`/`createFullTestApp`/`applyFetchMock`/`createSseResponse`/`createSseResponseThenError`/`mockModel`。
- (i) `stream:true` 正常完成 forwarded SSE 序列：严格字面锁 `expect(text).toBe(frames.slice(0,-1).join(""))`（参 `anthropic-v4.http.test.ts:252`）。设 keepalive ping=0 + grace=0（③ bypass）保字节确定。
- (ii) 上游 400（流式）现状行为：当前出 HTTP 400（pre-headers，参 `server-tool-rejection.http.test.ts:48-78` 的 `status:400` Response）+ 中途 RST（`createSseResponseThenError`）→ 记为**改动前基线**，③ 后 (ii)-pre-headers 仍 PRE-COMMIT 出 400、(ii)-mid-stream 变化范围由 C3b 验证。
- 连跑 10-25×（grace race 用 gate + 手搓 FakeClock，参 `streaming-l2-buffered.http.test.ts:317-461`，拦截 setTimeout/clearTimeout）。
- **不变量**：纯测试新增，src 零改动，系统不变。

### P3-naming — keepalive 一族重命名 + 默认降 45（foundational，先于 ③ 本体）
把 `stream_fake_sse_heartbeat`/`anthropicFakeSseHeartbeat` 全链改名为 `stream_keepalive_ping_sec`/`streamKeepalivePingSec` + 默认 0/120→**45**：
- `src/lib/config/schema.ts:280-292`（zod + docstring）
- `src/lib/state.ts`：字段声明 `:174`、`CONFIG_MANAGED_DEFAULTS` `:992`（0→45）、镜像 `:1074`/`:1181`、`setAnthropicBehavior` Pick `:797`
- `config.yaml:186-187`（注释重写 + `120`→`45`，说明"< CC 60s idle 才有效"）
- `src/lib/config/config.ts:470`（apply）、`:561`（warn 输入字段名）
- compat `src/lib/config/compat.ts`（`:186-207` anthropic 块加 renameLeaf）
- 消费点：`src/routes/messages/handler-v4.ts:616-617`、`src/routes/messages/web-search-handler.ts:164`、`src/routes/messages/web-search-direct.ts:394`
- 测试：`tests/config/config-hot-reload.it.test.ts:266-272`（configKey/stateKey 改名）+ 加 compat 迁移测试（旧键→新键 + warn-once + user-set 新键优先）
- **不变量**：纯改名 + 默认值变化；旧键经 compat 迁移；行为上 mid-stream 默认从"不 ping"变"45s ping"（**有意**，Q2 驱动）。既有 golden/测试显式设 ping=0 故不受影响。lint/type/`bun test tests/config tests/anthropic` 绿。

### C1 — pump sink 注入重构（normal 路径逐字节等价）
`pumpAnthropicStreamingV4`（`handler-v4.ts:547`）改为**接收注入的 `sink: ClientSink`**（而非自建 `:618-628`）。
- 所有权边界：sink 构造 + heartbeat config + `onForwarded`→`forwardedSseEvents` 数组归**调用方**（commit/normal callback）；`buffered` 路由决策 + `recordForwarded` 快照归 **pump**。
- 抽 `resolveBufferedAndHeartbeat(env): {buffered, heartbeatSec}`（DRY，复用 `:556-558`+`:616-617` 公式）+ 抽 `ANTHROPIC_PING` 字面量（`:624`）。
- 新 options：`{ sink, buffered, forwardedSseEvents, driver, upstream, env, clientAbortSignal }`（删 `:556-558`/`:607-628`/`:616-617`；保 `onUpstreamFrame`/accumulators/outcome 分支，均读注入 sink）。
- normal 调用点 `:383-393`：callback 内 `resolveBufferedAndHeartbeat` → 建 sink（同一 `streamStartMs` 穿进 sink + pump，保 forwarded `offsetMs` 不漂）→ 注入 pump。
- **不变量**：仅 sink 构造点搬家，normal 流逐字节等价（C3a-i 绿）。无 ③/race。

### C2/④ — COMMIT 分支 helpers（additive，dead-but-correct + 单测）
新增（先不接线，TS 穷尽 + 单测）：
- `toAnthropicSseErrorData(body, status, classified)`：`classified===false` 时把 `mapHttpErrorToEnvelope` 默认路径的 mis-shaped body（`{error:{message,type:"error"}}`，`forward.ts:313-315`）reshape 成合法 Anthropic SSE error data（`{type:"error", error:{type: status>=500?"api_error":"invalid_request_error", message}}`）；`classified===true` 透传。**不改** `mapHttpErrorToEnvelope`（它对 HTTP `c.json` 路径正确）。
- timeout/reaper/generic 富 error 帧 builder（非 HTTPError，手搓 canonical literal）。
- `dispatchPostCommit(...)` 覆盖 4(+1) 分支（见下「关键设计」）。
- **不变量**：纯新增，无 live caller（dead-but-correct），runtime 不变。

### C3b — ③ 本体（两段式 race + COMMIT dispatch + config + 可观测）
- 加 `stream_keepalive_grace_sec`/`streamKeepaliveGraceSec`（默认 40）：schema/state/config/Pick/hot-reload 矩阵行（同 P3-naming 改动锚点族）。**登记 `config-hot-reload.it.test.ts` 矩阵**（硬验证门，完整性守卫 `:828-834` 不登记即 fail）。
- 新 `FeatureKind`：`events.ts:113-140` 加 `"pre-stream-grace-commit"`/`"pre-stream-grace-resolved"`（kebab，对齐 `protect-streaming-retry`）；console renderer `console.ts` default 已透传、可选加 case。
- `handler-v4.ts:318-393` 两段式（见下「关键设计」），gate 在 `clientRaw.stream && streamKeepaliveGraceSec>0`；`grace<=0`/非流式**完全 bypass race**（退化现状）。
- **不变量**：gate 关闭时逐字节同现状（C3a-i）；开启时正常流逐字节等价、错误流变化范围精确（400 pre-headers 仍 PRE-COMMIT 出 400；只有 grace 后才到的错误降级富帧）。

### doc-sync（completion-includes-doc-sync）
RFC §5 C3a/C3b/§4.2.3.1 标 ✅；DESIGN.md 运行时选项表（改名 + 加 grace 两行）+ hot-reload 表（grace 参与热重载、不进需重启清单）+「活的架构现状」流式写出行补 grace-commit 分支；memory 回填（`project-pre-response-abort-rfc` 标 C3b ✅、`reference-claude-code-timeout-and-sse-error-oracle` 关联）。

## 关键设计（最易错处）

### 两段式生命周期（`handler-v4.ts:318-393`）
```
const p = driver.runRequest({...clientAbortSignal})         // 外置,一发即跑(含内部重试环)
if (!clientRaw.stream || state.streamKeepaliveGraceSec <= 0) { /* 现状 verbatim:try await p + 现有 catch :329-354 + dispatch :359-393(用注入 sink) */ }
const graceTimer = setTimeout(()=>res("grace"), grace*1000); graceTimer.unref?.()
const first = await Promise.race([p.then(()=>"upstream",()=>"upstream"), graceFired]); clearTimeout(graceTimer)
if (first==="upstream") { /* PRE-COMMIT: tie→upstream 优先; try await p + §3.2 catch(零发散 504/499) + !ok→reject + stream→streamSSE+pump */ }
else { /* COMMIT */ recordFeature("pre-stream-grace-commit",{graceSec,stalledAtLeastMs}); ctx.transition("streaming")
  return streamSSE(c, async (stream)=>{
    const pingSec = state.streamKeepalivePingSec>0 ? state.streamKeepalivePingSec : 30   // env-independent, <60
    const sink = makeSseSink(stream,{onForwarded,streamStartMs,heartbeat:{intervalSec:pingSec,pingFrame:ANTHROPIC_PING,clientAbortSignal}})
    stream.onAbort(()=>clientAbort.abort())          // 先注册再首 ping(round-B L1)
    await sink.write(ANTHROPIC_PING)                  // ★立即首 ping,用 write(采样)非 writeSynthetic
    try { await dispatchPostCommit(...) } finally { sink.close(); detachClientAbort() }
  })
}
```
硬点：`setTimeout`+`clearTimeout`（禁 `AbortSignal.timeout`）；`p.then(ok,err)` 永久消费 p 的 reject reaction（grace 赢不会 unhandledRejection，callback `await p` 是第二 reaction）；COMMIT 时 `env` 未就绪 → ping cadence **env-independent**（用 `streamKeepalivePingSec` floor 30）；`buffered` 仅在 (a) ok 分支 post-resolve 解（sink 已存在,**不重建**,single-sink）。

### COMMIT 状态机 4(+1) 分支判别（load-bearing）
POST-COMMIT `await p` 后区分（**signal state 判别,绝不用 error.name/classifyStreamError**——d/e/f 三者 name 都是 "AbortError",pre-response reaper 抛的是**普通 AbortError 非 StreamReaperCancelError**,后者只在 `guardSseIterable` stream-drain 合成,`stream.ts:322`):
- **(a) ok** → 同一 sink 交 pump（`resolveBufferedAndHeartbeat(env)` 取 buffered；`recordFeature("pre-stream-grace-resolved",{totalStalledMs})`）。
- **(b) `result.ok===false`**（decideRoute reject，**C2：resolve 非 throw,try/catch 接不住,须显式判**）→ 合成 `new HTTPError(reason,status,reason)` → `ctx.fail` + `toAnthropicSseErrorData` 富帧 `writeSynthetic`。
- **(c) throw HTTPError**（上游 4xx/5xx，主发散）→ `ctx.fail` + `mapHttpErrorToEnvelope(error,"anthropic").body`（classified 透传保 error.type/retry_after）经 `toAnthropicSseErrorData` `writeSynthetic`。
- **(d) throw timeout**（AbortError 且 `clientAbort.signal.aborted===false` 且 `ctx.lifecycleSignal.aborted===false`）→ `ctx.fail` + 富帧。
- **(e) throw client-abort**（`clientAbort.signal.aborted`,**判别优先级第一**）→ `ctx.abort()` 无字节（已 200,无 499）。
- **(f) throw reaper-cancel**（`ctx.lifecycleSignal.aborted` 且非 clientAbort）→ `ctx.fail`（reaper 自身已 `ctx.fail`,既有 `settled` flag 同步去重,**无需新 guard**,`request.ts:460/508`）+ 富帧。
- 判别顺序：`isAbortError` → `clientAbort.signal.aborted`(e) → `ctx.lifecycleSignal.aborted`(f) → else timeout(d)；非 abort → HTTPError(c) / generic。
- 富帧用 `writeSynthetic`（不采样,镜像 H3,保 H2-采样/H3-不采样不对称,B0-c golden 锁）。
- `if(ctx)` 守卫（client-abort 早于 parse 时 ctx undefined）。

### 顶级风险（实现期盯）
1. 双 makeSseSink 字节交错 → C1 是硬前置,grep 验 `makeSseSink` 仅在 callback 站点。
2. reaper/client/timeout 三 AbortError 误判 → 必用 signal state 优先级,三者各 mock 测。
3. 首 ping 时机 → heartbeat 首 tick 排在整 interval 后（`client-sink.ts:188`）,必须 commit 时手动 `sink.write` 首 ping 且先于 `await p`。
4. commit cadence 必 <60s（floor 30,不继承可能的大值）。
5. 中间件对 SSE 不 finalize → 每个 POST-COMMIT 分支必 settle ctx,无静默 return（否则 dangling entry + ctx 泄漏到 reaper 900s）。
6. graceTimer 泄漏 → clearTimeout + unref。

## Files

- `src/routes/messages/handler-v4.ts` — 两段式 race + COMMIT dispatch（`:318-393`）；pump sink 注入（`:515-521` options + `:556-628` 删自建）；`resolveBufferedAndHeartbeat`/`ANTHROPIC_PING`/`dispatchPostCommit`/`toAnthropicSseErrorData` + 帧 builders
- `src/lib/config/schema.ts`、`src/lib/state.ts`、`src/lib/config/config.ts`、`src/lib/config/compat.ts`、`config.yaml` — keepalive 改名 + grace 新增 + 默认 45
- `src/routes/messages/web-search-handler.ts`、`web-search-direct.ts` — 改名消费点
- `src/lib/observability/events.ts` — FeatureKind 加 2 值
- `src/lib/error/forward.ts` — 仅**读**（`mapHttpErrorToEnvelope`/默认 body 形状）；不改
- 测试：`tests/anthropic/`（C3a golden + ③ COMMIT 4 分支 http 测）、`tests/config/config-hot-reload.it.test.ts`（grace 行 + 改名 + compat 迁移测试）

## 验证

```
bun run typecheck
bun test tests/anthropic tests/streaming tests/pipeline tests/config
bunx eslint --fix <改动文件>            # 不用 prettier --write
```
- C3a 流式 fixture 连跑 10-25×（确定性,gate+FakeClock）。
- golden：normal 流逐字节等价；错误流变化范围精确（富帧保 error.type/retry_after）。
- COMMIT 4 分支各 http 测（mock fetch reject + 翻对应 signal,断终态 aborted/fail+帧）。
- config-hot-reload 矩阵登记 grace + 改名,完整性守卫绿；compat 迁移测试（旧键→新键 + warn）。
- **subagent 多轮对抗 review**（显式裁判轴：长远正确+完整,覆盖默认 ROI/YAGNI）,亲自复核引用 file:line。

## 不做（YAGNI / 范围）

- ③ **仅 Anthropic `/v1/messages`**（RFC §4.2 Q6；CC/Responses 无实测痛点,不推广）。
- `protect_streaming_heartbeat` **不改名**（留 L2 protect_streaming_* 族；它是 buffered 专用,不属 live keepalive）。
- 不改 `mapHttpErrorToEnvelope`（对 HTTP c.json 路径正确;③ 经 `toAnthropicSseErrorData` 适配默认路径形状）。
- 不引入 fake timers 框架（复用项目手搓 FakeClock）。
- POST-COMMIT 不对特定 error.type 拒绝 downgrade（已 200,物理回不了 HTTP status;唯一杠杆是 grace<60s 让可重试错误几乎都落 PRE-COMMIT,Q2 已裁决可接受）。

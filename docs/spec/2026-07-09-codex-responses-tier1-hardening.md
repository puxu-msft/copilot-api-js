# Spec：Codex / Responses 路径抬到 tier-1 健壮性基线

- 状态：草案 v2（已并入两轮对抗 subagent 审查 + 亲手代码核验；待用户复核）
- 日期：2026-07-09
- 归属：`docs/spec/`；配套 plan 落 `docs/plan/`，ADR（如需）落 `docs/decisions/`
- 相关：[upstream-stream-truncation-detection](./upstream-stream-truncation-detection.md)、[upstream-http2-transport](./upstream-http2-transport.md)、`docs/v4/03-spec/retry-transport.md`、ADR richest-data-flow、skill `debugging-server-crashes` / `bun-upstream-transport` / `claude-code-connection` / `ghc-api-reference` / `empirical-verification`
- 修订说明（v1→v2）：见 §10「审查并入与更正记录」——修正了根因触发点（before-first-event fallback 被击败，非 mid-stream idle-timeout）、R4 机制（采用 driver 的 buffered sink，而非新增策略）、R3 保活配置复用边界、R5 上游保活可行性约束、Phase 排序、以及 `ws.ts` 姊妹路径缺口。

## 1. 背景与动机（Why）

### 1.1 触发事件与实证根因（已亲手核验，非推断）

一条 gpt-5.5 的 **Codex CLI**（`/v1/responses`，openai-responses 格式，`state.upstreamWebSocket` 开启，模型 WS-capable）请求，流式 124s 后失败：`state = failed`、`attempt.error = "invalid code"`、0 tokens、`transport: http`。

**唯一自洽的触发链（经代码消去法 + undici 实测锁定）：**

1. 请求走上游 WebSocket 尝试。在**首个事件到达前**（长 reasoning 静默 / header 等待 / 握手超时等），`attemptUpstreamResponsesWs` 的 fallback 分支 `catch`（`src/lib/openai/upstream-ws-attempt.ts:184-196`）触发，本应 `manager.recordFallback()` 后 `connection.close()` 再 `return { kind: "fallback" }` 降级 HTTP。
2. 但 `connection.close()`（`upstream-ws-connection.ts:337-341`）内部调 `socket.close(CLOSE_CODE_GOING_AWAY /* =1001 */, "Going away")`。undici 的 WHATWG WebSocket `close()` 只允许 `1000` 或 `3000–4999`，对 `1001` 同步抛 `DOMException('invalid code','InvalidAccessError')`（`node_modules/undici/lib/web/websocket/util.js:288-295` `validateCloseCodeAndReason`；`websocket.js:202-222` `close()` → `closeWebSocketConnection(...,validate=true)`，`connection.js:227-235`）。
3. 该抛出**先占（pre-empt）了 `return { kind: "fallback" }`**——即**既有的 WS→HTTP 降级被这个 close 抛出击败**——异常经 awaited try/catch 向上传播，被记录为 `attempt.error="invalid code"`、`state=failed`。

**关键推论：**

- **这是 before-first-event 失败**，本应无缝降级 HTTP（很可能随后成功）。bug 让降级失效，把一次可恢复的传输波动变成了终态失败。
- **R1（关闭码 1001→1000）单独即可修复本触发事件**：`connection.close()` 不再抛 → `return { kind: "fallback" }` 执行 → HTTP 降级正常进行。
- 旧的 `ws` 包容忍 1001（RFC 6455 层面 1001 是合法**线路**关闭码）；迁到 undici 客户端 WebSocket 后，其 WHATWG API 层的禁令让 latent bug 暴露。
- 记录里 `transport: http` 反映的是失败发生在 WS 尝试的 fallback 边界（attempt 上报口径），与"WS 尝试→降级失败"一致。

> 证据可复现：`"invalid code"` 全仓源码无匹配，node_modules 内唯一来源即上述 undici 校验；用本项目 undici 实测 `close(1001)` → `InvalidAccessError: invalid code`，`close(1000)` 正常。

### 1.2 同族缺口：进程崩溃向量（真实但潜伏，与 §1.1 不同源）

§1.1 是**被捕获并记录**的失败（awaited catch）。另有一类**未捕获**的同族缺口会直接**崩溃整进程**——是不同的触发面，本触发事件**未**命中，但必须一并根治：

- `upstream-ws-connection.ts` 的 6 处 `close(1001)` 站点中，落在**裸 `setTimeout` / `addEventListener` 回调**里的那些（idle-timeout `:100-102`、`handleMessage` 的 parse-error catch `:146`、`handleError` `:160`、`handleClose`、`onOpenError` `:218`），其抛出无 awaiter → 冒泡成 `uncaughtException` → `main.ts:24-27` `process.on("uncaughtException") → process.exit(1)`（见 skill `debugging-server-crashes`：一条良性 lifecycle 事件放大成整进程崩溃，杀掉所有并发请求）。（子代理实测：Bun 下 EventTarget 监听器抛出确会逃逸为 `uncaughtException`。）
- 其中 idle-timeout（`:100`）在请求进行中被 `busy` 守卫（`:99` 当 `busy` 早退，`busy` 于 `:269` 请求期置真），故**不在活跃请求内触发**；它在**空闲池化连接**上（请求之间）会触发 → 那时 `close(1001)` 抛出即崩溃。故此向量对**空闲池连接**为真、对 §1.1 的在途请求为假——两者都要治。
- `handleMessage`/`handleError` 在 close 前已 `failRequest(...)` 写入**不同**的错误消息（"Upstream WebSocket error" / parse error），故它们即便触发也不会记成 "invalid code"（而是崩溃或记成别的错误）——这进一步印证 §1.1 的记录只可能来自 awaited 的 `:190`。

### 1.3 战略动机：Codex / Responses 成为 tier-1

Codex（Responses API）是本项目**一等公民**支持对象；`ws:responses` 上游 WebSocket 是一等公民传输，**保留并硬化**，不退役（§7）。上述缺口暴露 Responses / 上游-WS 路径的健壮性**未对齐** Anthropic 路径（后者已成熟：下游保活、崩溃防护、mid-stream buffered 重试、截断检测）。目标是把整条 Responses 路径抬到 Anthropic 同级 tier-1 基线，消除**同族**问题（`root-cause-over-patch` + `learn-by-analogy`），而非只修单个关闭码。

## 2. 目标与非目标

### 2.1 目标（What）

1. **WHATWG-WS 关闭码正确性（上游 + 下游姊妹路径）**：上游 WebSocket lifecycle 关闭永不用 WHATWG 禁用码；下游 WS-to-client（`ws.ts`）的 1011/1013 关闭码经**实测**核验其服务端运行时（Bun/Hono `WSContext`）是否抛出，据实修复。§1.1 触发场景端到端转绿（恢复 HTTP 降级）。
2. **崩溃防护**：任何上游-WS lifecycle 回调（EventTarget 监听器、定时器）内的抛出**不能**升级为 `uncaughtException` / `process.exit`。消除一类向量。
3. **下游客户端保活**：Responses 流式路径对 Codex 注入 Responses 专属保活帧，长 reasoning 静默期不触发 Codex 的 300s idle 超时；复用 Anthropic 保活的**节流间隔**（帧型不复用，见 R3）。下游 WS-to-client（`ws.ts`）路径一并纳入保活对齐（R3.5）。
4. **传输失败重试对齐（分两层）**：(pre) before-first-event 传输失败经 WS→HTTP 降级恢复（R1 解锁后即生效，核验有无残缺）；(mid) mid-stream 传输中断经**采用 driver 既有的 `runResponseBufferedSink`**（opt-in、门控）获得重试能力，对齐 Anthropic。
5. **上游保活 / 截断检测**：以**实测**确定上游-WS 是否可获等价保活（undici 客户端 WS 无应用层 ping API 是硬约束）；若不可行则 mid-stream buffered 重试成为 WS 的承重防线。截断检测在**实际使用的 sink 路径**上核验/落地。
6. **测试覆盖**：每条配回归测试，含 L1 守卫（本可拦下 close(1001) / 1011 / 1013 的契约测试）与 §1.1 的 before-first-event 黄金回归。

### 2.2 非目标 / 明确的范围边界（更正 v1）

- **不搬 Anthropic 专属的重试策略**（thinking / betas / tool-field / effort-learning 等 `src/lib/request/strategies/` 里格式绑定的）。R4 只涉及**格式无关的传输层重试**。
- **但要采用格式无关的 driver primitive `runResponseBufferedSink`**——v1 曾把它误列为"Anthropic-专属、记未来可选"，这是**错误**：它是 driver 层已参数化的共享原语（`sawMessageStop`/`anchor` 均为 opts），Anthropic 只是其**第一个**消费者。为 Responses 采用它（作第二个消费者）**正是**本 spec 的 tier-1 parity 工作，不推迟。
- **不退役上游-WS**（§7）。
- **不做 Anthropic + Responses 传输的完整统一合流**（触及已稳定路径、风险高；driver 已是部分共享层）——记为未来可选，不在本 spec。
- 不改客户端 Codex（`refs/codex` 只读，作容忍契约 oracle）。

## 3. 需求详述（Requirements）

### R1 — WHATWG-WS 关闭码正确性（上游 + 下游姊妹路径）

- **R1.1** 抽取单一上游关闭原语 `closeUpstreamWs(socket, reason)`，内部用 `1000`（normal closure），替换 `upstream-ws-connection.ts` 全部 6 处 `close(1001)`。
- **R1.2** `closeUpstreamWs` 对 `close()` 自身任何同步抛出 try/catch + 记日志（纵深防御）。
- **R1.3** 合规扫描**两个** WS 文件：
  - 上游客户端 `upstream-ws-connection.ts`（undici WebSocket，严格）。
  - 下游服务端 `src/routes/responses/ws.ts`（Hono `WSContext` on Bun，`ws.close(1011)` `:144/:595`、`ws.close(1013)` `:496`）——**实测**该运行时对 1011/1013 是否抛出（服务端 1011/1013 于 RFC 6455 合法，Bun/Hono 很可能容忍）。**仅当实测证明会抛**才改；否则记录"服务端运行时容忍 1011/1013"的结论，不盲目改动语义正确的码。
- **R1.4** `send()` 已被 `readyState===OPEN` 守卫（无 bug），以测试固化该前置。
- **验收**：(a) mock undici WebSocket 触发每处上游 lifecycle 关闭，断言不抛 `DOMException`、以 1000 关闭；(b) §1.1 before-first-event 场景：注入首事件前失败，断言**当前**会抛 "invalid code" 且降级被击败、**修复后**降级到 HTTP；(c) `ws.ts` 1011/1013 的运行时行为有测试或实测结论记录。

### R2 — 上游-WS lifecycle 崩溃防护

- **R2.1** 所有上游-WS 回调（`handleMessage`/`handleError`/`handleClose`/`onOpen`/`onOpenError`/`onAbort`）与 idle `setTimeout` 内的抛出被吞并路由到日志 + 请求失败通道（`markUnusable()` + `failRequest`），**永不**逃逸为进程级异常。
- **R2.2** 新增面向 **EventTarget/同步回调**的崩溃防护原语，形如 `guardCallback(fn, onEscape)`（每回调 try/catch 工厂），逐 `addEventListener` 注册点 + 裸 `setTimeout` 应用。**不复用** `withErrorSink`——其唯一动作 `emitter.on("error", noop)` 依赖 node `EventEmitter`「error 无监听者即抛」语义；undici WS 是 WHATWG `EventTarget`（`upstream-ws-connection.ts:32` `WebSocketLike extends EventTarget`），无此语义，套上去是**虚假保护（no-op）**。`guardCallback` 与既有 `withErrorSink`/`withRejectionObserver` 是同族三原语（都在产生点消除崩溃），差异（无单一 chokepoint、须逐注册点应用）写进 doc。不 monkey-patch `addEventListener`。
- **R2.3** 与 R1 是**纵深防御两层**（非二选一）：R1.2 在 close 原语处封住那一行 `DOMException`（源头）；R2.2 是更宽的 per-callback 网（封住任何未预期抛出，如 `currentQueue.push` 抛）。类比 h2 握手的两层（`http2-client.ts:130-136`）。
- **验收**：fault-injection 让回调内抛出，断言进程不退出、错误记录、在途请求 fail 而非 crash（覆盖裸 setTimeout 与监听器两种逃逸形状）。

### R3 — Responses 下游客户端保活（Codex）

- **R3.1** Responses **SSE**（HTTP）流式路径注入保活帧。帧型经 `refs/codex` 核定（§4）：`event: <合成标记>` + `data: {"type":"response.<keepalive>"}`（合法 JSON、未知 `type`）。Codex 双重容忍（未知 type→`Ok(None)` 忽略；解析失败→`continue`），零客户端可见副作用，且重置其 idle 钟。对标准 OpenAI Responses SDK 消费者亦以"合法 JSON + 未知 type"为最稳（O4，plan 以标准 SDK 复核）。
- **R3.2** 保活帧打项目**合成标记**（ADR richest-data-flow：注入真实流的合成物必可辨识），history forwarded 轨记录、上游轨不含。复用既有 `makeSseSink` 的 heartbeat 机制（`client-sink.ts` 的 `pingFrame` provider + `synthetic:"keepalive"` 标记）——加法式复用既有 hook。
- **R3.3**（更正 v1）**只复用间隔，不复用 mode**：间隔用 `streamKeepalivePingSec`（默认 20s ≪ 300s）；但 `streamKeepaliveMode`（`"ping"|"content_delta"|"empty_text"`，`state.ts:283`）是 **Anthropic 帧型**枚举（非-`ping` 值发 Anthropic `content_block_delta` 帧），语义上不能用于 Responses 流。Responses 需**独立的帧型/mode**（Responses-shaped）。plan 定：是复用 `streamKeepalivePingSec` + 固定 Responses 帧，还是引入 Responses 专属 keepalive 配置键。
- **R3.4** 保活覆盖"上游响应头前静默"与"上游响应中 reasoning 静默"两段（对齐 skill `claude-code-connection` 的两层 idle 认知）。
- **R3.5**（新增，**纳入范围** — 用户已确认）**下游 WS-to-client（`ws.ts`）保活对齐**：`ws.ts:290` 现"no heartbeat for WS"。为其补保活 parity。注意：浏览器/标准 WS 有协议级 ping/pong（运行时可自保活），故此路径的保活形态可与 SSE 不同——plan 阶段核定应发**应用层保活帧**（对齐 SSE 语义）还是依赖/主动发**协议级 WS ping**，以真正 keep-alive 为准（避免只是"看起来有保活"）。姊妹路径不静默略过（`against-yagni`）。
- **验收**：模拟上游长静默（>20s，<300s），断言下游按间隔收到带标记保活帧、且以 `refs/codex` 容忍契约为 oracle（合法 JSON + 未知 type 不报错、重置 idle）。

### R4 — Responses 传输失败重试对齐（拆两层）

- **R4.1（更正 v1 的错误事实）** 当前 Responses **流式走非缓冲的 `runResponseSink`**（`handler-v4.ts:306`、`ws.ts:331`），它**无重试循环**：任何非 abort 抛出直接 `return {kind:"stream-error"}`（`driver.ts:497`）。重试策略只在 `runExchange`（流开始前，`driver.ts:265/300`）生效。**Responses 并未接 L2 buffered**（v1 称其"已接 S4+L2"为**错**）——只有 Anthropic 接 `runResponseBufferedSink`（`messages/handler-v4.ts:1050`）。故：
  - **R4-pre（before-first-event）**：既有 WS→HTTP 降级（`upstream-ws-attempt.ts:184-196`）+ S4 策略覆盖此段；R1 解锁降级后，核验是否仍有未覆盖的 pre-stream 传输失败需补格式无关 S4 策略。§1.1 属此层，R1 即修复。
  - **R4-mid（mid-stream，post-first-frame）**：唯一无重复投递的机制是 driver 的 **`runResponseBufferedSink`**（`driver.ts:695-716`：仅对 transport-close 或截断重试，all-or-nothing）。Responses **采用**它（opt-in，见下），获得 mid-stream 重试。
- **R4.2 采用 buffered sink 的接线**（driver 签名不变，全走 opts）：`sawMessageStop: () => acc.status !== ""`（Responses 终止符 `response.completed/.incomplete/.failed` 均 set `acc.status`，复用 `handler-v4.ts:359` 既有判据）；`anchor: undefined`（anchor 是 Anthropic empty_text 专属，driver 各 anchor 分支在 undefined 时 inert）；`retryCap`/`bufferCapBytes` 需 Responses 侧对等 config（对齐 `state.protectStreaming*`）。
- **R4.3 两条承重约束（必须显式）**：
  - **(a) R4-mid 依赖 R3 保活**：buffered 模式 commit 前不投递真实帧，长 reasoning 静默会自触发 Codex 300s idle。故 **buffering ⇒ 强制启用 R3 保活**（对齐 Anthropic `resolveBufferedAndHeartbeat` 的 `buffered?forcedHeartbeatSec`，`messages/handler-v4.ts:905-912`）。
  - **(b) buffered 必须 opt-in（用户已确认：Codex 默认不做 mid-stream auto-retry）**：默认走 live `runResponseSink`（mid-stream 掉线→fail + 保留 partial + 截断 error frame，即今 `handler-v4.ts:359-369` 行为不变）。切 buffered 改客户端可见时序（帧末尾 burst、失去真流式 UX），故设为**可配置启用**的保护开关（门控如 `state.protectStreaming`）。**mid-stream 重试仅在 opt-in buffered 模式可达**——此 tradeoff 写进验收，消除 v1「live 模式先重试又保留 partial」的自相矛盾。
- **R4.4** 新增传输策略前 grep 同错误子串既有 matcher，避免被更宽的先命中遮蔽（记忆 `new-strategy-shadowed-by-broader-first-match`）。
- **验收**：mid-stream 上游-WS drop（buffered 模式）触发重试（attempts>1）、成功路径最终成功、彻底失败保留语义；live 模式 drop 保持 fail+partial；before-first-event 失败降级 HTTP。

### R5 — 上游保活 / 截断检测

- **R5.1（实测优先，硬约束前置）** 上游-WS **双缺**已确认（grep `upstream-ws-*.ts` 无任何 ping/keepalive 机制；唯一 idle 计时器是**关闭**空闲池连接，保活的反面）。h2 路径有两层（TCP `setKeepAlive` + 应用层 `scheduleH2KeepalivePing`，`http2-client.ts:98/108/189`）；GHC 对 WS 的收割理由与 h2 同构（长静默=真 idle 流被 middlebox/GHC edge 收割）。但 WHATWG WebSocket API 双重设障：无底层 socket 访问（不能像 h2 那样 `setKeepAlive`）、**无 `ping()` 方法**。故 R5.1 是 **PoC**：(a) undici WS upgrade socket 能否开 TCP keepalive（`ss` 验 `timer:(keepalive,...)`，复刻 h2 手法）；(b) GHC 是否转发/容忍带外 WS 帧。**预置结论分支**：若两层皆不可行，则 WS 路径**无法预防收割、只能恢复** → R4-mid（buffered 重试）成为 WS 的**承重防线**（对 WS 比对 h2 更关键，优先级反转）。
- **R5.2（折入 Phase 3）** 截断检测（clean drain 而无终止符 → 重试/失败，不冒充成功）：非缓冲 `runResponseSink` 在任何 clean drain 返回 `complete`（`driver.ts:490`），靠 handler 累加器 + `stopAfterFrame` 察觉缺失的 `response.completed`。须在**实际路径**（`runResponseSink` + handler 判据）核验，别假定与 buffered driver 逻辑 parity。buffered 的 commit/retry gate（`sawMessageStop` vs clean-drain-without-terminal）**就是**截断检测器——故 R5.2 是 R4-mid 的判据、属 **Phase 3**，非 Phase 4。
- **R5.3（独立项）** R3 的**下游**保活（Codex↔proxy）**不重置**我方**上游** idle guard（proxy↔GHC，`guardSseIterable` + `raceIteratorNext` 计帧间静默）。故一次 >`state.streamIdleTimeout` 的合法长 reasoning 静默会被我方上游 guard 杀掉（h2/WS 皆然；h2 PING 保 TCP 但不产帧、不重置帧间 idle）。须独立核 `state.streamIdleTimeout` 相对最长预期 reasoning 静默的余量。

### R6 — 测试覆盖与守卫

- **R6.1** 每条 R1–R5 配回归测试。
- **R6.2** L1 契约守卫：断言上游 WS 关闭永不传 WHATWG 禁用码（本可拦下 close(1001)）；`ws.ts` 关闭码运行时行为固化。
- **R6.3** §1.1 黄金回归：端到端复现 before-first-event WS 失败，断言修复前抛 "invalid code" 且降级被击败、修复后降级 HTTP 并优雅完成。
- **R6.4** 爆炸半径 tripwire：Anthropic 既有 golden 回归（buffered / keepalive / anchor 测试）保持绿，证明 Responses 采用 buffered sink 未波及稳定的 Anthropic 路径。

## 4. Codex 容忍契约（核定依据，来自 `refs/codex` 只读）

权威源：`refs/codex/codex-rs/codex-api/src/sse/responses.rs::process_sse_with_treatment`、`codex-rs/model-provider-info/src/lib.rs`。子代理已独立复核。

- **idle 超时**：`DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`（300s），可经 provider `stream_idle_timeout_ms` 覆盖。`timeout(idle_timeout, stream.next())`（`responses.rs:504`）：**每个 emit 的 SSE 事件**重置该钟；超时 → `ApiError::Stream("idle timeout waiting for SSE")`（`:522-527`）。
- **双重容忍**：`data:` JSON 反序列化失败 → `debug!`+`continue`（`:532-537`，不失败流）；反序列化成功但 `kind`/`type` 未知 → `process_responses_event` 的 `_ => Ok(None)`（`:466-471`，no-op）。两条都在 `stream.next()` yield 之后，**均已重置 idle 钟**。
- **结论**：保活帧只需带非空 `data:` 的合法 JSON（未知 `type` 最稳），即重置 Codex idle 钟且零副作用，对 GHC/OpenAI 未来 schema 变更免疫。

> Codex 自身有 Codex→上游 的 WS 与 HTTP fallback，但本项目对 Codex 下游主用 SSE-over-HTTP（根因记录 `transport: http`）；下游 WS-to-client（`ws.ts`）的范围见 R3.5。

## 5. 影响面（受影响组件）

| 组件 | 变更性质 | 需求 |
|---|---|---|
| `src/lib/openai/upstream-ws-connection.ts` | 关闭原语、崩溃防护 | R1, R2 |
| `src/routes/responses/ws.ts` | 下游关闭码实测核验；R3.5 保活范围判定 | R1.3, R3.5 |
| `src/lib/openai/upstream-ws.ts` / `upstream-ws-attempt.ts` | 回调防护、fallback 边界、上游保活 PoC | R2, R4-pre, R5.1 |
| `src/lib/transport/crash-safety.ts` | **新增** `guardCallback`（EventTarget 形态，纯加法，不碰既有原语） | R2.2 |
| `src/routes/responses/handler-v4.ts` | 下游保活注入；buffered sink 采用（opt-in） | R3, R4-mid |
| `src/lib/pipeline/driver.ts` | **仅新增 caller、不改签名/行为**（Responses 作 `runResponseBufferedSink` 第二消费者）；`:114` 陈旧注释 doc-sync | R4-mid |
| `src/lib/pipeline/client-sink.ts` | 复用既有 heartbeat hook 注入 Responses 帧 | R3 |
| `src/lib/codec/openai-responses/strategies.ts` | 核验/补格式无关 pre-stream 策略 | R4-pre |
| `src/lib/state.ts` / config | 复用 `streamKeepalivePingSec`；Responses buffered 的 `protectStreaming*` 对等键（新增，对齐命名） | R3.3, R4.2 |
| 测试（后端 `*.test.ts`，含 mock undici WS + Anthropic golden tripwire） | 回归 + 守卫 | R6 |

## 6. 阶段划分（交付顺序）

1. **Phase 0 — WHATWG-WS 关闭码正确性**（R1）：上游关闭原语 + 6 处替换 + 下游 `ws.ts` 实测核验 + §1.1 黄金回归。**直接止血、独立可交付**。
2. **Phase 1 — 崩溃防护**（R2）：`guardCallback` 原语 + 逐回调/定时器应用，消除进程崩溃向量。依赖 R1 的 `closeUpstreamWs`。
3. **Phase 2 — 下游保活**（R3）：Codex 保活帧注入（帧型/间隔由 §4 钉死；帧型 Responses 专属）。
4. **Phase 3 — 传输重试对齐 + 截断检测**（R4 + R5.2）：R4-pre 核验、R4-mid 采用 `runResponseBufferedSink`（opt-in，依赖 Phase 2 保活）、R5.2 截断 gate。
5. **Phase 4 — 上游保活 PoC + idle 余量**（R5.1 + R5.3）：WS 保活可行性 PoC（结论驱动是否落地 / 是否 R4 承重）、`streamIdleTimeout` 余量核验。
6. **Phase 5 — 测试收口**（R6）：贯穿各阶段，最后统一 L1 守卫 + 黄金回归 + Anthropic tripwire 收口。

每阶段：`typecheck` + `lint:all` + 针对性 `bun test` 绿灯 → 逐语义单元 pathspec 提交（`no-auto-server`，不启服务器）。

## 7. 未采纳备选（record-not-adopted）

- **退役 Responses 上游 WS、改 HTTP-only**：违背 `root-cause-over-patch` + `against-yagni`；用户已明确 `ws:responses` 为一等公民。**不采纳**。
- **抽取统一健壮流式 transport（Anthropic + Responses 完整合流）**：触及稳定 Anthropic 路径、风险高；driver 已部分共享。**记未来可选**。注意区别：采用 `runResponseBufferedSink`（把既有共享原语扩到第二消费者）**在本 spec 内做**；完整合流才推迟。
- **周期性 liveness 调度器提取为共享 util**（`scheduleH2KeepalivePing` 形状 → h2 + WS 复用）：**gate 在 R5.1 PoC 结论**——若 WS 保活不可行则无 WS 调度器可提，提取无意义。条件性推迟。
- **R4-mid 用「新增 Responses 专属传输重试策略」实现**：经核验**不可行**（`runResponseSink` 无重试循环、策略只在流前生效、live 直写无法重试而不重复投递）。**不采纳**，改用 buffered sink 采用。

## 8. 风险与开放问题（留 plan / architect）

- **O1** `guardCallback` 的确切签名与 `onEscape` 路由（fail 哪个请求的 per-callback 上下文）。
- **O2** R4-mid 的 buffered 门控配置形态（复用/对等 `protectStreaming*`）与 live 默认的边界。
- **O3** R5.1 PoC 两问（TCP keepalive 可否 + GHC 容忍带外帧否）——结论以实测为准，预置"不可行则 R4 承重"。
- **O4** 保活帧对非-Codex 标准 OpenAI Responses SDK 消费者的兼容（§4 选择对其亦最稳，plan 以标准 SDK 复核）。
- **O5** R3.5 下游 WS-to-client 保活的**实现形态**（应用层保活帧 vs 协议级 WS ping）——范围已定为纳入，形态留 plan（以真正 keep-alive 为准）。
- **O6** `ws.ts` 1011/1013 的运行时实测结论（改 vs 记录容忍）。

> **待探究点动态捕获（用户约定）**：实施过程中若发现可作为下一步方向 / 扩展的探究点（非本 spec 范围但有长期价值），**一并落文档**——归入 `docs/todo/deferred-backlog.md`（含根因 / 当前行为 / 理想架构 / 为何暂缓 / 若做需改什么），并在此 §8 追加 O 编号指针。不静默丢弃潜在需求（`defer-potential-demand-over-cut-it`）。已知候选见 §7 的条件性提取项（liveness 调度器共享化、完整传输合流）。

## 9. 验收总览（Definition of Done）

- §1.1 before-first-event 场景端到端复现并转绿（修复后降级 HTTP、不再 "invalid code"）。
- R1–R6 各验收项通过，测试纳入套件；Anthropic golden 回归保持绿（爆炸半径 tripwire）。
- 进程崩溃向量以 fault-injection 证明消除（裸 setTimeout + 监听器两形状）。
- 长静默场景 Codex 不触发 300s idle；`streamIdleTimeout` 余量有结论。
- mid-stream 上游-WS drop 在 opt-in buffered 模式触发重试；live 模式保 fail+partial。
- 上游-WS 保活可行性有实测结论（可行则落地 / 不可行则 R4 承重且记录）。
- 文档同步：`docs/DESIGN.md`「活的架构现状」更新 Responses 路径（含 buffered 采用、保活、关闭码）；`driver.ts:114` 陈旧注释更正；未采纳/推迟项入 `docs/todo/deferred-backlog.md`。

## 10. 审查并入与更正记录（v1→v2）

两轮对抗 subagent 审查（通用对抗 reviewer + architect），客观事实经**亲手代码核验**后并入；判断结论按项目裁判轴（长远正确 + 完整，非 ROI/YAGNI）取舍。

**已采纳（更正 spec）：**
- **[CRITICAL] R4 机制更正**：Responses 未接 L2 buffered（v1 事实错误）；`runResponseSink` 无重试循环、策略只在流前生效、live 直写无法 mid-stream 重试。R4 改为 R4-pre（降级/S4）+ R4-mid（采用 `runResponseBufferedSink`，opt-in，依赖 R3 保活）。§2.2 相应更正（buffered sink 是共享 primitive、本 spec 内采用；仅完整合流与 Anthropic 专属策略推迟）。
- **[HIGH] §1.1 根因更正**：非 mid-stream idle-timeout（idle 计时器 busy-guarded、且裸 setTimeout 抛出会崩溃而非记录）；实为 before-first-event 的 `connection.close()`（`upstream-ws-attempt.ts:190`）抛出**击败 HTTP 降级**、被 awaited catch 记录。**R1 单独修复本触发事件**；崩溃向量（§1.2）为潜伏的空闲池连接问题，另治。
- **[HIGH] R1 姊妹路径**：`ws.ts` 下游 1011/1013 同属禁用类，纳入 R1.3 合规扫描（服务端运行时实测，据实修）。
- **[MEDIUM] R3.3 更正**：`streamKeepaliveMode` 是 Anthropic 帧型枚举，不可复用于 Responses；只复用间隔，帧型 Responses 专属。
- **[MEDIUM] R3.5 新增**：下游 WS-to-client 保活的显式范围判定 + 理由。
- **[MEDIUM] R5.1 强化**：上游-WS 无应用层 ping 是硬约束，PoC 前置 + "不可行则 R4 承重"分支。
- **[LOW] R5.2**：在实际 `runResponseSink` 路径核验截断，折入 Phase 3（buffered 的 commit gate）。
- **[LOW] driver.ts:114 陈旧注释** doc-sync。
- **O1（架构）** `guardCallback` 原语形态；**O2（架构）** buffered/live 分层三层（intra-send fallback / S4 / L2）；**Phase 排序** R5.2→Phase 3。

**判断取舍：** 两 reviewer 均倾向"buffered 采用"而非"新增策略"，与 architect 的"扩既有共享原语到第二消费者"一致，且经代码核验证实——采纳。无 reviewer 建议缩小范围（符合项目裁判轴）；R4 保持在范围内（作 buffered 采用），未因"本触发事件是 before-first-event"而砍 mid-stream parity（用户要求全 tier-1 对齐）。

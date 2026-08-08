---
name: debugging-claude-client-connection
description: 当调试 copilot-api-js 与 Claude Code CLI 客户端之间的连接/流式行为时使用——CC 请求超时三层（响应头到达前只有 undici 默认 headersTimeout ~300s、可被客户端 API_FORCE_IDLE_TIMEOUT=0 关掉；头到达后 60s byte-idle 任意字节/ping 重置 + 300s event-idle 任何非-ping 事件都重置，长 pre-content thinking 静默撞它断连）、keepalive 默认发裸 ping、只在 escalate 阈值到点才升级为匹配当前 open block 的空 content-delta、合成帧必须打 synthetic 标记 + 必带 event: 行（否则 @anthropic-ai/sdk SSEDecoder 静默丢帧）、SDK 对 200+SSE-error 走裸 APIError 零重试；以及事后判别一条 `[FAIL] … The operation was aborted.`/断流 incident 的中止方（2026-07-28 起 abort 自带 provenance：先读 `err.name==="TimeoutError"`/`pool-closed` tag/`isShutdownCausedAbort`/`getCancellationCause`，History `state`(failed≠aborted)/上游 0 帧 status null/durationMs 只作 fallback，附 offsetMs commit-relative 时间基陷阱）。下游客户端行为，区别于上游传输（skill debugging-ghc-api-upstream-transport）与上游 Anthropic wire（skill ghc-anthropic-upstream）。
---

# Claude Code 客户端连接与流式行为

排查「CC 为何断流/重试/丢帧」。对象是**下游客户端**（Claude Code CLI + 其封装的 `@anthropic-ai/sdk`）如何连接我方代理、如何超时/重试、如何解析我方（可能合成的）帧。与上游传输（skill `debugging-ghc-api-upstream-transport`）、上游 Anthropic wire 异常（skill `ghc-anthropic-upstream`）正交。

## 探针方法（真实 CC 作独立 oracle）

真实客户端作独立 oracle（[[feedback-pass-null-clean-not-self-validating]]）+ 受控 mock 上游 + prod-faithful 接线（harness `exp/q2-oracle/`、`exp/cc-idle-280s/`）。驱动 headless CC 打到自定义 mock：`claude -p ... --settings <json>`（命令行优先级盖过 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL`）+ `--strict-mcp-config`；`--output-format json` 出 `is_error`/`result`/`duration_ms`。SDK 层裁决用 `@anthropic-ai/sdk`（CC 同款）消费受控 mock 流。通用方法论见 skill `empirical-verification` 的「客户端 SDK oracle」节。

## 请求超时：三层（一层 pre-header + 两层 post-header idle）

> **2026-07-28 订正**：本节原写「两层」且称 CC「关掉了 SDK 的 600s 总超时」。**都不准确**。600s 那个 client-level timer 确实存在（2.1.220 实装亦是 `API_TIMEOUT_MS || 6e5`），但它**从来没机会触发**——响应头到达之前，更低一层的 undici 默认 `headersTimeout` 在 ~300s 就掐断了。下面第 0 层是本轮新增的。

- **第 0 层 pre-header ≈ 300s（响应头到达之前）**：我方 delayed-commit 期间一个字节都不发，此时**只有这一层在跑**（下面两层要等响应头到达才武装）。实测真 CC 2.1.220 四次尝试落在 299.667–300.280s；裸 `fetch`（剥掉 SDK 与 CC）同样在 ~300.9s 抛 `UND_ERR_HEADERS_TIMEOUT`；裸 TCP socket 打同一 handler 420.1s 未被关（排除服务端）。**归属 undici 默认 `headersTimeout`，不是 Anthropic 层**——CC 自称的 `x-stainless-timeout: 1200` 与 SDK 显式 `timeout` 都够不着它。撞上后 CC **原生重试**（观测 4 个完整周期，backoff ≈0.55/1.05/2.16/4.06s；最大次数未测）。
  - **可被客户端侧关掉**：`API_FORCE_IDLE_TIMEOUT=0` 走到 `fetchOptions.timeout = false`，一次性关掉 undici 的 headers+body 两个超时——实测静默 600s 仍单次尝试干净成功。**这是客户端环境变量，代理设不了**；我方 `stream_commit_after_sec` 的默认/上限一律按「客户端没设它」来定。
  - **作用域**：这是**某个 runtime 的默认值**（本机 CC 2.1.220 + 其内置 Node v26.3.0），可被 dispatcher 覆盖、随版本变，**不是协议常量**——换客户端/runtime 版本要重测。
  - 证据与全部对照臂：`exp/silence-recovery-gates/FINDINGS.md` §「Q1 续测」/§「Q1 附测」+ `results/q1-firstfail/`。

响应头到达之后，改由 **两层 idle watchdog** 管（实测 2.1.185 + 2.1.201）：

- **第一层 byte-idle ≈ 60s**：每收**任意字节/帧**重置 deadline，无字节 60s → abort + **自动重试**（≥6× 60s-spaced）。`event: ping`（连 message_start 之前也算字节）重置它 → keepalive 只需 ping 间隔 < 60s；**heartbeat ≥ 60s（如 120s）无效**。first-party 与 prod-faithful 两路径一致（8 样本全 60.0–60.2s）。
- **第二层 event-idle ≈ 300s**（**2026-07-28 订正：原写「no-real-content、只有真实 `content_block_delta` 能重置」，不准确**）：真实判据是「**任何 `data.type !== "ping"` 的 SSE 事件都重置**」——`content_block_start` / `content_block_stop` / `message_delta` **全都算**，不必是 content delta（源码读证：CC 消费循环对 ping `continue`、其余一律调 `he()` 重新武装；`~/.claude/refs/claude-code-2.1.207/app.pretty.js:298198-298204`）。一定时间内没有任何可重置事件则断，报 `API Error: Stream idle timeout - no chunks received`（字面精确：no real content chunks）。**`event: ping` 与 SSE comment 都不算 chunk**——纯 ping 压住 60s 层却撞 300s 层断（复现用户 incident）。长 opus pre-content thinking 静默数百秒撞第二层。first-party 与 prod-faithful 一致（`duration_ms=300169/300187`），**不能从 60s 层跨层外推、须独立复测**。
- **空 `content_block_delta` 算 chunk**：`thinking_delta{thinking:""}` / `text_delta{text:""}` / `input_json_delta{partial_json:""}` 三种空 delta 全部实测保活到 340s 完整收尾（SDK 累积它们无害，SDK oracle 验）。
- 注：incident 报的 ~292s 单次断开**非**自动超时——是用户中断（孪生双请求同时断）或 headless 重试风暴（~5×60s）。

## 事后判别 `[FAIL] … The operation was aborted.`：client-abort vs reaper vs timeout

> **2026-07-28 大幅订正：先读错误身份，别再从 `durationMs` 猜。** 本节原来的前提——「三类中止都抛同一条字面量、归类只能靠信号状态」——已被修掉：`http2-client.ts` 的 `abortError()` 过去**丢弃 `signal.reason`**，现在原样透传；每个取消方也都带上了具名 reason。于是**中止方的身份现在直接写在错误对象上**：
>
> | 证据 | 含义 |
> |---|---|
> | `err.name === "TimeoutError"` | 响应头看门狗（`AbortSignal.timeout`）真的开火了——**只有这个**才配叫 header 超时 |
> | `getTransportErrorReason(err) === "pool-closed"` | 我方 h2 池被拆（关机 Step 4 / finalize） |
> | `isShutdownCausedAbort(err)` | 关机 Step 3 的具名 abort reason（对象身份比对） |
> | `getCancellationCause(err)` = `stale-reaper` / `request-deadline` / `request-cancel` / `dispatch-cancel` | 逐个取消方自报家门 |
> | 以上全无 | 一条**没人打标签**的 abort——这本身就是线索（哪条路径没接上 provenance） |
>
> 相应地，客户端拿到的东西也不再撒谎：pre-commit 走有序 precedence（499 client / 529 shutdown / 504 TimeoutError / 504 request-deadline / 503 其余并附真实 reason 原文），post-commit 的 `classifyPostCommitAbort(clientAborted, reaperAborted, error)` 也吃错误对象，`PostCommitAbortKind` 扩到八种、每种自己的终端 frame 文案——**没有证据时给 `unknown-abort` 而不是默认宣称 header 超时**（看到 `unknown-abort` 本身就是线索：某条路径还没接上 provenance）。
>
> **post-header（流式 body）同样已接通**：`guardSseIterable` 过去对 `ctx.lifecycleSignal` 一律抛 `StreamReaperCancelError`，于是 mid-stream 的 `request_deadline` 在**所有**流式端点上都被说成 stale reaper；现在按 reason 上的 cause tag 分派到 `StreamRequestDeadlineError` / `StreamRequestCancelError` / `StreamDispatchCancelError` / `StreamUnknownCancelError`。Responses 上游 WS 侧则把握手/请求取消改成**保留该层 message + 把 reason 挂 `cause`**（两个 provenance 读取器都走 cause 链），first-event 看门狗直接透传 `TimeoutError`。
>
> **无 tag 的 lifecycle abort 现在是 `unknown-cancel`，不再冒充 reaper**——每个 producer 都打 tag 之后，untagged 只意味着某条路径漏了契约。**在野看到 `unknown-cancel`/`unknown-abort` 就去补那条 producer 的 tag**，别当噪声。
>
> **改 kind → wire 的映射时，改的是这四张共享表，不是 codec 私有副本**（2026-07-28 第三轮：codec 的 `formatError` 无生产调用者，四份表全填而 wire 照旧输出旧值）：

| 表 | 位置 |
|---|---|
| 帧文案 | `packages/foundation/src/stream.ts:STREAM_ERROR_KIND_MESSAGES` |
| Anthropic `error.type` | `src/lib/anthropic/error-shaping.ts:ANTHROPIC_STREAM_ERROR_TYPE` |
| Gemini `{code,status}` | `src/lib/gemini/stream-error.ts`（code 由 status 经规范 gRPC↔HTTP 表推导，不独立硬编码） |
| OpenAI `error.type` | `src/lib/openai/stream-error.ts:OPENAI_STREAM_ERROR_TYPE` |

> 分组判据三协议一致：**我方跑完的时钟**（idle 看门狗 / hard deadline / reaper——`stale_request_max_age` 到期本质是 deadline）都报 timeout；`shutdown` 是唯一「立刻重试」；取消类在有字面量的协议用它（Gemini `CANCELLED`）、没有的诚实退化到通用桶。验收要从真实入口驱动读客户端字节（`tests/streaming/stream-error-wire-provenance.http.test.ts`），把 kind 喂给 formatter 的测试证明不了活路径在读表。
>
> **下面的 History 逐字段表退为 fallback**（错误对象拿不到、或看的是修复前的旧记录时用）。
>
> 促成本次修正的反例：History `req_1785234916721_3573` —— 一条 **609ms** 的请求被报成 `504 Upstream timed out before sending response headers`，而当时 `response_header` 配的是 **900s**。真凶是关机 Step 1 拆 h2 池（详见 [docs/lifecycle.md](../../../docs/lifecycle.md) Step 1 注）。**看到 duration 与所声称的超时值对不上，就别再往超时上套。**

一条 `[FAIL] POST /v1/messages … 301.0s ↑1.7MB ↑0 ↓0: The operation was aborted.` 的中止方，**不能凭错误串猜**——（修复前）三类中止（下游客户端断开 / stale-request reaper / 上游 header-wait 超时）在 h2 路径上**都**抛字面量 `"The operation was aborted."`（[http2-client.ts](../../../src/lib/transport/http2-client.ts) `raceAbort` 的 `abortError()`，`name:"AbortError"`），归类只能由**信号状态**决定。

**错误对象不在手上时，裁决走 History**（4141 `GET /history/api/entries/:id`，独立 oracle；日志串本身信息不足）。逐字段判：

| 字段 | client-abort | reaper-cancel | header-timeout |
|---|---|---|---|
| `state`（**首要判据**） | `aborted` | `failed` | `failed` |
| `attempts[].upstreamResponse.status` + `.sseEvents` | 可能已有帧 | 视时机 | **`null` + `[]`（0 帧）= 上游从未回响应头** |
| entry-relative `durationMs` | 任意（客户端何时走） | ≈ 该实例**生效的** `staleRequestMaxAge` | ≈ 该实例**生效的** `responseHeaderTimeout`/`streamIdleTimeout` |
| 下游终端 error 帧文案 | 无（客户端已走，零字节） | `Request cancelled by the stale-request reaper` | `Upstream timed out before sending response headers` |

> **⚠ `durationMs` 那一行没有可写死的数字——归因前先取该实例生效的配置。** 本 skill **不记**当前 bundled 默认值：这些键既有 bundled 标量、又有 `response_header_overrides`/`stream_idle_overrides` 两张 per-model 表，还随配置世代变；写进 skill 的任何具体秒数都会在下一次配置改动后变成陷阱。**判之前逐个取**：① 标量与 per-model override 的**生效值**（per-model 命中优先于标量，`0` = 该终止器禁用，此时这一行整个不适用）；② 该进程**实际持有**的值（配置热重载与进程启动世代可能不一致，声明值不等于运行态）；③ 事故发生时的配置世代（读旧记录时尤其重要）。
>
> **这三项各有各的取法，不许凭记忆填**：
>
> | 要取什么 | 从哪取 | 注意 |
> |---|---|---|
> | 进程此刻持有的生效值 | `GET /api/config`（`buildEffectiveConfig()`，挂载见 `src/routes/index.ts:78`，实现 `src/routes/config/route.ts`） | **不是读 `config.yaml`**，那只是声明值。实例已不在 → 只能走下面两行 |
> | 事故当时的 `stream_idle` | 该 entry 的 `pipelineInfo.streamIdleTimeoutMs`（`src/lib/history/types.ts:231`） | **只有这一个阈值真的落盘**。同一结构里的 `responseHeaderTimeoutMs`（`:233`）**当前没有生产写点**——六处 `setStreamTimeouts(...)` 生产调用全都只传 `streamIdleTimeoutMs`，只有单测写过它。所以 **header-timeout 事故没有结构化阈值字段可取** |
> | 事故当时的 `stale_request_max_age` / `request_deadline` | **没有结构化字段，但秒数嵌在终端 error 文案里**：`Request exceeded maximum age of <N>s (stale context reaper)` / `Request exceeded hard deadline of <N>s (request_deadline)`（产生点 `src/lib/context/manager.ts:329,440`），经 `ctx.fail` 保留、投影到 `_index.derived.failureReason`（`src/lib/history/v3/projection.ts:437`） | 只对这两条**具名 producer** 有效。文案没命中这两个模式 → 当作取不到 |
> | 上面都没有 | —— | **写「阈值归因未决」，停在这里。禁止由 duration 反推配置**——那正是本节要防的循环论证 |
>
> **机械判据**：这一行的归因要成立，必须能指出上表哪一格给了值。指不出来就是「未决」，不是「大概是默认值」。**尤其 header-timeout：它恰恰是最没有事故时证据的那一个**，别因为它的名字最像超时就默认套上去。

> **历史读数只在其自身世代内成立**：曾观测的 `300s`（代码 fallback 世代）、`600s`/`1200s`（2026-08-08 之前的 bundled 世代）都**不得**用来套当前 incident；2026-08-08 起 bundled 把这四个 wall-clock terminator 改为默认禁用、per-model 表清空，正值只在运维显式覆盖时出现并触发 bounded-wait 告警。看到 duration 与你以为的阈值对不上，先怀疑自己拿错了世代，再往别处查。

- `state:"failed"`（非 `aborted`）**当场排除 client-abort**：客户端断开走 `StreamClientAbortError` → driver `settled-abort` → state `aborted`；reaper/timeout 走 `ctx.fail` → `failed`。机制佐证 [forward.ts:557-571](../../../src/lib/error/forward.ts)（有序 precedence 的前两臂）——client-abort 会 abort `c.req.raw.signal`（→ 499），header-timeout 只 abort **fetch 信号**、留 `raw.signal` 未 abort，且必须自带 `name === "TimeoutError"` 才判 504。
- header-timeout 由 [fetch-utils.ts](../../../src/lib/fetch-utils.ts) 的 `AbortSignal.timeout(responseHeaderTimeout*1000)` 折进上游 fetch 信号触发（GHC 走 h2、不吃 undici Agent 的 `headersTimeout`，靠这个信号兜底）。**上游 0 帧 + status null + 时长≈该实例生效的 `responseHeaderTimeout` = 上游纯沉默、我方 header-wait 守卫开火**（既非客户端主动断、也非 GHC 主动报错/关流）。**该值为 `0` 时这条守卫根本不武装**，同样形态就得往别的中止方查。
- 巨型对话（`messageCount` 数百、`requestBytes` MB 级）+ 全程 `clientResponse.sseEvents` 皆 `synthetic:"keepalive"/"synthetic-message-start"/"anchor"`（真实内容 0 帧）= delayed-commit pre-response 路径：窗口期上游沉默 → commit 200 + 合成空 delta 保活撑住 CC 的 300s 层，最终自身 header-wait 到点（前提是该守卫已武装）。
  **注：终端 error 帧现在进 history 快照，可以据文案判别。** 早期实现里它写在 `ctx.fail` 之后、只留在 durable V3 轨；现行 `writeTerminalThenSettle` 已改成 `closeAnchor → writeSynthetic → setForwardedResponse → settle`（`src/routes/messages/handler-v4.ts:1003-1023`，`finally` 保证写 reject 也不跳过 settle）。owner-failure 路径**只保证后半段同序**——`settleMessagesOwnerFailure` 先 `recordForwarded()` 再 `ctx.abort`/`ctx.fail`（`src/routes/messages/owner-failure-settlement.ts:13-16`），终端帧本身由上游的 owner decision 决定写不写。**读 2026-07-28 之前的旧记录仍可能缺这帧**——那是旧路径的产物，不是当前缺陷。

**时间基陷阱（踩过，务必换算）**：`clientResponse.sseEvents[].offsetMs` 以 **`streamStartMs`=commit 时刻**为原点（≈ `entry.startedAt + streamCommitAfterSec`；bundled 默认自 2026-07-28 起为 180，此前为 20——**读旧样本按其世代的值换算，别套当前值**），而 `durationMs`/`attempts[].durationMs` 以 **entry 起始**为原点。拿 commit-relative 的心跳 offset 直接减 entry-relative 的 duration，会**凭空多出整整一个 `streamCommitAfterSec` 的"心跳空档"假象**（该实例配多少就差多少）。推理心跳节律（`streamKeepalivePingSec`，同样按生效值取）前先统一到同一原点：末次心跳绝对时刻 = `entry.startedAt + streamCommitAfterSec + offsetMs`，与 abort 时刻同基再比。**注意 `streamCommitAfterSec` 与 `streamKeepalivePingSec` 都不在 `pipelineInfo` 里**（那儿唯一真被写入的只有 `streamIdleTimeoutMs`），所以读旧记录时这个换算**没有事故时快照可依**：只能取当前 `GET /api/config` 值并显式声明「按当前值换算、可能跨世代」，或者判定该换算未决。别默默用当前值当成当时值。

## keepalive 修复 + 合成帧必须可辨识

**修复（本项目落地，2026-07-28 校正到当前实现）**：`stream_keepalive_mode` 的当前默认是 **`ping`**（可选值 `ping` / `enveloped_ping` / `empty_text`；原文写的 `content_delta` **已不是合法值**，「默认发空 content delta」也已被 ADR 2026-07-22 D2 反转——常态 wire 不该长期挂一个合成 text 块）。改为**按需升级**：`stream_keepalive_escalate_sec` 到点才发匹配当前 open block 的空 content delta（thinking→thinking_delta / text→text_delta / tool_use→input_json_delta），pre-content 无开块时惰性开锚点；日常仍是纯 ping、零污染。**这个阈值同样按生效值取，别记数字**——`0` = 不升级（升级机制整个不武装），而 `packages/foundation/src/state-defaults.ts` 里的 `streamKeepaliveEscalateSec` 只是**优先级更低的代码 fallback**，bundled `config.yaml` 一旦给出该键就轮不到它；看到「一直只有 ping、从没升级过」先查生效值是不是 `0`，别当缺陷。实现 `src/lib/anthropic/keepalive-frame.ts`（sink + web_search legacy heartbeat 共用）。覆盖矩阵+四臂对照 `exp/cc-idle-280s/REPORT.md`。

**合成帧必须打可辨识标记（关键，别漏）**：所有 keepalive（含 ping）在 forwarded 轨打 `SseEventRecord.synthetic:"keepalive"` 标记，否则空 delta **伪装成真实内容**、把上游沉默掩盖成正常 streaming。**上游轨 `sseEvents` 绝不含 keepalive、始终忠实**；合成物只进 forwarded 轨且打标记；下游据标记区分显示。见 [[feedback-synthetic-data-must-be-distinguishable-from-real]]（richest-data-flow 对称面）。

## 合成的 Anthropic SSE 帧必须带 `event:` 行（否则 SDK 静默丢帧）

`@anthropic-ai/sdk` 的 `SSEDecoder` 把 `this.event` 初始化为 `null`、仅从 `event:` 字段行赋值；**event-less 的纯 `data:` 帧解码成 `sse.event === null`**（连 SSE 规范的 `"message"` 默认都不应用）。消费循环按 `sse.event` 名分发（在 accept-set 才 yield），`null` 匹配不上 → **该帧被静默丢弃**（不报错、不解析 data）。yield 后 SDK 再按 parsed `data.type` 累积——故 `event` **不必等于** `type`（只需 ∈ accept-set；thinking-signature-compat 在 `event: content_block_start` 下发 signature_delta 良性）。

**结论：任何代理合成的 Anthropic SSE 帧都必须带 `event:` 行（= 帧 JSON 的 `type`）**，否则整帧丢失。真实 Anthropic 上游永远发 event 行。曾踩：recover-tool-call 合成 tool_use 帧无 event 行（一直被 SDK 丢）、recover-refusal 险些同样。落地 `src/lib/anthropic/sse-frame.ts` 的 `anthropicSseFrame(payload)`（`event:=payload.type`）单一 synth 入口；golden `assertEventLineInvariant` 守卫扫所有 forwarded 帧。**陷阱**：自洽 golden（`dat()` 锁 event-less 帧）锁的恰是这个缺陷输出、**抓不到**——必须独立 SDK oracle 裁决（喂合成帧进真 `_iterSSEMessages` 看幸存，`exp/refusal-sse-event-verify/`）。

## SDK 对 200+SSE-error 帧（vs HTTP-4xx）零重试

流内 `event: error`（`@anthropic-ai/sdk` `core/streaming.js:113`）→ `new APIError(undefined, body, ...)`：**`.status===undefined`、非 RateLimitError/AuthenticationError/BadRequestError 子类**（子类只由 HTTP-response 路径 `error.js generate(status)` 产）、**零自动重试**（`shouldRetry` 作用于 HTTP response、先于流迭代）。HTTP-4xx 则得类型化子类 + `.status` + 自动重试。`error.type` 两形态都在 `body.error.type` 保住。

**CC 包装层**：对 200+SSE-error **401/400 完全等价**（显示正确 + 不重试本就正确，401 还触发「请 /login」UX）；**仅 429/5xx 可重试类真发散**——HTTP-429 持续重试 ≥7×退避，200+SSE-error-429 一次即弃。流一旦 commit（message_start 后），即便真上游错误 CC 也不重试（流式协议固有）。支撑 [[project-pre-response-abort-rfc]] 的延迟-commit GO 裁决（grace<60s、heartbeat<60s、错误帧残余可接受）。

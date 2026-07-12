---
name: claude-code-connection
description: 当调试 copilot-api-js 与 Claude Code CLI 客户端之间的连接/流式行为时使用——CC 请求超时两层（60s byte-idle 任意字节/ping 重置 + 300s no-real-content 只有真实 content_block_delta 重置，长 pre-content thinking 静默撞第二层断连）、keepalive 发空 content-delta 而非裸 ping、合成帧必须打 synthetic 标记 + 必带 event: 行（否则 @anthropic-ai/sdk SSEDecoder 静默丢帧）、SDK 对 200+SSE-error 走裸 APIError 零重试；以及事后判别一条 `[FAIL] … The operation was aborted.`/断流 incident 是 client-abort vs reaper vs header-timeout（三类都抛同一字面量、靠 History `state`(failed≠aborted)/上游 0 帧 status null/durationMs≈300 vs 600 判，附 offsetMs commit-relative 时间基陷阱）。下游客户端行为，区别于上游传输（skill bun-upstream-transport）与上游 Anthropic wire（skill ghc-anthropic-upstream）。
---

# Claude Code 客户端连接与流式行为

排查「CC 为何断流/重试/丢帧」。对象是**下游客户端**（Claude Code CLI + 其封装的 `@anthropic-ai/sdk`）如何连接我方代理、如何超时/重试、如何解析我方（可能合成的）帧。与上游传输（skill `bun-upstream-transport`）、上游 Anthropic wire 异常（skill `ghc-anthropic-upstream`）正交。

## 探针方法（真实 CC 作独立 oracle）

真实客户端作独立 oracle（[[feedback-pass-null-clean-not-self-validating]]）+ 受控 mock 上游 + prod-faithful 接线（harness `exp/q2-oracle/`、`exp/cc-idle-280s/`）。驱动 headless CC 打到自定义 mock：`claude -p ... --settings <json>`（命令行优先级盖过 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL`）+ `--strict-mcp-config`；`--output-format json` 出 `is_error`/`result`/`duration_ms`。SDK 层裁决用 `@anthropic-ai/sdk`（CC 同款）消费受控 mock 流。通用方法论见 skill `empirical-verification` 的「客户端 SDK oracle」节。

## 请求超时：两层 idle watchdog（都是 idle 型、非 total）

CC 对 `/v1/messages` 流式请求关掉 SDK 的 600s 总超时（`API_TIMEOUT_MS`），改由 **两层 idle watchdog** 管（实测 2.1.185 + 2.1.201）：

- **第一层 byte-idle ≈ 60s**：每收**任意字节/帧**重置 deadline，无字节 60s → abort + **自动重试**（≥6× 60s-spaced）。`event: ping`（连 message_start 之前也算字节）重置它 → keepalive 只需 ping 间隔 < 60s；**heartbeat ≥ 60s（如 120s）无效**。first-party 与 prod-faithful 两路径一致（8 样本全 60.0–60.2s）。
- **第二层 no-real-content ≈ 300s**：一定时间内必须收到**真实 content chunk**（`content_block_delta`），否则断，报 `API Error: Stream idle timeout - no chunks received`（字面精确：no real content chunks）。**`event: ping` 与 SSE comment 都不算 chunk**——纯 ping 压住 60s 层却撞 300s 层断（复现用户 incident）。长 opus pre-content thinking 静默数百秒撞第二层。first-party 与 prod-faithful 一致（`duration_ms=300169/300187`），**不能从 60s 层跨层外推、须独立复测**。
- **空 `content_block_delta` 算 chunk**：`thinking_delta{thinking:""}` / `text_delta{text:""}` / `input_json_delta{partial_json:""}` 三种空 delta 全部实测保活到 340s 完整收尾（SDK 累积它们无害，SDK oracle 验）。
- 注：incident 报的 ~292s 单次断开**非**自动超时——是用户中断（孪生双请求同时断）或 headless 重试风暴（~5×60s）。

## 事后判别 `[FAIL] … The operation was aborted.`：client-abort vs reaper vs timeout

一条 `[FAIL] POST /v1/messages … 301.0s ↑1.7MB ↑0 ↓0: The operation was aborted.` 的中止方，**不能凭错误串猜**——三类中止（下游客户端断开 / stale-request reaper / 上游 header-wait 超时）在 h2 路径上**都**抛字面量 `"The operation was aborted."`（[http2-client.ts](../../../src/lib/transport/http2-client.ts) `raceAbort` 的 `abortError()`，`name:"AbortError"`），归类由**信号状态**决定、非 `error.name`（`classifyPostCommitAbort(clientAbort.signal.aborted, ctx.lifecycleSignal.aborted)`，优先级 client > reaper > timeout，见 `src/routes/messages/post-commit-error.ts`）。

**唯一可信的裁决走 History**（4141 `GET /history/api/entries/:id`，独立 oracle；日志串本身信息不足）。逐字段判：

| 字段 | client-abort | reaper-cancel | header-timeout |
|---|---|---|---|
| `state`（**首要判据**） | `aborted` | `failed` | `failed` |
| `attempts[].upstreamResponse.status` + `.sseEvents` | 可能已有帧 | 视时机 | **`null` + `[]`（0 帧）= 上游从未回响应头** |
| entry-relative `durationMs` | 任意（客户端何时走） | ≈ `staleRequestMaxAge`（默认 **600s**） | ≈ `responseHeaderTimeout`/`streamIdleTimeout`（默认 **300s**） |
| 下游终端 error 帧文案 | 无（客户端已走，零字节） | `Request cancelled by the stale-request reaper` | `Upstream timed out before sending response headers` |

- `state:"failed"`（非 `aborted`）**当场排除 client-abort**：客户端断开走 `StreamClientAbortError` → driver `settled-abort` → state `aborted`；reaper/timeout 走 `ctx.fail` → `failed`。机制佐证 [forward.ts:521-530](../../../src/lib/error/forward.ts)——client-abort 会 abort `c.req.raw.signal`，header-timeout 只 abort **fetch 信号**、留 `raw.signal` 未 abort。
- header-timeout 由 [fetch-utils.ts](../../../src/lib/fetch-utils.ts) 的 `AbortSignal.timeout(responseHeaderTimeout*1000)` 折进上游 fetch 信号触发（GHC 走 h2、不吃 undici Agent 的 `headersTimeout`，靠这个信号兜底）。**上游 0 帧 + status null + 时长≈300s = 上游纯沉默、我方 header-wait 守卫开火**（既非客户端主动断、也非 GHC 主动报错/关流）。
- 巨型对话（`messageCount` 数百、`requestBytes` MB 级）+ 全程 `clientResponse.sseEvents` 皆 `synthetic:"keepalive"/"synthetic-message-start"/"anchor"`（真实内容 0 帧）= delayed-commit pre-response 路径：窗口期上游沉默 → commit 200 + 合成空 delta 保活撑住 CC 的 300s 层，最终自身 header-wait 到点。注：此路径下终端 error 帧在 `ctx.fail`(snapshot forwarded) **之后**写，**不进 history 快照**——reaper/timeout 二选一别指望 history 里的文案，靠 `durationMs`（300 vs 600）或实时 wire 抓。

**时间基陷阱（踩过，务必换算）**：`clientResponse.sseEvents[].offsetMs` 以 **`streamStartMs`=commit 时刻**为原点（≈ `entry.startedAt + streamCommitAfterSec`，默认 **+20s**），而 `durationMs`/`attempts[].durationMs` 以 **entry 起始**为原点。拿 commit-relative 的心跳 offset 直接减 entry-relative 的 duration，会**凭空多出约一个 `streamCommitAfterSec`（~20s）的"心跳空档"假象**。推理心跳节律（默认 `streamKeepalivePingSec=20`）前先统一到同一原点：末次心跳绝对时刻 = `entry.startedAt + streamCommitAfterSec + offsetMs`，与 abort 时刻同基再比。

## keepalive 修复 + 合成帧必须可辨识

**修复（本项目落地）**：config `anthropic.stream_keepalive_mode: content_delta`（默认）——keepalive 发匹配当前 open block 的**空 content delta**（thinking→thinking_delta / text→text_delta / tool_use→input_json_delta）而非裸 ping，重置 300s 层；覆盖 pre-response/mid-stream/buffered 全程。实现 `src/lib/anthropic/keepalive-frame.ts`（sink + web_search legacy heartbeat 共用）。覆盖矩阵+四臂对照 `exp/cc-idle-280s/REPORT.md`。

**合成帧必须打可辨识标记（关键，别漏）**：所有 keepalive（含 ping）在 forwarded 轨打 `SseEventRecord.synthetic:"keepalive"` 标记，否则空 delta **伪装成真实内容**、把上游沉默掩盖成正常 streaming。**上游轨 `sseEvents` 绝不含 keepalive、始终忠实**；合成物只进 forwarded 轨且打标记；下游据标记区分显示。见 [[feedback-synthetic-data-must-be-distinguishable-from-real]]（richest-data-flow 对称面）。

## 合成的 Anthropic SSE 帧必须带 `event:` 行（否则 SDK 静默丢帧）

`@anthropic-ai/sdk` 的 `SSEDecoder` 把 `this.event` 初始化为 `null`、仅从 `event:` 字段行赋值；**event-less 的纯 `data:` 帧解码成 `sse.event === null`**（连 SSE 规范的 `"message"` 默认都不应用）。消费循环按 `sse.event` 名分发（在 accept-set 才 yield），`null` 匹配不上 → **该帧被静默丢弃**（不报错、不解析 data）。yield 后 SDK 再按 parsed `data.type` 累积——故 `event` **不必等于** `type`（只需 ∈ accept-set；thinking-signature-compat 在 `event: content_block_start` 下发 signature_delta 良性）。

**结论：任何代理合成的 Anthropic SSE 帧都必须带 `event:` 行（= 帧 JSON 的 `type`）**，否则整帧丢失。真实 Anthropic 上游永远发 event 行。曾踩：recover-tool-call 合成 tool_use 帧无 event 行（一直被 SDK 丢）、recover-refusal 险些同样。落地 `src/lib/anthropic/sse-frame.ts` 的 `anthropicSseFrame(payload)`（`event:=payload.type`）单一 synth 入口；golden `assertEventLineInvariant` 守卫扫所有 forwarded 帧。**陷阱**：自洽 golden（`dat()` 锁 event-less 帧）锁的恰是这个缺陷输出、**抓不到**——必须独立 SDK oracle 裁决（喂合成帧进真 `_iterSSEMessages` 看幸存，`exp/refusal-sse-event-verify/`）。

## SDK 对 200+SSE-error 帧（vs HTTP-4xx）零重试

流内 `event: error`（`@anthropic-ai/sdk` `core/streaming.js:113`）→ `new APIError(undefined, body, ...)`：**`.status===undefined`、非 RateLimitError/AuthenticationError/BadRequestError 子类**（子类只由 HTTP-response 路径 `error.js generate(status)` 产）、**零自动重试**（`shouldRetry` 作用于 HTTP response、先于流迭代）。HTTP-4xx 则得类型化子类 + `.status` + 自动重试。`error.type` 两形态都在 `body.error.type` 保住。

**CC 包装层**：对 200+SSE-error **401/400 完全等价**（显示正确 + 不重试本就正确，401 还触发「请 /login」UX）；**仅 429/5xx 可重试类真发散**——HTTP-429 持续重试 ≥7×退避，200+SSE-error-429 一次即弃。流一旦 commit（message_start 后），即便真上游错误 CC 也不重试（流式协议固有）。支撑 [[project-pre-response-abort-rfc]] 的延迟-commit GO 裁决（grace<60s、heartbeat<60s、错误帧残余可接受）。

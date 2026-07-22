# Spec：上游流终止归因 bus 化 + metrics（upstream-disconnect-attribution）

- 状态：**草案 v3（bus 化 + metrics-B）；B 已自证消解 v3-A 两个 BLOCK；待用户终审 → writing-plans**。v1（bus+A 维度，G1 前提过期）/v2（仅 G2-G5 加性）已被 supersede。
  - 评审轨迹：v1/v2/v3-A 均过 GPT reviewer 深度审（v1 BLOCK：G1 过期；v3-A 两 BLOCK：A 维度依赖不存在的 entry-kind 通路）。v3(B) 改用 bus-counter 消解两 BLOCK——B 在事件点累加、从不读 entry（照 `retry-strategy-fires.ts` 先例，2026-07-21），已主会话亲手核实机制（`metrics-exposition.ts:151-175` + `observability/retry-strategy-fires.ts`）。v3(B) 的独立 reviewer 复核因 agent surfacing 故障未取得正文，主会话自证承重点；用户可要求另派新 reviewer 走一遍 clean gate。
- 日期：2026-07-14（v3 扩写 2026-07-22）
- 归属：「上游传输可观测性子系统」（`docs/todo/upstream-transport-observability.md`）的**子项目 1**。
- 关键决策：metrics 走法见 ADR `docs/decisions/2026-07-22-metrics-via-prometheus-grafana.md`（/metrics-first、聚合交 Grafana、退役 /api/stats）。
- 边界邻居：request-timing-instrumentation（owns TTFB/时序）；upstream-error-client-shaping（客户端错误形态）；子项目 2（连接级 GOAWAY/PING + 多路复用关联）、子项目 3（history transportTrace + ui）——均正交/下游。

## 1. 动机与范围演进

timeout 归因审计（2026-07-11）识别 G1-G5。**G1（跨端点流终止归因不一致）已被并发 2026-07-14 工作解决**（commits `c08fd91b` 等，共享模块 `src/lib/upstream-stream-diagnostics.ts`——「SINGLE emission point used by EVERY non-native pump」，经 `logUpstreamStreamOutcomeError`/`logUpstreamStreamTruncation` 全端点覆盖）。

> **教训（记档）**：v1 复核过期审计时 grep 过窄（漏 `logUpstreamStreamOutcomeError`/`Truncation`）误判 G1 仍在；异模型 GPT reviewer 广口径 grep + git log 纠正。过期审计属二手源，须广口径 + git 时间线复核。

**v3 范围（用户 2026-07-22 拍板）**：不止补缺口，而是把上游流终止归因**做成 bus-native 一等信号 + 接入 /metrics**：
1. **Producer**：driver 单点发 `request.upstream_stream_disconnect` / `request.upstream_connect_timeout` bus 事件，退役各 pump 手动调用。
2. **Console sink**：订阅事件、格式化今天的诊断行（含 G5 补旋钮）。
3. **Metrics sink（B）**：订阅事件、累加 Prometheus counter 上 `/metrics`（**bus-counter，非 /api/stats registry 维度**——见 §5 决策）。
4. **缺口搭车**：G2（post-commit warn）、G3（classifyStreamError 认 undici code）、G4（连接层归因，现由 connect-timeout 事件承载）、G5（补旋钮）。

## 2. 架构

### 2.1 Producer：driver 单点发事件（fire-once）

**driver 侧 format-agnostic 累加器已存在、复用现成的**：`src/lib/pipeline/stream/response-processor.ts:147-161` 的帧循环对四端点+WS 统一无条件 `upstreamSse.push(...)`（含 `offsetMs`/`type`(via `upstreamFrameDiagType`)/`raw`）+ `:171` 无条件 `onUpstreamFrame`。基座字段（bytes/events/frames/lastFrameType/lastFrameOffsetMs/streamStartMs）从 `upstreamSse` 直接派生，**不新建累加器**（reviewer 核实）。

**fire-once 收口（reviewer 应改：非天然单点）**：`stream-error` 有 **8 处**函数级 return（`driver.ts:806/826/950/1172/1211/1232/1266/1326`，分布 `runResponseSink`+`runResponseBufferedSink` 两函数）。逻辑上一请求最多一次（重试中间走 `continue` 绕过），但**物理单点需新增一个两函数共经的收口**发事件。**任务**：抽 `emitDisconnectEvent(ctx, signals)` 收口，8 处 return 前统一经它（或在 `runResponsePump` 追踪层收口）。

**事件 schema**：
```ts
{ kind: "request.upstream_stream_disconnect"
  ctx: RequestContextSnapshot
  disconnect: {
    kind: StreamErrorKind            // classifyStreamError（G3 修后）
    elapsedMs; bytesIn; eventsIn; frames; lastFrameType?; lastFrameOffsetMs; silence
    keepaliveSec; h2PingSec; streamIdleSec; detail
    inputTokens?; outputTokens?; stuckBlockType?   // Anthropic 富化（缺则诚实省略）
  } }
{ kind: "request.upstream_connect_timeout"
  ctx: RequestContextSnapshot
  connect: { phase: "tls" | "proxy-connect" | "ws-first-event"; deadlineMs; target } }
```

**富化通道（reviewer 应改：v2 未说清）**：tokens/stuckBlock 是 Anthropic 候选会话解析的 format-specific 值，driver format-agnostic 拿不到。**任务**：设计「driver 发事件前向候选会话查询可选富化」的接口（如候选会话暴露 `getDisconnectEnrichment(): {inputTokens?,outputTokens?,stuckBlockType?} | undefined`，非 Anthropic 返 undefined）——不脏染 ctx。

### 2.2 Console sink：订阅事件、退役同步调用

新 console sink（或扩现有 bus 消费者）订阅两事件、格式化 `[upstream-diagnostics] STREAM DISCONNECT ...` / `CONNECT TIMEOUT ...` 行。退役各 pump 的同步 `logUpstreamStreamOutcomeError/Truncation` 调用——格式化逻辑（现 `upstream-diagnostics.ts:logUpstreamStreamDisconnect` **唯一 formatter**）搬进 sink 或由 sink 调用。**回归红线**：sink 行字段 ⊇ 今天（无归因倒退）。

### 2.3 Metrics sink（B）：bus-counter → /metrics

**照 `retryStrategyFires` 先例**（`metrics-exposition.ts:86-91/151-160`——独立单标签 counter 家族，不进 registry/不进 /api/stats）：新 metrics sink 订阅两事件，累加进程内 counter map，`renderPrometheusMetrics` append：
```
# TYPE copilot_api_upstream_stream_disconnect_total counter
copilot_api_upstream_stream_disconnect_total{kind="idle-timeout",endpoint="messages"} N
# TYPE copilot_api_upstream_connect_timeout_total counter
copilot_api_upstream_connect_timeout_total{phase="tls"} N
```
label 低基数：`kind`(~6) × `endpoint`(4) 有界；`phase`(3)。**connect-timeout 用 `phase` label 的同族 counter 承载**（reviewer 结论：虽也 settle 出 entry，但 B 路不碰 entry，直接从事件累加，最简）。sinceStart 语义（进程重启归零，Prometheus `rate()` 处理）。**Grafana 友好**——聚合/分位/多窗口交 Grafana（ADR）。

## 3. G2 + G3 正交小补（随 producer）

- **G3**：`classifyStreamError`（`src/lib/stream.ts`）在现有 `instanceof` 后补 `error.code` 识别——`UND_ERR_BODY_TIMEOUT`→`idle-timeout`、`UND_ERR_HEADERS_TIMEOUT`→`idle-timeout`（**不新增 kind**：三处消费点均 `switch...default` 兜底，新 kind 会被静默吞进 default；reviewer 核实）。`isErrorWithCode` 守卫全仓无既有实现，新写（或内联 `(error as NodeJS.ErrnoException)?.code`，参考 `process-identity.ts:146`）。
- **G2**：Anthropic 流式 post-commit header 超时（`src/routes/messages/post-commit-error.ts` 的 `timeout` kind，`handler-v4.ts:644-659` 只合成帧无日志）补 warn，与非流式 `forward.ts:556` `Upstream response-header timeout in ...` 同信息量。

## 4. G4 + G5

- **G4**：连接层三处超时（TLS `http2-client.ts:199`、proxy CONNECT `proxy-connect.ts:149`、WS first-event `upstream-ws-attempt.ts:159`）在 throw 前发 `request.upstream_connect_timeout` 事件。proxy-connect 发事件置于 `fail()` **内部**（`:137` `if(settled)return` 去重，防 socket 竞态重复）。console sink 打行、metrics sink 累加 `phase` counter。
- **G5**：console sink 格式化时 `keepalive=` 扩为 `keepalive=<tcp>s h2ping=<n>s idle=<n>s`；middlebox-hint 按 transport 分支（http2→`h2_ping_interval`，否则 `tcp_keepalive_probe_delay`）。**只改一处 formatter**（`emitDisconnect` 采集 leaf 委托给唯一 formatter，非两实现——reviewer 核实）。

## 5. 决策：metrics 为何 B（bus-counter）而非 A（registry 维度）

- **A（registry `disconnect_kind` 维度）BLOCKED**：`/api/stats` + `/metrics` 共享 registry，A 一次注册两端点白嫖——但要求 settled entry 上有结构化 kind 字段，而**该通路完全不存在**（`failureReason` 是自由文本；`attribution` 捕获从不投影且只服务 reaper/deadline；~49 处 `.fail()` 零处传 kind），需新建「49 fail 点写 kind → V3 projection 投影 → entry 新字段 → 统一 mid-stream/connect 两套 kind 词汇表」大通路（reviewer 两个 BLOCK）。
- **B（bus-counter）**：绕开整条通路，直接从 bus 事件累加，只上 `/metrics`（不进 /api/stats）。**且与 ADR 2026-07-22 一致**——聚合交 Grafana、退役 /api/stats，A 买的「/api/stats 断流维度 + 多窗口 + 分位」正是要退役的东西，Grafana 从 B 的 `{kind,endpoint}` label + 未来 histogram 全给得了。**B 是明确正解，本特性是 /metrics-first 方向的第一实践。**
- **不做**：`/api/stats` 断流维度（A 的通路）——若将来仍要 entry 上的结构化 kind（供 History 取证/UI），留给子项目 3 做 entry/history 工作时顺带（同一新字段）。

## 6. 测试（真相域：empirical，防自证）

- **Producer/覆盖**：每端点（Anthropic/CC/Responses/Gemini + reverse + WS）造 mid-stream 断流（`upstream-hook-mocking`），断言发 `upstream_stream_disconnect`、kind 正确、基座字段齐（从 upstreamSse 派生）。**正样本先证事件触达**。
- **fire-once**：一次终态流失败恰一事件（8 return 点 + 重试 continue 绕过，收口后不重不漏）。
- **富化**：Anthropic 事件含 tokens/stuckBlock，CC 省略但基座行照打（诚实退化）。
- **Console sink 回归**：行字段 ⊇ 今天（golden 只锁字段值、不锁 middlebox-hint 文字——G5 改它）。
- **Metrics（B）**：断流后 `/metrics` 出 `upstream_stream_disconnect_total{kind,endpoint}`、connect 超时出 `upstream_connect_timeout_total{phase}`；label 基数有界；重启归零。
- **G3**：`classifyStreamError({code:"UND_ERR_BODY_TIMEOUT"})`→idle-timeout 单测 + 正样本证真 `StreamIdleTimeoutError` 不回归。
- **G4**：三 phase connect-timeout 各一（proxy-connect 连跑多次证 `fail()` dedup 不重复发）。
- **G2**：Anthropic post-commit header 超时有 warn 行。

## 7. 范围红线
- **不**做 A 的 entry-recording 通路 / `/api/stats` 断流维度（→子项目 3 或 backlog）。
- **不**碰连接级 GOAWAY/PING/session/多路复用关联（子项目 2）。
- **不**做 history `transportTrace` 落盘 / ui-v4（子项目 3——可再订阅同一 bus 事件）。
- **不**碰时序/TTFB（request-timing）。
- **不**改 keepalive/PING/retry 行为，只补可观测。
- `/api/stats` 退役是**独立方向**（ADR 2026-07-22 + backlog），**不**在本特性做。

## 8. 采纳的评审结论
- **v1→v2**：G1 已解决移出；G4 proxy-connect 置 `fail()` 内；G3 归 idle-timeout 不新 kind；G5 只改一处 formatter（非收敛两实现）。
- **v2→v3（bus+metrics）reviewer 结论**：A 维度两个 BLOCK（entry 无 kind 通路）→ 改 B bus-counter（消解 BLOCK，且合 ADR 方向）；driver 累加器复用现成 `upstreamSse`（工作量更小）；fire-once 需真做两函数收口（非天然单点）；富化通道需设计候选会话查询接口；null 语义/维度基数无风险（已验证）；connect-timeout 用 phase-label counter 承载。
- **子项目 3 doc 同步**：backlog 子项目 3 措辞需去掉「metrics 并入本片」（metrics 已由本特性 B 路承担），待写 plan 时更新（`deferred-backlog.md` 子项目 3 条）。

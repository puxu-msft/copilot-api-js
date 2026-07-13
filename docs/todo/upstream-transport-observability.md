# 上游传输可观测性子系统（kickoff / 待专项会话继续）

> 状态：**未开工，仅起头**。本文件由 2026-07-09 会话在诊断「上游流长思考静默截断」bug 时派生——诊断中发现 `src/lib/transport/` 几乎零结构化可观测性，无法把「A 中间设备/连接级空闲回收」与「B GHC 对单条空闲流的应用层超时」区分开。用户决定把它作为独立大特性交给后续专项会话，本文档尽量灌全已知信息 + 猜测，让新会话冷启动即可推进，**不需重新探查**。
>
> 本文档不是 spec、不是 plan——是给新会话的**信息交接 + 设计草案**。正式流程仍走 brainstorming → spec（`docs/spec/`）→ plan（`docs/plan/`）→ 执行。

## 1. 缘起与动机

线上症状：客户端见前 ~3s 响应 → 后续 112s 完全静默 → 上游流被关闭且**无 `message_stop`**，报 `Upstream stream truncated before completion (no message_stop)`。

诊断已确认的事实（本会话，均实测/读码）：
- **上游真静默不是我方造的**：GHC 的 CAPI 代理**不透传** Anthropic 协议本该周期发的 SSE `event: ping` 帧。判据是 history **上游原始轨** `attempts[].upstreamResponse.sseEvents`（driver 在 rewrite 前全量无过滤 tap，`case "ping"` 不丢——[driver.ts:395](../../src/lib/pipeline/driver.ts#L395)、[stream-accumulator.ts:182](../../src/lib/anthropic/stream-accumulator.ts#L182)）。轨里没 ping = 上游没发。
- **已落地缓解**：TCP keepalive（`upstreamKeepaliveDelay` 默认 15s）+ **新增 h2 PING 保活**（`upstreamH2PingInterval` 默认 15s，[http2-client.ts:scheduleH2KeepalivePing](../../src/lib/transport/http2-client.ts)，commit `a1e97801`）。但 h2 PING 只对 **A 类**（中间设备/连接级空闲回收）是根因修；对 **B 类**（GHC 对单条流的应用层 idle 超时）PING 是连接级、刷新不了单流计时，救不了。
- **现有信号不足以判别 A/B**——正是本可观测性特性要解决的核心痛点。

### 为什么现有信号不够（关键，别重复踩）

- 截断走 [handler-v4.ts:1208-1229](../../src/routes/messages/handler-v4.ts#L1208) 的 `!acc.sawMessageStop` **干净 drain 分支**：Bun 把上游 clean RST 当正常 `end` 交付（rstCode=0，[http2-client.ts:446-447](../../src/lib/transport/http2-client.ts#L446)），driver 看到干净结束，**`[http2] ...rstCode` 那条 Error（[http2-client.ts:466](../../src/lib/transport/http2-client.ts#L466)）根本没被抛**。
- 那条 `[http2] upstream stream closed before end (rstCode=N)` 是**流 Error 不是日志**，且只在另一子情形（close-before-end，真丢连接）才触发。**Bun clean-RST 下 rstCode 恒 0、无区分力**。
- 实际能看到的日志只有 [handler-v4.ts:1217](../../src/routes/messages/handler-v4.ts#L1217) `[Stream] Upstream truncated for <model>: closed after N events without message_stop`（给 `eventsIn`，无 rstCode、无 close-reason、无 GOAWAY）。
- **GOAWAY 完全不可见**：`session.on("goaway", removeFromPool)`（[http2-client.ts](../../src/lib/transport/http2-client.ts)）既不记日志也不进 history。GOAWAY 是判别「连接级 drain（A/GHC 边缘）」的**最强信号**，现在被丢弃。
- **PING ack RTT 未采集**：`scheduleH2KeepalivePing` 的 ack 回调是 `NOOP_PING_ACK`（忽略）。ack RTT / 是否 unack 是连接健康的直接指标，现在扔掉。

## 2. 已锁定的范围决策（用户 2026-07-09 定）

- **范围边界 = B「上游传输 + 管线关联」**：把上游传输做成**一等可观测子系统**，并把传输事件与 request/pipeline 关联（一条 request 贯穿 connect→session→stream→truncation→retry 的完整因果链），surfaced 在 **history entry + /metrics + 结构化日志**三面。**不含**客户端↔我方那条腿（端到端全链路是更大范围，未选）。
- **首要用途 = 单请求事后取证**：设计重心是「打开一条 history entry 就能看到这次请求的完整传输因果链」。/metrics 聚合与实时 bus 也做，但**优先级低于**单请求因果链，形状上让位。

## 3. 当前状态（别重新探查）

- **传输层可观测性 ≈ 0**：`src/lib/transport/` 全树只有 2 处 `consola`，其一（[send.ts:149](../../src/lib/transport/send.ts#L149)）只是错误标签。connect/TLS/ALPN/session 建关/GOAWAY/PING/stream 开关/rstCode/close-reason **全黑盒**。
- **可建其上的现成底座**（都在 `src/lib/`）：
  - `observability/`：event bus（`bus.ts`）+ 事件类型（`events.ts`）+ 投影（`projections/`）+ sinks（`sinks/`，含 `sinks/telemetry.ts`）+ `telemetry-dimensions.ts` + `active-request-wire.ts`（活跃请求实时线）。**这是承载「结构化传输事件流」的天然宿主**。
  - `request-telemetry.ts` + `metrics-exposition.ts` + `routes/metrics/`：Prometheus `/metrics`。可扩展遥测 registry 的三支柱见 skill `telemetry-architecture`。
  - **history 双轨 sseEvents**：上游原始轨 `attempts[].upstreamResponse.sseEvents`（忠实上游）vs 转发轨 `clientResponse.sseEvents`（含我方合成、打 `synthetic` 标记）。传输因果链应作为 entry 的**新结构化字段**，与 sseEvents 并列。schema/写入见 skill `history-sqlite-schema`、`telemetry-architecture`、`persistence-async-invariants`。
  - history SQLite（`lib/history/sqlite/`）：新增 entry 字段的迁移/backfill 套路见 skill `history-sqlite-schema` / `history-backfill`。

## 4. 应观测的维度（全集，供新会话裁剪/分层）

按生命周期分层，每条注明**层级**（connection-级=多路复用共享 / stream-级=per-request）：

**连接建立（connection-级）**
- proxy 选路结果（direct / HTTP-CONNECT / SOCKS5，`getProxyUrlForOrigin`）
- TCP connect 耗时、TLS 握手耗时、ALPN 协商结果（h2 / 降级）、连接 reuse vs 新建、connect 失败原因（cert/RST/timeout/ALPN 降级——[http2-client.ts:awaitH2Handshake](../../src/lib/transport/http2-client.ts) 已有分类，只是没记）

**会话生命周期（connection-级）**
- session 建立/关闭时刻、pool 命中 vs 新建、per-origin 活跃 session 数、session 存活时长
- **GOAWAY 收到（含 lastStreamID、errorCode、debugData）** ← 判别 A/B 的最强信号
- **PING 往返（发出时刻、ack RTT、unack 计数）** ← 连接健康直接指标
- TCP keepalive 是否真落内核（可选：启动时一次性 `ss` 自检，或记录 `setKeepAlive` 生效与否——注意 Bun delay 参数已知坏，见 skill `debugging-ghc-api-upstream-transport`）

**流生命周期（stream-级，per-request）**
- stream 开启时刻、请求字节数、响应头到达耗时（TTFB）、`:status`
- **帧级到达节奏**：每帧 offsetMs（已在上游原始轨有 `offsetMs`）、**最长帧间静默 gap**（本 bug 的 112s 就是它）、eventsIn/bytesIn
- **流终止方式（核心）**：clean-end-with-message_stop（成功）/ clean-end-without-message_stop（截断，Bun clean-RST 伪装）/ close-before-end（真丢连接，带 rstCode）/ 显式 upstream error 帧 / client-abort。**rstCode**（即便 Bun 下多为 0，也记下以便与 Node 对照）
- **truncation 归因**：结合上面派生「这次截断最可能是 A（连接级 drain/GOAWAY/中间设备）还是 B（单流 idle、无 GOAWAY、连接仍活）」——这是取证的终点产物

**重试/管线关联（request-级）**
- 每次 attempt 用了哪条 session、是否换新连接、REFUSED_STREAM 重试（已有分类，见 skill `debugging-ghc-api-upstream-transport`）、L2 缓冲重试与传输事件的对应

## 5. 核心难题：多路复用池化 session 的关联（新会话重点解决）

`http2-client` 是**格式无关 + per-origin 池化 + 多路复用**的：一条 h2 session 被多个并发 request 共享。于是**连接级事件（GOAWAY / session-close / PING）不是 1:1 对应某个 request**。这是整个设计最硬的点。

猜测的候选解（供新会话评估，非定论）：
- **A. correlation-id 穿透 + 连接级事件 fan-out**：让 `upstreamFetch`/`http2Fetch` 收一个 request-correlation-id，stream-级事件直接归到该 request；连接级事件（GOAWAY 等）**扇出**记到「此刻共享该 session 的所有在途 request」+ 一份独立的 per-session 连接日志。取证时 entry 里既有本 stream 事件、又有「期间该连接发生了 GOAWAY」。**推荐倾向**——最贴合「单请求因果链」首要用途。
- **B. 两级模型 + 读时关联**：per-request stream 事件进 history entry；连接/session 生命周期单独成一条 keyed-by-session-id 的事件流（进 observability bus + 可选独立存储），取证时按 session-id + 时间窗关联。解耦更干净，但「打开一条 entry 就看全」要多一跳。
- **C. 全事件上 bus + 投影分发**：所有传输事件（带 session-id + 已知时 request-id）发上 `observability/bus`，一个 history 投影订阅并把相关事件贴到 entry，`/metrics` 投影聚合，`active-request-wire` 给实时视图。最「一等子系统」、最贴现有 `observability/` 架构，但要设计事件 schema + 投影关联逻辑，工作量最大。

现有 `observability/bus.ts` + `projections/` + `sinks/` 的存在，使 C（或 A 与 C 的融合：correlation-id 穿透 + 事件上 bus + history 投影）很可能是「最佳方案」。新会话应先读 `observability/` 全貌再定。

## 6. 三面 surface 的落点（首要=history）

- **history entry（首要）**：新增结构化字段（如 `attempts[].transport` 或顶层 `transportTrace`），承载本 request 的连接因果链 + 流终止归因。与 sseEvents 并列，遵循 richest-data-flow（后端存全、前端选择性呈现）。ui-v4 History 详情页加一个「Transport」段展示因果链时间线。schema 迁移 + 读时适配见 skill `history-sqlite-schema`；新顶层字段「三处必改」见 skill `persistence-async-invariants`。
- **/metrics（聚合）**：GOAWAY 速率、PING RTT histogram、truncation 分类计数（A/B/success）、TTFB histogram、per-origin 活跃 session gauge、连接 reuse 率。走遥测 registry 三支柱，见 skill `telemetry-architecture`。
- **结构化日志（实时）**：传输生命周期关键事件的 consola 结构化行（至少补 GOAWAY 收到、close-reason、truncation 归因——即便别的先不做，这几条能立刻让复现机取证可行）。

## 7. 与已落地工作的关系

- 本特性**不改** h2 PING/TCP keepalive 的行为（那已落地），而是让它们**可观测**（PING RTT、keepalive 是否生效、GOAWAY 是否发生）。
- backlog 里已有一条正交待办「unacked-ping 死连接快速 teardown（liveness）」（[deferred-backlog.md](deferred-backlog.md) 末尾）——它是**消费** PING ack 信号做主动 teardown，与本特性「采集并暴露 PING ack」是同簇、可一并设计（先采集，teardown 作为其消费者）。

## 8. 留给新会话的开放设计问题

1. 多路复用关联模型选 A/B/C 哪个（§5）——先读 `src/lib/observability/` 全貌。
2. 传输因果链在 history 的字段形状（顶层 `transportTrace` vs 挂 `attempts[].transport`）+ 是否需要 backfill 旧行（大概率不需要，读时缺省即可）。
3. 采集粒度是否始终全开（richest-data-flow + internal-tool-posture 倾向全开）vs debug-flag 门控（per-frame idle-gap 计时的开销评估）。
4. truncation 归因的判定规则（GOAWAY 存在 → 偏 A；无 GOAWAY + 连接仍活 + 单流 close → 偏 B；结合帧间 gap、eventsIn）——需要在真实数据上标定，可能先采集原始信号、归因作为读时/后处理派生。
5. Bun vs Node 传输行为差异（clean-RST 伪装、rstCode、keepalive delay）如何在观测里如实标注，别让 Bun 的伪装误导归因。

## 9. 文件/锚点地图

- 传输：[src/lib/transport/http2-client.ts](../../src/lib/transport/http2-client.ts)（session/stream 生命周期、GOAWAY/PING/close-reason 的产生点）、`upstream-fetch.ts`、`proxy.ts`、`proxy-connect.ts`、`send.ts`、`crash-safety.ts`
- 管线关联：[src/lib/pipeline/driver.ts](../../src/lib/pipeline/driver.ts)（`onUpstreamFrame` 上游帧 tap、attempt 重试）、[src/lib/context/request.ts](../../src/lib/context/request.ts)（ctx、sseEvents 载体、`recordAttemptFailure`）
- 截断判定：[src/routes/messages/handler-v4.ts:1208-1229](../../src/routes/messages/handler-v4.ts#L1208)
- 可观测底座：`src/lib/observability/{bus,events,telemetry-dimensions,active-request-wire}.ts` + `projections/` + `sinks/`；`src/lib/request-telemetry.ts`、`metrics-exposition.ts`、`routes/metrics/`
- history：`src/lib/history/`（`types.ts`、`sqlite/`、`entries.ts`、`entry-view.ts`）
- 相关 skill：`debugging-ghc-api-upstream-transport`（传输坑 + 两层保活 + A/B 判别）、`telemetry-architecture`、`history-sqlite-schema`、`history-backfill`、`persistence-async-invariants`、`empirical-verification`
- 相关 ADR：`docs/decisions/2026-07-05-richest-data-flow.md`、`docs/decisions/2026-07-05-internal-tool-security-posture.md`

## 10. 新会话 kickoff prompt（可直接复制）

```
在 copilot-api-js 做「上游传输可观测性子系统」特性。先读 docs/todo/upstream-transport-observability.md（信息交接 + 设计草案，范围/用途决策已锁定），再读 src/lib/observability/ 全貌与 skill telemetry-architecture / history-sqlite-schema / debugging-ghc-api-upstream-transport。走 brainstorming → docs/spec/ → docs/plan/ → 执行；先定 §5 的多路复用关联模型与 §6 的 history 字段形状，subagent 对抗审查后再实现。裁判轴：长远正确 + 完整，别用 ROI/YAGNI 缩范围。最小可交付的第一刀建议：先补 GOAWAY 收到 + close-reason（clean-end/close-before-end/rstCode）+ truncation 归因的结构化日志与 history 字段，让复现机能直接读出 A/B。
```

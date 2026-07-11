# Spec: per-model 上游过载背压（upstream overload backpressure）

- 状态：**Draft / 可选后续增强（本轮只出 spec、不实现）**
- 日期：2026-07-11
- 归属：`docs/spec/`，路线图见 `docs/todo/deferred-backlog.md`
- 前置：TTFB/idle 超时机制已存在且正常（`response_header`/`stream_idle`，见 exp/ttfb-timeout-queued/report.md）；本 spec 与之正交，复用其信号。

## 1. 问题（Why）

GHC 上游对 opus-4.8 等模型间歇性过载：单次 attempt 挂数百秒后返回 **502 GitHub "Unicorn" 页** 或 **`NGHTTP2_REFUSED_STREAM`**。实测频率：`502 "Failed to create messages"` 横跨 07-04/05/08/11 反复出现，单日可达 6+ 次（09:02、09:16、09:26、10:24、10:34、10:44）。

即便 TTFB 超时（300s）生效，过载时的行为仍是**纯浪费**：
- `req_300`（实测）：attempt[0] 71s→502，`server-error-retry` **重放同一 payload**，attempt[1] 又挂满 300s→abort = **371s 白烧**。
- 重放同 payload 对"GHC 真处理不了这个请求（常因 payload 大）"的场景几乎必然再失败。

**根因应对**：GHC 过载时应**全局/按模型降速退避**（背压），而不是盲目逐请求重放。这与现有的 429 背压（账号配额，全局）是**不同粒度的正交信号**——过载是**按模型容量**的。

## 2. 目标 / 非目标

**目标**
- 检测 GHC per-model 过载并对**该模型**施加背压（节流/排队/退避），其它模型不受影响。
- 复用现有 `AdaptiveRateLimiter` 状态机（mode/队列/指数退避/gradual recovery），不另造。
- 全量可观测：哪个模型因何进/出背压。

**非目标（本 spec 不含）**
- 不改 429 背压（保持现有全局行为）。
- 不改 TTFB/idle 超时机制本身（已存在、已验证）。
- 不实现（本轮只定 spec）。

## 3. 承重决策（已与用户敲定）

| # | 决策 | 选择 | 备注 |
|---|---|---|---|
| D1 | 过载信号定义 | **滞动窗口 N-in-M**：`M` 秒内 ≥`N` 个过载事件 → 触发 | 抗瞬时抖动，单次不跳闸 |
| D2 | 过载事件集 | 所有 `server_error`(5xx: 502/504/500) + `NGHTTP2_REFUSED_STREAM` + 上游 idle-timeout | 不做 Unicorn-HTML 嗅探（窗口已滤抖动、且不漏 504） |
| D3 | 超时语义 | **上游 idle 超时（无真实字节）** | 复用已存在的 `response_header`(TTFB) + `stream_idle`(mid-stream)；免疫我方 keepalive |
| D4 | 超时后处置 | **可重试**（同 REFUSED 走 network-retry）**且计入过载窗口** | 单次抖动重试一次；真过载靠窗口跳闸接管 |
| D5 | 背压行为 | **复用现有 rate-limited 模式 + 原因 tag** | tag ∈ {`429`, `upstream-overload`} |
| D6 | 窗口粒度 | **per-model** | opus 过载不拖累 haiku |
| D7 | 节流范围 | **per-model**（与 D6 自洽） | 429 仍全局；overload 按模型隔离 |

> **⚠ 定稿修订（2026-07-11 对抗审查 B1–B4，全部经代码核实成立）**：D3/D4/D5 的原「复用即可」表述过于乐观，与真实代码接缝冲突。修订后的接缝、来源辨识、层序契约见 §4.1（重写）+ §4.3（重写）+ **新增 §4.6 信号来源辨识与上报接缝**。要点预告：① 流式 idle 超时不经 transport 上报点、在 driver response-pump catch（B1）；② pre-response TTFB abort 在 h2 层被抹成 generic `AbortError`、与客户端断连不可辨（B2），须先补来源；③ `aborted` 无任何 retry strategy，D4「像 REFUSED 一样重试」需重分类而非复用（B3）；④ `execute()` 硬编码吞 429，层序必须讲死否则 governor 抢吞 429、违反 D5（B4）。

### 未采纳（record-not-adopted）
- **全局窗口/全局节流**（我最初推荐 B1）：被 D6/D7 否决——opus 过载会拖慢 haiku，per-model 窗口形同虚设。
- **Unicorn-HTML 专检**：被 D2 否决——过度精细、漏 504。
- **纯墙钟总时长封顶 / 直接失败不重试**：被 D3/D4 否决——误杀合法长 thinking、失去瞬时抖动的一次兜底。

## 4. 架构（How）

### 4.1 分层（B4 修订：层序 + `execute()` 的 429 行为讲死）

**代码事实**：`AdaptiveRateLimiter.execute()`（`adaptive-rate-limiter.ts:211-223`）对 429 是**硬编码自动跳闸**——`isRateLimitError` 命中即 `enterRateLimitedMode()` + `enqueue()`，429 **永不冒泡出 execute()**。故「哪层 limiter 最内层（最贴 `sendUpstreamHttp`），哪层就吞 429」。

**契约（不可二义）**：全局 429 限流器必须是**内层**，governor 是**外层**：

```
一次上游 attempt (model X)
  PerModelOverloadGovernor.forModel(X).gate(          # 外层：只按窗口状态 pacing/排队，NOT 吃 429
    () => executeWithAdaptiveRateLimit(               # 内层：现有全局单例，429 在此捕获（保持不动）
      () => sendUpstreamHttp(...)))                   # 最内：真实上游请求
```

- 内层看到 429 → 全局背压（D5「429 仍全局」成立）。
- governor 的 `gate()` **不复用 `execute()` 的错误捕获路径**（那会连 429 一起吞，违反 D5）——它只复用状态机的 **pacing/队列/退避/gradual-recovery** 部分，跳闸只由**外部窗口**触发（见 §4.2）。

### 4.2 `PerModelOverloadGovernor`（新单元，B4/C1 修订）

- 持有 `Map<modelId, GovernorUnit>`，`GovernorUnit` 懒创建。
- 每个 `GovernorUnit` 复用 `AdaptiveRateLimiter` 的 **pacing/队列/退避/recovery 状态机**，但**跳闸入口是外部窗口**、非 `execute()` 的 429 自动跳闸。**需要的接口改动（C1，非纯复用）**：
  - 现 `enterRateLimitedMode()` 是 **private、无参**（`:312`）；唯一公开外部 trip `forceRateLimitedMode()`（`:582`）也无 reason。→ 新增**公开的、带 `reason` 参数**的 trip 入口（如 `tripRateLimited(reason: "upstream-overload")`），或给 `forceRateLimitedMode(reason?)` 加参。
  - 新增一个「pacing-only、不经错误捕获」的执行入口（如 `paceOnly(fn)`），供 governor 的 `gate()` 用——避免走 `execute()` 的 429 分支（B4）。
- 每个模型独立进入/恢复背压（复用现有 gradual recovery：连续成功 → ramp-up → normal）。
- **shutdown drain（C2）**：`shutdown.ts:397-402` 现只 `rejectQueued()` 全局单例。governor 各 unit 各持独立队列，**必须**注册进 Phase 1 drain——governor 暴露 `rejectAllQueued()`，`gracefulShutdown` Phase 1 调用，否则排队请求悬挂/白占 drain 时间（违反 `persistence-async-invariants` drain-before-close）。

### 4.3 信号上报（B1/C5 修订：真实接缝在 driver，非 transport）

**代码事实**：`http-transport.ts:57` 的 `send()` **本身无 try/catch**；失败在两个 driver 接缝浮现：
- **非流式 + pre-response（含 TTFB abort、502、REFUSED）**：`sendUpstreamHttp` 抛错 → 冒泡到 `driver.ts:290` `runExchange` catch → `classifyError`（`:291`）。
- **流式 mid-stream idle**：`transport.send` 收到响应头即**成功返回** `{frames}`（`http-transport.ts:105-112`）；`StreamIdleTimeoutError` 在**消费 frames 时**触发，接缝在 `driver.ts:494`（`runResponseSink` catch）/ `driver.ts:615`（`runResponseBufferedSink` catch）→ `classifyStreamError`（`stream.ts:85`）得 `"idle-timeout"`。**opus 过载多是流式挂起（事故 `streaming 750s`），全落此接缝**——原 §4.3「transport 侧上报」会漏掉最主要的过载形态。

**修订**：signal bridge 挂在**两处 driver catch**（都能拿到 `env.model`），而非 transport：
- `runExchange` catch：`classifyError` 结果 → 映射 `kind`（见 §4.6）→ `reportOverloadSignal(env.model, kind)`。
- `runResponseSink` / `runResponseBufferedSink` catch：`classifyStreamError(error) === "idle-timeout"` → `reportOverloadSignal(env.model, "idle_timeout")`。
- 与执行路径解耦：上报只做窗口计数，命中 `≥N`/`M 秒` → 该模型 `GovernorUnit` 经 §4.2 的 trip 入口进背压。

### 4.4 配置面（`config.yaml`，均可关）

```yaml
overload_backpressure:
  enabled: true         # 总开关
  window_sec: 120       # M：滞动窗口长度（每模型各自）
  threshold: 3          # N：M 秒内 ≥N 个过载事件 → 该模型背压
```
（idle-timeout 复用现有 `timeouts.response_header` / `timeouts.stream_idle`，不新增。）

### 4.5 可观测（C1/C3 修订：全是 model+reason 维度改动，非纯复用）

**代码事实**：`publishRateLimitState`（`:323`）/ `getStatus`（`:559`）/ 事件 `system.rate_limit_state`（`events.ts:233` + `sinks/ws.ts:175`）/ `status/route.ts:90` **都无 model / reason 字段**，且 `_rateLimitPublisher`（`:19`）是模块级单例——per-model 实例若都经它发同名事件会互相混淆。

**接口改动清单**：
- `publishRateLimitState` / `getStatus` / `system.rate_limit_state` 事件类型 / WS sink / `/api/status` 形状**统一新增 `model` + `reason`（`429` \| `upstream-overload`）维度**。
- `/api/status` 与 telemetry 从「只读全局单例」改为「全局单例 + governor 注册表聚合」，暴露每模型背压状态。
- 过载事件、窗口跳闸、进/出 overload 背压 → 全量 telemetry（richest-data-flow），带 model 维度 + reason tag。

### 4.6 信号来源辨识与上报接缝（新增，解决 B2/B3）

D2/D3/D4 隐含「上游 idle 超时可识别、可重试」，但代码里**pre-response TTFB abort 不可辨识、`aborted` 不可重试**，须先补：

- **B2 来源辨识**：`http2-client.ts:397-400` `onPreResponseAbort` 无视 `signal.reason`、一律 `reject(abortError())`；`abortError()`（`:300-304`）产 generic `name="AbortError"`。故 **TTFB-timeout / 客户端断开 / shutdown / reaper-cancel 四种 abort 被抹成同一个**，`classify.ts:60-67` 统归 `type:"aborted"`。**若 bridge「abort→记过载」会把客户端断连误判为模型过载**。
  - **前置要求**：TTFB timer 用**独立错误标识**（专用 `UpstreamTtfbTimeoutError`，或 h2 层透传 `signal.reason`），使 pre-response idle 超时与客户端断连可分。**仅** TTFB-timeout 计入窗口，客户端断连**绝不**计入。
  - 注：**mid-stream idle 已可辨识**（`StreamIdleTimeoutError` → `classifyStreamError==="idle-timeout"`，`stream.ts:86`；driver `:497/:617` 已特判 `client-abort`），此腿无 B2 问题；B2 仅限 pre-response TTFB 腿。
- **B3 可重试性**：grep 全仓 strategies/codec，**无任何 strategy `canHandle("aborted")`**（`server-error-retry.ts:43`=server_error、`network-retry.ts:41`=network_error）。故今天 TTFB-timeout→`aborted`→无 strategy→**直接失败不重试**（report.md `req_300` 印证）。D4「像 REFUSED 一样 network-retry」**须把 TTFB-timeout 从 `aborted` 重分类为可重试类型**（依赖 B2 的来源辨识——在抹平的 abort 上重分类会把客户端断连也变可重试、重放已废弃请求）。**这是重分类改动，非复用。**

### 4.7 过载事件判别精度（C4/N3 修订）

- **REFUSED 精确判别（C4）**：`classify.ts:76-83` 把 `NGHTTP2_REFUSED_STREAM` 与 ECONNRESET/ETIMEDOUT/DNS/TLS 同归 `network_error`。bridge 若「network_error→记过载」会把一般网络抖动误计。**须在 bridge 用 `apiError.raw` 重跑 `isRetryableHttp2StreamError`（`http2-client.ts`）只认 REFUSED**，别停在字面 type。
- **5xx 范围（N3）**：D2「所有 5xx」须**排除** `503-upstream-ratelimited`（已被 `classify.ts:173` 上游吸收为 `upstream_rate_limited`，属 429 家族、走全局），只计真 server_error（502/504/500）。

## 5. 组件边界

| 单元 | 职责 | 依赖 | 可独立测 |
|---|---|---|---|
| `PerModelOverloadGovernor` | per-model 窗口 + 背压编排 + `rejectAllQueued`（C2） | `AdaptiveRateLimiter`（复用 pacing/队列/recovery，非 execute 的 429 分支） | ✅ opus 跳闸不影响 haiku 单元 |
| 滞动窗口计数器 | N-in-M 事件计数 + 跳闸判定 | 无（纯逻辑 + 时钟） | ✅ fake timers |
| 信号桥 | driver 两处 catch → `reportOverloadSignal`（§4.3，**driver 层非 transport**） | `classifyError` / `classifyStreamError` + REFUSED 精判（§4.7） | ✅ |
| 来源辨识前置 | `UpstreamTtfbTimeoutError` 使 TTFB 超时 ≠ 客户端断连（§4.6 B2） | `http2-client.ts` abort 路径 | ✅ |

## 6. 测试策略

- **窗口**：fake timers 确定性驱动 N-in-M 跳闸 + 恢复。
- **per-model 隔离**：opus 单元跳闸，断言 haiku 单元仍 normal。
- **层序不吞 429（B4）**：断言 429 只被内层全局限流器捕获、governor `gate()` 不吃 429（守卫测试锁层序契约 §4.1）。
- **idle-timeout 计入窗口（B1）**：在 `runResponseSink`/`runResponseBufferedSink` catch 注入 `StreamIdleTimeoutError` → 断言 `reportOverloadSignal(model,"idle_timeout")` 命中窗口。
- **来源辨识（B2）**：断言**客户端断连的 abort 绝不计入窗口**、仅 `UpstreamTtfbTimeoutError` 计入。
- **可重试重分类（B3）**：断言 TTFB-timeout 重分类后被 network-retry 认领；客户端断连**不**被重试。
- **信号分类精度（C4/N3）**：REFUSED 计入、一般 network_error（ECONNRESET/DNS）**不**计入；`503-upstream-ratelimited` 不计入（走 429 家族）。
- **复用状态机**：per-model 实例的 rate-limited/recovery 复用现有 `AdaptiveRateLimiter` 测试骨架 + reason-tag 断言。
- **背压不误伤 429**：429 仍只触发全局层（守卫测试锁边界）。

## 7. 实现分期（预留、待立项细化——本轮不实现，N1）

> 本 spec 状态为「可选后续增强、只出规格」。下列分期与 §9 开放问题是**立项时**的起点，非本轮交付。

- **Phase 0（前置，B2/B3）**：`UpstreamTtfbTimeoutError` 来源辨识 + `aborted`→可重试重分类。**其余 phase 依赖它**。
- **Phase 1**：`PerModelOverloadGovernor` + 滞动窗口 + 复用 `AdaptiveRateLimiter`（pacing/队列/recovery + 新增 `tripRateLimited(reason)` / `paceOnly` 入口，纯单元、不接线）。
- **Phase 2**：信号桥挂 driver 两处 catch（§4.3）+ 请求路径接线（governor 外层、全局 429 内层，§4.1）+ 配置 + `rejectAllQueued` 接 shutdown（C2）+ model/reason 可观测（§4.5）。

## 8. 风险 / 权衡

- **复用 vs 双层**：请求过两层限流器增加一层间接，但复用状态机避免重造，净收益。
- **per-model 内存**：每活跃模型一个 `GovernorUnit`（handful 量级），懒创建，可加空闲回收（deferred）。
- **窗口参数默认**：`N=3/M=120s` 是初值，需生产观测校准（telemetry 支撑）。
- **恢复策略**：per-model 独立恢复复用现有 gradual recovery，行为已 battle-tested。
- **接缝改动面（审查后修正）**：B1–B4 揭示本特性并非「纯复用」——需动 h2 abort 来源辨识、error 重分类、`execute()` 层序、publish/status 的 model+reason 维度、shutdown drain 五处接缝。这些是**立项时的真实工作量**，spec 已在 §4.1/§4.3/§4.5/§4.6/§4.7 逐条钉死接缝与 `file:line`。

## 9. 开放问题（实施前定）

- `GovernorUnit` 空闲回收策略（长期不活跃的模型条目）——可先不做，记 deferred（与 C2 unit 生命周期一并定）。
- 窗口是否需按 endpoint 再细分（目前只按 model）——默认否，YAGNI 边界待观测；若做则放大 per-model 内存（N2）。

## 10. 审查记录（2026-07-11 对抗审查，采纳情况）

对抗 subagent 亲读全部锚点代码，4 BLOCK + 5 CONCERN 全部**经代码核实成立**、已采纳修订本 spec：

| 项 | 结论 | 采纳位置 |
|---|---|---|
| B1 流式 idle 不到 transport 上报点 | 成立（driver `:494/:615`） | §4.3 改上报接缝到 driver |
| B2 pre-response TTFB abort 来源被抹平 | 成立（`abortError()` generic） | §4.6 前置 `UpstreamTtfbTimeoutError` |
| B3 `aborted` 无 retry strategy | 成立（grep 空） | §4.6 D4 改为重分类、非复用 |
| B4 `execute()` 硬编码吞 429、层序矛盾 | 成立（`:211-223`） | §4.1 层序契约（governor 外 / global 内 + `paceOnly`） |
| C1 `enterRateLimitedMode` private 无参 | 成立 | §4.2 接口改动清单 |
| C2 governor 队列不在 shutdown drain | 成立（`shutdown.ts:397`） | §4.2 `rejectAllQueued` |
| C3 status/telemetry 读全局单例 | 成立 | §4.5 governor 注册表聚合 |
| C4 REFUSED 并入通用 network_error | 成立（`classify.ts:76`） | §4.7 用 `isRetryableHttp2StreamError` 精判 |
| C5 kind 分类在 driver 非 transport | 成立 | §4.3 接缝修正 |
| N1/N2/N3 | 采纳 | §7 标预留、§9 内存、§4.7 排除 503 |

无「未采纳」的审查意见——全部客观代码事实。判断结论（方向 D1/D6/D7 站得住）与本项目裁判轴（长远正确 + 完整）一致。

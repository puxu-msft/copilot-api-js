# Spec：上游超时归因剩余缺口补全（upstream-timeout-attribution-gaps）

- 状态：**草案 v2（两轮 GPT reviewer 复核通过、可进 writing-plans）；待用户终审**
- 日期：2026-07-14
- 归属：`docs/spec/`；「上游传输可观测性子系统」（`docs/todo/upstream-transport-observability.md`）分解出的**子项目 1**。
- 背景：timeout 归因审计 `docs/timeout-attribution-audit.md`（G1-G5）。**G1 已被并发工作解决**（见 §1）。
- 边界邻居：request-timing-instrumentation（owns TTFB/时序）；upstream-error-client-shaping（owns 客户端可见错误形态）；均正交。

## 1. 动机与已澄清的现状（What & Why）

timeout 归因审计（2026-07-11）识别出上游超时/断流的 5 个归因缺口 G1-G5。**其中承重的 G1（跨端点流终止归因不一致）已被并发工作解决**：2026-07-14 的 commits `c08fd91b`/`7da31d21`/`1fbf5e35`/`91c3a296` 引入共享模块 `src/lib/upstream-stream-diagnostics.ts`（自述「the SINGLE emission point ... used by EVERY non-native-Anthropic response pump」），使 CC/Responses/Gemini + reverse 腿 + WS 的 `stream-error`/truncation 分支都发同一条 `[upstream-diagnostics] STREAM DISCONNECT` 富归因行（经 `logUpstreamStreamOutcomeError`/`logUpstreamStreamTruncation`）。

> **教训（记档）**：v1 spec 因复核过期审计时 grep 过窄（漏 `logUpstreamStreamOutcomeError`/`Truncation` 调用点）误判 G1 仍在。异模型 GPT reviewer 广口径 grep + git log 纠正。3 天前审计属过期二手源，须广口径 + git 时间线复核。

**本 spec（v2）范围＝已核实仍 live 的剩余缺口 G2/G3/G4/G5**（现状均在当前 HEAD 亲手复核）。**bus 化架构重构（原 v1 的 C 方案）折入子项目 3**——mid-stream 覆盖已工作，把「各 pump 手动调共享 primitive」重构成「driver 单点 + bus 事件」的主要受益方是子项目 2/3 的订阅需求，宜等它们有真消费者时按真 schema 设计，不在本片对可工作代码空转。

## 2. 范围（用户 2026-07-14 拍板：方案 A）

补全四个仍 live 的归因缺口，均为**加性、低回归**的结构化补充；**不**重构已工作的 mid-stream 归因路径。

| 缺口 | 现状（当前 HEAD 已核实） | 本 spec 落点 | 量级 |
|---|---|---|---|
| **G4** | 连接层三处超时是裸 `Error(...)` 字面、零结构化归因 | 对称 pre-header 归因 primitive | 主 |
| **G5** | disconnect 行只报 `upstreamKeepaliveDelay`；middlebox-hint 恒指 tcp keepalive 旋钮，对 http2 指错 | 补 h2ping/idle 旋钮 + 提示按 transport 选旋钮（**改单一 formatter 一处**） | 中 |
| **G3** | `classifyStreamError` 仍只 `instanceof`，undici `UND_ERR_BODY_TIMEOUT` 落 "other"→误标 | 补 undici code 识别 | 小 |
| **G2** | Anthropic 流式 post-commit header 超时合成错误帧但无操作者日志 | 补 warn，与非流式对齐 | 小 |

## 3. G4：连接层 pre-header 超时对称归因 primitive（主）

连接层超时**不是 mid-stream 流终止**（发生在收到首帧之前），不该走 `[upstream-diagnostics] STREAM DISCONNECT`。加对称 primitive：

```ts
// upstream-diagnostics.ts 新增（与 logUpstreamStreamDisconnect 并列）
export function logUpstreamConnectTimeout(info: {
  phase: "tls" | "proxy-connect" | "ws-first-event"
  deadlineMs: number
  target: string          // origin / proxy host:port
}): void
// 输出：`[upstream-diagnostics] CONNECT TIMEOUT phase=<p> deadline=<n>ms target=<t>`
```

三处 throw 前调用：
- TLS connect — [http2-client.ts:199](../../src/lib/transport/http2-client.ts#L199)（`onTimeout` → `settle(new Error("[http2] TLS connect timeout ..."))`）。
- proxy CONNECT — [proxy-connect.ts:149](../../src/lib/transport/proxy-connect.ts#L149)。**实现细节（reviewer HIGH）**：调用必须放在 `fail()` **内部**（`fail` 有 `if (settled) return` 去重，[proxy-connect.ts:137](../../src/lib/transport/proxy-connect.ts#L137)），否则 socket 竞态可能多次发。
- WS first-event — [upstream-ws-attempt.ts:159](../../src/lib/openai/upstream-ws-attempt.ts#L159)。

## 4. G5：disconnect 行补旋钮 + 收敛两模块

**现状**：disconnect 行的 `keepalive=` 只读 `state.upstreamKeepaliveDelay`（[upstream-diagnostics.ts:241](../../src/lib/upstream-diagnostics.ts#L241)）；middlebox-reclaim 提示恒指向 `tcp_keepalive_probe_delay` 一个旋钮（[:252](../../src/lib/upstream-diagnostics.ts#L252)）。对 http2 transport，h2 PING 才是承重保活，提示会指错旋钮。

> **单一 formatter（reviewer 复核纠正）**：`[upstream-diagnostics] STREAM DISCONNECT` 行的字符串拼接**只有一处**——[upstream-diagnostics.ts:235](../../src/lib/upstream-diagnostics.ts#L235) `logUpstreamStreamDisconnect`（唯一定义 + 唯一调用点 [upstream-stream-diagnostics.ts:110](../../src/lib/upstream-stream-diagnostics.ts#L110)）。新模块 `upstream-stream-diagnostics.ts` 的 `emitDisconnect` 只**采集信号后委托**给它（为避免 `~/lib/error` 循环 import 而拆的 leaf，非平行格式化实现）。故 G5 **无「收敛两实现」的工作**，只改这一个函数。

**落点**（全部在 `logUpstreamStreamDisconnect` 一处）：
1. `keepalive=` 字段扩为 `keepalive=<tcp>s h2ping=<n>s idle=<n>s`（读 `upstreamKeepaliveDelay`/`upstreamH2PingInterval`/`streamIdleTimeout`）。
2. middlebox-reclaim 提示按 runtime/transport 分支：http2 → 建议 `upstream_transport.h2_ping_interval`；否则 `tcp_keepalive_probe_delay`。
3. `emitDisconnect`（采集 leaf）**不需改动**——字段已透传给唯一 formatter。

## 5. G3：classifyStreamError 补 undici code

[stream.ts classifyStreamError](../../src/lib/stream.ts) 在现有 `instanceof` 后补 `error.code` 识别，防 undici body 空闲超时被误标 transport-close：

```ts
  // ... 现有 instanceof 分支 ...
  if (isErrorWithCode(error, "UND_ERR_BODY_TIMEOUT")) return "idle-timeout"
  if (isErrorWithCode(error, "UND_ERR_HEADERS_TIMEOUT")) return "idle-timeout" // 见决策
  return "other"
```

**决策（reviewer 澄清风险方向）**：`UND_ERR_HEADERS_TIMEOUT` **归入既有 `idle-timeout`**，不新增 `header-timeout` kind。理由：三个 `StreamErrorKind` 消费点（[stream-error.ts:35](../../src/lib/openai/stream-error.ts#L35)、[error-shaping.ts:220](../../src/lib/anthropic/error-shaping.ts#L220)、[gemini:534](../../src/routes/gemini/handler-v4.ts#L534)）**均 `switch...default` 兜底**（非穷尽 Record）——新增 kind 不报编译错、会被**静默吞进 default**（`server_error`/`api_error`），反而丢语义。归入 idle-timeout 复用既有客户端语义，零下游改动。（headers-timeout 严格说是 pre-first-byte，但 body/headers 两者都归 idle-timeout 已足够修正「误标 transport-close」这个原始缺口。）

## 6. G2：post-commit header 超时补操作者日志

Anthropic 流式 post-commit header 超时在 [post-commit-error.ts](../../src/routes/messages/post-commit-error.ts) 合成错误帧（header-wait-timeout 情形，[:103](../../src/routes/messages/post-commit-error.ts#L103)）但无操作者日志。补一条与非流式 [forward.ts:556](../../src/lib/error/forward.ts#L556) `consola.warn(Upstream response-header timeout in ... (Ns))` 同信息量的 warn（method/path/`responseHeaderTimeout`s）。

## 7. 测试（真相域：empirical，防自证）

- **G4**：三 phase（tls/proxy-connect/ws-first-event）各造一次连接超时，断言发了 `[upstream-diagnostics] CONNECT TIMEOUT phase=... deadline=...`。proxy-connect 场景**连跑多次**验证 socket 竞态下不重复发（`fail()` 内 dedup 生效）。
- **G5**：断言 disconnect 行含 `h2ping=`/`idle=`；http2 场景断言提示指 `h2_ping_interval`、非 http2 指 `tcp_keepalive_probe_delay`；**回归 golden 只锁字段数值、不锁 middlebox-hint 提示文字**（G5 本就改它）。（无「两 formatter 一致」断言——只有一个 formatter。）
- **G3**：`classifyStreamError({code:"UND_ERR_BODY_TIMEOUT"})`→`idle-timeout`、`UND_ERR_HEADERS_TIMEOUT`→`idle-timeout` 的单测；**正样本**先证一个真 `StreamIdleTimeoutError` 仍→idle-timeout（不回归）。
- **G2**：Anthropic post-commit header 超时断言有 warn 行（含 method/path/秒数）。
- **无回归红线**：Anthropic 今天的 disconnect 行**字段数值不倒退**（G5 收敛/补字段后 ⊇ 今天）。

## 8. 范围红线（明确不做）

- **不**做 bus 事件化 / driver 单点重构（折入子项目 3——`docs/todo/deferred-backlog.md`）。coverage 已工作，本片只补 G2-G5 加性缺口。
- **不**碰连接级 GOAWAY/PING/session/多路复用关联（子项目 2）。
- **不**做 history/metrics/ui（子项目 3）。
- **不**碰时序/TTFB（request-timing spec）。
- **不**改 keepalive/PING/retry **行为**，只补**可观测**。

## 9. 采纳的评审结论（v1→v2，两轮 GPT reviewer）
- G1 已解决 → 移出范围（v1 BLOCK：现状已被并发 2026-07-14 工作推翻）。
- G4 proxy-connect 调用置于 `fail()` 内防竞态重复（v1 应改）。
- G3 `UND_ERR_HEADERS_TIMEOUT` 归 idle-timeout 而非新 kind（v1：switch-default 静默吞风险）；`isErrorWithCode` 守卫全仓无既有实现，plan 阶段新写（或内联 `(error as NodeJS.ErrnoException)?.code`，参考 `process-identity.ts:146`）。
- G5 回归 golden 不锁 hint 文字（v1 应改）；**「收敛两 formatter」前提错误——只有一个 formatter（`logUpstreamStreamDisconnect`），`emitDisconnect` 只委托；G5 只改一处**（v2 应改，已修）。
- bus 架构折入子项目 3（用户方案 A）。
- G2/G3/G4 现状 + 行号经 reviewer 逐行核实准确；涉及的 8 个文件在全部 15 个并发 worktree 上无未提交/未合并改动，无并发碰撞风险。
- **v2 复核裁决：可进 writing-plans。**

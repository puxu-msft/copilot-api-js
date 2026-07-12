# WS 上游保活可行性 PoC — 结论（Task 4.1 / spec R5.1）

> 归属：`docs/plan/2026-07-09-codex-responses-tier1-hardening/plan-4-upstream-keepalive.md` Task 4.1。
> PoC 代码：`probe-api.mjs`（PoC-A）、`probe-tcp-keepalive.mjs`（PoC-B）。实测环境：`bun 1.3.14` / `node v24.16.0`、undici `7.28.0`、`ss` iproute2-6.1.0、Linux WSL2。

## TL;DR（承重结论）

**计划的前置假设（“undici WHATWG WebSocket 无 `ping()`”）只对 Node 成立、对 Bun 不成立**——这是本 PoC 的核心实测更正。`import { WebSocket } from "undici"` 解析到**哪一个实现取决于运行时**：

| 运行时 | `import {WebSocket} from "undici"` 解析到 | 有 `.ping()`？ | 有 socket 访问器？ | 默认 TCP keepalive？ |
|---|---|---|---|---|
| **Bun**（`dev`/`start` = `bun run ./src/main.ts`，主运行时） | Bun 原生 `globalThis.WebSocket`（native code） | **是**（`ping`/`pong`/`terminate`，实测可发真帧） | 否 | **否**（`ss` 实测无 keepalive timer） |
| **Node**（发布 npm CLI `dist/main.mjs`，`#!/usr/bin/env node`） | npm undici 7.28.0 WHATWG WebSocket | 否 | 否 | 未设 |

**两条运行时都不改变承重判定**（spec R5.1 预置分支仍然成立）：即便在 Bun 上 `.ping()` 可用，WS PING 是**控制帧**、不产生应用层 `ResponsesStreamEvent`，因此**不重置** `state.streamIdleTimeout` 帧-idle guard（与 h2 PING 完全同构）。故 app-level WS ping 至多是一层**预防**（防 middlebox/GHC edge 收割空闲但活着的连接），**不是恢复**、也不延长 300s 合法静默预算。**WS 长静默的承重恢复防线仍是 Phase 3 的 buffered 重试**（对 WS 比 h2 更关键，因为 Node 运行时连预防层都没有）。

---

## PoC-A —— 客户端 WS 的 `ping()` / socket 访问器（`probe-api.mjs`）

原型链枚举 `import { WebSocket } from "undici"` 得到的实现。**实测原始输出**：

**Bun 1.3.14：**
```
undici version (from package): 7.28.0
prototype-chain members: CLOSED, CLOSING, CONNECTING, OPEN, URL, addEventListener,
  binaryType, bufferedAmount, close, constructor, dispatchEvent, extensions, onclose,
  onerror, onmessage, onopen, ping, pong, protocol, readyState, removeEventListener,
  send, terminate, url
has ping(): true
has pong(): true
socket/dispatcher-like member names: (none)
```

**Node v24.16.0：**
```
members: CLOSED, CLOSING, CONNECTING, OPEN, addEventListener, binaryType,
  bufferedAmount, close, constructor, dispatchEvent, extensions, onclose, onerror,
  onmessage, onopen, protocol, readyState, removeEventListener, send, url
has ping(): false
socket-like: (none)
```

**判定：**
- **Bun**：`import {WebSocket} from "undici"` 恒等于 `globalThis.WebSocket`（`U === globalThis.WebSocket` 实测 `true`，`toString` 为 `function WebSocket() { [native code] }`）。Bun 用**原生 WebSocket 替换了整个 `undici` 模块导出**——它带 `ping()`/`pong()`/`terminate()`。⟹ 计划假设在 Bun 上**不成立**。
- **Node**：真正的 npm undici 7.28.0 WHATWG 实现，**无 `ping()`**（undici 源码里 `ping` 是一个内部 `static`，构造后即 `Reflect.deleteProperty(WebSocket, 'ping')` 从公开面删除，仅作模块内部导出——外部消费者拿不到）。⟹ 计划假设在 Node 上**成立**。
- **两条运行时都无 socket / dispatcher 访问器**（无 `socket`/`_ws`/`fd` 等成员）——底层 upgrade socket 不经 WHATWG 面暴露。

## PoC-B —— `.ping()` 功能性 + TCP keepalive（`probe-tcp-keepalive.mjs`）

对 loopback `Bun.serve` WS 服务端（`127.0.0.1`、临时端口、`finally` 停服）建立客户端 WS，实测两问。**实测原始输出**：

**Bun 1.3.14：**
```
[bun] undici.WebSocket === globalThis.WebSocket: true
[bun] client WebSocket has ping(): true
[bun] loopback server: ws://127.0.0.1:35587
[bun] client connected (readyState=OPEN)
[bun] Q1 client.ping() -> server received PING frame: true
[bun] Q2 ss -tnope (sockets on :35587):
ESTAB 0 0 127.0.0.1:35587 127.0.0.1:45206 users:(("bun",pid=...,fd=13)) ...
ESTAB 0 0 127.0.0.1:45206 127.0.0.1:35587 users:(("bun",pid=...,fd=12)) ...
[bun] Q2 socket carries timer:(keepalive,...): false
[bun] server stopped
```

**Node v24.16.0：**
```
[node] runtime = v24.16.0
[node] undici WebSocket.prototype has ping(): false
[node] (loopback ss probe skipped — Bun.serve is Bun-only; run under bun for the wire test)
```
（Node 下的 loopback WS 服务端需引入 `ws` 依赖，未做；PoC-A 的原型扫描已是 Node 侧的权威结论——无 `ping()`。）

**判定：**
- **Q1（功能性 ping，Bun）**：`client.ping()` **真的把 WS PING 控制帧发上了线**——loopback 服务端的 `Bun.serve` `ping` 回调触发（`pingReceived === true`）。这不是“有个方法名”，而是 wire 层可用。⟹ Bun 上 app-level WS ping **功能性可行**，是 `scheduleH2KeepalivePing` 的直接 WS 类比物。
- **Q2（TCP keepalive）**：Bun 客户端 WS 的 upgrade socket **默认不带** `timer:(keepalive,...)`（`ss -tnope` 实测两端都无 keepalive timer）。对比 h2 路径：`http2-client.ts` 显式 `tlsSocket.setKeepAlive(true, delay)`，`ss` 能看到 keepalive timer——WS 路径没有等价的显式设置，也**没有 WHATWG 面的开关**（无 socket 访问器）。
- **可配置性**：WHATWG 构造器不暴露 socket，故**无法**像 h2 那样 `socket.setKeepAlive()`。Node 侧 undici 的 `WebSocketInit` 接受 `dispatcher` 选项，理论上可传一个 `connect` 工厂里调 `socket.setKeepAlive()` 的自定义 `Agent`——但这是 **Node-only**（Bun 的 shim 用原生实现、忽略 dispatcher）、**未实测**、且**同样不重置帧-idle guard**（TCP keepalive 只保 L4，不产应用帧）。不作为本次落地项。

---

## h2 vs WS 上游保活能力对比

| 保活层 | h2 路径（`http2-client.ts`） | WS 路径（`upstream-ws-connection.ts`） |
|---|---|---|
| **TCP keepalive（L4，防 NAT/middlebox 断连）** | ✅ 显式 `tlsSocket.setKeepAlive(true, delay)`，`ss` 实测有 `timer:(keepalive)` | ❌ 默认无，WHATWG 面无 socket 访问器不可设（Node 理论上可经自定义 dispatcher，未实测、Node-only） |
| **应用层 PING（防连接-idle reaper）** | ✅ `scheduleH2KeepalivePing` 周期 `session.ping()` | ⚠️ **仅 Bun**：`client.ping()` 实测可发真帧；**Node**：undici 无 `ping()`，不可行 |
| **是否重置我方帧-idle guard（`streamIdleTimeout`）** | ❌ 不重置（PING 非应用帧） | ❌ 不重置（WS PING 是控制帧、非 `ResponsesStreamEvent`） |
| **> 300s 合法 reasoning 静默存活** | ❌ 被 guard 杀（需调大 `streamIdleTimeout`） | ❌ 被 guard 杀（同一 knob，R5.3） |
| **掉线后的恢复（承重）** | buffered 重试（Anthropic 已成熟） | **buffered 重试（Phase 3，WS 的承重恢复防线，spec R5.1）** |

**GHC 上游是否转发/容忍带外 WS 帧？** —— 本 PoC `no-auto-server`、不联 GHC，故未实测；且此问题的实践意义有限：Node 运行时压根发不出 WS ping，Bun 运行时虽能发但**收益未经真实 GHC 证明**（不像 h2 PING 有过实测收割观测：112s 静默后无 `message_stop` 关闭）。要证明 Bun WS ping 的真实收益，需对真实 GHC 上游做长静默保活对照实验（承重前提，尚无观测数据）。

## 承重判定（spec R5.1 预置分支）

计划 Task 4.1 的预置结论——“若 WS 两层保活皆不可行 → Phase 3 buffered 重试成为 WS 承重恢复防线”——**结论成立，但推理路径经实测更正**：

- 不是“WS ping 全然不可行”，而是“WS ping **仅 Bun 可行、且只是预防层、且真实收益未证**”。
- 恢复（掉线后重试拿回结果）**只能**由 Phase 3 buffered 重试提供；预防层（TCP keepalive / WS ping）无论是否可用，都**不构成恢复**、也不救 > 300s 的合法静默。
- 因此 **buffered 重试对 WS 的承重程度 ≥ 对 h2**：h2 至少有实测有效的双层预防（TCP keepalive + h2 PING）；WS 在 Node 运行时**零预防层**，在 Bun 运行时只有一层未证收益的 ping。

## 落地（Task 4.1 Step 4）

- **TCP keepalive**：不可经 WHATWG 面配置、默认不开 → **不落地代码**（无 speculative code），记入 `docs/todo/deferred-backlog.md`。
- **Bun-only app-level WS ping**：功能性可行但（a）运行时不对称（Node CLI 无此能力）、（b）仅预防非恢复、不重置 idle guard、（c）真实 GHC 收益未证 → **不落地 speculative 代码**，作为带完整根因/触发条件的 backlog 项记录（`defer-potential-demand-over-cut-it`：记录而非静默砍）。
- **防误加注释**：`upstream-ws-connection.ts` 顶部加指向本结论的注释——**关键是别把注释写成“WS ping 不可能、别加”**（那对 Bun 是假的），而是准确写明“运行时分裂 + 只是预防层 + 不重置 idle guard + 收益未证 → 见 backlog”。

---

## Idle-guard margin —— 结论（Task 4.2 / spec R5.3）

> 归属：`docs/plan/2026-07-09-codex-responses-tier1-hardening/plan-4-upstream-keepalive.md` Task 4.2。
> 锁定测试：`tests/responses/upstream-idle-margin.unit.test.ts`（3 tests，FakeClock 确定性、10× 无 flaky）。

**承重结论：`state.streamIdleTimeout`（默认 300s）是上游帧-静默上限，SSE 与 WS 同一 knob，且不被下游/连接级保活延长。**

- **同一 knob**：SSE 路径（`guardSseIterable`，responses/handler.ts + fallback.ts）与 WS 路径（`raceIteratorNext`，upstream-ws-attempt.ts 的 `streamWsEvents`）都从**同一** `state.streamIdleTimeout` 派生 `idleTimeoutMs`（`state.streamIdleTimeout > 0 ? *1000 : 0`）。300s 上限对 SSE、WS、h2 一致。
- **两个独立 racer**：下游客户端保活（Phase 2，`makeSseSink`/`makeWsSink` 的 heartbeat）是**驻留在 sink 的 SOFT forward-idle racer**（注入客户端 ping，让 Codex 自己的 300s reader deadline 不在合法静默上误杀）；上游帧-idle guard 是**驻留在 transport 的 HARD racer**（上游 `streamIdleTimeout` 无帧则杀流）。一个下游 ping **不是**上游帧，故**永不重置**上游 guard。锁定测试全程触发真实下游保活 timer（同一 FakeClock），断言上游 guard 仍在 `streamIdleTimeout` 精确 idle-kill——若保活能重置 guard，`rejects(StreamIdleTimeoutError)` 永不 settle、测试失败（已用变异体证明断言有牙）。
- **连接级保活也不重置**（承接 4.1）：WS PING（Bun-only 控制帧）/ h2 PING / TCP keepalive 保**连接**活但**不产应用帧**，故同样不重置帧-idle guard。
- **§1.1 事件非本 guard 触发**：§1.1 是 124s < 300s（详见本报告 §1.1 语境），是**关闭码 bug**（`1001` 被 undici 同步抛 → 降级被击败），已 Phase 0 修（`1001→1000` + try/catch）。**不是** idle guard 误杀。

**运维建议（非强制改默认）：**
- **合法 > 300s 静默 reasoning**：若某模型真会连续 > 300s 不产任何中间帧，需**调大** `streamIdleTimeout`（config `timeouts.stream_idle`）；下游保活**不代偿**（它只防 Codex reader 端超时，不延长本代理的上游 guard，也救不回一条真正 wedged 的上游连接——那是 Phase 3 buffered 重试的职责）。
- **300s 默认对 gpt-5.5 是否足够**：reasoning 模型通常有中间帧（token/进度事件），每帧刷新两端 deadline，故 300s **连续零帧**窗口在实践中极少触及。默认**不改**（无证据其错，且与 Codex 自身 300s reader deadline 对齐）；确遇长静默上游再按上条调大即可。

---

## 2026-07-12 — GHC 服务端 WS idle 计时器对 client PING 的响应（gate 问题）

> 归属：本 gate 问题决定「是否值得写 Bun-only 周期 `socket.ping()` 上游 WS 保活」（类比 `scheduleH2KeepalivePing`）。
> PoC 代码：`probe-ghc-idle.mjs`（PoC-C，真打 GHC 上游）、`smoke-ghc-ws.mjs`（wire 正样本对照）。原始逐行日志：`raw-poc-c-run-logs.txt`。
> 实测环境：`bun 1.3.14`、undici `7.28.0`、Linux WSL2；账号类型 enterprise（token 响应 `endpoints.api = https://api.enterprise.githubcopilot.com` → `wss://api.enterprise.githubcopilot.com/responses`）。鉴权非交互：读 `~/.local/share/copilot-api/github_token`（40B `gho_…`）→ 打 `https://api.github.com/copilot_internal/v2/token` 换 copilot token，全程**未碰 4141 用户主服务器**（pid 602300，只读旁路）。

### 裁决：gate 问题 **INCONCLUSIVE**；工程决策 **不要写 WS ping 代码（NO）**

两者不矛盾——literal gate 问题因**正样本对照未成立**而 INCONCLUSIVE，但实验产出了一个**比原假设更强**的结论，直接否掉了 ping 代码的价值。

**承重实测事实：GHC 对上游 WS 静默连接在 ≤462s 内没有任何可观测的 idle-close。** 5 次运行（gpt-5.5 `reasoning.effort=high`、单条 `response.created` 于 0.4s 后进入**单个**长静默、末尾一次性 burst 全部 content + `response.completed`）：

| 臂 | run | 最长单次静默（无帧）| 静默期 PING 数 | 结局 | close |
|---|---|---|---|---|---|
| no-ping | 1 | 266.0s | 0 | 正常完成（1721 events）| `code=1000 reason=""` |
| no-ping | 2 | 284.8s | 0 | 正常完成（4977 events）| `code=1000 reason=""` |
| no-ping | 3 | 352.4s | 0 | 正常完成（5106 events）| `code=1000 reason=""` |
| ping | 1 | 381.8s | 38 | 正常完成（5723 events）| `code=1000 reason=""` |
| ping | 2 | 462.1s | 46 | 正常完成（5860 events）| `code=1000 reason=""` |

**每一条**（含 no-ping 的 352s、ping 的 462s）都撑过了长静默、拿到完整响应、正常关闭。**没有任何一次** GHC 主动 `close(1000, "idle timeout")`。

### 逐项对照经验裁判轴

1. **正样本对照未成立 → gate INCONCLUSIVE（不许推断 YES）**。rubric #1 要求 no-ping 臂**先真的复现** GHC 的 pre-first-event `close(1000, "idle timeout")`。它**没有复现**——三次 no-ping（静默 266/285/352s）GHC 全部维持连接到正常完成。既然 GHC 的 idle 计时器在 ≤352s 从未触发，就**无法**判断 client PING 是否会重置它；严格标 INCONCLUSIVE，**不从 ping 臂"没被掐断"推断 YES**（ping 臂本来就没进入任何 GHC idle 窗口）。
2. **wire 正样本先证**（`smoke-ghc-ws.mjs`）：trivial 请求 0.74s 收到 `response.created`、1.41s `response.completed`、11 帧——证明鉴权/握手/发送/接收链路真通，长静默存活不是"根本没连上"的假象。
3. **时序确定性**：no-ping 3 次 + ping 2 次，静默从 266s 递增到 462s，结论（GHC 不 idle-close）**5/5 稳定**，非单次侥幸。
4. **Bun-only caveat**：本实验在 Bun 下跑，`import{WebSocket}from"undici" === globalThis.WebSocket`、`.ping()` 存在且真发帧（承接 PoC-A/B）。Node 发布版无 `.ping()`——即便结论是 YES 也只对 Bun 成立。此处结论是 NO/moot，运行时分裂不改变它。

### 生产 `close(1000, "idle timeout")` 的真正来源：**GHC-originated 关闭帧**，不是我方 line-129（2026-07-12 归因更正）

> ⚠️ 本节更正本报告初版的错误归因。初版曾断言"生产 close 是我方 300s guard"——**错**。经 coordinator 三处代码事实核对 + 复核源码，生产那条 close 是 **GHC 服务端主动发的关闭帧**。三条铁证：
>
> 1. **大小写**：line 129 是 `closeUpstreamWs(socket, "Idle timeout")`——**Title-Case**。全仓 grep：我方**所有** `closeUpstreamWs` reason 都是 Title-Case（`"Idle timeout"`/`"Parse error"`/`"Socket error"`/`"Handshake failed"`/`"Send failed"`/`"Going away"`），`src/` 里**没有任何一处**发出小写 `idle timeout`，也**没有**对 reason 做 `toLowerCase`。而生产日志 `closeEvent.reason` 是**小写** `idle timeout`——只能是 **GHC 关闭帧回填**进 `CloseEvent.reason`（`CloseEvent.reason` 携带对端发来的 close-frame reason）。
> 2. **busy gating**：line-129 的 `scheduleIdleClose` 有 `if (!socket || busy || ...) return`（connection.ts:125）——**只在非-busy（空闲池连接）时**开火。而生产日志是 `mid-request`。`handleClose` 的 mid-request 日志（connection.ts:230-231）只在 `busy && currentQueue` 时打；line-129 的空闲关闭走到 handleClose 会在 227 行 `if (!busy||!currentQueue) return` 直接返回，**不可能**产生 mid-request 日志。
> 3. **错误串路径**：生产 fallback 的 `Upstream WebSocket closed (1000: idle timeout)` 逐字来自 handleClose:231 的 **close-EVENT 路径**（`${closeEvent.reason}` 回填）。我方 300s `responseHeaderTimeout` fetch-timeout abort 走的是 onAbort→failRequest（`"request aborted"`/`"first-event timeout"`），**不产生**这个串。故生产事件是**真 GHC close 帧**，不是我方 guard 掐的。

**为什么我 5 次没复现？regime 不同。** 生产日志是 **pre-first-event**（`failed before first event, falling back to HTTP (5/3)`）——GHC 在**连 `response.created` 都还没发**时就自己 idle-close 了。而我 5 次 probe 里 `response.created` **恒在 0.4s 到达**（请求被即时受理），我全程处于 **post-first-event** 的帧间静默 regime。两者是**正交的两个问题**：

### 两个正交问题（reconciliation 成立）

- **问题 A（GHC pre-first-event idle-close，真实、我未复现）**：GHC 在某条件下（我未触及——可能大 input / 后端排队 / 负载 / edge，使 GHC 迟迟不发 `response.created`）会**自己**发 `close(1000, "idle timeout")`。我的触发器每次都拿到 0.4s 的 `response.created`，从未进入这个 pre-first-event 静默窗口，故**5 次未复现**、也**无从测** client PING 是否能重置 GHC 这个 pre-first-event 计时器。对问题 A，literal gate **INCONCLUSIVE**（且 ping 的价值**未证**，不能说无用、也不能说有用）。修复方向：**per-model 熔断**（连续 pre-first-event 失败→暂停 WS 走 HTTP，即现有 `consecutiveFallbacks`/half-open 机制）+ buffered 重试恢复。
- **问题 B（我方 300s guard 对 gpt-5.5 太短，我的实测发现、独立 bug）**：gpt-5.5 `effort=high` 在 WS 上的典型形态是**单个 266–462s 连续零帧静默**、末尾一次性 burst 全部 content（5000+ 帧）+ `response.completed`——**无**周期性中间帧刷新 deadline。post-first-event 路径 `streamWsEvents` 用 `raceIteratorNext(idleTimeoutMs = streamIdleTimeout*1000 = 300s)`（upstream-ws-attempt.ts:211）。故 **`response.created` 后到 burst 之间 >300s 的合法静默，会被我方 `streamIdleTimeout` 在 300s 掐死**（抛 `StreamIdleTimeoutError`，症状是 post-first-event 的 stream-error，**不同于**问题 A 的 pre-first-event fallback 日志）。**即使 GHC 不掐（实测 ≤462s 不掐），我方也会掐**。这是一个当前潜伏/已发生的独立 bug。

> 这更正了本报告 §124 旧断言"reasoning 模型通常有中间帧…300s 连续零帧极少触及，默认不改"——**实测反驳**：gpt-5.5 的正常形态就是 400s+ 单个零帧静默。

### ping 代码：仍**不落地**，但理由更新（非"证明无用"，而是"未证有用 + 有更确定的修复"）

- 对**问题 B**：WS PING 是控制帧、不产生 `ResponsesStreamEvent`、**不重置** `streamIdleTimeout`（PoC-A/B + Task 4.2 已定）——ping 对 B **确定无用**，B 的修复是**调大 guard**。
- 对**问题 A**：ping 是否能重置 GHC 的 pre-first-event 计时器**未证**（我未复现 A）。speculative 写 ping 不成立；且 A 有**更确定**的修复（per-model 熔断 + buffered 重试）。
- 结论：**现在不写 ping**。仅当未来**复现问题 A** 且**实测证明 client PING 能重置 GHC 计时器**时才重新评估。

### 承重修复建议值 + 风险

- **`streamIdleTimeout`（问题 B 承重修复）**：实测单次静默达 462s，且更难的 prompt 只会更长（462s 是**地板不是天花板**）。建议**≥600s**，且**优先做 per-model override**（gpt-5.5 类 reasoning 模型给 600s+，其余保持 300s）而非全局一刀切——因为这是 SSE/h2/WS **共用的同一 knob**（Task 4.2），全局调大会同时拖慢 SSE/h2 的死连接检测。
- **`responseHeaderTimeout`（pre-first-event，对问题 A 价值有限）**：仅当 GHC "慢但活着"时有用；若 GHC 自己先 close（问题 A 实况），我方 timeout **moot**。可小幅上调（300→420–600s）配合熔断，但别指望它单独解决 A。
- **调太大的风险**：真正 wedged/死连接要拖到 timeout 才被 reap，占着连接池槽位 + 延迟客户端失败/fallback。**缓解 = 与恢复层配合**：(1) **buffered 重试**让长 timeout 不等于丢结果（Phase 3）；(2) **per-model 熔断**（连续 pre-first-event 失败 trip → 暂停 WS）让问题 A 不至于反复长等；(3) **per-model override** 把死连接检测延迟的代价只加在真需要的模型上。注意 buffered 重试**单独不够**治 B——若每次尝试都 >300s 静默，每次都撞同一堵 300s 墙，**必须**配合调大 guard。

### 交付边界

- 未复现问题 A（GHC pre-first-event idle-close）——我的触发器恒得 0.4s `response.created`，进不了该 regime。要闭合 literal gate（GHC pre-first-event 计时器阈值 + ping 是否重置），需构造能让 GHC 迟发 `response.created` 的触发器（疑似大 input / 特定负载），再跑 no-ping 正样本复现，然后加 ping 臂对照。
- 已确证：post-first-event regime 下 GHC ≤462s 不 idle-close（5/5 稳定），问题 B 独立于 GHC 行为成立。

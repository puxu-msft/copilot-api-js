# Spec: buffered 模式 keepalive —— `empty_text` 合成锚点兑现 buffered pre-commit 的 300s 断连边界

- **状态：草案（draft）——已过三轮对抗性 subagent review（含新锚点机制 C1/H1/H2 修复）+ 一轮用户设计定夺（见 §9）。待用户终审后进 writing-plans。**
- **日期：** 2026-07-08
- **Owner：** 排查会话（起于两条 320s `client disconnected` incident）
- **前身：** [anthropic-keepalive-content-delta.md](anthropic-keepalive-content-delta.md)（`content_delta` keepalive 本体）。本 spec **兑现该 spec §6「已知边界/暂缓」第 3 条**（L2 buffered pre-commit：commit 前不转发任何帧 → openBlock 恒空 → 心跳 fallback ping → 若 >300s 仍断），并扩展 `stream_keepalive_mode` enum。
- **相关 skill：** `claude-code-connection`（CC 两层 watchdog + 合成帧标记）、`ghc-anthropic-upstream`（thinking-signature 毒化）、`empirical-verification`（客户端 SDK oracle）、`persistence-async-invariants`（buffered-retry 信号）、`large-refactor`（commit invariants）。
- **相关 ADR：** [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)（合成帧必打可辨识标记）。

---

## 0. TL;DR

buffered 模式（`protect_streaming_generation` = `on` / `tool_use_only`，用于 buffered-retry：扣住所有真实帧到 message_stop，让上游中途失败可对客户端透明重试）在 commit 前**不向客户端写任何真实帧**，导致 sink 的 openBlock 状态机（[client-sink.ts](../../src/lib/pipeline/client-sink.ts) `noteBlockState`，只从写给客户端的帧学结构）恒空 → 心跳只能 fallback 裸 `ping`。裸 ping 压得住 CC 第一层 60s byte-idle watchdog，但**压不住第二层 300s no-real-content watchdog**（只认真实 `content_block_delta`）。于是 heavy thinking 类请求（上游在 `content_block_start` 后合法静默数百秒、已知 >600s）会在 ~300s 撞 CC 断连。

**修复 = 新增 keepalive 模式 `empty_text`（`stream_keepalive_mode` 的第三个值，设为新默认）**：buffered pre-commit 无 forwarded open block 时，**懒注入一个合成空 text 锚点块**（`content_block_start{text}` @index 0），心跳发空 `text_delta{text:""}` 重置 CC 300s；真实生成内容**全部照旧缓冲**（buffered-retry 透明性 100% 保留），commit 时真实块落 index+1（统一 remap）、锚点以空 text 收口。

**为什么合成锚点优于 eager 真实首块**（设计演进见 §9 Round 3）：真实内容一帧不提前泄露 → buffered-retry 完全透明；锚点跨重试恒定 → **无结构发散对账**；空 text 块收口 known-benign（我方 `filterEmptyAnthropicTextBlocks` 本就剥空 text）→ **无 thinking/tool_use 毒化门控**；支持**全部**首块类型（thinking/text/tool_use/redacted，真实首块类型与锚点无关）；懒注入 → 快响应（<心跳间隔即 commit）**字节等价**、零锚点。

**核心锚点：** 配置 [schema.ts:501](../../src/lib/config/schema.ts#L501)（enum + 默认）· 锚点注入 + 收口 + remap [driver.ts](../../src/lib/pipeline/driver.ts) `runResponseBufferedSink` · 心跳触发锚点 [client-sink.ts](../../src/lib/pipeline/client-sink.ts) `makeSseSink` heartbeat · 合成标记 [history/types.ts](../../src/lib/history/types.ts) `SseEventRecord.synthetic`。

---

## 1. 问题（实测锁定的根因链）

### 1.1 Incident

两条 Claude Code 请求（用户日志）：

```
[FAIL] 12:22:06 POST /v1/messages claude-opus-4.8 320.2s ↑613.8KB ↓532B: client disconnected req_1783513006062_77
[FAIL] 12:27:26 POST /v1/messages claude-opus-4.8 320.3s ↑613.8KB ↓531B: client disconnected req_1783513326351_78
```

req_78 恰在 req_77 断连时刻起 = CC 断连后的**顺序重试**（非孪生双请求）。两条对 613.8KB 巨型上下文的 heavy-thinking 请求，同样 320s 同样断。

### 1.2 History 记录（独立 oracle，两条同构）

经 4141 History API 取两条记录（`state: aborted`, `durationMs: 320140/320227`, `responseBytes: 532/531`）：

| 轨道 | 内容 |
|---|---|
| **上游轨**（`upstreamResponse.sseEvents`，真实、`synthetic=None`） | 仅 `message_start`(offset 1ms) + `content_block_start`(offset 2ms, `{type:thinking, thinking:"", signature:""}`)，之后 320s **零帧**（`upstreamResponse.success=false`）。`attempts[0].responseHeaders` 有完整 14 个头（含 `x-copilot-service-request-id`）→ 上游确返回了 200 响应头 |
| **forwarded 轨**（`clientResponse.sseEvents`，发给 CC） | **16 个 `ping`**（offset 9ms、20s、40s…、`synthetic:"keepalive"`），零真实帧。respBytes 532 ≈ 16 个 ping 帧字节数——客户端连 `message_start` 都没收到 |

### 1.3 根因链（三层守卫赛跑）

1. `protectStreamingGeneration=tool_use_only`（**运维热改/本地覆盖的活配置**——仓库 checked-in [config.yaml:532](../../config.yaml#L532) 与 state 默认均为 `false`，即默认不进 buffered 路径、本 incident 不发生；本次实例由运维显式开启 `tool_use_only`）+ CC 必带 tools → **buffered=true**。
2. `streamCommitAfterSec=20`：20s 窗口内上游未返回响应头 → 走 delayed-commit COMMIT 路径（开 200 + 心跳，`await p` 内继续）。
3. `p`（driver.runRequest）在上游返回 200 headers 后 resolve，[handler-v4.ts:571](../../src/routes/messages/handler-v4.ts#L571) 用同一 sink 跑 `pumpAnthropicStreamingV4(buffered=true)`。
4. buffered pump（[driver.ts:521 `runResponseBufferedSink`](../../src/lib/pipeline/driver.ts#L521)）把所有 rendered client frame `buffer.push()`，**只在 commit（`drained && (sawMessageStop || sawUpstreamError)`）时一次性 `sink.write()` flush**。上游 stall 在 `content_block_start` 后（heavy thinking 合法静默），从未到达 message_stop → 一帧真实帧都没 `sink.write` → sink openBlock 恒空。
5. sink 心跳（[client-sink.ts:243](../../src/lib/pipeline/client-sink.ts#L243)）`typeof pingFrame === "function"` 但 `openBlock === undefined` → provider 回退 `ANTHROPIC_PING`。配 [handler-v4.ts:517](../../src/routes/messages/handler-v4.ts#L517) 冷启动首帧硬编码 `ANTHROPIC_PING` → 整条流 16 个 ping。
6. CC 两层 watchdog（skill `claude-code-connection` 实测）：ping 压住第一层 60s byte-idle，但第二层 **300s no-real-content 只认真实 `content_block_delta`、不认 ping** → ~300s 断，报 `Stream idle timeout - no chunks received`。
7. 我方上游 idle HARD 守卫 `streamIdleTimeout=900s` 远松于客户端 300s → 等它时客户端早死；buffered-retry（`protectStreamingMaxRetries=3`）依赖上游 attempt 被判失败才触发，900s 内没触发 → 重试从未启动。CC 顺序重试（req_78）同样 320s 再断。

**关键定性（用户确认）：** 上游不是「死」而是「合法地慢」——heavy thinking 下 GHC 在 `content_block_start(thinking)` 后静默数百秒（thinking 在上游侧算完才回吐），**已知有 >600s 先例**。故这是纯粹的**客户端保活问题**，不是上游故障。

## 2. 范围决策（与用户敲定）

- **只修 client keepalive**：让 CC 撑过其 300s watchdog，直到合法慢的上游（≤~900s）吐出内容。
- **不做 stall 快检**：任何 ~120s 的「no-content-yet」快检都会**误杀合法的 heavy-thinking 请求**并触发无谓重试。保留 900s 上游 idle 守卫（900 > 已知 600s 先例，够容纳）。
  - record-not-adopted：「上游 stall 快检提前触发 buffered-retry」——被否，因 heavy-thinking 合法慢，快检会误伤。若未来出现「真 stall 与 heavy-thinking 可区分的信号」再单列 spec。
- **重试触发仍依赖现有 900s 上游 idle 守卫**：稀有（仅上游真 idle >900s，或 truncation RST），不因本 spec 改动重试触发时机。
- **仅 buffered 路径**：live（非 buffered）路径的 keepalive 已由前身 spec 修好（真实帧流过 sink.write，openBlock 天然正确）；`empty_text` 在 live 路径退化为与 `content_delta` 等价（恒有真实 open block，不触发锚点）。本 spec 不改 live 行为。

## 3. 设计：`empty_text` 合成锚点 keepalive

### 3.1 config：`stream_keepalive_mode` 增第三值 `empty_text`（新默认）

现有 enum `["ping", "content_delta"]`（[schema.ts:501](../../src/lib/config/schema.ts#L501)，默认 `content_delta`）扩为 **`["ping", "content_delta", "empty_text"]`，默认改 `empty_text`**。全链同前身 spec §3.3：schema → state（[state.ts:279/1270](../../src/lib/state.ts#L279) 类型 + 默认）→ config.ts apply → bundled `config.yaml` 注释 + hot-reload 矩阵。三模式语义：

| mode | 有 forwarded open block（live / buffered post-anchor） | buffered pre-commit 无 open block |
|---|---|---|
| `ping` | 裸 ping（不重置 300s） | 裸 ping |
| `content_delta` | 空 delta 匹配 open block（重置 300s） | fallback 裸 ping（= 本 incident 现状） |
| **`empty_text`（默认）** | 同 `content_delta`（空 delta 匹配 open block） | **懒注入合成空 text 锚点**（§3.2）→ 之后即「有 open block」发空 `text_delta` |

即 `empty_text` = `content_delta` 的**严格超集**：唯一区别是 buffered pre-commit 无 open block 时，不再 fallback ping、而是注入锚点。**live 路径行为不变**——不是因为「live 恒有 open block」（live 也有 pre-first-block 窗口：message_start 后、首 content_block_start 前，`noteBlockState` 不认 message_start → 无 open block），而是因为**只有 buffered pump 注册 `injectAnchor` 闭包、live pump（`runResponseSink`）不注册**（§3.3 M1），故 live 该窗口仍退 ping、逐字节不变。运维可回退 `content_delta`/`ping` 保留旧行为。

### 3.2 机制：合成空 text 锚点

buffered pre-commit 期间，若心跳到期且**无 forwarded open block**（`empty_text` 模式），注入一个**合成空 text 锚点**：
1. 先转发缓冲里的**真实 `message_start`**（若尚未转发；协议要求它先于任何 content_block_start）。
2. 转发**合成** `content_block_start{content_block:{type:"text",text:""}, index:0}` —— 经 `sink.write` → `noteBlockState` 自动点亮 openBlock={0,text}。
3. 本次及后续心跳 → 空 `text_delta{text:""}`（重置 CC 300s，前身 spec 覆盖矩阵实证 ✅）。
4. **真实生成内容全部照旧缓冲**（锚点是纯合成物，不含任何真实内容 → buffered-retry 透明性 100% 保留）。

commit（或终末失败）时：
5. 转发合成 `content_block_stop{index:0}` 关闭锚点（空 text 块 known-benign，§3.6）。
6. flush 真实缓冲帧，**所有真实 content_block_* 的 `index` 统一 +1**（锚点占了 index 0，§3.3 remap）。

客户端最终 content 序列 = `[0]=空 text 锚点, [1]=真实块0, [2]=真实块1, …`——协议合法，锚点渲染为空。

**层次约束（reviewer H2）：** `driver.ts` 是 **format-agnostic**（[driver.ts:6-13](../../src/lib/pipeline/driver.ts#L6) 明写「No format is wired here」，渲染一律委托 `deps.codec.renderResponse`）——它**不能自造** Anthropic 的 `content_block_start{text}`/`content_block_stop`，也不能做 Anthropic-aware 的 index JSON 重写。故锚点帧构造 + remap helper 必须由 Anthropic handler/codec 经 **`RunBufferedOpts` 新字段注入**（同现有 `onRenderedFrame`/`escalate` 的注入范式），driver 只负责编排「**何时**注入/收口/remap」、写不透明帧。新增约意如 `RunBufferedOpts.anchor?: { startFrame: ClientFrame; stopFrame: ClientFrame; remap(frame: ClientFrame, offset: number): ClientFrame }`（Anthropic handler 提供）。

**为什么用 text 而非 thinking 作锚点：** thinking 块需 signature、空/无签名 thinking 会毒化下轮（skill `ghc-anthropic-upstream`）；空 text 块我方 `filterEmptyAnthropicTextBlocks` 本就在 inbound 剥除 → 下轮不会毒化上游，known-benign。`text_delta{text:""}` 与 `thinking_delta{thinking:""}` 同样重置 CC 300s（前身 spec 矩阵）。

### 3.3 懒注入 + sink/pump 协调 + index remap

**懒注入（footprint 最小化）：** 锚点只在**心跳真正到期且无 open block** 时注入——快响应（在首个心跳间隔 `stream_keepalive_ping_sec` 内即 commit）**从不触发锚点、字节等价于今**。慢/stall 响应才带锚点。

**协调（心跳在 sink、message_start 在 pump 缓冲）：** 心跳 timer 在 sink（[client-sink.ts](../../src/lib/pipeline/client-sink.ts)）；但锚点需先转发 pump 缓冲里的 `message_start`。故 pump 向 sink heartbeat 配置注入一个 **`injectAnchor()` 闭包**（捕获 pump 的 message_start 引用 + 共享 `anchorState`）；心跳 tick 在 `empty_text` 模式 + buffered + 无 open block + 未注入 + message_start 已到 时调用它。JS 单线程：pump 挂在 `for await` 时，sink 的 setTimeout 回调仍可跑该闭包（访问 pump 闭包态 + sink.write）；`injectAnchor` 在首个 `await` 前**同步写完全部 `anchorState` 字段**（injected/reservedIndex/sentMessageStart）→ 无撕裂。

**心跳接口扩展（reviewer M1）：** 现 `pingFrame` 是纯 provider（[client-sink.ts:69](../../src/lib/pipeline/client-sink.ts#L69)），tick 用**内部 `writeSse`**（[client-sink.ts:243-245](../../src/lib/pipeline/client-sink.ts#L243)）——它**不调 `noteBlockState`**（只有公开 `write` 才点亮 openBlock，[client-sink.ts:195-197](../../src/lib/pipeline/client-sink.ts#L195)）。故：(a) heartbeat opts 新增可选 side-effecting 钩子承载 `injectAnchor`；(b) tick 新增分支「有 injectAnchor + 无 open block + 未注入 → 调 injectAnchor（经**公开 `write`** 转发 message_start + 合成 start(0)，使 `noteBlockState` 点亮 openBlock={0,text}）」而非走 provider；(c) sink 是否 buffered 由「injectAnchor 是否注册」隐式判定（live pump 不注册 → live 不受影响，见 §3.1）。后续 tick 见 openBlock={0,text} → 空 `text_delta{text:""}`。

**C1 竞态修复（reviewer CRITICAL）：** commit flush 是 `for (frame of buffer) await sink.write(frame)`（[driver.ts:590](../../src/lib/pipeline/driver.ts#L590)），**每个 `await` 让出事件循环 → 心跳 timer 可在 flush 中途 fire `injectAnchor`**。若 commit 入口按「未注入」路径开始 flush（真实块用原 index），中途注入的锚点 start(0) 会**与已按原 index flush 的真实块 index 0 碰撞** + 乱序 → 协议违规。**修法**：commit 分支入口（及终末失败收口入口）**第一步先解除心跳**（新增 `sink.freezeHeartbeat()`——`clearTimeout` 但不 `close` 整个 sink，区别于外层 finally 的 `sink.close()` [driver.ts:634](../../src/lib/pipeline/driver.ts#L634)），**再一次性快照 `anchorState.injected`**，整个 flush（收口 + remap）用同一快照值。使「注入」与「flush」互斥。

**index remap（reviewer M4，统一 +1）：** 快照 `injected===true` 时，pump flush 每个真实 content_block_* 帧的 `index` +1（对已 render 的 ClientFrame 做 JSON parse→改 index→reserialize），由 §3.2 注入的 `anchor.remap` helper 负责（**format-aware、只按 `type` 前缀 `content_block_*` 门控**——`message_delta`/`message_stop` 无 index、跳过；reviewer P4）；独立测试。未注入则不 remap（真实块原 index，字节等价）。

**message_start 去重（reviewer C1+H1，覆盖同 attempt + 跨重试）：** `anchorState`/`sentMessageStart` **hoist 到 `runResponseBufferedSink` 的 `for(;;)` 循环外**（`buffer` 每 attempt 重建 [driver.ts:536](../../src/lib/pipeline/driver.ts#L536)）。两类双发都须防：
- **同 attempt（reviewer H1）**：incident 中 message_start 在 1ms 即入 `buffer[0]`，锚点注入在 ~20s 把它提前转发——但它**仍在 buffer 中**，commit flush 会**再发一次**。故 `injectAnchor` 转发 buffer 里的 message_start 时须**从 buffer 移除它**（splice），或等价地 commit flush 按 `sentMessageStart` 显式跳过 message_start。**去重规则统一表述为「commit flush 跳过任何已转发的 message_start」**（覆盖同 attempt + 跨重试），非仅「跨重试」。
- **跨重试**：锚点已发 message_start 后，重试轮 attempt-N 的 message_start 亦按上述规则跳过。

这是**唯一**的跨 attempt 对账（远简于「eager 真实首块」方案的结构发散对账——锚点恒定、真实内容从未提前泄露，重试只是重新缓冲真实内容 flush 到 index+1；remap offset 跨重试恒 +1，reviewer P3）。

### 3.4 锚点生命周期与失败终末（reviewer M1）

- **注入一次**：`anchorState.injected` 幂等守卫，跨重试只注一次。
- **commit 成功**：入口先 `sink.freezeHeartbeat()` + 快照 `injected`（§3.3 C1）；`injected` 则先 `content_block_stop(0)` 关锚点、真实块 remap +1 flush；否则原样 flush（字节等价）。
- **终末失败**（exhaustion [driver.ts:632](../../src/lib/pipeline/driver.ts#L632) / H3 throw / H2 upstream error）：各终末分支入口同样先 `sink.freezeHeartbeat()` + 快照；若 `injected`，须在 error 帧**前**发 `content_block_stop(0)` 关锚点，否则客户端残留 open 锚点块（协议不完整）。空 text 锚点收口 known-benign。**注意（reviewer H2）**：收口 stop(0) 帧亦由 handler 经 `anchor.stopFrame` 提供、driver 只写；终末失败分支须能读到 `anchorState`（driver 编排层持有，跨 handler/driver 分工须确保可达）。
- **H1 usage（reviewer，用户接受）**：锚点注入已转发 attempt-1 的 `message_start`（携 `usage.input_tokens`/`id`）；重试后客户端复用它、input_tokens 停留 attempt-1 值。**仅当锚点已注入（慢响应）且随后重试**才发生——快响应无锚点、message_start 随 commit flush（attempt-N 真实值，无陈旧）。可用 flush 出的终末 `message_delta`（真实 output usage）部分纠正；`input_tokens` 陈旧为**已文档化的可接受降级**（计费/显示层，非协议破坏，用户已接受）。

### 3.5 合成帧标记（reviewer M2 + richest-data-flow ADR）

锚点的三类合成帧（`content_block_start{text}` / 空 `text_delta` / `content_block_stop`）全走 forwarded-track 采样并打 `SseEventRecord.synthetic` 标记：空 `text_delta` 沿用 `"keepalive"`（它就是保活）；锚点的 start/stop 打 `"anchor"`（结构性合成物，区别于真实 upstream start/stop）。**上游轨 `sseEvents` 绝不含锚点**（始终忠实）。下游 UI 据标记 dim + 标注。避免锚点被误当真实内容、掩盖上游沉默。

### 3.6 oracle：前导空 text 锚点对 CC 良性（empirical-verification）

合成锚点的毒化面**远小于** eager-thinking（空 text 而非空 thinking），但仍须实测确认（不凭推断）。用真实 CC 作 oracle（复用 `exp/cc-idle-280s/` 手法）验证：
- **保活有效**：buffered pre-commit 注入 text 锚点 + 空 `text_delta` → CC 存活 >300s（当前断）。
- **前导空 text 块良性 —— 须显式测「锚点 + 真实首块=thinking」最高危组合（reviewer M2）**：真正的风险不是空 text 本身，而是真实首块为 thinking 时流式序列变 `[0]=空text, [1]=thinking`——回传时若 thinking 不再首位，Anthropic 因「thinking 必须首块」400。已核实 `filterEmptyAnthropicTextBlocks`（[content-blocks.ts:11-25](../../src/lib/anthropic/sanitize/content-blocks.ts#L11)）在**请求侧**、`finalizeAnthropicSanitization` 内**无条件**调用（[sanitize/result.ts:51](../../src/lib/anthropic/sanitize/result.ts#L51)），剥 `text.trim()===""` → 空锚点回传被剥、thinking 复位首块 → 不 400（reviewer P5）。故设计成立，但 oracle **必须点名测这条链**：注锚点（真实首块 thinking）→ CC 流式期接受 `[空text, thinking]` → CC 下轮把该 assistant 消息发回 → 经 filter 剥空 text、thinking 复首 → 上游不 400。（非仅泛测「空 text 被剥」。）
- **retry 透明**：注锚点 → attempt-1 truncation → attempt-2 重生成 → 客户端只见连续锚点空 delta，真实内容 commit 时一次性 flush（index+1）、无双 message_start。

## 4. 剩余边界（本 spec 不覆盖，须文档化）

合成锚点支持**全部首块类型**（thinking/text/tool_use/redacted——锚点与真实首块类型无关），故 eager 方案的类型门控边界消失。仅剩：

- **纯 pre-message_start 静默**：上游返回 headers 但 `message_start` **尚未缓冲**时心跳到期——无 message_start 可先行转发 → `injectAnchor` 暂不可行、退 ping。极窄（incident 中 message_start 在 1ms 到达，20s 心跳时早已在缓冲）。可选未来增强：合成 message_start（usage/id 占位），本 spec 不做。
- **mode = `ping` / `content_delta`（运维显式选择）**：buffered pre-commit 无锚点 → ping → >300s 仍断。运维知情取舍（默认 `empty_text` 已避免）。
- **web_search bypass 路径**（前身 spec §6 第 2 条）：独立心跳（`streaming-pump.ts`），本 spec 不动（其亦可后续复用 `empty_text` 锚点）。

## 5. 触及文件 / 代码锚点

| 关注点 | 文件 |
|---|---|
| config 全链：enum 增 `empty_text` + 默认改 + 注释 + hot-reload | [schema.ts:501](../../src/lib/config/schema.ts#L501) · [state.ts:279/1270](../../src/lib/state.ts#L279) · `config/config.ts` · `config.yaml` |
| **编排**（format-agnostic）：何时注入/收口/remap + commit/终末入口 `freezeHeartbeat`+快照 injected（C1）+ message_start 去重（flush 跳过已发）；跨重试状态 hoist 出 `for(;;)`；新增 `RunBufferedOpts.anchor?:{startFrame,stopFrame,remap}`（H2：driver 只写不透明帧、不自造） | [driver.ts](../../src/lib/pipeline/driver.ts) `runResponseBufferedSink` + `RunBufferedOpts`（[types.ts](../../src/lib/pipeline/types.ts)） |
| 心跳接口扩展（M1）：opts 增 `injectAnchor` 钩子 + tick 分支（无 open block+未注入→经**公开 `write`** 转发 message_start+锚点 start，点亮 openBlock）+ 新增 `freezeHeartbeat()`（clearTimeout 不 close） | [client-sink.ts](../../src/lib/pipeline/client-sink.ts) `makeSseSink` |
| Anthropic 锚点帧构造（text start/stop）+ index remap helper（type-gate `content_block_*`）+ `resolveAnthropicKeepalive` 增 `empty_text` 臂；由 handler 填 `RunBufferedOpts.anchor` 传给 driver | [keepalive-frame.ts](../../src/lib/anthropic/keepalive-frame.ts) · [sse-frame.ts](../../src/lib/anthropic/sse-frame.ts)（`event:` 行不变量，P6）· 新 remap helper `src/lib/anthropic/` · [handler-v4.ts](../../src/routes/messages/handler-v4.ts) |
| 合成标记 `SseEventRecord.synthetic` 联合增 `"anchor"`（现仅 `"keepalive"`，[history/types.ts:154](../../src/lib/history/types.ts#L154)）+ 全消费端/UI 区分显示 | [history/types.ts](../../src/lib/history/types.ts) + UI |
| 实测 harness（保活 + 前导空 text 良性 **+ 真实首块=thinking 组合** + retry 透明） | `exp/`（复用 `exp/cc-idle-280s/` 手法） |
| 回归测试 | `tests/pipeline/`（注入/收口/remap/message_start 去重/**C1 flush 期心跳解除**单元）+ `tests/anthropic/`（活路径 e2e：buffered + 上游 stall 注入，证锚点 + 空 text_delta 非 ping） |

## 6. 验证方法（commit invariants + 实测）

- **根因复现 / CC 断连阈值**：`exp/cc-idle-280s/` 扩一臂 = buffered + `empty_text` + 上游 `content_block_start(thinking)` 后静默 → 证 CC 存活 >300s（`content_delta`/`ping` 臂仍断，作对照）。
- **懒注入字节等价**：断言快响应（<`stream_keepalive_ping_sec` 即 commit）**不注锚点、不 remap**、forwarded 轨与 `content_delta` 模式逐字节相同（footprint 零）。
- **锚点内容不泄露**：断言 buffered pre-commit forwarded 轨**只含** 真实 message_start + 合成锚点帧（打 `anchor`/`keepalive` 标记），**零**真实 `content_block_delta`（buffered-retry 透明性）。
- **收口 + remap**：断言 commit 时先 `stop(0)`（`synthetic:"anchor"`）、真实块 index 全 +1；未注锚点则真实块原 index、无 stop(0)。
- **终末失败收口（reviewer M1）**：注锚点后 exhaustion/H3/H2 失败 → error 帧**前**有 `stop(0)`、客户端无残留 open 块。
- **message_start 去重（reviewer C1+H1，覆盖同 attempt + 跨重试）**：① 同 attempt——注锚点（发 buffer 里的 message_start）→ 单 attempt 慢响应 commit → 断言 forwarded 轨 `message_start` 恰 1 次（flush 跳过已发）。② 跨重试——注锚点 → 重试 → 仍恰 1 次。
- **C1 flush 期心跳解除（reviewer CRITICAL 回归守卫）**：构造「commit 恰撞首个心跳间隔」的时序（FakeClock）→ 断言 commit 入口 `freezeHeartbeat` 后 flush 期心跳**不再 fire**、无中途注入、真实块 index 无碰撞/乱序。
- **前导空 text 良性 + retry 透明 oracle**：§3.6 真实 CC 实测（上线门控）。
- **H1 usage 陈旧**：文档化断言——注锚点后重试，客户端 `message_start.usage.input_tokens` 停留 attempt-1；若实现 message_delta 纠正，断言终末 usage 反映 attempt-N。
- **buffered-retry 信号完整**（persistence-async-invariants）：锚点不破坏 `onAttemptReset` / `commitAttemptSseEvents` / `onBufferedResolve` 计量。

## 7. record-not-adopted（评估过未采纳）

- **eager 转发上游真实首块**（本 spec 前一版设计，Round 3 被 `empty_text` 锚点取代）：否。真实结构提前泄露破坏 buffered-retry 透明性；需结构发散对账（TN===T0/TN!==T0）；空 thinking 块收口毒化需 oracle 门控；tool_use 首块携 name/id 无法安全 eager（退 ping）。合成锚点在每个维度更优（§9 Round 3）。
- **上游 stall 快检提前触发 buffered-retry**（§2）：否，heavy-thinking 合法慢会被误伤。
- **合成锚点总是注入（非懒）**：否，快响应也带前导空 text 块、非字节等价；懒注入 footprint 更小、协调成本可接受。
- **deadline-bounded buffering（临 300s flush + 转 live）**：否——stall 场景无内容可 flush，对本 incident 无效；且放弃 buffered-retry 太重。
- **锚点用 thinking 块**：否，空/无签名 thinking 毒化下轮；text 块 known-benign。

## 8. 相关

- 前身：[anthropic-keepalive-content-delta.md](anthropic-keepalive-content-delta.md)（本 spec 兑现其 §6#3、扩展其 `stream_keepalive_mode` enum）。
- buffered-retry 机制：[upstream-stream-truncation-detection.md](upstream-stream-truncation-detection.md)（L2 truncation → 缓冲重试）。
- thinking 毒化：[2026-07-07-thinking-signature-quarantine.md](2026-07-07-thinking-signature-quarantine.md) + skill `ghc-anthropic-upstream`。
- 合成帧须带 `event:` 行（否则 SDK 静默丢帧）：[sse-frame.ts](../../src/lib/anthropic/sse-frame.ts) `anthropicSseFrame` + skill `claude-code-connection`。
- 活的架构现状 + 运行时选项：[../DESIGN.md](../DESIGN.md)（`streamKeepaliveMode` / `protectStreamingGeneration` 行 + 流式写出行）。

## 9. 评审记录（三轮对抗性 subagent review + 用户设计定夺，2026-07-08）

裁判轴显式设为「长远正确 + 完整」（非 ROI/YAGNI）。客观事实全盘吸收，判断谨慎取舍并复核。

### Round 1 — 代码事实核查（file:line 锚点 vs 真实代码）
- 锚点高度准确，无杜撰。采纳：① `protectStreamingGeneration=tool_use_only` 是活配置非仓库默认（默认 `false`）→ §1.3#1 注明。② `onRenderedFrame` 签名做不到「写 sink + 不入 buffer」→ 分流须改缓冲循环/新回调（现锚点方案的注入亦不经它）。

### Round 2 — 对抗性正确性攻击（针对前一版 eager 真实首块设计）
- **C1（CRITICAL，采纳）**：`buffer` 每 attempt 重建（[driver.ts:536](../../src/lib/pipeline/driver.ts#L536) 亲验）→ 跨重试状态须 hoist 出循环、已发 message_start 须 DROP（现方案 §3.3 保留此修正，锚点方案下对账简化为仅 message_start 去重）。
- **H1（采纳）**：message_start usage 陈旧 → §3.4 文档化；懒注入使其仅在「慢响应+重试」发生。
- **H2（部分采纳 + 修正 reviewer 事实错误）**：reviewer 称「escalate 默认开启」**错**——亲验 `protect_streaming_escalate_context` 默认 `false`（[config.yaml:544](../../config.yaml#L544)）。其结构洞察（开启时删 thinking 上下文致重试发散）在 eager 方案下要求毒化门控；**锚点方案下发散对账整体消失**，该风险面不复存在。
- **M1/M2/M3/M4（采纳）**：M1 终末失败收口锚点（§3.4）；M2 合成帧打标记（§3.5）；M3 tool_use 首块泄露 name/id——**锚点方案根治**（真实首块从不 eager，全类型支持）；M4 index remap = ClientFrame JSON 重写 helper（§3.3）。
- **正样本 P1-P5**：核心保活机制（空 delta 重置 300s + flush 期 openBlock 自然推进 + telemetry 不受影响）经代码验证成立。

### Round 3 — 用户设计定夺：eager 真实首块 → `empty_text` 合成锚点
用户 Q2（tool_use 首块能否支持）引出更优方向：**不 eager 真实首块，改用合成空 text 锚点**。用户定：**做成可配置 `anthropic.stream_keepalive_mode`，新增 `empty_text` 值并设为默认**。合成锚点相对 eager 真实首块，在透明性/发散对账/毒化门控/类型支持/footprint 全维度更优（§0 + §7）。Q3（合成收口帧标记）→ 锚点方案下「reconcile」类别消失，锚点帧统一 `synthetic:"anchor"`（§3.5）。H1（usage 陈旧）用户接受。

### Round 4 — 对抗性审查新锚点机制（懒注入/remap/生命周期，全部采纳）
第三方 subagent 攻击新机制（前置事实确认：机制纯 spec 草案、代码零实现），发现均**代码接地、致客户端可见协议违规**，全部采纳：
- **C1（CRITICAL）**：commit flush 每 `await` 让出 → 心跳 timer 可中途 fire `injectAnchor` → 锚点 start(0) 与已按原 index flush 的真实块碰撞/乱序。**修**：commit + 终末收口入口先 `sink.freezeHeartbeat()`（clearTimeout 不 close）+ 一次性快照 `injected`，使注入与 flush 互斥（§3.3 C1 + §3.4）。
- **H1（HIGH）**：同 attempt message_start 双发——message_start 1ms 入 buffer[0]，注入时提前转发但**仍留 buffer**，commit flush 再发。**修**：去重规则改为「commit flush 跳过任何已转发的 message_start」，覆盖同 attempt + 跨重试（§3.3）。
- **H2（HIGH）**：`driver.ts` format-agnostic（「No format is wired here」），不能自造 Anthropic 锚点帧 / index JSON 重写。**修**：锚点帧构造 + remap helper 由 Anthropic handler 经 `RunBufferedOpts.anchor?:{startFrame,stopFrame,remap}` 注入，driver 只编排（§3.2 层次约束 + §3.4 + §5）。
- **M1**：`SseSinkHeartbeat` 无 injectAnchor 挂载点、tick 用内部 `writeSse`（不点亮 openBlock）。**修**：定义心跳接口扩展 + injectAnchor 经公开 `write`（§3.3 M1）。
- **M2**：真正约束是「thinking 必须首块」——oracle 须显式测「锚点 + 真实首块=thinking」最高危链（§3.6 M2）。已核实 `filterEmptyAnthropicTextBlocks` 请求侧无条件剥空 text（[content-blocks.ts:11-25](../../src/lib/anthropic/sanitize/content-blocks.ts#L11) / [result.ts:51](../../src/lib/anthropic/sanitize/result.ts#L51)）→ 设计成立。
- **M3**：`SseEventRecord.synthetic` 现仅 `"keepalive"`，须扩联合加 `"anchor"`（§5）。
- **正样本 P1-P8**：单一序列化链无字节交错、client-abort 无泄露、跨重试 remap offset 恒 +1、message_delta/stop 无 index、filter 请求侧剥空 text、`event:` 行不变量、懒注入字节等价（修 C1 后兑现）、commit 中途心跳退 ping 合法——均经代码验证成立。

未采纳：无客观发现被搁置。eager 真实首块方案整体被 `empty_text` 锚点取代（§7 记录理由）；Round 4 全部缺口已补入 §3.2-§3.6/§5/§6。

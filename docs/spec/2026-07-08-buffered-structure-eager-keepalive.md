# Spec: buffered 模式 structure-eager keepalive —— 兑现 buffered pre-commit 的 300s 断连边界

- **状态：草案（draft）——已过两轮对抗性 subagent review（见 §9），待用户终审后进 writing-plans。**
- **日期：** 2026-07-08
- **Owner：** 排查会话（起于两条 320s `client disconnected` incident）
- **前身：** [anthropic-keepalive-content-delta.md](anthropic-keepalive-content-delta.md)（content_delta keepalive 本体）。本 spec **兑现该 spec §6「已知边界/暂缓」第 3 条**（L2 buffered pre-commit：commit 前不转发任何帧 → openBlock 恒空 → 心跳 fallback ping → 若 >300s 仍断），思路与其第 2 条（web_search「占位 block + 真实 events index remap」）同源。
- **相关 skill：** `claude-code-connection`（CC 两层 watchdog + 合成帧标记）、`ghc-anthropic-upstream`（thinking-signature 毒化）、`empirical-verification`（客户端 SDK oracle）、`persistence-async-invariants`（buffered-retry 信号）、`large-refactor`（commit invariants）。
- **相关 ADR：** [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)（合成帧必打可辨识标记）。

---

## 0. TL;DR

buffered 模式（`protect_streaming_generation` = `on` / `tool_use_only`，用于 buffered-retry：扣住所有真实帧到 message_stop，让上游中途失败可对客户端透明重试）在 commit 前**不向客户端写任何真实帧**，导致 sink 的 openBlock 状态机（[client-sink.ts](../../src/lib/pipeline/client-sink.ts) `noteBlockState`，只从写给客户端的帧学结构）恒空 → 心跳只能 fallback 裸 `ping`。裸 ping 压得住 CC 第一层 60s byte-idle watchdog，但**压不住第二层 300s no-real-content watchdog**（只认真实 `content_block_delta`）。于是 heavy thinking 类请求（上游在 `content_block_start` 后合法静默数百秒、已知 >600s）会在 ~300s 撞 CC 断连。

**修复 = structure-eager keepalive**：在 buffered 缓冲循环里**只把 `message_start` + 第一个 `content_block_start` 提前转发给客户端**（其余内容/stop/后续 start/终末帧照旧缓冲），点亮 sink openBlock → 心跳自动发匹配当前块的空 content_delta（`thinking_delta{thinking:""}` 等）重置 CC 300s；真实生成内容仍只缓冲，保住 buffered-retry 不泄露内容的不变量。稀有重试若发生结构发散，用**空内容收口**关闭已开的客户端可见块 0（收口形状经实测验证，防 thinking 块毒化）。

**核心锚点：** [driver.ts](../../src/lib/pipeline/driver.ts) `runResponseBufferedSink`（缓冲循环分流 + flush 去重 + 重试对账）· [client-sink.ts](../../src/lib/pipeline/client-sink.ts)（openBlock 状态机已就绪，仅需结构帧流过）· 新增客户端可见结构状态机 primitive（跨重试对账）。

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
- **仅 buffered 路径**：live（非 buffered）路径的 keepalive 已由前身 spec 修好（真实帧流过 sink.write，openBlock 天然正确）。本 spec 不动 live 路径。

## 3. 设计：structure-eager keepalive

### 3.1 核心：只提前转发「开场结构」，锚定 openBlock

保活的唯一诉求是：**pre-commit 缓冲期让 sink 的 openBlock 非空**，好让心跳发匹配的空 content_delta（重置 CC 300s）。达成它的**最小且正确**干预 = 在 buffered 缓冲循环 [driver.ts:542-562](../../src/lib/pipeline/driver.ts#L542-L562) 里，**只把 `message_start` + 第一个「可空-delta 型」`content_block_start` 提前 `sink.write()` 转发**，其余全部照旧缓冲：

| 帧 | 处理 | 理由 |
|---|---|---|
| `message_start`（首个） | 提前转发（一次） | 开启客户端流；协议要求它先于任何 content_block_start。**注意**：携 `message.usage.input_tokens` / `message.id` / `message.model`（重试陈旧问题见 §3.4 H1） |
| **第一个** `content_block_start` **且 `type ∈ {thinking, text}`** | 提前转发（一次），点亮 sink openBlock={0, type0} | 心跳锚定块 0，整段生成期发匹配空 delta。**门控 thinking/text**：这两类的 `content_block_start` 载荷为空（无生成内容）；`tool_use`/`server_tool_use` 的 start 携 `name`+`id`（[recover-tool-call/stream.ts:89](../../src/lib/anthropic/recover-tool-call/stream.ts#L89)）= 生成内容，提前转发会泄露、削弱 buffered-retry → 不 eager（§4 边界） |
| 其余全部（`content_block_delta` 内容帧、`content_block_stop`、**后续** `content_block_start`、`message_delta`、`message_stop`；及首块为 `tool_use`/`redacted_thinking`/其他的 start） | 仍只入 `buffer`，commit 时 flush | 保住 buffered-retry「不泄露生成内容 + 可隐形重试」不变量 |

**为什么只需第一个 content_block_start（而非每个）：** buffered 生成中**客户端可见的唯一 open block 恒为首块 0**（后续块的 start/stop 全在 buffer 里、客户端不可见，即便上游已推进到块 1/2 静默）。锚定块 0 后，心跳整段发空 `thinking_delta(0)`（或 text_delta，按块 0 type）——客户端视角块 0 始终 open，空 delta 对它恒合法（SDK 累积 `""` 无害，前身 spec SDK oracle 实证）。commit flush 时按序发 `content(0), stop(0), start(1), content(1), …, message_stop`，客户端序列 = `start(0)[eager] + 空delta… + content(0) + stop(0) + start(1) + …` **协议合法**（空 delta 全落在块 0 real content 之前）。

**为什么不提前转发 `content_block_stop` / 后续 `content_block_start`：** 提前发 `stop(0)` 会让客户端认为块 0 已完结、但其真实内容还在 buffer → 客户端收到「空块 0」；且不发 stop(0) 就发 start(1) 又是「块 0 未关先开块 1」的协议违规。两难的根因是「stop 提前 = 提前 commit 块为空」——故 **stop 与后续 start 一律归 commit flush**，绝不 eager。

**为什么心跳无需改：** sink 已有 `keepaliveFrame(openBlock)` provider（[client-sink.ts:243](../../src/lib/pipeline/client-sink.ts#L243)）。openBlock 由 `noteBlockState`（[client-sink.ts:176](../../src/lib/pipeline/client-sink.ts#L176)）在 `sink.write` 里跑——被提前转发的 content_block_start(0) 点亮，且 commit flush 的真实结构帧（stop/start）流过 sink.write 时**自然推进** openBlock（flush 到 stop(0) → openBlock 清空、gap 内心跳暂回 ping；flush 到 start(1) → openBlock={1}），故 flush 期间心跳恒匹配当前 flush 块、无失效 delta（reviewer P2 实证）。**本 spec 不碰心跳/provider/config**。

### 3.2 注入点：统一的三态每帧决策（状态跨重试存活）

**关键正确性约束（reviewer C1）：** `runResponseBufferedSink` 的 `buffer` 在 attempt 循环**内部**每轮重建（[driver.ts:535-536](../../src/lib/pipeline/driver.ts#L535) `for(;;)` → `const buffer=[]`）。故「客户端可见结构状态」（`sentMessageStart` / 首块 `{index:0, type:T0}` / index remap 表）**必须 hoist 到 `for(;;)` 循环外**，跨 attempt 存活。否则重试轮里已发过的 message_start / start(0) 会落入缓冲、commit flush 重发 → 客户端收到**第二个 message_start / 重复 start(0)**（协议违规）。

对缓冲循环里每个 rendered `toWrite`，做**统一三态决策**（覆盖首 attempt + 所有重试，取代初稿「否则 buffer」的二段式）：

| 决策 | 触发条件 | 动作 |
|---|---|---|
| **EAGER-FORWARD** | ①`message_start` 且 `!sentMessageStart`；②首 `content_block_start` 且 `type∈{thinking,text}` 且首块状态未定 | `await sink.write(toWrite)` + 更新跨重试状态；**不**入 buffer |
| **DROP**（新增，修 C1） | 重试轮里：`message_start` 且 `sentMessageStart` 已真；或 `TN===T0` 复用的首 `content_block_start` | 既不 eager 转发、也**不入 buffer**（客户端已有，丢弃） |
| **RECONCILE**（发散） | 重试轮首 `content_block_start` 且 `TN!==T0` | 注入空收口 `stop(0)`（打 synthetic 标记，§3.4 M2）+ 起 index remap +1（§3.4 M4），该 start 按 remap 入 buffer |
| **BUFFER** | 其余全部 | `buffer.push(toWrite)`（含 index remap 改写，若 remap 生效） |

`retreated`（OOM cap）语义不变：eager/DROP 帧从不入 buffer，retreat flush 只发 `buffer` 内容，天然不双发。

### 3.3 flush 去重（commit 时）

commit flush [driver.ts:588-604](../../src/lib/pipeline/driver.ts#L588-L604) `for (frame of buffer) await sink.write(frame)` 不变——因为 EAGER-FORWARD 与 DROP 的帧**从不入 `buffer`**（§3.2），flush 只发缓冲的内容/stop/后续 start/终末帧。**不变量：`message_start` 恰转发一次；首 `content_block_start`（提前转发的那个）不被 flush 重发。** golden 守卫（§6）锁定。

### 3.4 稀有重试的结构对账 + 失败终末清理（best-effort）

跨重试状态机（§3.2 hoist 到循环外）记 `sentMessageStart` + 首块 `{index:0, type:T0}` + index remap 表。重试（truncation RST 或上游 idle >900s abort）或终末失败时：

**(a) 重试对账**（attempt-N 首 `content_block_start(0, type TN)`）：
- `TN === T0`（同结构）→ **DROP** 该 start（客户端已开块 0，复用）；attempt-N 块 0 内容照常 flush。
  - **H1 已知语义降级（reviewer）**：客户端复用的是 attempt-1 的 `message_start`，其 `message.usage.input_tokens` / `message.id` 停留在 attempt-1 值；若 attempt-N 上下文不同（见 H2），与实际提交的 body 不符。**缓解**：优先用 flush 出的 attempt-N 终末 `message_delta`（携真实 output usage）纠正客户端可见 usage；`input_tokens` 停留 attempt-1 值作为**已文档化的可接受降级**（计费/显示层，非协议破坏）。当前无-eager buffered 会 flush attempt-N 的 message_start（正确 usage）——此为 eager 引入的降级，须显式记录。
- `TN !== T0`（发散）→ **RECONCILE**：空收口 `stop(0)`（收口形状经 §3.6 实测定 + 打 synthetic 标记）+ **index remap +1**（§3.4(c)）。

**(b) 失败终末清理（reviewer M1，初稿漏）**：eager 转发 `start(0)` 后请求**彻底失败**（exhaustion [driver.ts:632](../../src/lib/pipeline/driver.ts#L632) / H3 throw / H2 upstream error），当前各终末分支只 `writeSynthetic` 一个 error 帧、**不闭合 eager 开的块 0** → 客户端残留「块 0 open（仅空 heartbeat delta、无 stop）+ error 帧」，同 §3.6 毒化维度。**须在 error 帧前发收口 `stop(0)`**（同 §3.6 形状 + synthetic 标记），纳入 oracle。

**(c) index remap 机制（reviewer M4，钉死）**：发散 remap 是对**已 render 的 ClientFrame** 做 JSON `index` 字段重写——attempt-N 每个缓冲帧（content_block_start/delta/stop）的 `index` 字段 +offset（客户端 index 空间与上游解耦）。由**新增 format-aware helper** 负责（逐帧 parse→改 index→reserialize），归属 §5、须独立测试。remap 表随 flush 平移。

**(d) 合成收口帧标记（reviewer M2）**：所有 RECONCILE/失败清理注入的空 `stop(0)` 是**新类别合成物**，须走采样 + 打 `SseEventRecord.synthetic:"reconcile"` 标记（区别于心跳的 `"keepalive"`），否则 forwarded 轨出现与真实 stop 无法区分的幻影帧，违背 richest-data-flow ADR（合成帧必打可辨识标记）。

**取舍（用户已认可）：** structure-eager 部分削弱 buffered-retry 透明性（发散多见一个空收口块 0 + H1 usage 陈旧）。鉴于 heavy-thinking 主场景是单 attempt 无重试、escalate 默认关（见 H2）故重试同结构居多，用主场景正确性（不再 300s 断）换稀有发散路径的复杂度/降级，好处远大于坏处。

### 3.5 提前转发帧的精确判定（实现须钉死）

structure-eager 只认以下提前转发，判定基于 rendered client frame（post-S5-rewrite）的 `type`（+首块 type 门控）：
- `message_start`：`type === "message_start"`，pre-commit 首次（`!sentMessageStart`）。
- 首 `content_block_start`：`type === "content_block_start"` 且首块状态未定 且 `content_block.type ∈ {thinking, text}`。首块为 `tool_use`/`server_tool_use`/`redacted_thinking`/其他 → **不 eager**（归 BUFFER，keepalive 退 ping，§4 边界）。

其余帧类型（`content_block_delta` 各 delta / `content_block_stop` / `message_delta` / `message_stop` / `error` / `ping`）一律不 eager。帧类型全集经代码核对为 8 种（[stream-accumulator.ts:152-186](../../src/lib/anthropic/stream-accumulator.ts#L152)）。

**注入实现（fact-check 修正）**：判定分流**不能**靠现有 `onRenderedFrame` 钩子——其签名 `(frame)=>ClientFrame|undefined`（[types.ts:257](../../src/lib/pipeline/types.ts#L257)）只能转换/丢弃一帧，做不到「写 sink + 不入 buffer」双动作，且它在 buffer.push 决策前运行、产出仍会入 buffer。故 eager 分流须**直接改缓冲循环** 或**新增 buffered 专用回调**（返回 `"eager" | "drop" | "buffer"` 路由信号 + 可选 remap 后帧），format-aware 判定 helper 由该回调调用，避免污染 format-agnostic 的 sink。

### 3.6 空块收口毒化 —— 实测验证提为上线门控（用户已定 + reviewer H2/M3）

若重试发散/失败终末需空内容收口块，空/无签名 thinking 块可能触发 CC 下轮 `thinking cannot be modified` 400（skill `ghc-anthropic-upstream`：空明文 thinking 毒化）。**须用真实 CC 作 oracle 实测**（复用 `exp/cc-idle-280s/` 手法）：合成空收口块喂真 CC，看下轮是否毒化/报 400。

- **oracle 须覆盖 thinking / text 两种收口形状**（reviewer M3；tool_use 首块已不 eager 故无需其收口）。据实测决定形状（候选：空 text 块替代 thinking 收口 / 可被 CC 丢弃的 sentinel / 复用 thinking-signature-quarantine 已落地的合成 sentinel）。
- **提为上线门控（reviewer H2）**：`protect_streaming_escalate_context` 默认 `false`（[config.yaml:544](../../config.yaml#L544)，故发散默认罕见），但它**接线进 buffered 重试**（[handler-v4.ts:977](../../src/routes/messages/handler-v4.ts#L977) `escalate`）——**一旦运维开启**，重试会激进删减 thinking-触发上下文 → attempt-2 很可能不再以 thinking 开场（`T0=thinking, TN=text`）→ 发散收口成**常规路径**。故收口形状的毒化 oracle **未通过则 structure-eager × escalate 组合不可上线**（非 best-effort）。**不凭推断下结论**（empirical-verification 纪律）。

## 4. 剩余边界（本 spec 不覆盖，须文档化）

本修复**非普适**：只保证「首块是可空-delta 型（thinking/text）且已到达」时 CC 存活。以下情形 keepalive 仍退 ping、若 >300s 仍撞断（reviewer L2 确认如实文档化）：

- **纯 pre-first-block 静默**：`message_start` 已发、首个上游 `content_block_start` **尚未到达**的窗口（或 pre-response cold-start，上游连 headers 都没返回）——无结构可锚定，openBlock 空 → ping。本 incident 里 content_block_start 在 2ms 到达，故 structure-eager 几乎立即生效；纯 pre-first-block 窗口（headers 已返回但首块 >300s 未到）罕见但存在（同前身 spec §6 第 1 条）。
- **首块为 `tool_use`/`server_tool_use`**：其 `content_block_start` 携 `name`+`id`（生成内容），提前转发会泄露 + 削弱 buffered-retry → 不 eager（§3.1 门控）→ ping。模型直接工具调用（非 heavy-thinking 主场景）时命中。
- **首块为 `redacted_thinking`**：无法发有意义空 delta（前身 spec 已 fallback ping），不 eager → ping。
- **web_search bypass 路径**（前身 spec §6 第 2 条）：独立心跳（`streaming-pump.ts`），本 spec 不动。

## 5. 触及文件 / 代码锚点

| 关注点 | 文件 |
|---|---|
| buffered 缓冲循环三态分流（EAGER/DROP/RECONCILE/BUFFER）+ flush + 重试/失败对账（核心）；跨重试状态须 hoist 出 `for(;;)` | [src/lib/pipeline/driver.ts](../../src/lib/pipeline/driver.ts) `runResponseBufferedSink` |
| openBlock 状态机（已就绪，仅需结构帧流过 `sink.write`） | [src/lib/pipeline/client-sink.ts](../../src/lib/pipeline/client-sink.ts) |
| 客户端可见结构状态机 primitive（新增，跨重试对账）+ index remap JSON 重写 helper（format-aware，逐帧改 `index`） | 新文件，`src/lib/pipeline/` 或 `src/lib/anthropic/` |
| 结构帧判定 helper（format-aware，thinking/text 首块门控）+ buffered 专用分流回调（返回 eager/drop/buffer 路由，**非** onRenderedFrame） | 新 helper + 回调（`driver.ts` opts 扩展） |
| 合成收口帧标记 `SseEventRecord.synthetic:"reconcile"`（区别于 `"keepalive"`） | [src/lib/history/types.ts](../../src/lib/history/types.ts) + UI 区分显示 |
| 实测 harness（thinking/text 空收口毒化验证，上线门控） | `exp/`（复用 `exp/cc-idle-280s/` 手法） |
| 回归测试 | `tests/pipeline/`（三态分流 + 重试对账 + 失败终末收口单元）+ `tests/anthropic/`（活路径 e2e：buffered + 上游 stall 注入，证 eager + 心跳空 delta 非 ping） |

## 6. 验证方法（commit invariants + 实测）

- **根因复现 / CC 断连阈值**：`exp/cc-idle-280s/`（真实 `claude` CLI + mock 上游），扩一臂 = buffered 模式 + 上游 `content_block_start(thinking)` 后静默 → 证修复后 CC 存活到 >300s（当前断）。
- **提前转发帧恰好转发一次**：golden 守卫扫 buffered 路径 forwarded 轨，断言 `message_start` 恰 1 次、且首 `content_block_start`（提前转发的那个 index）不被 commit flush 重发（§3.3 不变量）。注意多块生成的 forwarded 轨本就含多个 content_block_start（块 1/2…来自 flush），守卫只锁「提前转发的两帧不双发」，非「content_block_start 全局唯一」。
- **内容不泄露**：断言 buffered pre-commit 的 forwarded 轨**只含** `message_start` + 首 `content_block_start` + 合成心跳（空 delta / ping），**零** 真实内容 `content_block_delta`（保住 buffered-retry 不变量）。
- **重试对账（三态）**：单元测试 attempt-1 eager start(0) → attempt-1 truncation → attempt-2 `TN===T0`（**DROP** start(0)、不双发 message_start/start(0)，reviewer C1 回归守卫）/ `TN!==T0`（RECONCILE：空收口 + index remap +1）两路。
- **失败终末收口（reviewer M1）**：eager start(0) 后 exhaustion/H3/H2 失败 → 断言 error 帧**前**发了收口 `stop(0)`（打 `synthetic:"reconcile"`），客户端无残留 open 块。
- **首块门控（reviewer M3）**：首块 `tool_use`/`redacted_thinking` → 不 eager、keepalive 退 ping（断言无工具 name/id 提前泄露进 forwarded 轨）。
- **合成收口帧标记（reviewer M2）**：断言 RECONCILE/失败收口的 `stop(0)` 在 forwarded 轨带 `synthetic:"reconcile"`，与真实 stop 及 `"keepalive"` 心跳可区分。
- **空块收口毒化 oracle（上线门控，reviewer H2/M3）**：§3.6 真实 CC oracle 实测 thinking/text 收口形状；未过则 structure-eager × escalate 不上线。
- **H1 usage 陈旧**：文档化断言——`TN===T0` 复用后客户端 `message_start.usage.input_tokens` 停留 attempt-1；若实现 message_delta 纠正，断言终末 usage 反映 attempt-N。
- **buffered-retry 信号完整**（persistence-async-invariants）：structure-eager 不破坏 `onAttemptReset` / `commitAttemptSseEvents` / `onBufferedResolve` 计量。

## 7. record-not-adopted（评估过未采纳）

- **上游 stall 快检提前触发 buffered-retry**（§2）：否，heavy-thinking 合法慢会被误伤。
- **只对 text 块 structure-eager、thinking 仍 ping**：否，本 incident 恰卡在 thinking 块，修不了主场景。
- **deadline-bounded buffering（临 300s flush + 转 live）**：否作为主方案——stalled/静默场景无内容可 flush，对本 incident 无效；且放弃 buffered-retry 太重。structure-eager 更精准（只放行结构、内容仍受保护）。保留为「若 structure-eager 收口复杂度过高」的退路。
- **合成假 open block（不转发真实 content_block_start）仅供心跳**：否，commit flush 真实内容需与已转发结构匹配，转发真实 content_block_start 最干净、无对账二义。

## 8. 相关

- 前身：[anthropic-keepalive-content-delta.md](anthropic-keepalive-content-delta.md)（本 spec 兑现其 §6#3）。
- buffered-retry 机制：[upstream-stream-truncation-detection.md](upstream-stream-truncation-detection.md)（L2 truncation → 缓冲重试）。
- thinking 毒化：[2026-07-07-thinking-signature-quarantine.md](2026-07-07-thinking-signature-quarantine.md) + skill `ghc-anthropic-upstream`。
- 活的架构现状 + 运行时选项：[../DESIGN.md](../DESIGN.md)（`streamKeepaliveMode` / `protectStreamingGeneration` 行 + 流式写出行）。
- CC 两层 watchdog + 合成帧标记：skill `claude-code-connection`。

## 9. 评审记录（两轮对抗性 subagent review，2026-07-08）

裁判轴显式设为「长远正确 + 完整」（非 ROI/YAGNI）。客观事实全盘吸收，判断谨慎取舍并复核。

### Round 1 — 代码事实核查（file:line 锚点 vs 真实代码）
- **结论**：锚点高度准确，无杜撰钩子/字段。
- **采纳**：① `protectStreamingGeneration=tool_use_only` 是活配置非仓库默认（默认 `false`）→ §1.3#1 已注明「运维显式开启」。② `onRenderedFrame` 签名 `(frame)=>ClientFrame|undefined` 做不到「写 sink + 不入 buffer」双动作 → §3.5 改为「直接改缓冲循环 / 新增 buffered 专用回调」。

### Round 2 — 对抗性正确性攻击
- **CRITICAL C1（采纳，核心修正）**：`buffer` 每 attempt 重建（[driver.ts:536](../../src/lib/pipeline/driver.ts#L536) 亲验），初稿「否则 buffer」在重试会重发 message_start/start(0) → 协议违规。§3.2 改为**统一三态决策（EAGER/DROP/RECONCILE/BUFFER）+ 状态 hoist 出循环**，已发帧走 DROP 不入 buffer。
- **HIGH H1（采纳）**：`TN===T0` 复用客户端 attempt-1 的 message_start → usage/id 陈旧 → §3.4(a) 文档化 + message_delta 纠正缓解。
- **HIGH H2（部分采纳 + 修正 reviewer 事实错误）**：reviewer 称「escalate 默认开启」**错**——亲验 `protect_streaming_escalate_context` 默认 `false`（[config.yaml:544](../../config.yaml#L544)）。但其结构性洞察成立（开启时 escalate 删 thinking 上下文 → 发散成常态）→ §3.6 采纳「毒化 oracle 提为上线门控」，并注明默认关故默认罕见。
- **MEDIUM 全采纳**：M1 失败终末收口 eager 块 0（§3.4(b)）；M2 收口帧打 `synthetic:"reconcile"`（§3.4(d)+§5）；M3 eager 门控 thinking/text、tool_use 首块携 name/id 不 eager（§3.1+§4）、oracle 覆盖 text 收口（§3.6）；M4 index remap = ClientFrame JSON index 重写 helper（§3.4(c)+§5）。
- **LOW 采纳**：L1 §3.1「上游最后开的块」→「客户端可见唯一 open block 恒为首块 0」；L2 §4 强调修复非普适。
- **验证为正确的正样本（P1-P5）**：核心机制（eager 锚定 + 空 delta 心跳 + flush 期 openBlock 自然推进 + 块 0 前无发散点 + telemetry 不受影响）均经代码验证成立——设计主干无需改，缺口全在重试/失败对账维度。

未采纳：无（除修正 H2 的默认值事实错误）。reviewer 的所有客观发现均已落地。

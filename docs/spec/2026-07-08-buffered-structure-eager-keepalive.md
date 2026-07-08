# Spec: buffered 模式 structure-eager keepalive —— 兑现 buffered pre-commit 的 300s 断连边界

- **状态：草案（draft）**——设计经排查会话与用户敲定，待对抗性 subagent review + 用户终审后进 writing-plans。
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

1. `protectStreamingGeneration=tool_use_only`（活配置）+ CC 必带 tools → **buffered=true**。
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

保活的唯一诉求是：**pre-commit 缓冲期让 sink 的 openBlock 非空**，好让心跳发匹配的空 content_delta（重置 CC 300s）。达成它的**最小且正确**干预 = 在 buffered 缓冲循环 [driver.ts:542-562](../../src/lib/pipeline/driver.ts#L542-L562) 里，**只把 `message_start` + 第一个 `content_block_start` 提前 `sink.write()` 转发**，其余全部照旧缓冲：

| 帧 | 处理 | 理由 |
|---|---|---|
| `message_start`（首个） | 提前转发（一次） | 开启客户端流；不含生成内容 |
| **第一个** `content_block_start` | 提前转发（一次） | 点亮 sink openBlock={index0, type0} → 心跳锚定块 0，整段生成期发匹配空 delta |
| 其余全部（`content_block_delta` 内容帧、`content_block_stop`、**后续** `content_block_start`、`message_delta`、`message_stop`） | 仍只入 `buffer`，commit 时 flush | 保住 buffered-retry「不泄露生成内容 + 可隐形重试」不变量 |

**为什么只需第一个 content_block_start（而非每个）：** 上游 idle/静默期恒只有一个 open block（上游沉默前最后开的块）。锚定块 0 后，心跳整段发空 `thinking_delta(0)`（或 text/input_json，按块 0 type）——即使上游后续实际已推进到块 1/2（其 start/stop 全在 buffer 里、客户端不可见），客户端视角块 0 始终 open，空 delta 对它恒合法（SDK 累积 `""` 无害，前身 spec SDK oracle 实证）。commit flush 时按序发 `content(0), stop(0), start(1), content(1), …, message_stop`，客户端序列 = `start(0)[eager] + 空delta… + content(0) + stop(0) + start(1) + …` **协议合法**（空 delta 全落在块 0 real content 之前）。

**为什么不提前转发 `content_block_stop` / 后续 `content_block_start`：** 提前发 `stop(0)` 会让客户端认为块 0 已完结、但其真实内容还在 buffer → 客户端收到「空块 0」；且不发 stop(0) 就发 start(1) 又是「块 0 未关先开块 1」的协议违规。两难的根因是「stop 提前 = 提前 commit 块为空」——故 **stop 与后续 start 一律归 commit flush**，绝不 eager。这修正了本 spec 初稿的一处设计缺陷。

**为什么心跳无需改：** sink 已有 `keepaliveFrame(openBlock)` provider（[client-sink.ts:243](../../src/lib/pipeline/client-sink.ts#L243)）。openBlock 由 `noteBlockState`（[client-sink.ts:176](../../src/lib/pipeline/client-sink.ts#L176)）在 `sink.write` 里跑——被提前转发的 content_block_start(0) 点亮，且 commit flush 的真实结构帧（stop/start）流过 sink.write 时**自然推进** openBlock（flush 到 stop(0) → openBlock 清空、gap 内心跳暂回 ping；flush 到 start(1) → openBlock={1}），故 flush 期间心跳恒匹配当前 flush 块、无失效 delta。**本 spec 不碰心跳/provider/config**。

### 3.2 注入点

`runResponseBufferedSink` 缓冲循环里维护两个 pre-commit 标志（`sentMessageStart` / `sentFirstBlockStart`），对每个 `toWrite`：
1. 未发过 `message_start` 且 `toWrite` 是 message_start → `await sink.write(toWrite)` + 置 `sentMessageStart`；**不**入 buffer。
2. 未发过首 block start 且 `toWrite` 是 `content_block_start` → `await sink.write(toWrite)` + 记录 `{index,type}`（客户端可见结构状态机，§3.4）+ 置 `sentFirstBlockStart`；**不**入 buffer。
3. 否则 → `buffer.push(toWrite)`（照旧）。
4. `retreated`（OOM cap）语义不变：retreat 后剩余帧本就 live 写；已提前转发的 message_start/首 block start 不能再在 flush 重发（`buffer` 里本就没有它们，天然一致）。

### 3.3 flush 去重（commit 时）

commit flush [driver.ts:588-604](../../src/lib/pipeline/driver.ts#L588-L604) `for (frame of buffer) await sink.write(frame)` 不变——因为提前转发的 message_start + 首 content_block_start **从未入 `buffer`**（§3.2 步 1/2），flush 只发缓冲的内容/stop/后续 start/终末帧，天然无双发。**不变量：`message_start` 与首 `content_block_start` 对客户端恰好转发一次。** golden 守卫（§6）锁定 forwarded 轨无重复 message_start / 首块 start。

### 3.4 稀有重试的结构对账（best-effort）

重试时（truncation RST 或上游 idle >900s abort）客户端已见前一 attempt 的**开场结构**——因 §3.1 只提前转发 `message_start` + 首 `content_block_start(0, type T0)`，客户端可见结构前缀恒只有这两帧。故对账极简（只涉及块 0），维护一个跨 buffered 重试存活的**客户端可见结构状态机**（记 `sentMessageStart` + 首块 `{index:0, type:T0}`）：

- attempt-N 的 `message_start`：`sentMessageStart` 已真 → **不重发**（Anthropic 协议单 message_start）。
- attempt-N 的首 `content_block_start(0, type TN)`：
  - `TN === T0`（**主流**，同请求同结构）→ 复用客户端已开的块 0，**不重发** start(0)；attempt-N 的块 0 内容照常 flush 进去。
  - `TN !== T0`（结构发散，罕见）→ 对客户端**空内容收口**关闭块 0（`content_block_stop(0)`，收口形状经 §3.6 实测定）+ **index 重映射 +1**：attempt-N 的上游块 0/1/2… 映射到客户端 index 1/2/3…（客户端 index 空间与上游解耦，remap 表随 flush 平移）。
- attempt-N 后续块（1+）：本就归 commit flush（§3.1），按 remap 表转发，无提前对账。

**取舍（用户已认可）：** structure-eager 部分削弱 buffered-retry 透明性（发散时客户端多见一个空收口块 0）。鉴于 heavy-thinking 主场景是单 attempt 无重试、重试极稀有且同结构居多（`TN===T0` 主流复用零收口），用主场景正确性（不再 300s 断）换稀有发散路径的一点复杂度/降级，好处远大于坏处。

### 3.5 提前转发帧的精确判定（实现须钉死）

structure-eager 只认**两个**帧类提前转发，判定基于 rendered client frame（post-S5-rewrite）的 `type`：
- `message_start`：`type === "message_start"`，pre-commit 首次出现时转发。
- 首 `content_block_start`：`type === "content_block_start"` 且 `sentFirstBlockStart` 未置时转发。

其余 Anthropic SSE 帧类型（`content_block_delta` 各 delta / `content_block_stop` / `message_delta` / `message_stop` / `error` / `ping`）**一律不提前转发**：内容与终末帧归 commit flush；`error`（H2 上游 error）走现有 `sawUpstreamError` commit 路径；`ping` 是 sink 心跳合成、不在 rendered 流里。判定 helper 须 format-aware（Anthropic 帧类型知识），避免污染 format-agnostic 的 sink——放 handler 侧或新 helper，经现有 `onRenderedFrame` 钩子（[driver.ts:544](../../src/lib/pipeline/driver.ts#L544)）或新增 buffered 专用回调注入判定。

### 3.6 空 thinking 块收口毒化 —— 实测验证（用户已定）

若重试发散需空内容收口 thinking 块，空/无签名 thinking 块可能触发 CC 下轮 `thinking cannot be modified` 400（skill `ghc-anthropic-upstream`：空明文 thinking 毒化 / thinking-signature quarantine）。**spec/实现期须用真实 CC 作 oracle 实测**（复用 `exp/cc-idle-280s/` harness 手法）：合成空 thinking 块喂真 CC，看下轮是否毒化/报 400，据实测决定收口形状（候选：空 text 块替代收口 / 可被 CC 丢弃的 sentinel / 复用 thinking-signature-quarantine 已落地的合成 sentinel 机制）。**不凭推断下结论**（empirical-verification 纪律）。

## 4. 剩余边界（本 spec 不覆盖，须文档化）

- **纯 pre-first-block 静默**：`message_start` 已发、首个上游 `content_block_start` **尚未到达**的窗口（或 pre-response cold-start，上游连 headers 都没返回）——无结构可提前转发，openBlock 空 → 仍 ping。本 incident 里 content_block_start 在 2ms 到达，故 structure-eager 几乎立即生效；纯 pre-first-block 窗口（上游返回 headers 但首块 >300s 未到）罕见但存在，遗留为已知边界（同前身 spec §6 第 1 条）。
- **redacted_thinking 块**：无法发有意义的空 delta（前身 spec 已 fallback ping）；structure-eager 转发其 content_block_start 后，心跳对 redacted 仍 ping（延续现状）。
- **web_search bypass 路径**（前身 spec §6 第 2 条）：独立心跳（`streaming-pump.ts`），本 spec 不动。

## 5. 触及文件 / 代码锚点

| 关注点 | 文件 |
|---|---|
| buffered 缓冲循环分流 + flush 去重 + 重试对账（核心） | [src/lib/pipeline/driver.ts](../../src/lib/pipeline/driver.ts) `runResponseBufferedSink` |
| openBlock 状态机（已就绪，仅需结构帧流过 `sink.write`；可能需暴露判定 helper） | [src/lib/pipeline/client-sink.ts](../../src/lib/pipeline/client-sink.ts) |
| 客户端可见结构状态机 primitive（新增，跨重试对账 + index remap） | 新文件，`src/lib/pipeline/` 或 `src/lib/anthropic/` |
| 结构帧判定（Anthropic 帧类型清单） | 新 helper（format-aware，避免污染 format-agnostic 的 sink） |
| 实测 harness（空块收口毒化验证） | `exp/`（复用 `exp/cc-idle-280s/` 手法） |
| 回归测试 | `tests/pipeline/`（buffered structure-eager 单元）+ `tests/anthropic/`（活路径 e2e：buffered + 上游 stall 注入，证结构提前转发 + 心跳空 delta 非 ping） |

## 6. 验证方法（commit invariants + 实测）

- **根因复现 / CC 断连阈值**：`exp/cc-idle-280s/`（真实 `claude` CLI + mock 上游），扩一臂 = buffered 模式 + 上游 `content_block_start(thinking)` 后静默 → 证修复后 CC 存活到 >300s（当前断）。
- **提前转发帧恰好转发一次**：golden 守卫扫 buffered 路径 forwarded 轨，断言 `message_start` 恰 1 次、且首 `content_block_start`（提前转发的那个 index）不被 commit flush 重发（§3.3 不变量）。注意多块生成的 forwarded 轨本就含多个 content_block_start（块 1/2…来自 flush），守卫只锁「提前转发的两帧不双发」，非「content_block_start 全局唯一」。
- **内容不泄露**：断言 buffered pre-commit 的 forwarded 轨**只含** `message_start` + 首 `content_block_start` + 合成心跳（空 delta / ping），**零** 真实内容 `content_block_delta`（保住 buffered-retry 不变量）。
- **重试对账**：单元测试 attempt-1 提前转发结构 → attempt-1 truncation → attempt-2 同结构（复用块，不双发）/ 异结构（空收口 + index remap）两路。
- **空块收口毒化**：§3.6 真实 CC oracle 实测。
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

# Claude Code 2.1.207 客户端行为审计（对照本项目 CC-facing 代码）

> 状态：**审计进行中（迭代累积）**。本文件由 `/loop`（每 10 分钟）驱动的会话产出——逐轮对照 `~/.claude/refs/claude-code-2.1.207/app.pretty.js`（CC CLI 打包源码，46 万行）与本项目**面向 Claude Code 下游客户端**的代码（`src/lib/anthropic/`、`src/routes/messages/`、`src/lib/pipeline/`），把发现的 gap / 风险记这里，**不直接改代码**。
>
> 本文档不是 spec、不是 plan——是**问题清单 + 交接**。正式修复仍走 brainstorming → spec → plan → 执行。
>
> **可信度标注纪律**（项目 `empirical-verification`）：每条注明依据是「读 CC 源码」「读本项目代码」还是「待实测」。CC 源码里的超时**绝对量**（60s/300s）以已建立的实测为准（skill `debugging-claude-client-connection`），本轮只核**质变行为**（新增/改动的控制流），凡影响本项目决策的绝对量都标「待实测复测」。
>
> 基线：既有 CC 客户端行为的实测结论沉在 skill `debugging-claude-client-connection`（超时两层、keepalive、合成帧必带 `event:` 行、200+SSE-error 零重试）。本文件记的是 **2.1.207 相对该基线的漂移**，及本项目未覆盖的点。

---

## 轮次 1（2026-07-13）：流式 watchdog 重构 + thinking-only 静默重试

### 发现来源（CC 源码坐标）

CC 2.1.207 的流式查询循环在 `app.pretty.js`（行号为该文件内坐标，pretty 版）：
- watchdog 闭包 `he`/`io`/`q`：**298069–298093**（两个 `setTimeout`：`to`=idle 警告、`_o`=idle 硬超时）。
- byte-tier idle 错误处理（`bFn`、`tier:"byte"`）：**298395**。
- event-tier idle 硬超时置 `wn=true` + `tengu_streaming_idle_timeout{tier:"event"}`：**298092**。
- **thinking-only-yield 重试**分支：**298415–298431**。
- watchdog 干净退出后抛 `"Stream idle timeout - no chunks received"`：**298366**。
- env 变量声明（`CLAUDE_STREAM_IDLE_TIMEOUT_MS`→`npm`、`CLAUDE_SLOW_FIRST_BYTE_MS`→`opm`、`CLAUDE_MOCK_HEADERLESS_429`）：**28332**。
- SDK 侧心跳 ping 生成器 `v1y`（stall→`{type:"ping"}`）：**297761**；常量 `b1y=1e4`（10s）、`oLs=2e4`（20s）、`S1y=30`（最多 30 次）：**298647**。
- `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` / `tengu_disable_streaming_to_non_streaming_fallback`（流式→非流式回退）：**298411**。

### F1（HIGH）— thinking-only 空档撞 event-tier idle 超时 → CC **静默整请求重试**（本项目 keepalive 有盲区）

**CC 源码事实（读码，已核实守卫）**：2.1.207 新增控制流——当**流式 idle 超时**（`wn=true`，byte 或 event tier 任一置位）发生后，若 `!_i && ve === null && dr < Cn`（未注入 `_i` / 尚未定 stop_reason `ve` / 仍有重试额度），CC **不报错、不结束**，而是 `continue e`——**重试整条 streaming 请求**（日志 `Stream idle timeout after thinking-only yield — retrying streaming (dr/Cn)`，telemetry `tengu_streaming_watchdog_retry{after_thinking_only:true}`，298416–298417）。对照旧行为（idle 仅 abort/报错），这是**质变**。
- **重要澄清（避免误述）**：可见的重试守卫是 `wn`(idle-abort) + `!_i` + `ve===null` + 剩余次数——`after_thinking_only:true` 是 CC **自打的标签/telemetry 字段**。`Pu`（`_r` 里有非 thinking/redacted 的真实块）与 `Ad`（有 tool_use）**只用于兜底的 finalize-partial 腿**（298426–298433：`stop_reason = Ad?"tool_use":"end_turn"`、`has_output = Pu || _i`），**并不门控重试**。故不能断言「仅 `!Pu` 时才重试」——待实测确认真实内容已 yield 时 CC 是否也会 `continue e`（若会，重试会**向用户重复吐已发内容**，风险更大）。
- 重试额度耗尽后落到 finalize-partial（`tengu_streaming_partial_finalized`，298432）或**回退非流式**（`tengu_streaming_fallback_to_non_streaming`，`fallback_cause:"partial_yield"`，298435——印证下方 F4）。
- 连接被关（非 idle，走 `$r?.code`）另有对称的 `tengu_streaming_stale_connection_retry`（`fr < It`）。

**为何是本项目的坑（读本项目代码）**：本项目 keepalive 在 [keepalive-frame.ts:43-45](../../src/lib/anthropic/keepalive-frame.ts#L43-L45) 的 `default` 分支——**无 open block / redacted_thinking / unknown**——回退到**裸 `ANTHROPIC_PING`**。而裸 ping **不重置 CC 的 event-tier（300s no-real-content）计时**（这是 skill `debugging-claude-client-connection` 的承重实测事实：只有 `content_block_delta` 才算 chunk）。注释自我辩护「the block-less gap is short-lived; a ping is correct there」——**这是承重假设**。

风险链：上游 GHC 在**一个 thinking `content_block_stop` 之后、下一个 `content_block_start`（text 或再一个 thinking）之前**长时间静默（此窗口无 open block → keepalive 只发裸 ping）。若该窗口 > event-tier 阈值：
1. CC event-tier idle 超时开火（因为期间只有 ping、无 content_block_delta）。
2. 此时已 yield 的**只有 thinking 块** → 命中新的 thinking-only 分支 → **CC 静默重试整条 `/v1/messages`**。
3. 代理侧收到一条**请求体完全相同的新流式请求** → **对 GHC 发起重复上游调用**（烧额度、可能重复副作用），而用户端**毫无感知**（UI 只见「仍在思考」）。

旧行为下这只是一次 idle abort（用户可见错误）；2.1.207 把它变成**放大成重复上游请求的静默重试**，更糟。

**待实测（独立 oracle，别从读码外推）**：
- 用 headless CC + 受控 mock 上游（harness 复用 `exp/cc-idle-280s/`、`exp/q2-oracle/`）造「thinking 块 → content_block_stop → 长静默（跨过 idle 阈值）」，观测 CC 是否发第二条请求（mock 侧计数上游命中数）+ telemetry `after_thinking_only`。
- 复核本项目 keepalive 是否真会落进 `default` ping 分支：sink 在 thinking `content_block_stop` 后、下一 block 前，`openBlock` 是否为 `undefined`（→ ping）。查 [client-sink.ts](../../src/lib/pipeline/client-sink.ts) 的 `OpenBlock` 生命周期：`content_block_stop` 后到下个 `content_block_start` 间 openBlock 是否清空。**若清空 = 盲区确认**。

**理想修复方向（不在本轮做）**：块间空档的 keepalive 不该退化成裸 ping。可选：(a) 维持「最后一个已关闭块」的类型记忆，空档期发一个**新的合成 block（empty text block@next-index + empty delta）**顶住 event-tier；(b) 空档期主动发 `content_block_start`(text) 占位。两者都要保证不污染真实内容语义 + 打 `synthetic` 标记（`richest-data-flow` ADR 对称面）。需 brainstorming。

### F2（MEDIUM）— event-tier idle 超时现可由 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 配置（不再是硬 300s）

**CC 源码事实（读码）**：2.1.207 暴露 env `CLAUDE_STREAM_IDLE_TIMEOUT_MS`（getter `npm`，声明 28332），event-tier 硬超时 `ll` 与警告 `qi` 由它派生。意味着**300s 不是固定值**——用户可调低（如设 60s 做激进探测）也可调高。

**对本项目的含义**：本项目 keepalive 节律（默认 `streamKeepalivePingSec=20`）针对默认 300s 设计，安全裕度大。但：
- 文档/skill 里凡把「300s」当**常量硬编码前提**处，应改述为「默认 300s，客户端可经 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 覆盖」。
- 若某用户把它调到 < keepalive 间隔的量级（如 15s），本项目 20s keepalive 反而不够——但这是客户端自伤，非代理 bug。**仅需在 skill/文档补一句「阈值可被客户端 env 覆盖」**，不需代码改动。

**待实测**：确认 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 的默认值与是否同时改 byte-tier。读码时变量名碰撞严重（`ll`/`qi` 与循环变量同名），未能干净提取默认字面量，留待专项 sed/AST 定位。

### F3（LOW/信息）— 新增 idle **警告**阶段 + byte-tier 富诊断字段

**CC 源码事实（读码）**：event-tier 在硬 abort 前先发一次**警告**（`Streaming idle warning: no chunks received for Xs`，`cli_streaming_idle_warning`，298090），两阶段（warn→abort）。byte-tier（`bFn`，`tier:"byte"`，298395）携带 `bytesReceived`/`ttfbMs`/`bodyReadPending`/`sleptMs`/`cfRay`，并有独立 env `CLAUDE_SLOW_FIRST_BYTE_MS`。

**对本项目的含义**：纯客户端侧遥测，代理无法直接观测（这些是 CC 进程内日志）。**无需代码改动**。价值仅在于：事后诊断断流 incident 时，若能拿到用户的 CC 日志，可用 `cli_streaming_idle_warning`（warn 早于 abort）与 `tier:"byte"` vs `tier:"event"` 精确区分是「字节级 socket 停」还是「有字节但无 content chunk」——补进 skill `debugging-claude-client-connection` 的判别表。

### F4（LOW/待查）— 流式→非流式回退路径

**CC 源码事实（读码）**：`CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK` / `tengu_disable_streaming_to_non_streaming_fallback`（298411）表明 CC 在流式反复失败后可回退到**非流式** `/v1/messages`（`stream:false`）。

**待查**：本项目非流式 Anthropic 路径（`handler-v4` 的 non-streaming 分支 + `non-streaming-completeness.ts`）是否与流式路径行为等价（尤其 thinking/tool_use/usage 完整性）。若 CC 因流式 idle 反复失败而回退非流式，非流式路径必须能独立完整返回。**留待后续轮次对照非流式完整性代码。**

---

## 后续轮次待覆盖的 CC-facing 面（TODO 清单，逐轮消化）

- [ ] **请求形状漂移**：2.1.207 CC 发往 `/v1/messages` 的 `betas`/`anthropic-beta` 值、`metadata`、`tool_choice`、fine-grained tool streaming（`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`，28304）——本项目 `request-preparation.ts` / `payload-rewrites.ts` 是否有未识别的新字段被吞或误拒。
- [ ] **count_tokens**：CC 对 `/v1/messages/count_tokens` 的调用形状/频率 vs 本项目 `count-tokens.ts`。
- [ ] **SDK SSEDecoder**：2.1.207 的 `@anthropic-ai/sdk` 版本是否改了 `event:` 行处理（本项目「合成帧必带 event 行」不变量的前提）。
- [ ] **refusal / fallback_request**：CC 的 `stop_reason:"refusal"` → `fallback_request` 控制流（298057–298060）vs 本项目 `recover-refusal.ts`。
- [ ] **200+SSE-error 重试**：复核 2.1.207 是否仍对 200+流内 error 零重试（skill 基线来自旧版）。
- [ ] **thinking signature**：CC 侧对 `signature_delta` / thinking immutability 的消费 vs 本项目 `thinking-signature-compat.ts` / `thinking-immutability.ts`。

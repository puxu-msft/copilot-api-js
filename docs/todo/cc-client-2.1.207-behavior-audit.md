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

## 轮次 2（2026-07-13）：请求体新增顶层字段（`speed` / `diagnostics`）

### 发现来源（CC 源码坐标）

CC 2.1.207 发往 `/v1/messages` 的请求体构造（单行，`app.pretty.js:297987`）比旧版多了几个顶层字段：

```
let wr = { model, messages, system, tools, tool_choice,
           ...Y && (!$r || Gr.length>0) && { betas },
           metadata, max_tokens, thinking,
           ...temperature, ...context_management,   // 已被本项目妥善处理
           ...output_config,                         // 已被本项目 partner-feature-strip 处理
           ...q !== void 0 && { speed: q },          // ★ 新：q="fast"（fast 模式）
           ...ee && d && Y && !$r ? { diagnostics: { previous_message_id } } : {} }  // ★ 新
```

- `speed: "fast"`：`q = "fast"`（297967 附近），CC **fast 模式**开启时发；**不受 `Y`（first-party/betas 门）门控** → 只要 fast 模式开就普遍可达代理。CC 内部 `speed==="fast"` 语义见 62138 / 139115。
- `diagnostics: { previous_message_id }`：门控 `ee && d && Y && !$r`（会话诊断链，多轮时带上一条消息 id）。

### 本项目现状（读码）

- 全仓 `grep -niE '"speed"|\bspeed\b|previous_message_id|diagnostics'`（排除测试/无关词）在 anthropic/messages/pipeline **零命中**——本项目**完全不读** `speed` 也不读 `diagnostics`。fast 语义本项目只有无关的 `X-Initiator: agent/user` 头（[request-preparation.ts:435](../../src/lib/anthropic/request-preparation.ts#L435)），与 Anthropic 的 `speed` priority-tier **不是一回事**。
- 请求体是**原地增删已知字段 + 透传未知字段**（`wire` 就地 mutate，`structuredClone` 只对已知键，[request-preparation.ts:568](../../src/lib/anthropic/request-preparation.ts#L568)）→ `speed`/`diagnostics` **原样转发到 GHC**。
- 兜底：**已注册**通用顶层 body-field 剥离策略 `createBodyFieldRejectionStrategy`（[codec/anthropic/strategies.ts:64](../../src/lib/codec/anthropic/strategies.ts#L64)，实现 `context-management-retry.ts`），正则 `EXTRA_INPUTS_PATTERN = /(?<![.\w])([a-z_]\w*):\s*Extra inputs are not permitted/i` 匹配**任意顶层字段**。

### F5（MEDIUM）— CC fast-mode 意图（`speed:"fast"`）被代理静默丢弃

**判断（读码，部分待实测）**：`speed:"fast"` 转发到 GHC 后三种结局，**都导致 CC 的 fast 模式对代理无实效**：
1. GHC 静默接受+忽略 → 请求成功，但没有任何 fast-tier 路由，意图丢失、无错。
2. GHC 报 `speed: Extra inputs are not permitted`（标准顶层格式）→ body-field-rejection 策略剥掉 `speed`、重试成功、fixate → 意图丢失，但多一次**上游往返**（首请求必 400）。
3. GHC 报**非标准/嵌套**消息（见 F6）→ 两个正则都不匹配 → **每条 fast-mode 请求硬 400**。

无论哪种，本项目都**不在 history/telemetry 记录客户端曾请求 fast**（违 `richest-data-flow`：客户端能力信号未被最丰富地留存）。用户在 CC 里开 fast 模式，经代理后**行为不可观测、不被荣誉**。

**理想方向（不在本轮做）**：(a) 实测 GHC 对 `speed:"fast"` 的真实反应；(b) 若 GHC 拒，仿 `eager_input_streaming` **proactive strip**（省往返）；(c) 记录客户端 `speed` 到 history 供诊断；(d) 若 GHC 有可对接的 fast/优先 tier，考虑**映射**而非丢弃（真正荣誉客户端意图）。需 brainstorming + GHC 能力探针（skill `ghc-api-reference`）。

### F6（LOW）— 嵌套未知字段拒绝（`diagnostics.previous_message_id`）落在两个策略正则的**缝隙**

**判断（读码）**：body-field-rejection 正则**只匹配顶层**（`(?<![.\w])` 前瞻锁死点/词前缀），tool-field 正则只匹配 `tools\.\d+\.`。若 GHC 把 `diagnostics` 拒成**嵌套路径** `diagnostics.previous_message_id: Extra inputs are not permitted`，则：**顶层正则被点号排除、tool 正则不匹配 → 无策略认领 → 落到 loud 400**（`context-management-retry.ts:36-40` 注释明确「嵌套 leaf 当 body field 剥是 no-op」）。

缓解现状：GHC pydantic 对**整体未建模的顶层键**通常报顶层名（`diagnostics: Extra inputs`）→ 被顶层正则覆盖。**残余风险**仅在 GHC 报嵌套路径时成立。`diagnostics` 门控较窄（多轮 + `Y` + `!$r`），触达频率低于 `speed`。

**待实测**：造带 `diagnostics:{previous_message_id}` 的请求打 GHC，看 400 消息是顶层 `diagnostics:` 还是嵌套 `diagnostics.previous_message_id:`。前者=已覆盖；后者=需给 body-field 正则加「顶层键的任意子路径归并到顶层键剥除」的能力（一般化，非只为 diagnostics）。

### 本轮结论（避免误导）

`speed`/`diagnostics` **不是「请求会崩」的高危项**——通用 body-field-rejection 策略对标准顶层 "Extra inputs" 400 已兜底。真实问题是 **F5 的功能意图丢失 + 不可观测**（中）与 **F6 的嵌套拒绝缝隙**（低、条件性）。两者都需先做 **GHC 能力探针**再定修复形状。

---

## 轮次 3（2026-07-13）：`count_tokens` —— 失败契约 + 调用突发

### 发现来源（CC 源码坐标）

- 主 count 路径 `lTt`（`app.pretty.js:299502`）：`l.beta.messages.countTokens({ model, messages: e.length>0?e:[{role:"user",content:"foo"}], tools, ...betas(经 Gmi 白名单 `Gmi=new Set([R_t,S5t,L_t,ZYe])` 过滤,61832), ...thinking(若 containsThinking) })`，`maxRetries:1`，`source:"count_tokens"`。**读 `u.input_tokens`，非 number → 返回 null**（299507）。
- **失败回退 `HLs`**（299511）：`lTt` 抛错时 `catch` → 若 `o_()` 为真，调 `HLs`（**客户端本地 tokenizer 估算**，用默认模型 `dL()`/haiku，不需精确模型）。`car`=`countTokensWithFallback`（299048）：先 `lTt`(API) → null 则 `HLs`(本地)。
- **调用者是突发的**：`q1y`（299078）算 system-prompt 分段 token（`/context` 面板）时 `Promise.all(o2.map(({content}) => car([{role:"user",content}], [])))`——**逐段一个 count 调用并行**；`_lt`=`countToolDefinitionTokens`（299060）算工具定义 token。
- **CC 侧有磁盘缓存**：`ZRs`（297325）把 messages/tools 归一化（CWD→`[CWD_SLUG]`、UUID→`[UUID]`、ISO 时间戳→占位）成稳定 key，走 `zOy(key,"token-count",…)` 持久缓存（`crypto`/`fs`/`path`），**gated on `tvo()`**。命中缓存不打网络。

### 本项目现状（读码，[count-tokens.ts](../../src/routes/messages/count-tokens.ts)）

实现相当完善：同款 payload sanitize（`runAnthropicPayloadRewrites`，与 completion 路径 driver S3 一致）+ `isEndpointSupported` 门控省 doomed 400 + 默认走 GHC 上游 count_tokens + 本地 tiktoken 兜底 + auto-truncate 通胀。**但有两个与 CC 契约的错配。**

### F7（MEDIUM）— 失败/未知模型返回 `{input_tokens:1}`（200）**抑制 CC 更优的本地兜底**

**判断（读码）**：本项目在三条降级路径返回 **HTTP 200 + `{input_tokens:1}`**：
- 未知模型（不在 catalog，[count-tokens.ts:188-191](../../src/routes/messages/count-tokens.ts#L188-L191)）。
- 外层 catch（JSON parse 等意外，[count-tokens.ts:206-208](../../src/routes/messages/count-tokens.ts#L206-L208)）。

CC 的 `lTt` 读到 `input_tokens===1`（**合法 number**）→ **当作真实计数接受，绝不触发 `HLs` 本地估算**（`HLs` 只在 SDK 抛错 / `input_tokens` 非 number 时才走）。后果：
- `/context` 面板 / 工具定义 token（`_lt`）显示 **1 token**（CC 甚至打 `countToolDefinitionTokens returned 1` 警告，299064，但仍用错误预算继续）。
- CC 的 **context 预算 / auto-compact 决策**基于「≈1 token」→ 误判有巨量余量。

**关键洞见**：对「无法计数」的场景，返回**非 200 错误**（或 `input_tokens` 非 number）**优于**返回 `{input_tokens:1}`——因为 CC 的 `HLs` 用**默认模型 tokenizer**，**即便未知模型也能给出合理估算**（不需要代理认识该模型）。返回 `1` 反而把 CC 从「合理本地估算」拽到「离谱的 1」。这是 `deliver-something-when-blocked` 的反面：给了个**误导性的确定值**而非让下游用它自己的更优兜底。

**注意区分**：auto-truncate **通胀**路径返回的大数（`contextWindow*0.95`）是**故意**的（诱导 compaction），正确、不在此列。只有退化的 `1` 有问题。

**理想方向（不在本轮做，需确认 CC 行为）**：未知模型 / 意外错误路径改为返回**非 200**（如 400/500）让 CC 走 `HLs`；或至少实测「代理返回 4xx/5xx 时 CC 是优雅本地估算还是把错误抛给用户」——若后者，则保留 200 但换一个**基于本地 tokenizer 的真实估算**（即使模型未知，用默认 tokenizer 估，别给 1）。**待实测**：headless CC + mock 代理返回 `{input_tokens:1}` vs 400，观测 CC 的 `/context` 显示与是否落 `HLs`。

### F8（LOW，已被 CC 缓存缓解）— `/context` 触发 N 个并行 count_tokens，本项目每个都打 GHC 往返

**判断（读码）**：CC 的 `q1y` 逐 system-prompt 段并行 `car`，冷缓存时 = N 个并行 count_tokens 请求。本项目 `countTokensViaGhc` **无自己的服务端缓存**，每个都是完整 GHC 上游往返（burst 放大到 GHC 配额 + N× 网络延迟）。

**缓解现状**：CC 侧 `ZRs` 磁盘缓存（归一化 key）吸收重复段——**稳态下同一 CC 安装很少真打**。残余仅在：冷缓存（新会话/新 system prompt）、`tvo()` 关闭缓存、或跨 CC 安装。**优先级低**（本项目 count_tokens 明确 out-of-observability、非热路径）。

**可选（低优先）**：本项目给 `countTokensViaGhc` 加一层短 TTL 内容寻址缓存（归一化 messages/tools 为 key，仿 CC 的 `ZRs`），吸收 burst——但仅当实测证明 burst 确实造成配额/延迟痛点才值得（`long-term-wins` 但需先证债非虚）。

### 本轮结论

count_tokens 本项目实现是**成熟**的；唯一实质错配是 **F7 的失败契约**（返回 `1` 抑制 CC 本地兜底，中）。F8 是被 CC 缓存缓解的低优先性能项。F7 修复前需实测 CC 对代理非 200 的反应（避免把「优雅估算」换成「用户见错误」）。

---

## 轮次 4（2026-07-13）：SDK SSEDecoder —— 承重不变量在 2.1.207 **确认无回归**

> 本轮结论是**确认性**的（无新缺陷）——按 faithful 纪律如实记录，不制造假问题。价值在于**给「合成帧必带 event: 行」承重不变量钉一个版本锚**，让后续审计不必重查。

### 发现来源（CC 源码坐标）

- **SSE 解码器 `v5a`**（`app.pretty.js:9963`）：`constructor` 里 `this.event = null`；`decode` 只在遇到 `event` 字段行时 `this.event = n3`；空行结束一帧时若 `!this.event && !this.data.length` 返回 null，否则 emit `{event: this.event, data, raw}`。**无 `event:` 行的纯 `data:` 帧 → `event` 保持 `null`**（**不**回退到 SSE 规范默认的 `"message"`）。与 skill `debugging-claude-client-connection` 记录的旧版行为**逐字一致**。
- **消费循环 `Sjf`**（10005–10030）：按 `a.event` 名分发——`message_start`/`message_delta`/`message_stop`/`content_block_*`/`message`/`user.*`/`agent.*` → `yield JSON.parse(a.data)`；`ping` → `continue`；`error` → `throw new li(void 0, l, …)`（APIError，`.status` undefined，`error.type` 从 `l.error.type` 保住）。**`event === null` 匹配不上任何分支 → 既不 yield、不 continue、不 throw → 静默丢弃**。

### F9（CONFIRMED，无缺陷）— 「合成帧必带 `event:` 行」前提在 2.1.207 依旧成立

本项目所有合成 Anthropic SSE 帧经 `anthropicSseFrame(payload)`（`event: = payload.type`）单一入口 + golden `assertEventLineInvariant` 守卫（skill 记录）。该不变量的**前提**——「event-less 帧被 SDK 静默丢弃」——在 2.1.207 的解码器 + 消费循环里**双双未变**：
- 解码器仍给 event-less 帧 `event: null`（不是 `"message"`）。
- 消费循环仍只按名分发、丢弃 `null`。

**故无需任何代码改动**。这是一次去风险确认：本项目 tool_use/refusal 合成帧带 `event:` 行的做法在最新 CC 上仍是**必要且充分**的。

### 观察（信息，非缺陷）

1. **accept-set 大幅扩容**：10013 现含 `"message"` + Sessions-V2 / 互动 agent 协议事件 `user.message`/`user.interrupt`/`user.tool_confirmation`/`user.custom_tool_result`/`agent.message`/`agent.thinking`/`agent.tool_use`/…。这些 `user.*`/`agent.*` 属 CC 的**双向互动 agent 流协议**（另一处消费者 `SessionsV2Client`，391908 `event===null` 分支即其一），**不是** `/v1/messages` 的经典 SSE——本代理不服务该端点，**与代理无关**。
2. **`"message"` 入 accept-set 不破坏不变量**：虽然 SSE 规范默认事件名是 `"message"`，但本 SDK 解码器对 event-less 帧仍给 `null` 而非 `"message"` → event-less 帧照样被丢。二者不冲突。
3. **200+SSE-error 仍零重试**：`error` 帧 → `new li(void 0, …)`（`.status` undefined、非类型化子类），与 skill 的「200+SSE-error vs HTTP-4xx」结论一致，2.1.207 无变化。

### 软建议（低优先，非阻塞）

本不变量依赖一个**未来 CC 版本可能改**的 SDK 内部行为（解码器给 event-less 帧的 `event` 值 + 消费循环的丢弃语义）。本项目已有独立 SDK oracle 测试（`exp/refusal-sse-event-verify/`，喂合成帧进真 `_iterSSEMessages` 看幸存）——**建议把「对照 CC 版本」写进该测试的注释/README**，标注「本次确认锚定 CC 2.1.207 解码器 `v5a`」，作为版本回归锚。纯文档动作，不改逻辑。

---

## 轮次 5（2026-07-13）：refusal 恢复 vs CC 原生 `refusalFallbackModel` fallback

### 发现来源（CC 源码坐标）

CC 2.1.207 对 `stop_reason:"refusal"` 有**两处**（流式 + 非流式）对称的 fallback 编排：

- **流式**（`app.pretty.js:298325-298345`，`ve` = message_delta 的 stop_reason）：`ve==="refusal"` 时——
  1. `serverRefusalFallback`（上游 first-party 服务端换模型）→ `yield {type:"server_fallback"}`。
  2. **client 配置 `refusalFallbackModel`**（`pd`，非 silent lane）→ 路由匹配后 `yield {type:"fallback_request", trigger:"refusal", fallbackModel:Ws}` + **`return`（弃当前流、用 fallback 模型整条重试）**。
  3. 都无 → `BTt(...)` → `yield {type:"refusal_no_fallback"}` + refusal 消息（死轮）。
- **非流式**（298057-298060）：同构，`yi.stop_reason==="refusal" && yl!==void 0` → `fallback_request`。
- **关键**：CC 的 fallback 触发**只看 `stop_reason==="refusal"`，不检查有无 content**。`fallback_request` 会用 fallback 模型发**一条新的 `/v1/messages`** → 经本代理 → 若该模型在 GHC catalog 内，**能真的产出一个可用回复**。

### 本项目现状（读码）

本项目 [recover-refusal.ts](../../src/lib/anthropic/recover-refusal.ts) 只处理 **thinking-only refusal**（`stop_reason:refusal` 且无 text/tool_use），三模式（`state.refusalSseRewrite`，[response-rewrite-adapters.ts:296-343](../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L296-L343)）：
- `refusal` = **passthrough**（byte-identical 透传真 `stop_reason:refusal`）。
- `end_turn` = 追加合成 text + 改写 `stop_reason→end_turn`。
- `error` = 发 `event: error` 帧 + ctx.fail。
- **默认 = `error`**（[state.ts:1496](../../src/lib/state.ts#L1496)、[config.yaml:755](../../config.yaml#L755)）。
- refusals **带 content** 的一律透传不碰；history `sseEvents` 始终保留上游原始 refusal。

### F10（MEDIUM）— 默认 `error`/`end_turn` 恢复**抢占**了 CC 原生 refusal-fallback

**判断（读码，交互推理）**：本项目 `error`（默认）与 `end_turn` 两模式，都在**改写层**把 thinking-only refusal 的 `stop_reason:"refusal"` 变成 CC 看不出是 refusal 的东西（error 帧 / end_turn delta）。于是 CC 流式循环里 `ve` **永远不等于 `"refusal"`** → 上面整套 `refusalFallbackModel` / `fallback_request` 重试机制**永不触发**。

对**配置了 `refusalFallbackModel`**（CC 的真实特性：refusal 时自动换模型重试）的用户：
- 期望：thinking-only refusal → CC 自动用模型 B 重试 → 可能拿到真答案。
- 经本代理默认 `error` 模式：拿到的是一个 **200+SSE-error**（`event: error`）→ CC 走 `new li(...)` APIError、**零重试**（轮次 4 F9 确认）→ **配置的 fallback 被静默击败**。
- `end_turn` 模式同理：CC 看到一个正常 end_turn（带道歉文本）→ 也不触发 fallback。

**唯一保留 CC fallback 的是 `refusal`（passthrough）模式，而它不是默认。**

**范围与权衡（faithful，别夸大）**：
- 只影响 **thinking-only** refusal（带 content 的透传、CC fallback 正常）。
- 只影响**配置了 refusal fallback 的少数用户**；多数没配的用户，本项目 `error`/`end_turn` 恢复**优于** CC 的 `refusal_no_fallback` 死轮（proxy 的恢复是净收益）。
- CC 的 fallback 若触发，也可能再次 refusal → 最终仍走到 error；proxy 只是**短路**到同一终态、跳过了那次 fallback 尝试。但那次尝试**有可能成功**（换模型），proxy 默认剥夺了它。
- observability 不丢：history 保留真 refusal。

**理想方向（不在本轮做，需产品判断）**：
1. 至少在 [docs/refusal-recovery.md](../../docs/refusal-recovery.md) 补一节：三模式与 **CC 原生 `refusalFallbackModel` 的交互**——`error`/`end_turn` 会抢占它，`refusal` 保留它。让配了 fallback 的用户知道该选 `refusal`。
2. 考虑默认值取舍：`refusal`（passthrough）保留 CC 机制但给没配 fallback 的用户死轮；当前 `error` 相反。**代理无法探知 CC 是否配了 fallback** → 无法自动二选一。可能的更优形状：新增一个「先 passthrough 让 CC 自己决定；仅当 CC 明确不会重试时才恢复」的模式——但 CC 是否重试对代理不可见，落地难。需 brainstorming + 明确这是否值得（多数用户不配 fallback）。
3. **待实测**：headless CC 配 `refusalFallbackModel` 打本代理（各模式），确认 (a) 默认 `error` 下 fallback 确实不触发；(b) `refusal` 模式下 CC 的 `fallback_request` 是否真的发第二条请求到代理并被正常路由。

### 本轮结论

本项目 refusal 恢复设计**成熟**（三模式 + 配置化文案 + history 忠实 + 只碰 thinking-only）。唯一新洞见是**与 CC 2.1.207 原生 refusal-fallback 的交互**（F10，中）：默认 `error` 抢占了少数用户配置的 `refusalFallbackModel`。优先做**文档化交互 + 实测**，默认值是否改需产品判断（不自行拍板）。

---

## 轮次 6（2026-07-13）：thinking signature —— CC 原生自愈 + 新 `compaction` 块

### 发现来源（CC 源码坐标）

- **累加器**（`app.pretty.js:11104-11115` / 11187-11195）：`thinking_delta`→追加 `thinking`、`signature_delta`→**覆写** `signature`；新增 **`compaction_delta`/`compaction`** 块类型（context compaction）。
- **`H8i`**（170082）= thinking-signature **HTTP-400** 检测器：`e2 instanceof li && e2.status===400` 且消息含 `"signature in thinking block"` / (`"thinking.signature"`+`"field required"`) / ((`"thinking block"`|`"redacted_thinking"`)+(`"cannot be modified"`|`"invalid signature"`))。
- **`H8i` 恢复**（298155-298165）：命中即 `W$d(F)` = **剥掉 conversation 里所有 thinking 块并重试**（`tengu_thinking_signature_strip_retry`，记 signed/unsigned 计数）。
- **`C8i`**（170088）= `thinking.type=enabled/adaptive not supported` 检测 → 恢复（298149）**切到另一种 type（enabled↔adaptive）重试**。
- 两者都在 HTTP-error 重试分类器 `ii`（298027）里，**硬要求 `status===400`**。

### 本项目现状（读码）

thinking 处理**非常完备**：`thinking-quarantine/store.ts` + `thinking-immutability.ts`（L1/L2/L3）+ `poisoned-thinking-match.ts` + `thinking-coercion.ts` + `thinking-signature-compat.ts` + `thinking-protection.ts`；反应式 `adaptive-thinking-rejection-retry.ts`（`adaptive thinking is not supported` → `adaptiveToEnabledThinking` **主动 coerce**）。累加器（[stream-accumulator.ts](../../src/lib/anthropic/stream-accumulator.ts)）对块/delta/event 类型有显式 case + `default`（194/282）。

### F11（LOW/CONFIRMED-compatible + 一条 caveat）— CC 原生 thinking-400 自愈是 HTTP-400 门，与本项目架构**兼容**

**判断（读码 + 架构推理）**：CC 的 `H8i`（剥 thinking 重试）与 `C8i`（切 thinking.type 重试）都要求 `status===400`。本项目对 GHC thinking-400 的处理在**请求/重试侧**（driver 的 reactive strategies，pre-commit 尝试循环）：GHC 通常在**响应头**就返 400（流式还没 commit）→ 本项目要么 reactive 自愈（`adaptive-thinking-rejection-retry` 等 + quarantine），要么**以 HTTP-400 透出** → CC 的 `H8i`/`C8i` 作为**兼容后备**正常触发。二者**同向、不冲突**，是「代理主愈 + CC 后备」双保险。

- 本项目 `adaptive→enabled` **主动 coerce** 甚至**优于** CC 的 `C8i` 双向 toggle（proactive 省往返，CC 从不需触发 C8i）。
- **唯一 caveat（记档、别踩）**：**绝不**把 thinking-signature / adaptive-thinking 的 400 转成 **post-commit 200+SSE-error**（`li.status===undefined`）——那样 CC 的 `H8i`/`C8i` 都**匹配不上**（同轮次 4 F9 / 轮次 5 F10 的结构），既丢了 CC 后备、又可能 wedge 会话。本项目 refusal `error` 模式是 thinking-only refusal 专用、与 thinking-sig 400 正交，目前无此转换——**保持**即可。**待实测**：确认本项目任何路径都不会把 thinking-sig/adaptive 400 post-commit 化。

### F12（LOW，前瞻）— 新 Anthropic `compaction` 块本项目累加器未识别

**判断（读码）**：CC 2.1.207 累加器新增 `compaction`/`compaction_delta`（11113/11195）。本项目累加器无此 case → `compaction` 块落 `default`（282）→**本项目不累积它**（history/keepalive 视角）。影响：
- **history 保真**：若 GHC 未来发 `compaction` 块，本项目 history 累积**丢该块内容**（违 `richest-data-flow`，但转发轨 `sseEvents` 原始帧仍在）。
- **keepalive**：`compaction` 是未知 open-block 类型 → keepalive `default` 回退裸 ping（与 F1 同源盲区叠加）。
- **客户端转发不受影响**：转发层默认透传（compaction 帧带原 `event:` 行）→ CC 自己的 compaction 累加器仍能消费。

**现状风险低**：需 GHC 真的发 `compaction` 块才成立（当前 context_management/compaction 是否让 GHC emit 此块型未证）。**待实测**：查 GHC 在 context editing / 200K compaction 下是否 emit `compaction` content block（skill `ghc-api-reference`）；若会，则给本项目累加器补 `compaction` case（累积 + 认作 open-block 供 keepalive）。

### 本轮结论

thinking 是本项目**最成熟**的子系统之一，与 CC 2.1.207 原生 `H8i`/`C8i` 自愈**兼容且互补**（F11 是确认+caveat，非缺陷）。唯一前瞻 gap 是 `compaction` 新块型（F12，低，需 GHC 实测才升级）。

---

## 轮次 7（2026-07-13）：stop_reason 家族 + auto-truncate ↔ CC context 管理交互

### 发现来源（CC 源码坐标）

CC 2.1.207 流式循环对非常规 stop_reason 的客户端处理（`app.pretty.js:298172-298173`）：
- `ve==="max_tokens"` → `tengu_max_tokens_reached` + 提示「响应超 `${qe}` 输出上限，设 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`」。
- `ve==="model_context_window_exceeded"`（**非标准 Anthropic stop_reason**）→ `tengu_context_window_exceeded` + 提示「模型已达 context window 上限」，`apiError:"max_output_tokens"`。
- `pause_turn`：运行时（TS runner）**自动 resume**（server-tool agentic flow 续跑；SDK 文档 419784/420160 述 Python runner 不自动 resume，TS 会）。

### 本项目现状（读码）

- 直连 Anthropic 路径**透传 stop_reason**（`grep model_context_window_exceeded` 全仓零命中；`pause_turn` 仅在跨格翻译矩阵 [anthropic-to-cc.ts:163](../../src/lib/openai/translate/anthropic-to-cc.ts#L163) 映射 → stop）。对代理是**正确**行为：这些 stop_reason 由 CC 客户端消费，代理不该拦。
- auto-truncate（[auto-truncate.ts:autoTruncateAnthropic](../../src/lib/anthropic/auto-truncate.ts)）是**真截断**：`payload.messages.slice(preserveIndex)` 丢老消息 + 注入 `createTruncationSystemContext` 摘要到 system。双触发：**proactive**（count_tokens 通胀诱导 CC 自己 compact，轮次 3）+ **reactive**（token-limit 400 后截断重试，[strategies/auto-truncate.ts](../../src/lib/request/strategies/auto-truncate.ts)）。

### F13（LOW/信息）— stop_reason 透传无 gap；记录 auto-truncate ↔ CC context 的双主体交互

**stop_reason 家族**：透传正确，CC 客户端处理，**无缺陷**。`pause_turn` 直连路径透传 → CC TS runner 自动 resume（发续跑请求，对代理是新请求）→ 正常。`model_context_window_exceeded` 若 GHC 以 stop_reason 发则透传给 CC（298173 处理）；若 GHC 以 HTTP-400 发则本项目 reactive auto-truncate 接住——两路都覆盖。

**值得记录的交互（by-design，但需知晓）**：context 管理现在是**双主体**——CC 有自己的 auto-compact / `context_management` / `/context`，本项目也有 auto-truncate。本项目 proactive 通胀 count_tokens（返 `contextWindow*0.95`）是**刻意让 CC 先 compact**（优于代理盲截）。残余需知晓的三点：
1. **CC 不感知代理的 server-side 截断**：reactive 腿 drop 老消息 + 注入摘要后，GHC 基于**截断后**上下文回答，而 CC 的会话态仍持完整消息 → **CC 认知的 context ≠ GHC 实际处理的**。下一轮 CC 又发完整历史 → 每轮重截（幂等但重复计算）。
2. **CC auto-compact 关闭时的错配**：若用户关了 CC 自动 compact，proactive 通胀让 `/context` 显示 ~95%（代理信号，非真实 token）却不触发 compact → 真请求走 reactive 截断 → CC 全程不知情。`/context` 面板读数在此情形**误导**。
3. **谁的截断更优**：CC 的 compact 是语义摘要（LLM 驱动），代理的截断是消息级 slice + 简摘要——CC 的通常更优，这正是 proactive 通胀「让位给 CC」的动机。reactive 腿是 CC 未 compact 时的安全网。

**理想方向（不在本轮做，低优先）**：在 [docs/](../../docs/)（auto-truncate 相关文档或 DESIGN）补一节「双主体 context 管理：代理 proactive 通胀让位 CC compact + reactive 截断安全网 + CC 不感知代理截断」，让接手者理解这层交互；无需代码改动（当前设计是 considered tradeoff）。**待实测**（可选）：CC auto-compact 关闭时，proactive 通胀是否造成 `/context` 读数困惑或 compact 抖动。

### 本轮结论

stop_reason 家族**透传正确、无 gap**（对代理是应有行为）。唯一产出是把 **auto-truncate 与 CC 2.1.207 context 管理的双主体交互**显式记档（F13，低/信息）——当前是 considered design，仅需文档化那三点认知错配，不需改代码。

---

## 轮次 8（2026-07-13）：prompt-caching beta —— 较新 cache betas 的 proactive 感知缺口

### 发现来源（CC 源码坐标）

- CC 2.1.207 发送的 cache 相关 betas（常量 `app.pretty.js:61831`）：`extended-cache-ttl-2025-04-11`、`prompt-caching-scope-2026-01-05`、**`cache-diagnosis-2026-04-07`**、**`prompt-caching-evict-2026-05-12`**。
- **`w8i`**（170036）= cache-diagnosis-beta 拒绝检测：`li && status===400 && msg.includes(F2e.header) && msg.includes("anthropic-beta")` → 恢复（298146）`ee=false, wSe($,F2e), "retry:cache-diagnosis-beta"`（丢该 beta latch、重试）。
- **`T8i`**（170039）= prompt-caching-evict 拒绝检测：`status===400` 且 `msg.includes(B2e.header)` 或（`"evict_on_complete"`+`"beta"`）→ 恢复（298147）丢 evict beta、重试。
- `cache-diagnosis` beta 令上游返 `diagnostics.cache_miss_reason`（CC 读 `fi.diagnostics?.cache_miss_reason`，298325）；`prompt-caching-evict` = `evict_on_complete` 缓存驱逐提示。
- **结构**：`w8i`/`T8i` 都 `status===400`（beta 拒绝天然 pre-commit：GHC 在响应头就拒、流未 commit）→ CC 自愈与本项目 reactive strip **同为 HTTP-400 路径**、无 post-commit 风险（不同于 F9/F10/F11 的 caveat）。

### 本项目现状（读码）

cache-beta negotiation **极完备**：
- 通用 [unsupported-beta-retry.ts](../../src/lib/request/strategies/unsupported-beta-retry.ts)：处理 explicit-list（`unsupported beta header(s): X`）与 laconic（`invalid beta flag` 无清单，升序子集枚举定位最小非法集）两形态，学习并 fixate **任意** unsupported beta → 覆盖 `cache-diagnosis`/`prompt-caching-evict`。
- [cache-control-subfield-rejection-retry.ts](../../src/lib/request/strategies/cache-control-subfield-rejection-retry.ts) + [request-preparation.ts:298](../../src/lib/anthropic/request-preparation.ts#L298)：内置地雷列表**proactive 剥** `scope`（`prompt-caching-scope` beta 引入、GHC 未启用）。
- `extended-cache-ttl-2025-04-11`：**主动镜像 GHC** 的 per-layer 5m/1h TTL（[features.ts:330](../../src/lib/anthropic/features.ts#L330)），header 精确随 body。
- 未知 client beta 默认透传到 GHC → 被拒则 reactive strip + fixate。

### F14（LOW-MED）— `cache-diagnosis` / `prompt-caching-evict` 无 proactive 感知：首轮浪费往返 + 诊断/驱逐特性静默不可用

**判断（读码）**：全仓 `grep cache-diagnosis|prompt-caching-evict|cache_miss_reason|evict_on_complete` **零命中**——本项目对这两个较新 cache beta 及其响应产物**无显式感知**。功能上：
- **无硬失败**：通用 `unsupported-beta-retry` 兜底——GHC 拒 → 学习 strip → 重试成功、fixate（此后免疫）。CC 的 `w8i`/`T8i` 也是兼容后备（同 HTTP-400 路径）。
- **代价 1（首轮往返）**：每个新会话首次带这些 beta 打 GHC → 首请求 400 → reactive strip → 重试。fixate 后不再犯，但每冷启动一次浪费。对比：`scope` / `eager_input_streaming` 是 **proactive 剥**（零往返），这两个不是。
- **代价 2（特性静默丢失）**：若 GHC 不支持 `cache-diagnosis`（大概率）→ beta 被剥 → GHC 不返 `diagnostics.cache_miss_reason` → CC 的缓存未命中诊断（`/context` 等）**空**。`prompt-caching-evict` 被剥 → `evict_on_complete` 驱逐意图丢失、GHC 用默认缓存。均非硬 bug，是 GHC 能力边界下的静默降级。

**理想方向（不在本轮做，需 GHC 探针）**：
1. **实测 GHC 是否支持** `cache-diagnosis-2026-04-07` / `prompt-caching-evict-2026-05-12`（skill `ghc-api-reference`，curl 带 beta 打 GHC 看 200 vs 400）。
2. 若 GHC **不支持** → 加入 request-preparation 的内置地雷列表**proactive 剥**（仿 `scope`/`eager_input_streaming`），省首轮往返；同时在文档标注「这些 CC cache 诊断/驱逐特性经 GHC 不可用」。
3. 若 GHC **支持** `cache-diagnosis` → 考虑把 `diagnostics.cache_miss_reason` 纳入本项目 history/telemetry（`richest-data-flow`：缓存命中诊断是高价值运维信号，别丢）。

### 本轮结论

cache-beta negotiation 是本项目**最完备**的子系统之一（通用枚举 strip + 子字段地雷 + extended-ttl 镜像），对新 betas reactive 全覆盖、无硬失败。唯一缺口是**两个 2026 新 cache beta 的 proactive 感知**（F14，低-中）：首轮往返浪费 + 诊断/驱逐特性静默降级。修复前需 GHC 能力探针裁定「proactive 剥 vs 接住诊断信号」。

---

## 轮次 9（2026-07-13）：mid-conversation `role:"system"` —— convert 模式不复刻 CC 的 `<system-reminder>` 回退

### 发现来源（CC 源码坐标）

- CC 2.1.207 新 beta **`mid-conversation-system-2026-04-07`**（`Ipe`，常量 61831）——允许在 `messages` 数组里发**会话中途**的 `role:"system"` 消息（旧版被 Anthropic 拒）。
- **`_7n`**（170073）= mid-conv-system 拒绝检测：`li && status===400` 且——含 `Ipe.header`+`"anthropic-beta"` / 含 `"Unexpected role"`+`"input message role"` / `"cache_control"`+`$hg` / `"not supported"`+`/role .system/i`。
- **`_7n` 恢复**（298169）：`wSe($, Ipe)` 丢 `mid-conversation-system` beta + 把 `role:"system"` 消息**改写成 `<system-reminder>` 包裹的 body 内容**、sticky 拒该 beta 直到 `/clear` 或 `/compact`。
- **结构**：`_7n` 要求 `status===400`（role/beta 拒绝天然 pre-commit）→ 与本项目 reactive 同 HTTP-400 路径、无 post-commit 风险。

### 本项目现状（读码）

inline `role:"system"` 处理**完整**：[sanitize/system-messages.ts](../../src/lib/anthropic/sanitize/system-messages.ts) 五模式 `false`(passthrough) / `drop_invalid` / `merge`（折进顶层 system）/ `as_user` / `as_assistant`；[system-reject-mode.ts](../../src/lib/anthropic/system-reject-mode.ts) 按出站模型选 `system_reject_mode` vs `system_default_mode`（**默认 passthrough**）；[system-reject-retry.ts](../../src/lib/request/strategies/system-reject-retry.ts) reactive 学习哪些模型拒 inline system。**默认 passthrough = 把 inline system + beta 原样转发 GHC**（对 GHC 支持时正确）。

### F15（MEDIUM）— GHC 拒绝时，本项目 convert 模式**抢占且劣于** CC 的 `<system-reminder>` 原位回退

**判断（读码，与 F10 同构）**：本项目全仓对 `mid-conversation-system-2026-04-07` beta **无显式感知**（grep 零命中）。默认 passthrough 下：
- **GHC 支持该 beta** → 转发即正确（最优，待实测确认）。
- **GHC 不支持** → 两条 reactive 策略介入：`unsupported-beta-retry` 剥 beta + `system-reject-retry` 学习该模型拒 inline system → 应用 `system_reject_mode` **服务端 convert**。此 convert **抢占**了 CC 的 `_7n`（因为 400 被代理消化、CC 看不到）。

**语义损失（关键）**：CC 的 `_7n` 回退是**原位 `<system-reminder>` 包裹**——保留「这是系统指令」的框定 + 会话中的**位置**。本项目五模式**无一复刻**（`<system-reminder>` 在本项目只被**剥**、convert 时从不添加）：
- `merge`：折进**顶层** system → 丢失 mid-conv 的**位置语义**（中途指令变全局前言）。
- `as_user`/`as_assistant`：保留位置，但**不包 `<system-reminder>`** → 模型看到的是普通 user/assistant 轮、非系统指令框定。
- `drop_invalid`：**内容丢失**。

即：当 GHC 拒 mid-conv system 时，本项目给出的降级比 CC 原生 `_7n` **语义更失真**，且 CC 更忠实的回退被抢占、无从触发。

**理想方向（不在本轮做，需 GHC 探针）**：
1. **实测 GHC 是否支持** `mid-conversation-system-2026-04-07`（curl 带 beta + inline `role:"system"` 打 GHC，skill `ghc-api-reference`）。支持则默认 passthrough 已最优、F15 不成立；不支持才继续。
2. 若不支持 → 新增一个 `system_reject_mode` 值 **`as_user_system_reminder`**（as_user 位置 + `<system-reminder>` 包裹），**逐字复刻 CC 的 `_7n` 回退**作为语义最忠实降级，并设为该场景推荐模式。
3. 或（更激进）识别该 beta 后**故意不 reactive 消化、透传 400** 让 CC 的 `_7n` 自己处理——但与本项目「服务端消化」哲学冲突，且多数用户可能没有更好的 CC 版本，需权衡。
4. 两 reactive 策略（beta-strip + system-reject convert）的**协调/顺序**待核（会否 2 往返 / 抖动）——`system-reject-retry` 与 `unsupported-beta-retry` 是否在同一 400 上竞争认领。

### 本轮结论

inline `role:"system"` 处理本项目**机制完整**（五模式 + 按模型选择 + reactive 学习），默认 passthrough 恰当让位 GHC。缺口是 **2.1.207 新 `mid-conversation-system` beta 场景下**：GHC 拒绝时本项目 convert **抢占且语义劣于** CC 的 `<system-reminder>` 原位回退（F15，中，与 F10 refusal-fallback 同构）。修复前需 GHC 探针裁定该 beta 是否被支持。

---

## 轮次 10（2026-07-13）：context-hint SSE 双向 context 管理协议

### 发现来源（CC 源码坐标）

CC 2.1.207 新 beta **`context-hint-2026-04-09`**（`$mi`，61831）——一个**双向** context 管理协议（`de` handler，297473-297490）：
- **请求侧**：`tokensSaved >= DZi`（阈值）时，body 加 `context_hint: { enabled: true, ...target_tokens_saved: N }` + `context-hint` beta（客户端告诉服务端「我能省 N token，你可据此 compact」）。
- **响应侧 SSE**：`classifyStreamError(i)` 用 `v$d(i)` 检测**上游中途下发的 context-hint SSE 信号**（`Ydu` 归类为 `"context_hint_sse"`，163852）→ `onStreamFallback` 触发 `tLs(...)` = clear/compact messages 后重试。
- `onRequestError`：400（`A$d`）→ `{messages, clearedIds, clearedContent}`（清特定消息 id 重试）；409/529 也有分支。即 298168-298170 的 `retry:context-hint`。

### 本项目现状（读码）

全仓对 `context_hint` / `context-hint-2026-04-09` beta **零感知**（grep 零命中）。兜底：body-field-rejection 的 `EXTRA_INPUTS_PATTERN`（[context-management-retry.ts:42](../../src/lib/request/strategies/context-management-retry.ts#L42)）匹配顶层 `context_hint:` → GHC 拒则 reactive strip；`unsupported-beta-retry` 剥 beta。

### F16（LOW，与 F14 同族）— `context_hint` 无 proactive 感知：reactive 兜底但特性经 GHC 静默不可用

**判断（读码）**：
- **无硬失败**：`context_hint` body 字段 + beta 若被 GHC 拒 → 通用 reactive strip 兜底、fixate。
- **请求侧信号丢失**：GHC 大概率不支持 → `context_hint` 被剥 → 客户端「我能省 token」的提示传不到服务端。**危害极小**——这只是让服务端做 server-side compact 的**优化信号**，CC 仍有自己的 client-side auto-compact 兜底，非correctness需求。
- **响应侧 SSE**：GHC 几乎certainly不发 context-hint SSE 信号 → 当前非问题。若未来发，本项目 passthrough 会转发该帧（带 event: 行）给 CC 的 `classifyStreamError` 消费——但需核实累加器 `default` 分支不吞（同 F12 compaction 块的前瞻性核实）。

**理想方向（低优先）**：并入 F14 的 GHC 能力探针批次——一并测 `context-hint-2026-04-09` / `context_hint` body GHC 是否支持。支持则透传即可（甚至纳入本项目 context 决策）；不支持则 proactive 剥省往返。

### 本轮结论

context-hint 是 CC 2.1.207 又一个新 context-管理协议，本项目 reactive 兜底、无硬失败，请求侧信号经 GHC 静默丢失（危害极小，有 CC 自身 compact 兜底）。归入「2026 新 beta 无 proactive 感知」族（F14/F15/F16）。

---

---

## 轮次 11（2026-07-13）：fine-grained tool streaming —— 确认无正确性 gap，仅 UX eagerness 降级

> 次级面第一项。结论**确认性**（无缺陷），按 faithful 纪律如实记录。

### 发现来源（CC 源码坐标）

- **`eager_input_streaming` 是 per-backend 能力**（模型表 `app.pretty.js:9030`：`eager_input_streaming: {bedrock:true, vertex:true}` 或 `{vertex:true}`）——**无 first-party 标志**，主要为 bedrock/vertex 后端；`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`（28304）可强开。beta `fine-grained-tool-streaming-2025-05-14`（422518，SDK 文档）。
- **CC tool 输入累加器**（11100）：`input_json_delta` → `_emit("inputJson", partial_json, input)`，仅在 `P5a(n3) && n3.input`（块是 tool_use）时；**最终 JSON 解析在 content_block_stop**（累加器 concat partial_json，非逐帧解析）→ **分片粒度与正确性无关**。
- **空 `partial_json` 安全**：mid-stream 消费者（281618）`if (T?.type!=="input_json_delta" || !T.partial_json) continue`——空串 falsy → 跳过；累加器 concat 空串无害。呼应轮次 1「空 delta 安全」。
- **281618 的 mid-stream partial 解析是 web_search 专用**（regex 抽 `"query"` 喂 live search-progress UI）——本项目已**退役 web_search**（git log「删 web_search 双跳模块」）→ 与通用 tool 路径无关。

### 本项目现状（读码）

`stripToolFields` 内置默认**proactive 剥** `eager_input_streaming`（轮次 2，零往返）→ GHC 从不见该字段 → 产**非-eager（保守）分片**。tool 输入累加/修复由 `decode-tool-input.ts` / `tool-input-repair.ts` 兜底（robust，含 AskUserQuestion \uXXXX 修复）。keepalive 对 open tool_use 块发 `input_json_delta{partial_json:""}`（轮次 1）。

### F17（LOW/信息，主线 C 家族）— 剥 `eager_input_streaming` 仅损 UX eagerness，零正确性

**判断（读码）**：
- **零正确性影响**：CC 只在 content_block_stop 解析 tool 输入，GHC 的分片粒度（eager vs 保守）不改变最终累加结果。空 keepalive input_json_delta 被 CC 安全跳过。**无 gap**。
- **唯一代价（UX）**：剥 `eager_input_streaming` → GHC 不 eager 流式 tool 输入 → CC 对**正在流入的 tool 参数**的 live 显示更新更粗（成块而非逐字）。对多数工具**无感**，仅超大 tool input 的实时预览略钝。属主线 C（客户端能力经 GHC 静默降级）但**严重度最低**——非诊断/驱逐那种功能缺失，纯呈现细腻度。

**理想方向（极低优先）**：并入主线 C 的 GHC 探针批次时**顺带**测 GHC 是否支持 `eager_input_streaming` / `fine-grained-tool-streaming-2025-05-14`——若 GHC 已支持，可停止 proactive 剥、恢复 eager UX；若不支持（现状假设），保持剥、文档标注「fine-grained tool streaming 经 GHC 不可用（仅 UX）」。

### 本轮结论

fine-grained tool streaming **无正确性 gap**（CC block-stop 解析 + 空 delta 安全 + web_search mid-parse 已退役）。唯一是剥 `eager_input_streaming` 的 UX eagerness 降级（F17，最低severity，归主线 C）。本项目 tool 输入子系统（proactive 剥 + decode/repair + 累加）**成熟**。

---

## 轮次 12（2026-07-13）：anthropic-beta 全集对账（27 betas）

### CC 2.1.207 完整 beta 常量表（`app.pretty.js:61831` 的 `Q0(name, token)`）

逐条对本项目 negotiation 支持矩阵。**关键前提**：本项目 negotiation 是**数据驱动通用剥离**——`unsupported-beta-retry`（explicit + laconic 枚举）剥**任意**未识别 beta。故下表「reactive-only」≠ 坏，= GHC 拒时通用 strip 兜底、无硬失败。仅「改响应 wire」或「应主动 emit/映射」的才是真待办。

| beta token | CC 特性 | 本项目状态 | 备注 |
|---|---|---|---|
| `claude-code-20250219` | 基础 claude_code | 透传 | CC 恒发、GHC 必受 |
| `interleaved-thinking-2025-05-14` | 交错思考 | ✓ 显式 | |
| `context-1m-2025-08-07` | 1M 上下文 | ✓ 显式 | |
| `context-management-2025-06-27` | context 编辑 | ✓ 显式 | 主动 emit/映射 |
| `extended-cache-ttl-2025-04-11` | 1h cache TTL | ✓ 显式主动 | 镜像 GHC 5m/1h |
| `structured-outputs-2025-12-15` | 结构化输出 | ✓ 按名 | partner-strip + retry |
| `effort-2025-11-24` | effort 档位 | ✓ 按名 | effort-learning-retry |
| `advanced-tool-use-2025-11-20` | tool_search 新 | ✓ 显式 | |
| `tool-search-tool-2025-10-19` | tool_search 旧 | reactive-only | CC 同发新旧两版；本项目认新版 |
| `prompt-caching-scope-2026-01-05` | scope 子字段 | ✓ 按名（剥 scope） | 轮次 8 |
| `prompt-caching-evict-2026-05-12` | evict_on_complete | reactive-only | **F14** |
| `cache-diagnosis-2026-04-07` | cache_miss_reason | reactive-only | **F14** |
| `context-hint-2026-04-09` | 双向 context hint | reactive-only | **F16** |
| `mid-conversation-system-2026-04-07` | 中途 role:system | reactive-only | **F15** |
| `fast-mode-2026-02-01` | speed:"fast" | reactive-only | **F5 增补**：fast 模式发 body `speed` **+ 此 beta**，两者都未识别、都 reactive 剥 |
| `redact-thinking-2026-02-12` | 服务端 redact thinking | reactive-only | **新 F18-a**：改响应侧 thinking 形态 |
| `thinking-token-count-2026-05-13` | usage 加 thinking token 数 | reactive-only | **新 F18-b**：改 usage wire |
| `server-side-fallback-2026-06-01` | 服务端换模型 | reactive-only | 连 **F10**（GHC 无服务端 fallback） |
| `fallback-credit-2026-06-01` | fallback 计费 | reactive-only | 连 F10（`creditCode`） |
| `web-search-2025-03-05` | web_search | 退役 | 本项目已删 web_search 双跳 |
| `task-budgets-2026-03-13` | 任务预算 | reactive-only | 客户端特性倾向；proxy 相关性低 |
| `advisor-tool-2026-03-01` | advisor 工具 | reactive-only | `tengu_advisor_tool_interrupted`（轮次 5 见） |
| `afk-mode-2026-01-31` | 离席模式 | reactive-only | 客户端特性 |
| `mcp-servers-2025-12-04` | MCP servers | reactive-only | 可能异端点/客户端侧 |
| `files-api-2025-04-14` | Files API | reactive-only | **异端点**（非 /v1/messages） |
| `environments-2025-11-01` | 环境/沙箱 | reactive-only | 客户端特性 |
| `ccr-byoc-2025-07-29` | BYOC | reactive-only | 客户端/路由特性 |

### F18（LOW-MED）— 两个「改响应 wire」的新 beta 需专门核实（其余 reactive 覆盖足够）

全 27 betas 里，**未识别但需超出「通用 reactive 剥」关注**的仅两个（改响应侧、不是纯请求装饰）：

**F18-a — `thinking-token-count-2026-05-13`（改 usage wire）**：该 beta 令上游在 usage 里回**思考 token 计数**（独立字段）。若 GHC 支持 → 本项目 usage 转发 / history 记录**必须不吞该新字段**（`richest-data-flow`；参见排队中的「usage wire 形状」待查项，二者应合并核）。若 GHC 不支持 → 剥 → CC 拿不到、退回自算。**待实测**：GHC 是否支持 + 本项目 usage passthrough 是否 allowlist（会漏未知字段）还是全量透传。

**F18-b — `redact-thinking-2026-02-12`（改 thinking 响应形态）**：客户端请求上游**服务端 redact thinking**（返 `redacted_thinking` 而非明文）。与本项目 thinking quarantine（F11）交互：若 CC 请求 redaction 而 GHC 不支持 → 上游返**明文** thinking（CC 期望 redacted）→ 本项目 quarantine 按明文处理，CC 侧显示/存储与预期不符。**待实测**：GHC 是否支持；不支持时明文 thinking 经本项目 quarantine 后对 CC 的影响。

**其余 22 betas 结论**：
- 已显式/按名处理 8 个（interleaved-thinking / context-1m / context-management / extended-cache-ttl / structured-outputs / effort / advanced-tool-use / prompt-caching-scope）——**无 gap**。
- 已在前轮记为 F5/F14/F15/F16 的 5 个（fast-mode / prompt-caching-evict / cache-diagnosis / context-hint / mid-conversation-system）——归主线 C。
- `server-side-fallback` / `fallback-credit` 连 F10：GHC 无服务端 fallback，剥之与 F10 结论一致（只 client-side `refusalFallbackModel` 有效）。
- 客户端特性 / 异端点 7 个（task-budgets / advisor-tool / afk-mode / mcp-servers / files-api / environments / ccr-byoc）：proxy 相关性低，reactive 剥足够；`files-api` 是**独立端点**（若用户走 Files API 需另评，不在 /v1/messages 审计范围）。
- `tool-search-tool-2025-10-19`（旧 tool-search）：CC 新旧两版都发，本项目认新版，旧版 reactive 剥——无实害。

### 本轮结论

27 betas 全对账完成：本项目**通用 reactive 剥离 + 8 个显式/按名处理**已覆盖绝大多数，无硬失败。真正需专项核实的仅 **F18-a（usage wire）/ F18-b（redact-thinking）** 两个改响应侧的 beta，均待 GHC 探针。矩阵本身可作为「CC↔GHC beta 支持矩阵」长期参照落进 skill `ghc-api-reference`。

---

## 轮次 13（2026-07-13）：usage wire —— 结构化 accumulator allowlist 漏 cost 相关因子（含 F18-a 结论）

### 发现来源（CC 源码坐标）

CC 2.1.207 从 `message_delta.usage` 累加（`app.pretty.js:11153-11157`）：`output_tokens` / `input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `server_tool_use` / **`iterations`（新）**，外加 `message_delta.context_management`。**成本计算**（`ehi` 62134 / `bYm` 62129）读**嵌套** `cache_creation.ephemeral_1h_input_tokens`（1h vs 5m cache write 拆分定价）与 `server_tool_use.web_search_requests`；`speed==="fast"` 走**独立定价表**（`thi` 62138，per-model fast 档更贵）。

### 本项目现状（读码）——usage 处理**分裂**

- **转发给 CC = passthrough 原始帧**：response-rewrite 默认 `[raw]`（[response-rewrite-adapters.ts:327-330](../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L327)），非 refusal 的 `message_delta` **逐字转发** → **CC 拿到完整 usage wire（含 iterations / ephemeral_1h / web_search_requests / 任何新字段）**。**CC 侧无 gap**。
- **raw 存 history sseEvents**：上游原始轨忠实（[driver.ts:426-432](../../src/lib/pipeline/driver.ts#L426)）→ 原始 usage 帧**在 history 里可回溯**。
- **本项目结构化 accumulator = allowlist**（[stream-accumulator.ts:211-220](../../src/lib/anthropic/stream-accumulator.ts#L211) + 类型 385-387）：**只**取 `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `server_tool_use.tool_search_requests`。

### F19（MEDIUM，richest-data-flow）— 结构化 usage 漏 cost 相关因子（iterations / 1h-cache 拆分 / web_search_requests）

**判断（读码）**：本项目喂 history entry usage 投影 + telemetry 的**结构化** accumulator **漏**以下 CC/Anthropic 现发的 usage 字段：
- **`iterations`**（新，2.1.207）——完全未取。
- **`cache_creation.ephemeral_1h_input_tokens`**——嵌套的 1h-vs-5m cache-write 拆分。本项目只取扁平 `cache_creation_input_tokens` 总数 → **无法区分 1h/5m 定价腿**（`bYm` 需要它做准确成本归因）。
- **`server_tool_use.web_search_requests`**——本项目只捕 `tool_search_requests`（[220](../../src/lib/anthropic/stream-accumulator.ts#L220) 只 typed 这一个），漏 `web_search_requests`。

违 `richest-data-flow` ADR（后端存储必须完整、永不为 DRY/YAGNI/无消费者裁剪）+ `telemetry-architecture`（**聚合后不可重算的因子拆最细**——1h/5m 拆分正是聚合后不可重算的 cost 因子）。**危害**：raw 虽在 sseEvents，但**结构化/可查询/可聚合**的 usage 投影缺这些 → telemetry 成本归因（`/metrics`、model 维度成本）**算不准 1h-cache 与 web_search 成本**，也拿不到 iterations；下游要用得回去重解析 sseEvents（违「聚合后不可重算拆最细」）。

**F18-a（`thinking-token-count-2026-05-13`）在此结题**：该 beta 若令 GHC 在 usage 加思考 token 字段，会被**同一 allowlist 丢弃**（结构化层）——与 F19 同根同修。CC 侧仍 passthrough 拿得到（若 GHC 发）。注：本轮未在 CC 累加器直接见到 `usage.thinking_tokens` 读取点（206940 的 thinking_tokens 是 message-action 集、非 usage），故 F18-a 的「usage 新字段」仍**待 GHC 实测确认存在**再定。

**理想方向（不在本轮做）**：把结构化 accumulator 从 allowlist 改为**保留完整 usage 对象**（或至少补 `iterations` + `cache_creation` 嵌套 + `server_tool_use.web_search_requests` 三项），并在 telemetry registry 按最细因子拆（skill `telemetry-architecture` 三支柱）。新增 usage 顶层字段的三处必改见 skill `persistence-async-invariants`（toHistoryEntry + onTerminal 投影 + updateEntry allowlist）。**这是一条明确的 richest-data-flow 正确改进，非可选**——按项目哲学不因「当前无消费者」降级。

### 本轮结论

usage **对 CC 无 gap**（passthrough 全字段 + raw 存 sseEvents）。真问题是本项目**自身结构化 usage 投影是 allowlist**、漏 3 个 cost 相关因子（+ 潜在 thinking-token-count），违 richest-data-flow / telemetry「不可重算因子拆最细」（F19，中）。这是明确该做的正确改进，落地见 telemetry-architecture / persistence-async-invariants skill。

---

## 轮次 14（2026-07-13）：metadata / 请求归属 —— 丢弃 CC 的丰富会话关联负载

### 发现来源（CC 源码坐标）

CC 2.1.207 的 `metadata` builder `Wtt()`（`app.pretty.js:297580-297589`）：
```
metadata = { user_id: JSON.stringify({
  ...CLAUDE_CODE_EXTRA_METADATA(env 注入的额外对象),
  device_id, account_uuid, session_id,
  ...parent_session_id (子会话/subagent 才有)
}) }
```
即 CC 把**一整个 JSON 对象**（设备、账户、**会话 id、父会话 id**、用户额外注入）序列化成字符串塞进 Anthropic `metadata.user_id`（本是不透明 id 的字段，CC 超载它承载归属/telemetry）。`session_id`=CC 会话、`parent_session_id`=subagent 到其父会话的链接。

### 本项目现状（读码）

- 全仓对**请求 `metadata` 字段零处理**：grep 到的 `metadata` 全是**模型** metadata（capabilities）；`session_id`（thinking-quarantine/store.ts）是本项目**自有**的中毒会话追踪键、**非**来自 CC 的 metadata。
- 请求体 mutate-in-place + 透传未知字段（轮次 2）→ `metadata` **原样转发 GHC**（Anthropic 标准字段，GHC 代理 Anthropic 大概率受；被拒则 body-field-rejection 剥 `metadata:`）。**无硬失败**。

### F20（MEDIUM，richest-data-flow + 观测机会）— 丢弃 CC 的 session/parent_session 关联负载

**判断（读码）**：本项目**不解析、不利用** `metadata.user_id` 里的 JSON——每条 CC 请求都自带的**高价值关联信号被整体丢弃**：
- **`session_id`**：可把 history entries **按 CC 会话分组**（当前 history 只有 proxy 自己的 `ctx.id`，无 CC 会话维度）。
- **`parent_session_id`**：subagent 请求到父会话的链接 → 可在 history **重建 subagent 父子树**（哪些请求是某主会话派生的子 agent）。
- `account_uuid` / `device_id`：多账户 / 多设备归属。

违 `richest-data-flow` ADR（丰富上下文应流动、末端决定呈现，后端**完整捕获**不 upstream 裁剪）。本项目有 **History Web UI（ui-v4）**——按 CC session 分组、重建 subagent 树是**实打实的观测增强**，而数据就在每条请求的 metadata 里、当前白白透传丢弃。属与 F19（usage allowlist）同族的「rich data 就在手边却没捕获」。

**落地注意（faithful，别踩）**：
- `metadata.user_id` 被 CC 打包成 **JSON 字符串**（超载不透明 id 字段）——解析须**防御式** `JSON.parse`（try/catch，非 CC 客户端会发普通字符串或不发 → 优雅降级为「无关联信息」，绝不因解析失败影响主流程）。
- `device_id`/`account_uuid` 是准 PII，但按项目 `internal-tool-security-posture`（内部工具全量暴露、运维价值 > 假想泄露、且是用户自己的数据）→ 存 history **对齐项目哲学、无安全阻塞**；仍建议不写日志明文（`secure-by-default`）。
- 新增 history 关联字段的三处必改见 skill `persistence-async-invariants`（toHistoryEntry + onTerminal 投影 + updateEntry allowlist）；ui-v4 侧加「按会话分组 / 父树」视图。

**理想方向（不在本轮做，需 brainstorming）**：新建一个 request-preparation/history 的「入站 metadata 提取」步——防御解析 `metadata.user_id`，把 `session_id`/`parent_session_id`/`account_uuid` 存进 history entry 的新关联字段；ui-v4 加会话维度分组 + subagent 父树。这是明确的 richest-data-flow 正确增强。

### 本轮结论

metadata **对 GHC 转发无 gap**（passthrough / reactive 剥兜底）。真问题是本项目**丢弃了 CC 每请求自带的会话关联负载**（`session_id`/`parent_session_id` 等），错失 history 按会话分组 + 重建 subagent 树的观测能力（F20，中，richest-data-flow）。与 F19 同族、同为 on-philosophy 的正确增强。

---

## 轮次 15（2026-07-13）：tool_choice —— 缺 CC 的「forced tool + thinking → auto」降级（翻译矩阵可撞 GHC 400）

> 次级面最后一项。原清单 + 5 个次级面全覆盖。

### 发现来源（CC 源码坐标）

- CC 2.1.207 请求体 `tool_choice: ai`（`ai = i.toolChoice`，297964）——透传调用方的 tool_choice。
- **NEW 客户端降级规则**（297965）：`_o = thinking 激活（enabled/adaptive）`；`if (ai?.type==="tool" && _o) ai = {type:"auto"}`，warn「tool_choice {type:'tool'} demoted to auto: extended thinking is active」。即 **Anthropic 不允许 forced tool_choice（`tool`/`any`）与 extended thinking 并存**，CC **客户端侧主动降级**避 400。
- `disable_parallel_tool_use` 仅 SDK 文档（420944/424372）、**非运行时**构造 → 低相关。

### 本项目现状（读码）

- **直连 Anthropic 路径不碰 tool_choice**（透传，grep 无处理点）。
- **翻译矩阵翻译 tool_choice**：`cc-to-anthropic-request.ts:286 translateToolChoice`（OpenAI `required`/`{type:function}` → Anthropic `any`/`tool`）等三向。
- **全仓无 tool_choice+thinking 降级**（grep 零命中）；反应式策略目录**无**对应项（17 个策略里没有 tool-choice/thinking-incompat）。
- 本项目**会 transform thinking**（request-preparation.ts:613-680，enabled↔adaptive）——但**不检查/不降级 tool_choice**。

### F21（MEDIUM）— 无 forced-tool+thinking 降级，非-CC 客户端 / 翻译矩阵撞 GHC 400 且无恢复

**判断（读码）**：本项目**既不 proactive 降级**（像 CC 那样）**也无 reactive 策略**兜底 forced-tool+thinking 的 400。
- **CC 2.1.207 请求安全**：CC 客户端已自降级 → 代理收到的是 `tool_choice:auto`，永不撞。
- **真实风险路径**：
  1. **翻译矩阵**（本项目核心特性：任意客户端 × 任意 GHC 模型）——OpenAI/Gemini 客户端发 forced function（`tool_choice:{type:"function",name}`）打到 thinking 模型，`translateToolChoice` 译成 Anthropic `tool_choice:{type:"tool"}`，若该 GHC 模型注入/带 thinking → **forced tool + thinking → GHC 400、无恢复**。
  2. **非-CC 直连 Anthropic 客户端**发 `tool_choice:{type:"tool"}` + `thinking` → 同样 400（此情形客户端自身有责，但代理可更友好）。
- **潜在自造**：本项目把 thinking `enabled→adaptive`（629）——若原请求带 forced tool_choice，transform 后仍是 forced+thinking 不兼容（transform 不解不兼容、也不降级 tool_choice）。虽 enabled→adaptive 只在原本就有 thinking 时触发（非凭空注入），但代理经手后仍把不兼容组合送出。

**理想方向（不在本轮做）**：
1. **proactive 降级（推荐，镜像 CC）**：在 request-preparation / 翻译矩阵出站，检测 `tool_choice.type ∈ {tool, any}` 且 thinking 激活 → 降 `{type:"auto"}` + `ctx.recordFeature("tool-choice-demoted-thinking")` + 日志。**逐字复刻 CC 的 297965**，对所有客户端统一兜底（覆盖 CC 不经手的翻译矩阵路径）。
2. **或 reactive 策略**：新增 catch 该特定 400（消息约含 `tool_choice` + `thinking`）→ 降级重试 + fixate。proactive 更优（省往返、翻译矩阵路径尤其）。
3. **待实测**：确认 GHC/Anthropic 对 forced-tool+thinking 的确切 400 文案（proactive 不需要、reactive 需要）；确认翻译矩阵是否真会对 thinking 模型注入 thinking 同时保留 forced tool（复现路径）。

### 本轮结论

tool_choice 对 **CC 2.1.207 无 gap**（CC 客户端自降级）。真缺口是本项目**未复刻该降级**、对**翻译矩阵 / 非-CC 客户端**的 forced-tool+thinking 组合无 proactive 降级也无 reactive 兜底 → 硬 400（F21，中）。推荐 proactive 降级（镜像 CC 297965），统一覆盖 CC 不经手的路径。`disable_parallel_tool_use` 非运行时、无关。

---

## 轮次 16（2026-07-13）：限流头 / 429 重试 —— 响应头转发完备，429 吞噬有 keepalive 覆盖

> 新主题（原清单已尽）。结论**大体确认无 gap** + 一条 config 边缘 caveat + 一条 richest-data-flow 判断（此处**不该**伪造）。

### 发现来源（CC 源码坐标）

- CC 2.1.207 读丰富的限流头驱动配额 UI：`Fhu`（`app.pretty.js:169690`）读 `anthropic-ratelimit-unified-{5h,7d,7d_oi,overage}-{utilization,reset}`，外加 `-representative-claim` / `-overage-status` / `-fallback` / `-overage-in-use` / `-overage-period-{channel,monthly}-utilization` / `-overage-disabled-reason`（163849 / 169423 / 169746）。
- SDK `shouldRetry`（12354）+ Retry-After 解析（73175）：429/529/overloaded 按头退避重试（`maxRetries`）。`is529Error` / `overloaded_error`（170244）。

### 本项目现状（读码）—— 三层都已妥善

1. **响应头转发完备**：[response-header-forward.ts](../../src/lib/anthropic/header-policy/response-header-forward.ts) 显式为**把 `request-id` / `anthropic-ratelimit-*` / `anthropic-organization-id` 等上游头转发给客户端**而存在，双模式（strict=false 黑名单转发全部除 blacklist / strict=true 白名单）。→ **若 GHC 发限流头，本项目会转发给 CC**。无 gap。
2. **429/529 服务端吞噬**：adaptive rate-limiter 在队列里吸收 429（[http-transport.ts:10](../../src/lib/transport/http-transport.ts#L10)「429 absorbed in its queue」），`executeWithAdaptiveRateLimit` 包裹上游 send（在 `runRequest` 内）；退避计入 `queueWaitMs`。CC 通常**看不到 429**（代理自己退避）。
3. **delayed-commit keepalive 覆盖队列等待**：handler 的 commit 计时器（`streamCommitAfterSec` 默认 20s，[handler-v4.ts:461-469](../../src/routes/messages/handler-v4.ts#L461)）与 `runRequest`（含 rate-limiter 队列 + 429 吞噬 + 退避）**赛跑**——20s 上游仍静默即 commit 200 + 起 keepalive → **覆盖限流队列等待** → CC 的 60s byte-idle 不撞（keepalive < 60s）、300s no-real-content 被空 delta 重置。

### F22（LOW/主要确认）— 限流/重试链路已妥善；两点记档

**结论：无实质 gap。** 三层（头转发 / 429 吞噬 / keepalive 覆盖）都到位。两点值得记档：

**(a) config 边缘 caveat（与 F1 同源）**：若把 `streamCommitAfterSec` 设 **0**（禁用 delayed-commit）**且** rate-limiter 队列等待 > 60s（429 风暴），则 commit 前无 keepalive → CC 的 **60s byte-idle watchdog 可能开火** abort + 重试 → 代理收到新请求而旧请求还在队列 → 放大。默认 20s 下不成立。**记档**：依赖 rate-limiter 队列削峰时**别禁用 delayed-commit**（`streamCommitAfterSec>0` 是 429 风暴下 CC 保活的前提）。归主线 A 家族的 config 前提。

**(b) CC 配额 UI 经 GHC 为空——且此处 richest-data-flow 判定为「不该伪造」**：GHC（Copilot）用自己的配额模型，**不发** Anthropic 的 `anthropic-ratelimit-unified-*` 头 → CC 的配额/overage UI 空。本项目头转发完备（GHC 若发就转），故这是**GHC 能力边界、非代理缺陷**。
- **反直觉但重要**：本项目**有**自己的限流状态（adaptive-rate-limiter 的 429 计数 / 队列深度）——理论上可**合成** `anthropic-ratelimit-unified-*` 形状的头去**填充 CC 原生配额 UI**。但**不该这么做**：Copilot 配额（无 5h/7d 窗口概念）≠ Anthropic unified 窗口，合成这些头会让 CC 显示**不存在的 Anthropic 式配额**，违 `synthetic-data-must-be-distinguishable-from-real` ADR（合成物伪装成真实上游信号）。**留空（诚实）优于伪造（误导）**。这与主线 C/D 的「透传/捕获真实数据」不同——此处是「别造假数据」，是 richest-data-flow 的对称边界。

### 本轮结论

限流/重试链路**已妥善、无 gap**：响应头转发完备（`anthropic-ratelimit-*`/`request-id`/`retry-after` 都转）、429 服务端吞噬 + delayed-commit keepalive 覆盖队列等待。记档两点：(a) 依赖 rate-limiter 削峰时别禁 delayed-commit（config 前提，主线 A）；(b) CC 配额 UI 空是 GHC 边界，且此处**正确地不伪造** Anthropic 限流头（synthetic-distinguishable ADR 的对称边界）。

---

## 阶段综合（轮次 1-15，F1-F21）：四条跨轮主线 + 待办优先级

> 10 轮审计已覆盖原清单全部 CC-facing 面。以下把 16 条发现提炼成**三条可复用主线**（供修复排期 + 未来审计参照），并给优先级。**均待 GHC 探针/headless-CC 实测裁定后再动手**，本文件不含实现。

### 主线 A（承重）— 「HTTP-4xx vs 200+SSE-error」决定 CC 原生自愈能否触发

CC 2.1.207 的**所有**原生自愈（`H8i` thinking 剥块 / `C8i` thinking.type 切换 / `w8i`/`T8i` cache-beta 丢弃 / `_7n` role:system 回退 / `refusalFallbackModel` fallback / 各 `retry:*`）**硬要求 `error instanceof li && status===400`**。一旦某错误在本项目**post-commit** 化为 `200+SSE-error`（`li.status===undefined`），CC 这些自愈**全部匹配不上**、零重试（轮次 4 F9 根因）。
- **合规现状**：本项目对 GHC 的 4xx 基本 pre-commit reactive 处理或以 HTTP-4xx 透出 → 与 CC 自愈**同向**。
- **红线（记档防踩）**：**任何** thinking-sig / adaptive / beta / role 类 400 **绝不**转 post-commit SSE-error（否则双杀本项目 pre-commit retry + CC 后备）。涉及 F9/F11-caveat/F15。

### 主线 B（行为分歧）— 本项目服务端「消化」抢占了 CC 语义更忠实的原生自愈

本项目为把问题在服务端解决，reactive 消化了本会到达 CC 的 400，从而**抢占** CC 的原生恢复；而 CC 的恢复有时**语义更忠实**：
- **F10**（refusal）：默认 `error` 模式抢占 CC 的 `refusalFallbackModel` 换模型重试。
- **F15**（mid-conv system）：reactive convert 抢占 CC 的 `<system-reminder>` 原位回退，且本项目五模式无一复刻该包裹。
- **权衡**：对没配 fallback / 无更好 CC 版本的多数用户，服务端消化是净收益；只对少数「CC 原生能做得更好」的用户是损失。**修复取向**：给这些场景补一个「逐字复刻 CC 回退」的模式（refusal 的 passthrough 已有；system 的 `as_user_system_reminder` 待补），让用户可选。

### 主线 C（能力边界）— 2026 新 beta 无 proactive 感知：reactive 兜底但特性经 GHC 静默降级

CC 2.1.207 引入一批 2026 新 beta，本项目**无显式感知**、靠通用 reactive strip 兜底（无硬失败），代价是**首轮往返浪费 + 特性经 GHC 静默不可用**：
- F5（`speed`）、F14（`cache-diagnosis` / `prompt-caching-evict`）、F15（`mid-conversation-system`）、F16（`context-hint`）；F12（`compaction` 块）是响应侧对应物。
- **统一修复入口**：一次 **GHC 能力探针批次**（skill `ghc-api-reference`，curl 逐 beta/字段打 GHC 看 200 vs 400），据结果二选一：GHC 支持 → 透传 + 考虑纳入 history（`richest-data-flow`）；不支持 → 加入 request-preparation 内置地雷列表 **proactive 剥**（仿 `scope`/`eager_input_streaming`）省往返。

### 待办优先级（供用户排期，含 F1-F21）

新增**主线 D（richest-data-flow 捕获缺口）**：本项目丰富数据就在手边却未捕获进结构化/可查询层——F19（usage allowlist 漏 cost 因子）、F20（丢弃 metadata 会话关联负载）。均 on-philosophy 的明确正确增强，**不需 GHC 探针**、落地清晰（telemetry-architecture / persistence-async-invariants skill）。

| 优先 | 项 | 一句话 | 前置 |
|---|---|---|---|
| **P1** | F1 | thinking-only 块间空档裸 ping 不重置 300s → CC 静默重试整请求(重复上游调用) | headless-CC + mock 上游实测触发条件 |
| **P2** | F7 | count_tokens 失败返 `{input_tokens:1}` 抑制 CC 本地兜底 | 实测 CC 对代理非 200 的反应 |
| **P2** | F10/F15 | 服务端消化抢占 CC 原生自愈(主线 B) | 补「复刻 CC 回退」模式 + 文档化 |
| **P2** | F19/F20 | richest-data-flow 捕获缺口(主线 D)：usage cost 因子 + metadata 会话关联 | 无(明确该做)；落地见 skill |
| **P2** | F21 | 无 forced-tool+thinking 降级 → 翻译矩阵/非-CC 撞 GHC 400 | 复现路径 + 镜像 CC proactive 降级 |
| **P3** | F5/F14/F16/F18/F17 | 2026 新 beta 无 proactive 感知(主线 C) | 一次 GHC 能力探针批次 |
| **P4** | F12 | `compaction` 新块累加器未识别(前瞻) | 待 GHC 实测是否 emit |
| 记档 | F2/F3/F13/主线 A | 阈值可配 / 双主体 context / 红线 | 纯文档 |
| 确认 | F9/F11 | 不变量/兼容性已确认无回归 | 无 |

---

## 后续轮次待覆盖的 CC-facing 面（TODO 清单，逐轮消化）

- [x] **请求形状漂移**（轮次 2）：`speed:"fast"`（F5）、`diagnostics.previous_message_id`（F6）已覆盖；`betas`/`metadata`/`tool_choice`/`output_config`/`context_management` 经查本项目已妥善处理（partner-feature-strip + request-preparation）。`eager_input_streaming`（fine-grained tool streaming）本项目已 proactive strip，无 gap。
- [x] **count_tokens**（轮次 3）：失败契约 `{input_tokens:1}` 抑制 CC 本地兜底（F7,中）、`/context` burst 无服务端缓存（F8,低/已缓解）。CC 请求形状（tools/thinking/betas 白名单/空占位）与本项目 sanitize 一致，无形状 gap。
- [x] **SDK SSEDecoder**（轮次 4）：解码器 `v5a` + 消费循环 `Sjf` 均未变，「合成帧必带 event 行」不变量**确认无回归**（F9）。accept-set 扩容为 Sessions-V2 `user.*`/`agent.*`（互动 agent 协议，非 `/v1/messages`，与代理无关）。
- [x] **refusal / fallback_request**（轮次 5）：CC 流式(298325)+非流式(298057) refusal→`fallback_request` 换模型重试；本项目默认 `error` 恢复抢占了配了 `refusalFallbackModel` 的用户的原生 fallback（F10,中）。只 `refusal` passthrough 模式保留之。
- [x] **200+SSE-error 重试**：轮次 4 F9 已确认（error 帧→`li`、`.status` undefined、零重试），并在 F10/F11 反复印证其结构影响（HTTP-4xx 才触发 CC 各类原生自愈）。结题。
- [x] **thinking signature**（轮次 6）：CC 原生 `H8i`（剥 thinking 重试）/`C8i`（切 thinking.type）自愈是 HTTP-400 门，与本项目 quarantine+coerce **兼容互补**（F11 确认+caveat）；新 `compaction` 块本项目累加器未识别（F12,低/前瞻）。

### 新增待查面（供后续轮次继续）

- [x] **stop_reason 家族**（轮次 7）：`max_tokens`/`model_context_window_exceeded`/`pause_turn` 直连路径**透传正确、无 gap**；记录 auto-truncate ↔ CC 双主体 context 管理交互（F13,低/信息，仅需文档化）。
- [x] **prompt-caching beta 自愈**（轮次 8）：CC `w8i`/`T8i`（HTTP-400 丢 beta 重试）与本项目通用 `unsupported-beta-retry` 兼容；本项目对 `cache-diagnosis`/`prompt-caching-evict` 无 proactive 感知（F14,低-中），reactive 兜底但首轮浪费往返 + 诊断/驱逐特性静默降级。
- [x] **mid-conv role:"system"**（轮次 9）：CC 新 `mid-conversation-system-2026-04-07` beta + `_7n` 回退（原位 `<system-reminder>` 包裹）；本项目 convert 五模式无一复刻该包裹，GHC 拒时 reactive convert 抢占且语义劣于 CC（F15,中，与 F10 同构）。
- [x] **context-hint SSE**（轮次 10）：CC 新 `context-hint-2026-04-09` 双向 context 协议；本项目零感知、reactive 兜底，请求侧信号经 GHC 静默丢失（F16,低，归主线 C）。

### 原清单已全覆盖（10 轮，F1-F16）。后续轮次可深挖的**次级面**（未开工）

- [ ] **fine-grained tool streaming 语义**（轮次 11 已查）：确认无正确性 gap（CC block-stop 解析、空 delta 安全、web_search mid-parse 已退役）；剥 `eager_input_streaming` 仅 UX eagerness 降级（F17,最低，主线 C）。
- [x] **anthropic-beta 全集对账**（轮次 12）：27 betas 全对账（矩阵表）；通用 reactive 剥 + 8 显式/按名处理覆盖绝大多数，无硬失败。真待办仅 F18-a（`thinking-token-count` 改 usage wire）/ F18-b（`redact-thinking` 改 thinking 形态）两个改响应侧 beta。
- [x] **usage wire 形状**（轮次 13）：CC 侧无 gap（passthrough 全字段 + raw 存 sseEvents）；本项目结构化 usage accumulator 是 allowlist、漏 `iterations`/`cache_creation.ephemeral_1h_input_tokens`/`server_tool_use.web_search_requests`（F19,中,richest-data-flow）；F18-a 同根结题。
- [x] **metadata.user_id / 请求归属**（轮次 14）：CC 把 `{device_id,account_uuid,session_id,parent_session_id}` JSON 塞进 `metadata.user_id`；本项目透传但不解析/不利用（F20,中,richest-data-flow）——错失 history 按会话分组 + 重建 subagent 父树。
- [x] **tool_choice 变体**（轮次 15）：CC 客户端在 thinking 激活时把 forced tool_choice 降级为 auto（297965）；本项目未复刻，翻译矩阵/非-CC 客户端的 forced-tool+thinking 撞 GHC 400 无恢复（F21,中）。`disable_parallel_tool_use` 非运行时、无关。

**★ 原清单 10 项 + 次级面 5 项全部覆盖（15 轮，F1-F21）。后续 cron 轮次可开新主题或深化 P1/P2 待办的实测。**

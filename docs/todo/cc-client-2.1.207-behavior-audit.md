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

## 后续轮次待覆盖的 CC-facing 面（TODO 清单，逐轮消化）

- [x] **请求形状漂移**（轮次 2）：`speed:"fast"`（F5）、`diagnostics.previous_message_id`（F6）已覆盖；`betas`/`metadata`/`tool_choice`/`output_config`/`context_management` 经查本项目已妥善处理（partner-feature-strip + request-preparation）。`eager_input_streaming`（fine-grained tool streaming）本项目已 proactive strip，无 gap。
- [x] **count_tokens**（轮次 3）：失败契约 `{input_tokens:1}` 抑制 CC 本地兜底（F7,中）、`/context` burst 无服务端缓存（F8,低/已缓解）。CC 请求形状（tools/thinking/betas 白名单/空占位）与本项目 sanitize 一致，无形状 gap。
- [ ] **SDK SSEDecoder**：2.1.207 的 `@anthropic-ai/sdk` 版本是否改了 `event:` 行处理（本项目「合成帧必带 event 行」不变量的前提）。
- [ ] **refusal / fallback_request**：CC 的 `stop_reason:"refusal"` → `fallback_request` 控制流（298057–298060）vs 本项目 `recover-refusal.ts`。
- [ ] **200+SSE-error 重试**：复核 2.1.207 是否仍对 200+流内 error 零重试（skill 基线来自旧版）。
- [ ] **thinking signature**：CC 侧对 `signature_delta` / thinking immutability 的消费 vs 本项目 `thinking-signature-compat.ts` / `thinking-immutability.ts`。

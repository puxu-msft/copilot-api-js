# Spec: 统一 block 级延迟提交缓冲重试（block-level buffered retry）

状态：**已获用户批准（2026-07-11）** · 三轮对抗审查定稿 · 实施计划见 `docs/plan/2026-07-11-block-level-buffered-retry/` · 日期：2026-07-11 · 归属：`docs/spec/`

关联：ADR `docs/decisions/2026-07-11-block-level-buffered-retry.md`（决策级：整响应缓冲退役 + 块级默认，待建）· 前身 RFC `docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md`（整响应版，本 spec 退役之）· `docs/DESIGN.md`「活的架构现状」流式写出行/driver 例外行/运行时配置表 · `docs/streaming.md`（活文档，须同步）· backlog `docs/todo/deferred-backlog.md`。

> 本 spec 描述**目标态与为何**，不是实施步骤（plan 职责）。v2 变更摘要见 §14。已整合：设计阶段 2 轮 + spec 阶段 2 轮对抗 subagent 审查的全部 CRITICAL/HIGH/MEDIUM，及用户 6 裁决（block 级默认 / 排除 Gemini / **web_search 拆出独立 spec** / 共享配置键 / **退役整响应模式** / 默认启用）。审查采纳/未采纳记录见 §13。

---

## 1. 背景与问题（Why）

### 1.1 实证故障

`req_1783704300404_484`（`claude-opus-4.8`，`/v1/messages` 流式）：上游 GHC 静默 ~169s 后在 ~1.7s 内爆发一个 `Write` 工具调用的部分 `input_json`（~14.8KB），随即**关流且无 `message_stop`**，客户端收 `api_error: Upstream stream truncated before completion (no message_stop)`。这是 GHC 对大生成的**单流应用层截断**——本地超时、TCP keepalive、h2 PING（连接级、刷不了单流应用层 idle）都治不了。唯一救回手段是**缓冲重试**：透明重跑整请求换一次完整生成。此故障命中最佳情形（单 tool_use 块、index 0、首块提交前截断）。

### 1.2 现状：整响应缓冲已存在但默认关、覆盖不全

现有 L2「事务化缓冲重试」（`runResponseBufferedSink`，`src/lib/pipeline/driver.ts`）缓冲**整个响应**、仅在终止符处一次性 flush，遇截断重跑：

| 端点 | 当前 sink | 开关 | 默认 |
|---|---|---|---|
| `/v1/messages`（Anthropic 单跳） | buffered **或** live | `anthropic.protect_streaming_generation`（`false`/`on`/`tool_use_only`） | **false** |
| `/v1/responses`（Codex，HTTP） | buffered **或** live | `responses.buffered_retry` | **false** |
| `/v1/responses`（Codex，WebSocket） | 仅 live（`ws.ts:359`） | 无 | **未保护** |
| `/v1/chat/completions` | 仅 live（`handler-v4.ts:370`） | 无 | **未保护** |
| `/v1beta/.../generateContent`（Gemini） | 仅 live | 无 | **未保护（本轮排除，§7.4）** |
| `/v1/messages` web_search（双跳） | 遗留管线，两跳 `stream:false` | 无 | **拆出独立 spec，§7.5** |

两个缺陷：(1) 整响应缓冲的代价 = 客户端全程只见保活、收不到增量真实内容，长生成体验差；(2) 多条流式路径默认裸奔。

### 1.3 为何现在能推进 + 诚实取舍

keepalive-anchor（`empty_text` 合成锚点）+ unconditional timeout-safety（ADR `2026-07-09`）已让缓冲窗口内客户端不 idle out。本 spec 用 **block 级延迟提交**拿到「保护 + 增量流式」并**全面默认化**。

**诚实取舍（审查 E/F，非纯赢）**：今天 `on`（整响应缓冲）对响应**任意位置**的截断都可重试（commit 只在流末）。块级下**首块 flush 后**的截断走优雅降级、**不重试**（§5.2）——对**多块**响应，块级重试覆盖**严格弱于**整响应缓冲，换取的是增量流式体验。用户裁决（§13 fork 2）**退役整响应模式**、块级全面取代：实证 req_484 等大生成截断几乎总落在单个大 tool_use 块内部（首块提交前，块级完整保护），多块中途截断罕见；接受该覆盖特性。**这正是本改动的 ADR 决策核**（不是「默认 on」这个表象，而是「覆盖换体验 + 退役整响应」这个 why）。

---

## 2. 目标与非目标

**目标：**
- G1 把 `runResponseBufferedSink` 从「缓冲到终止符」推广为「缓冲到**块边界**就 flush」，块级增量下发。
- G2 **默认启用**且**退役整响应模式**：`protect_streaming_generation` 默认 `on`（= 块级；无 `whole` 模式）、Responses `buffered_retry` 默认 `true`、CC/WS 新建默认开。
- G3 覆盖本轮范围内所有面向客户端的流式响应：Anthropic 单跳、Responses（HTTP + WS）、Chat Completions。
- G4 vendor 中立共享缓冲配置键 + vendor 维度可观测性。
- G5 定清块级多次 commit 下的 History 记账、telemetry outcome 分类、每端点保活的实证门。

**非目标：**
- N1 不做断点续传/续写半截生成（Anthropic 协议不支持 resume；重试永远无状态整请求重发，靠 prompt cache 降成本）。
- N2 **不保护 Gemini**（本轮排除，§7.4；结构不兼容需先重构 `flushResponse`，新建 backlog 条）。
- N3 **不做 web_search 双跳重写**（拆出为下一个独立大任务/spec，§7.5）。
- N4 不保护非流式路径（§8 论证）。
- N5 不改非截断类错误的既有分类/重试（S4 请求侧、REFUSED_STREAM 等不动）。

---

## 3. 核心机制：commit-boundary 抽象

### 3.1 边界推广

现 commit 门（`driver.ts` 约 :642，循环**外**）：`if (drained && (sawMessageStop() || sawUpstreamError()))` 一次性 flush 整个 buffer。推广为：**在每个 commit 边界处 flush「截至该边界（含）」的缓冲帧**。新增 per-codec 谓词：

```ts
commitBoundaries(frame: ClientFrame): boolean  // 该渲染帧是否一个「块完成、可安全 flush」的边界
```

| 格式 | commit 边界 | 性质 |
|---|---|---|
| Anthropic | `content_block_stop` + 终止（`message_stop` / 上游 `error`） | 原生块级 |
| Responses | `response.output_item.done` + 终止（`status` settle / 上游 `error`） | 原生 item 级 |
| Chat Completions | **仅**终止（`acc.finishReason !== ""`；`[DONE]` handler post-loop 合成） | 终止-only 退化 |

终止符 + 上游 `error` 帧（审查 M1）**永远**是 commit 边界。终止-only（CC）= 边界集只含终止符的退化态。

### 3.2 提交点倒置的范围（审查 H-2，勿低估为「行为不变的地基」）

块级把提交点从「for-await 循环**外**（drain 后一次）」移到「循环**内**每个边界」，这是对 driver 提交/重试骨架的**实质倒置**：
- in-loop commit 后若再 throw/截断，须路由到 partial-degrade（§5.2）而非重试——现 `driver.ts` 约 :691 的 `thrown ? … : true` 须变 `… : !committedAny`。
- `drained` 语义须重定义（不再等价「可提交」）。
- 每块 flush 循环（`for(frame of buffer) await write`）与心跳并发的守卫须重建（§4.4）。

故 §12 分阶段中，此倒置属 **P1 核心**，非「行为不变的机制地基」。P0 只做**新增**（谓词接口、共享配置键、telemetry 维度）不动提交点，保持默认关、行为逐字不变；提交点倒置在 P1 与 anchor 协同一并落地。

### 3.3 buffering rewrite 的块内释放不变量（审查 H2 + H-1 + P + Q）

**约束**：`src/lib/codec/anthropic/response-rewrite-adapters.ts` 的两个 buffering rewrite——`recover-tool-call`（order 100，:111）、`tool-input-decode`（order 200，:207）——经 `bufferOrEmit`（:92）缓冲。理论风险：若某块帧被 hold 越过后续块的 commit 边界，则乱序 → 协议损坏。（其余 rewrite thinking-compat/server-tool-filter/recover-refusal 均 emit-only 非缓冲，无此问题——计数无遗漏。）**但实测两个 rewrite 均已满足块级安全（见下）**，故本节是**核实项**而非改造项。

**正确不变量（审查 H-1 纠正——已亲手核实两个 rewrite 的真实释放语义）**：`flush()` 只是 **abort 兜底**（真流末仍挂缓冲时），正常运行的释放全在 `processEvent`。不变量应表述为「**buffering rewrite 不得持某块的帧越过后续块的 commit 边界**」，而**两个 rewrite 均已天然满足**：
- **tool-input-decode（块级自释放）**：在本块 `content_block_stop` 的 `processEvent` 内 `finalize` emit（`decode-tool-input.ts:274-278`）——恰好在该块 commit 边界处释放，与块级 commit 天然对齐。
- **recover-tool-call（下块/终止自释放）**：candidate 在**下一个 `content_block_start`** 处 `rollbackCandidate()` 释放（`recover-tool-call/stream.ts:134-138`）或在 **`message_delta`** 处按 stop_reason commit（:140-155）——它只把**最后一个候选 text 块**持到 message_delta（≈终止边界），**永不跨后续块**的 commit 边界。

故 **无需 `flushBlock` 原语**（原 v1 的 flushBlock/flushChain 路径已删——对 recover 既不必要也不可实现：recover 的 commit 依赖 stop_reason、只在 message_delta 可得，强制在候选块的 `content_block_stop` 释放会逼它提前 rollback → **破坏 req_484 类 tool-call 恢复**，且违反 `response-rewrite-adapters.ts:8`「Algorithm cores are NOT rewritten」铁律）。

**P1 只需**：用独立 oracle 确证 decode 的边界释放（:274-278）与 recover 的 rollback-on-next-start（:134-138）在块级 buffered 下仍先于后续块提交，**无需新建原语**。缺证即协议损坏风险，属 P1 门控核实项。

---

## 4. anchor 保活与块级 commit 的协同（审查 C1 + C-1 —— 本 spec 最硬接缝）

### 4.1 问题

Anthropic keepalive 靠 `empty_text` anchor@0 的 `text_delta@0`（**真实内容**帧，能重置 Claude Code 300s no-real-content 死线，`client-sink.ts:44`）；裸 `ping` **不能**重置（`exp/cc-idle-280s` 实证）。

### 4.2 深层机制缺口（审查 C-1，已亲手核实 `client-sink.ts:186-198`）

`noteBlockState` 是**单槽** `openBlock` 状态机：真实块 remap 到 @+1 的 `content_block_start@1` 经 `sink.write` 会**覆盖** anchor 的 `{0,text}` → `openBlock={1,type}`；其 `content_block_stop@1` 置 `openBlock=undefined`（:192）。块间静默时心跳 tick（:301）遇 `openBlock===undefined && anchorAttempted===true`（:310）→ 跳过 injectAnchor → `emitKeepalive` → `pingFrame(undefined)` → **裸 ping**（`keepalive-frame.ts:44`）。即 anchor@0 在 wire 上仍 open（未发 stop@0），但 sink 追踪器已丢它，块间退化裸 ping = C1 原样复发。**「openBlock 维持 {0,text}」不是自动成立的**，需 sink 侧改造。

### 4.3 目标形状 + 必需的 sink 改造

anchor@0 全程 open 作保活载体，真实块在 @+1 流，块间空档发 `text_delta@0` 续命，仅终止符 close@0。为让「块间 `text_delta@0` 可产出」，**必需**二选一 sink 改造（plan 定）：
- (a) `noteBlockState` 改**块栈**：记所有 open 块，真实块@+1 push、stop 弹出，anchor@0 始终在栈底 → 块间 tick 时栈非空、fallback 发 `text_delta@栈底(0)`。
- (b) anchor 存活期把心跳 fallback 从「裸 ping」改为「发 `text_delta@anchorIndex`」：sink 暴露 `anchorBlockOpen` 状态，tick 时 `openBlock===undefined && anchorBlockOpen` → 发 `text_delta@0` 而非裸 ping。

`freezeHeartbeat`（:277）**只在终止 freeze**，块间不 freeze（§4.4 解决并发）。

### 4.4 每块 flush 期间的心跳并发守卫（审查 C-1 补充）

现 `driver.ts` 约 :643-648 的 freeze-before-flush 守卫防「flush 循环每个 await 让出时，tick 把 empty delta 插进真实块 deltas 中间」。块级拆掉整体 freeze 后须替代：每块 flush 循环期间**挂起心跳**（`suspendHeartbeat`），flush 完**恢复**——sink 新增挂起/恢复原语。否则 tick 命中块 1 flush 中途会污染其 deltas。

### 4.5 PoC 门重定义（审查 O + C-1：先验代理可产出，再验客户端接受）

原 PoC 门只测「客户端接受两块并存 open + 死线重置」= 只测了一半。重定义为**两段**（`exp/block-level-anchor-coexist/`，poc-first + keep-poc-in-project）：
1. **代理可产出**（独立 oracle 抓 wire）：4.3 改造后，合成一条「anchor@0 open + 真实块@+1 流 + 块间实发 `text_delta@0`（非裸 ping）+ 仅终止 close@0」，用 wire 抓包 oracle 证代理**确实产出** text_delta@0。
2. **客户端接受**：把该流发真实 Claude Code，验 SDK SSE decoder 正确解析两块并存 open + 300s 死线被 text_delta@0 重置。

**三级 fallback 保「默认 on」确定可交付**（审查 O 认可）：
- 主形状（4.3）两段全绿 → 采用，块级默认 on。
- 客户端拒绝两块并存 open → **备选**：每块 flush 前 close anchor@0 → flush 该块 → 重开新 anchor@0（多次 open/close index 0，需验客户端接受 index 复用 + 每 gap 复位 `anchorAttempted`、走非 injectAnchor 门的重开路径）。备选更契合单槽 openBlock。
- 两者皆失败 → Anthropic 保留**整响应缓冲**（已证形状）作 anchor 端点的兜底，块级仅对无 anchor 的 Responses/CC 生效。**默认 on 的前提 = 主/备/兜底之一实证通过**——不牺牲「默认启用」裁决，用实证保证安全。

CC/Responses/WS **无 anchor 机制**（Responses 显式 `anchor: undefined`，`responses/handler-v4.ts:366`），本节约束不适用，但其首块前保活须各自过实证门（§7.1/§7.3 M-2）。

---

## 5. 重试语义

### 5.1 重试窗口 = 尚无真实块承诺给客户端（审查 M2 + M-3）

`可重试 = !committedAny && !retreated`：
- `!committedAny`：首个**真实块** flush 之前。**任何首块前落 wire 的 keepalive/结构帧都不置 committedAny**——vendor 中立判据：anchor 注入（跨 attempt 由 `anchorState` 持久，`onAttemptReset` 不碰它，已核 `messages/handler-v4.ts:1098-1113`）、message_start、cold-start 首 ping（`messages/handler-v4.ts:553`）、CC/Responses forced-heartbeat keepalive 帧——均须是「重试后可无害前置于新生成」的幂等形状。
- `!retreated`：未因 OOM buffer cap 退回 live 转发（`driver.ts` 约 :608，已向 wire 写字节）。

首块前 transport-close(RST)/截断(clean drain 无终止符) → 透明重跑整 exchange，最多 `max_retries` 次。

### 5.2 首块 commit 后截断 → 优雅降级（新终局 partial-degrade）

首块 flush 后的截断 → 降级为当今 live 行为：fail + 截断/error 帧（已发帧收不回）。这是**新终局 `partial-degrade`**（§9.2）。

### 5.3 commit 边界含上游 error（审查 M1）

commit 门保留 `sawUpstreamError()`；H2 上游 `error` 帧（clean drain 无 message_stop）是必须提交且失败的终止态，须在 `commitBoundaries` 与重试判定中显式纳入。

---

## 6. 配置（vendor 中立共享键 + 全默认开 + 退役整响应）

### 6.1 共享键 + per-vendor 覆盖（审查 G 定名 + 用户 fork 2 退役 whole）

抽 vendor 中立共享键：
```yaml
buffered_retry:
  max_retries: 3            # 原 anthropic.protect_streaming_max_retries
  buffer_cap_bytes: 16777216
  heartbeat_sec: 15         # 首块前 forced keepalive；streamKeepalivePingSec>0 时优先
```
per-vendor 保留模式开关 + **可选覆盖键**（定名，审查 G + MEDIUM-2 消除 schema 冲突）。**命名铁律（避免同键既标量又 map）**：布尔 mode-switch 统一用 `<vendor>.buffered_retry.enabled`（让 `buffered_retry` 恒为 map），覆盖键 `<vendor>.buffered_retry.{max_retries,buffer_cap_bytes,heartbeat_sec}`。Anthropic 例外：其 mode-switch 是三态 `protect_streaming_generation`（独立键），覆盖仍走 `anthropic.buffered_retry.*`。解析优先级：**per-vendor 覆盖 > 共享 `buffered_retry.*` > 内置默认**。

| 键 | 现默认 | 新默认 | 语义 |
|---|---|---|---|
| `anthropic.protect_streaming_generation` | `false` | **`on`** | **就地重定义 `on`**：整响应缓冲 → 块级（无独立 `whole` 枚举可删，`schema.ts:531` 现枚举仅 `false`/`on`/`tool_use_only`）。`tool_use_only`=仅带 tools 请求；`false`=纯 live |
| `responses.buffered_retry` | `false` | **`true`** | 升级为 output_item 块级 |
| `chat_completions.buffered_retry`（新） | 无 | **`true`** | 终止-only 退化态 |
| `responses_ws`（无独立键，**复用** `responses.buffered_retry`） | 无 | 随 Responses | terminal-only（§7.3，backlog:304 一致） |

`escalate_context` 保持 Anthropic-only（审查 I，次要不推广）。

### 6.2 迁移触点（审查 H 补全）

旧键 `protect_streaming_max_retries`/`_buffer_cap_bytes`/`_heartbeat` 读时映射到 `buffered_retry.*`（无向后兼容负担，一次性迁移 + 短期报错）。触点：`config.ts:505-509`（解析）、`schema.ts:530-586`、`config.yaml:549-561`、`config.example.yaml`、`state.ts` 三处 CONFIG_MANAGED_DEFAULTS（:1354/:1487/:1633）、**`validation.ts:53-68`**（跨字段告警硬引用旧键名 `protect_streaming_heartbeat`/`_generation`，须同步改文案）。

### 6.3 默认翻转影响 + retreat bug 纳入修复

`on` 后所有 Anthropic 流式按块 flush（纯文本几乎无感，顺带保护非 tool 长文本截断）。回退：per-vendor 设 `false` 回 live。**已知 retreat bug**（backlog「retreated + empty_text 锚点 index 碰撞 + 双 message_start」）被默认全开放大 → 本 spec **纳入修复**（不再「罕见不修」），P1 一并处理 anchor remap 的 retreat 分支。

---

## 7. 各端点接入

### 7.1 Chat Completions（净新建，审查 H1 + M-2 实证门）

CC 当前仅 `runResponseSink`（`chat-completions/handler-v4.ts:370`）、**无 buffered、无心跳**（`makeSseSink` 不带 heartbeat）——从零建：
- 终止检测：`sawMessageStop()` = `acc.finishReason !== ""`（:402），非终止符帧；`[DONE]` handler post-loop 合成（:416）。收尾帧须纳入 buffered 提交单元。
- 边界：终止-only。
- 首块前保活：新增 forced keepalive（复用 `buffered_retry.heartbeat_sec`，发 CC-shape keepalive chunk）——实现 backlog:316「chat-completions 下游 SSE 无 heartbeat」的 **CC 腿**（landing 关该腿，Gemini 腿保留）。
- **实证门（M-2，比照 §4.5）**：CC 客户端是否有 idle 死线、且被该 keepalive chunk 重置——须独立 oracle 实证，非「加个 keepalive 就默认 true」。

### 7.2 Responses HTTP（升级块级）

已有 buffered（`handler-v4.ts:364`），升级为 `output_item.done` 块级 + 默认 true。forced-heartbeat 已存在（`buffered-config.ts:19-24`），但其「确能重置 Codex idle 死线」同样补实证门（M-2）。

### 7.3 Responses WS（terminal-only，审查 D 降级）

`ws.ts:359` 仅 live。WS = **terminal-only buffered**（= 已证的整响应形状，**无增量块**，故「block 级破坏交互期望」风险不适用——审查 D 纠正原 PoC 定性）。**现状核实（审查 MEDIUM-1）**：`makeWsSink`（`client-sink.ts:480`）**已返回** `writeSynthetic` + `close`，且 WS **已有下游 forward-idle heartbeat**（`ws.ts:296-307` 的 `responsesKeepaliveFrame`）——故「首块前保活」基本已具备；WS 真正缺的只是 anchor 原语（terminal-only 不需要）。**键（审查 MEDIUM-2 对账 backlog:304）**：WS **复用** `responses.buffered_retry` 门控键（与 backlog:304「`responsesBufferedRetry` on 时选 buffered」一致，不新造 `responses_ws.*` 独立键）。P4 唯一真开放项 = `sendErrorAndClose`+1011 close-code 与 buffered commit 的**时序对齐**（backlog:300-306「若做需改什么」四点），属实现细节非可行性 PoC。

### 7.4 Gemini（本轮排除，审查 C2 + 用户 fork 2 决策2）

终止帧 + 缓冲 tool_call 帧由 `flushResponse(env)` 在 `runResponseSink` **返回后**产出（`gemini/handler-v4.ts:338,360`），driver 循环内不可见，buffered 会 commit 缺 tool_call 的残缺 buffer。**排除本轮**，**新建 backlog 条**（审查 M：Gemini 排除目前 backlog 无条目）：根因 + 理想架构（把 flushResponse 产出重构进 driver 循环纳入 buffered 提交单元）+ 为何暂缓 + 若做需改什么。Gemini 保持现 live 行为。

### 7.5 web_search（拆出独立 spec，审查 A/N + 用户 fork 1）

审查证实（已亲手核实）：orchestrator 两跳硬编码 `stream:false`（:356/:414），search 路径客户端 SSE 是从**已物化非流式响应本地合成**（`webSearchResponseToEvents`）、**结构上不可截断**——迁 driver「继承块级保护」价值≈0。真正会被截断的仅 `web-search-direct.ts:322` 的 **no-search 直发**路径（普通 Anthropic 流走遗留管线）。web_search 迁移的**真实动机**是 backlog 的 L3 隔离（:41-47）+ tool-field 反应式学习（:35-38）覆盖，与块级无关。

**用户裁决：web_search 双跳重写移出本 spec，作为下一个独立大任务**（独立 spec，交叉引用 backlog 真动机）。本 spec **不含** web_search。no-search 直发路径（`web-search-direct.ts:322`，真正会被截断的那条）暂仍未保护 —— 登记进 `docs/todo/deferred-backlog.md` **新建一条**（含根因/当前行为/理想架构=迁 driver/为何暂缓/若做需改什么，交叉引用未来 web_search spec + backlog:41 L3 隔离项），非静默遗留。

---

## 8. 非流式路径为何不纳入（审查「非流式未论证」）

`runResponseNonStreaming`（4 handler）/ `runResponseWhole`（`messages/handler-v4.ts:742`）：非流式是**单次 fetch 整体到手**，上游截断表现为 **fetch 层抛错**（连接错误/不完整 body），由既有 **S4 请求侧重试**覆盖，**无 partial-flush 问题**。故不需块级缓冲。除非将来实证观测到「200 + 不完整 body 但 fetch 不报错」的静默截断（当前无），否则不纳入。本节即显式论证，非静默忽略。

---

## 9. 可观测性与 History

### 9.1 telemetry vendor 维度（审查「vendor-blind」+ J）

`protect-streaming-stats.ts` 现为进程级全局、Anthropic+Responses 共写、vendor-blind。4 端点全开后**加 vendor 维度**（或 per-endpoint 分桶），使 `/api/status` 聚合能区分哪个 vendor 在重试。本改动**取代/解决** backlog:324-330（vendor-blind telemetry）——landing 时按 session-closeout 剪除该条。

### 9.2 outcome 完整分类（审查 M3 + M-1 + L-1）

`onBufferedResolve` 现标签 `success|exhausted|retreated`（`protect-streaming-stats.ts:15`）。块级引入新终局，**完整分类 + 优先级**：

| outcome | 定义 | 优先级说明 |
|---|---|---|
| `success` | 干净收全 + 无重试 | — |
| `success`（retries≥1） | 重试后干净收全（L2 真救了） | — |
| `partial-degrade`（新） | 已 flush 首块、后截断、降级不重试 | **即使 attempt 早期重试过**（retries≥1）仍报 `partial-degrade`，但**同时记录 `retriesBeforeDegrade`**，不丢「重试引擎生效」信号（M-1） |
| `exhausted` | 首块前重试到 cap 仍失败 | — |
| `retreated` | OOM cap 退回 live | — |

**hit-rate 公式修订**（§8 前身 RFC 的 `success/(success+exhausted)` 失真）：分母纳入 partial-degrade（部分成功）。**类型三处必改**（L-1，比照 telemetry-architecture「新顶层字段三处必改」）：`ProtectStreamingOutcome` union（:15）+ `ProtectStreamingStats` 接口（:17）+ `getProtectStreamingStats`/`/api/status` 聚合。

### 9.3 History 记账（审查「记账未定义」+ L-2 ordering）

- 首块 commit 前重跑：per-attempt `sseEvents` 累积 + `onAttemptReset` 清空（沿用 `driver.ts` 约 :697-700），非最终 attempt 帧不污染最终轨。
- partial-degrade：entry 终态 = `stream-error`；已 commit 块 + 失败尾部都进 `clientResponse.sseEvents`（richest-data-flow），`upstreamResponse.success=false`；合成帧保持 `synthetic` 标记可辨识。失败尾帧**须沿用 `writeSynthetic → recordForwarded → ctx.fail` 的 settle-前-record 顺序**（L-2，persistence-async-invariants；settle 后快照会丢尾帧）。

---

## 10. 端点覆盖总表（目标态）

| 端点 | 目标 | 块边界 | 默认 | 备注 |
|---|---|---|---|---|
| `/v1/messages`（单跳） | 块级 buffered | `content_block_stop` | **on** | anchor 协同（§4）+ 两段 PoC 门 + retreat 修复 |
| `/v1/responses`（HTTP） | 块级 buffered | `output_item.done` | **true** | 升级现有 + keepalive 实证门 |
| `/v1/chat/completions` | 终止-only buffered | 终止（finishReason） | **true** | 净新建（§7.1）+ keepalive 实证门 |
| `/v1/responses` WS | terminal-only buffered | 终止 | **true** | §7.3，核 close-code/commit 时序 |
| `/v1beta/.../generateContent`（Gemini） | **排除本轮** | — | 现 live | §7.4，新建 backlog 条 |
| `/v1/messages` web_search 双跳 | **拆出独立 spec** | — | 现状 | §7.5，下一大任务；no-search 直发暂未保护、登记 roadmap |
| 非流式（所有） | **不纳入** | — | — | §8 论证 |
| warmup 合成流（`warmup.ts:211/241`） | **排除** | — | — | 无上游、不可截断（审查 C，显式记一行保 exhaustiveness） |
| Azure deployments | 自动继承 | — | 随 CC/Responses | 委派，无独立接线 |

---

## 11. 测试策略

- 单元：各 codec `commitBoundaries`（含终止符 + 上游 error）。
- 块内释放不变量（§3.3）：独立 oracle 证 decode 在本块 `content_block_stop` 释放（`:274-278`）、recover 在下块 `content_block_start` rollback（`:134-138`）均先于后续块提交——**核实项非改造项，无 flushBlock**。P1 门控。
- anchor 协同（§4）：两段 PoC——① 独立 wire oracle 证代理产出块间 `text_delta@0`（非裸 ping）；② 真实 Claude Code 验两块并存 open 可解析 + 300s 死线重置。含 sink 块栈/anchorBlockOpen 改造单元测试 + 每块 flush 期心跳挂起/恢复。
- 重试门：`!committedAny && !retreated`；首块前 RST→重试；首块后 RST→partial-degrade 不重试；retried-then-partial-degrade 的 outcome 归属 + `retriesBeforeDegrade`。
- 每端点 keepalive 实证门（M-2）：该 keepalive 帧确能重置该消费者 idle 死线（独立 oracle），非无实证默认开。
- Golden fixture：req_484 形状（单 tool_use、index 0、mid-block 截断）→ 被重试救回；改动前锁旧整响应 buffered 行为证块级退化态对 CC/WS 等价。
- telemetry：vendor 维度 + 完整 outcome 分类 + hit-rate 公式。
- 回归：现有整响应 buffered 测试——注意整响应模式**退役**，其多块「全程可重试」测试须改写为块级「首块前可重试」的新契约（不是保留旧行为）。
- empirical：flaky/时序（重试、心跳、并发 tick）连跑 10–25 次；fake timers + mock 随机源。

---

## 12. 分阶段

- **P0**：commit-boundary 谓词接口 + 共享配置键 + 迁移旧键 + telemetry vendor 维度/新分类（**纯新增，不动提交点，默认仍关，行为逐字不变**）。
- **P1**：Anthropic 提交点倒置（§3.2）+ `content_block_stop` 块级 + anchor 协同（§4 sink 改造 + 两段 PoC 门 + 心跳挂起/恢复）+ 块内释放不变量（§3.3）+ retreat bug 修复 + 默认 `on`、**退役 `whole` 语义**。**覆盖 req_484**。
- **P2**：Responses HTTP `output_item.done` 块级 + keepalive 实证门 + 默认 true。
- **P3**：CC 净新建终止-only buffered + keepalive 实证门 + 默认 true。
- **P4**：Responses WS terminal-only buffered + close-code/commit 时序 + 默认 true。

每 phase 交付物须含：`commitBoundaries` + 首块前 keepalive 帧（过实证门）+ 终态/上游 error 谓词 + telemetry vendor 维度 + History 记账 + 测试。缺任一项即砍范围，不接受。**每 phase landing 关闭对应 backlog 条**（审查 J/M，session-closeout doc-sync）：P1 关 retreat-bug 条（:251-257）；P2 关 Responses caps（:308-314）；**P3 关 backlog:316 的 CC 腿**（chat-completions SSE 无 heartbeat，Gemini 腿保留）；**P4 关 backlog:300-306**（WS 未采用 buffered，P4 落地即实现其理想架构）+ Responses caps 的 WS 部分；telemetry vendor 维度关 vendor-blind（:324-330）。**新登记**：Gemini buffered 结构不兼容排除条（§7.4，注明与 :316/:321 keepalive 缺口是不同维度）；web_search no-search 直发暂未保护条（§7.5）。

## ADR 决策核（审查 K）

`docs/decisions/2026-07-11-block-level-buffered-retry.md` 记的**不是**「默认 on」表象，而是：**退役整响应缓冲模式、以块级取代，用「多块截断重试覆盖下降」换「增量流式体验 + 全端点默认保护」**（§1.3 取舍）。含：为何接受覆盖下降（大生成截断实证落单块）、为何退役而非双模式（用户裁决 fork 2b）、默认翻转影响与回退。

## doc-sync 目标（审查 L，landing 必更）

`docs/DESIGN.md`：流式写出行 + driver 例外行（:57）+ 运行时配置表（5 条 `protectStreaming*` + `responsesBufferedRetry` 行 → 改名键 + 新默认）+ 「默认关」叙述行（:74-76）。`docs/streaming.md`（buffered/keepalive 行为）。前身 RFC `docs/archive/2606-landed-rfcs/streaming-upstream-rst-buffered-retry.md` **加 superseded banner**（指向本 spec；它仍被 DESIGN:75/76 + 配置表当活契约引用，退役后须打标）。`docs/todo/deferred-backlog.md`（web_search no-search 直发 + Gemini 排除两条新建）。

---

## 13. 审查发现整合记录（采纳 / 未采纳 + 理由）

**采纳（本 spec v2）：** 设计轮 C1→§4 + C-1 深化（sink 改造 + PoC 重定义）；C2→§7.4 排除 + 新建 backlog；H1→§3.1/§7.1 净新建；H2→§3.3；M1→§5.3；M2→§5.1；M3→§9.2。spec 轮 A/N→§7.5 拆出；C→§10 warmup 排除行；D→§7.3 WS 降 terminal-only；E/F→§1.3 诚实取舍 + fork 2b 退役；G→§6.1 覆盖键定名；H→§6.2 validation.ts；H-1→§3.3 弃 flushChain 用 flushBlock；H-2→§3.2 提交点倒置非地基；M-1→§9.2 outcome 优先级 + retriesBeforeDegrade；M-2→§7 每端点 keepalive 实证门；M-3→§5.1 vendor 中立判据；L-1→§9.2 三处；L-2→§9.3 ordering；J/M→§12 backlog 关闭 + Gemini 新建条；K→ADR 决策核；L→doc-sync 目标；P/Q→§3.3 路径修正 + decode 走 emit-at-boundary。v2 复审轮：H-1→§3.3 **纠正**（decode/recover 均已满足块级安全、无需 flushBlock，对 recover 建 flushBlock 会破坏 tool-call 恢复）；MEDIUM-1→§7.3 WS sink 现状事实修正；MEDIUM-2→§6.1/§7.3 WS 复用 `responses.buffered_retry` 键对账 backlog:304；LOW-1→§6.1 就地重定义 `on`（无 whole 枚举）；ROADMAP→backlog + §9.1「5→4」+ §7.3「P5→P4」。

**未采纳 / 降级（理由）：**
- `escalate_context` 推广全 vendor → 本轮不做（Anthropic-only 次要特性，§6.1）；Responses 需 context 收紧重试时再评估。
- web_search 留本 spec（fork 1b）→ 用户选 1a **拆出**（真动机=反应式/隔离非块级，独立大任务）。
- 保留整响应双模式（fork 2a，我曾倾向）→ 用户选 **2b 退役**；§1.3 诚实记录覆盖取舍，回归测试改写为块级新契约。
- Gemini 纳入本轮 / 非流式纳入 → 均显式排除 + 理由（§7.4/§8），非静默砍。

---

## 14. v2 变更摘要

相对 v1：① web_search（原 P4）**拆出**独立 spec（fork 1a）——前提本就错（两跳非流式、合成不可截断）；② 整响应模式**退役**（fork 2b），就地重定义 `on`=块级（无 `whole` 枚举）、§1.3 补诚实覆盖取舍；③ C-1 深化——§4.2 揭示单槽 openBlock 产不出块间 text_delta@0，§4.3 补 sink 块栈/anchorBlockOpen 改造，§4.4 补心跳挂起/恢复，§4.5 PoC 门改两段（先验代理产出再验客户端）；④ §3.3 **纠正 H-1**：两个 buffering rewrite（decode 块级自释放 / recover 下块-终止自释放）均已满足块级安全，**无需 flushBlock 原语**（对 recover 会破坏 tool-call 恢复），改为纯核实项；⑤ §3.2 提交点倒置显式非「地基」；⑥ §9.2 outcome 完整分类 + retriesBeforeDegrade + hit-rate 修订；⑦ §7 每端点 keepalive 实证门；⑧ §6.2 迁移触点补 validation.ts；⑨ §10 补 warmup 排除行；⑩ §12 backlog 关闭责任 + ADR 决策核 + doc-sync 目标。相对 v2 复审：§6.1 消除 `buffered_retry` 标量/map 命名冲突（mode-switch 用 `.enabled`）；WS 复用 `responses.buffered_retry` 键（对账 backlog:304）+ 现状事实修正（makeWsSink 已有 writeSynthetic/close/heartbeat）；ROADMAP→backlog 登记；§9.1「5→4」+ §7.3「P5→P4」。范围端点从 6→4（Anthropic/Responses-HTTP/Responses-WS/CC）。

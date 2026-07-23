# Spec: 续写重试 + 顺序 anchor 保活（continuation-retry & sequential-anchor）

> 状态：草案（brainstorming 产出，待 subagent 对抗审查 + 用户过目）
> 日期：2026-07-22
> 关系：**修订并完成** [`2026-07-11-block-level-buffered-retry.md`](2026-07-11-block-level-buffered-retry.md)（下称「前 spec」）在 Anthropic 上未完成的部分，并反转其 N1 非目标与 §5.2 partial-degrade 终局。
> 起源 incident：`req_1784722475722_162`（opus-4.8，Claude Code CLI，142.9s 首字节前静默 → 6.6s 流式 → tool_use 中途 `NGHTTP2_CANCEL` → 169.7s FAIL、0 可用产出）。

> **⚠️ 2026-07-22 用户裁决修订（权威见 [ADR](../decisions/2026-07-22-continuation-retry-sequential-anchor.md)，本 spec 部分节被反转）：**
> - **[D2 反转] §3「顺序 anchor」整节被退役。** 不再向 client 注入空-text block 保活（`empty_text` 全路径禁用、代码保留休眠，默认 `stream_keepalive_mode: ping`）。判据：空-text block 是错误形状且 G2 实证不能重置 CC 300s 死线。**块级递送的 CLI-safety 改由「严格按 index 顺序输出」保证**（块闭合时总按 index 顺序 output，未闭合的低 index 压住已闭合的高 index），不再靠空 anchor 逼单块。**过渡期长静默 = 裸 ping，接受 >300s 断连限制**，真保活留待 [调研](../todo/2026-07-22-client-proxy-keepalive-300s.md)。P1 landed 的顺序 anchor 代码因此转为默认休眠。
> - **[D3 细化] §4/§5.3 续写触发**：已提交前缀含任一「完整的、需客户端交互的 tool_use 块」→ **不续写、正常终止**（合法轮边界，客户端要执行工具）。续写只在被掐于 text/thinking 且无完整可交互 tool_use 时触发。已完整 text/thinking 块照发客户端但不发 message_stop，直接合成 user 续写轮接进同一连接；thinking 发客户端但不进合成 assistant 前缀。
> - **[D1 澄清] §6.1 回退 live**：block hook 的跳过是**类型层面**保证的（`runResponseSink` 无法接收 block hook），非约定。**已知缺口**：当前无「运行时自动降级 live」探测，`buffered` 纯由配置决定；记 backlog。

---

> **✅ 实施状态(2026-07-23,分支 `feat/continuation-retry`,未合并 master):P2 = Anthropic 续写已完整落地并端到端验证**(SSOT `continued` verdict + `runContinuation` + driver 旁路缝合分支 + handler 接线 + telemetry 拆分;真 `@anthropic-ai/sdk` e2e 证缝合流,含 thinking-offset 与 chained 多跳)。合并态异模型审 2 Critical + 2 Important 已修。**端点矩阵(D4 全端点分阶段,当前仅 Anthropic 落地)**:
>
> | 端点 | 块级缓冲 | 续写 | 状态 |
> |---|---|---|---|
> | Anthropic messages | ✅ | ✅ **已落地+验证(P2)** | 续写默认 on,需 `protect_streaming_generation` 开块级才激活 |
> | Responses HTTP | ✅(已有) | ❌ 待 **P4** | builder/extractor/hooks 未接线 |
> | CC | ⚠️ terminal-only | ❌ 待 **P5** | 需先升块级 |
> | Responses WS | ⚠️ terminal-only | ❌ 待 **P6** | 需先升块级 + WS 传输门 |
> | Gemini | — | 排除(N1) | — |
>
> 权威实施细节见 plan `.../plan-2b-continuation-executor.md` §11。

## 1. 背景与问题（Why）

### 1.1 实证 incident

`req_162` 经 4141 History API 取证（`clientResponse.sseEvents` + `attempts[0].upstreamResponse.sseEvents` 双轨对齐）还原的真实时间线：

- 0–142.9s：上游零字节（GHC 处理 250 条消息 / 336k cache-read token，无 thinking 帧、GHC 不透传 SSE ping）。代理每 ~20s 注入合成 keepalive 撑住客户端。
- 142.9s：上游首字节（文本块 `"Now the fully-detailed Phase 0 plan..."`）。
- 142.9→149.6s：平滑流式 6.6s（2921 帧、帧间 ≤74ms），文本块完成后进入 `Write` 工具的 tool_use，`partial_json` 流到 `"refact"`。
- 149.6s：`NGHTTP2_CANCEL` 在 tool_use **中途**掐断（GHC 单流应用层 cancel，pattern-B；TCP keepalive / h2 PING 均救不了）。
- 169.7s：FAIL。客户端只拿到已完成的文本块 + `event: error`，真正要写的计划（tool_use）全丢。

**根因判定**：mid-stream `NGHTTP2_CANCEL` 协议上不可安全重试（前 spec §5.3 / `classify.ts` 仅 REFUSED 可重试），故当今行为是首块后截断 → `partial-degrade`（不重试、已发帧收不回）。**用户诉求**：client 不在乎双重计费/不完美，要的是「尽力拿到完整响应」——即首块后仍续写重试。

### 1.2 前 spec 的两处未完成（实测 landed 状态）

前 spec 机制大体 landed 到 master（plan README「待实施」已陈旧），但**分裂**：

| 端点 | 缓冲粒度 | 默认 | 状态 |
|---|---|---|---|
| Responses HTTP | 块级（`output_item.done`） | ON | ✅ 达成 |
| Responses WS | terminal-only | ON | ⚠️ 范围决定，未升块级 |
| CC | terminal-only（`ccCommitBoundaries` 只认上游 error 帧） | ON | ⚠️ 退化档，未升块级 |
| **Anthropic** | 块级谓词已接线（`anthropicCommitBoundaries`） | **OFF** | ❌ 未达成 |

两个前 spec 目标未完成：
- **「退役整响应」未做**：`protect_streaming_generation` 三态 `false/"on"/"tool_use_only"` 仍在，`schema.ts:637-645` 文档仍描述「buffer the **whole response**」旧语义。
- **「Anthropic 默认 on」未做**：默认 `false`，原因是——

### 1.3 承重发现：Anthropic 块级对 Claude Code CLI 不安全

前 spec §4.3 的块级保活主形状 = **anchor-coexist**（empty-text anchor@0 全程 open + 真实块@+1 在其之上**同时** open）。`config.yaml:370` + `tests/e2e-client/anthropic-coexist-cli.e2e.test.ts` 记录：真 Claude Code CLI 的 agent-loop 状态机比 `@anthropic-ai/sdk` 严，「两个 index 同时 open」把它搞糊涂 → 重新查询 → **stall**（`numTurns>1` + 空结果）。SDK 能吞，CLI 不能。故 Anthropic 块级只能默认关。

**问题不在「多块」，而在「并存 open」。** 这是本 spec 的核心突破口（见 §3）。

---

## 2. 目标与非目标

**目标：**
- G1 **顺序 anchor** 取代 anchor-coexist，让 Anthropic 块级 **CLI-safe**、可默认 on（完成前 spec 未竟部分）。
- G2 **续写重试**：首块 commit 后被掐 → 合成 continuation 轮续写，覆盖 Anthropic + Responses HTTP + Responses WS + CC。
- G3 **CC 升块级** + **Responses WS 升块级**（移出 terminal-only）。
- G4 **彻底退役整响应缓冲**：无 whole 模式；Anthropic 块级不可用时回退 **live**，永不回退 whole。
- G5 续写预算、终局分类、每格式实证门定清。

**非目标：**
- N1 不保护 Gemini（结构不兼容，保持 live；沿用前 spec §7.4 backlog）。
- N2 不保护非流式路径。
- N3 不改非截断类错误分类（REFUSED_STREAM 等不动）。
- N4 **不追求续写「完美保真」**：合成 continuation 轮是「重构的意图」而非模型真实内部状态，续写块可有降级（诚实标注，见 §5.3）。

---

## 3. 顺序 anchor（Anthropic 块级 CLI-safe 形状）

### 3.1 形状：任一时刻单块 open

```
message_start
content_block_start@0    (empty-text ANCHOR)      ← pre-content 静默期保活载体，独自 open
content_block_delta@0    (text_delta "")          ← 每 ~15s 一个，重置 CC 300s 死线
content_block_stop@0     ← 真实块打开前先 CLOSE anchor（与 coexist 的唯一本质差异）
content_block_start@1    (真实块)
content_block_delta@1 …
content_block_stop@1
content_block_start@2    (块间 gap：新开一个 empty-text anchor)
content_block_delta@2    (text_delta "")          ← gap 保活
content_block_stop@2
content_block_start@3    (下一真实块 / 续写块)
…
message_delta / message_stop
```

**不变量**：任一时刻至多一个块 open。全程是标准顺序块流，永不并存 open。

### 3.2 为何 CLI-safe（PoC 已实证）

`exp/block-level-anchor-sequential/`（mock upstream + 真 `claude` CLI oracle）：顺序 wire 喂真 Claude Code，实测 **`numTurns=1`（不 stall）、两真实块内容全保留、`end_turn`、无 error**。对比 coexist 的 `numTurns>1` stall 签名。agent-loop stall 的诱因（并存 open）被顺序形状绕过；穿插的空 text 块渲染为空、无害、不触发重查。

**附带优势**：顺序形状不需要 coexist 逼出的 sink 单槽 `openBlock`→块栈改造（前 spec §4.3(a)），实现更简单。

### 3.3 index 分配重写（承重——非「sink 小改」；审查 Critical-1 确认）

**PoC 的作用域边界（务必明确）**：`exp/block-level-anchor-sequential/hook.ts` 是**手写裸 SSE 帧**，未经过 `client-sink.ts` / `driver.ts` / `keepalive-anchor.ts` 任何一行产线代码。故它证明的是「**Claude CLI 接受这个 wire 形状**」，**没有**证明「**代理能产出这个 wire 形状**」。后者是下面这块尚未动过的架构工作。

**现有 index 模型是「唯一锚点固定 index 0、所有真实块 +1」**（已核实）：
- `keepalive-anchor.ts:16` `ANCHOR_INDEX = 0`，JSDoc 明言「anchor occupies index 0; all real content blocks flush at index+1」。
- `remapAnthropicBlockIndex(frame, offset)`（:71-84）被**硬编码 offset=1** 调用：`driver.ts:1095`（buffered 提交）、`driver.ts:1142`（retreat 分支）、`live-reconcile.ts:132`（live 逐帧对账）。

**顺序 anchor 打破这个模型**：anchor 出现在 wire 的 index 0、2、4…（穿插在真实块之间），真实块的最终 index = 它前面已插入的锚点数，是**运行时递增 offset**，不是常量 1。故本 spec 必须在**实现前**定清：
- (a) **锚点 index 分配算法**：谁在第几个位置、真实块 offset 如何随已插入锚点数递增（取代 `ANCHOR_INDEX=0` 常量 + 固定 +1）。
- (b) `remapAnthropicBlockIndex` 的 offset 参数从常量改为**依 sink 状态计算**（三处调用点 driver.ts:1095/1142、live-reconcile.ts:132 同步改）。
- (c) **retreat 分支**（driver.ts:1142）在多锚点情形下的重映射语义。
- (d) sink 侧 `noteBlockState` 顺序策略：pre-content anchor open→delta→close-on-first-real；块间 gap 心跳 tick 无 open 块时新开 anchor→delta→下一真实帧到达时 close。仅需单槽 `openBlock`（这一层确实比 coexist 块栈简单，但**不是**全部工作）。

这是 index-allocation 原语的重设计，属**本 spec 承重项 + 计划期首个 PoC 门（代理产出侧）**，不是「计划期核实项」。

### 3.4 剩余子门 + 价值前提（计划期；审查 Important 确认因果链）

**300s 死线重置**：本 PoC 用短 wire。incident 的 142.9s 静默要求 anchor 空 `text_delta` 每 ~15s 重置 CC 300s no-real-content 死线（对比 `exp/cc-idle-280s`：裸 ping 不重置、真 text_delta 重置）。顺序 anchor 的 gap 保活也是 text_delta，预期重置，但需 >300s 长-idle 真 CLI 跑实证。

**承重因果链（本 spec 价值主张的前提条件，勿藏）**：本 spec 的真正新增价值在**首块 commit 之后**的 mid-stream CANCEL（如 incident 的 tool_use 截断）——incident 的前 142.9s 纯静默**已被现有 live 路径覆盖**（ADR `2026-07-09-unconditional-keepalive-timeout-safety` §1，`protect_streaming_generation:false` 默认下合成 message_start + anchor 已撑住）。但续写重试**依赖首块已走块级缓冲路径**。故若 300s 门 FAIL → Anthropic 回退 live（非缓冲）→ 块级不启用 → **续写不触发** → incident 类「长静默 + mid-tool_use 截断」复合场景**仍 0 可用产出**（等同今天）。即：**300s 门 PASS 是续写对 Anthropic 长静默场景有效的前提**，非可有可无的细节。门 FAIL 的退路不是「回退 live 就没事」，而是须另想保活形状（否则 incident 目标未达成）。

---

## 4. 续写重试（continuation-retry）

### 4.1 上游不支持 prefill —— 用合成 continuation 轮

**实证**（PoC，haiku + opus-4.8 双验）：GHC 上游拒绝 assistant-prefill——`"This model does not support assistant message prefill. The conversation must end with a user message."`。故续写**不能**把已发内容作 assistant 消息结尾让模型接着写。

可行形状（PoC 已证，含 tool_use 续写）：
```
[原始请求体不变（cache 友好）]
+ { role: assistant, content: [已 commit 的完整块] }
+ { role: user, content: <可配置续写消息> }   ← 合成轮，默认 "network issue. please continue"
```
模型把已 commit 块当完整 assistant turn，从续写轮继续生成剩余块（PoC 实测干净续写、不重复、能续出 tool_use）。

### 4.2 数据源：committed-blocks-ledger（新单元）

buffered driver 累积「已 flush 给客户端的完整块」的 canonical 快照（text 块文本、tool_use 完整 name+input）：
- 只记**已 commit**（过 `commitBoundaries` 并落 wire）的块。
- partial 块（还在缓冲 / 中途被掐，如 incident 的 tool_use→`"refact"`）**绝不入账**、直接丢弃重生成。
- per-attempt 语义：`onAttemptReset` 不清 ledger（ledger 是跨 attempt 累积的已承诺前缀），但每次续写在 committed settle 点冻结快照（对齐 skill `persistence-async-invariants` §3「信号在 committed settle 点记录」）。

### 4.3 请求组装：continuation-request-builder（新单元，per-format）

| 格式 | assistant 载体 | 续写轮载体 | 已知 hazard → 门 |
|---|---|---|---|
| Anthropic | `messages[…, {role:assistant, content:[已commit块]}, {role:user}]` | user 消息 | ✅ **text-only 前缀已验证（= incident 场景）**；**已 commit 完整 tool_use 块作前缀未验证**（PoC `/tmp/poc_tool.json` 的 assistant 前缀是纯文本，证的是「从文本前缀模型会续出 tool_use」，非「tool_use 块作前缀被接受」）→ 补 PoC |
| CC | `messages[…, {role:assistant,…}, {role:user}]` | user 消息 | **tool_calls 尾随约束（覆盖率窄，勿夸大）**：只在「同一响应内已有**完整** tool_call 被提交、且被截断的是其后的另一个 tool_call」这一窄子集触发（多 tool_call 链非首个被截断）；**单 tool_call / 纯文本 / text+单tool_call 响应的截断续写不受影响**（partial tool_call 被丢弃后前缀不以 tool_calls 结尾）。触发窄子集时回退 partial-degrade → 计划期 PoC 门 |
| Responses HTTP/WS | `input[…, 已done的output_item, {role:user}]` | input message | GHC Responses 是否接受 prior-output + 合成 follow-up → 计划期 PoC 门（HTTP/WS 共用结论） |

三 builder 共享接口；Responses HTTP 与 WS 共用同一 builder（同 Responses 格式，仅传输不同）。

### 4.4 合成物标记（richest-data-flow 铁律）

- 合成 assistant 块 + 合成 user 轮进 `attempts[].upstreamRequest`（忠实反映真实发上游的字节），但打 `synthetic:"continuation"` 标记、可辨识。
- **绝不污染上游原始轨**（`upstreamResponse.sseEvents` 只含真实上游帧）。
- 每次续写 = 新 attempt，`attempts[]` 完整记录（upstreamRequest 含合成轮 + ledger 快照引用 + upstreamResponse）。
- 客户端转发轨缝合后是**一条连续流**：已 commit 块（attempt N）+ 续写块（attempt N+1，index 从已 commit 块数接着编）。续写块的合成结构帧（重编号）打标记。

### 4.5 客户端视角

一条连续 SSE 流，块 index 0,1,2,3… 连续递增（跨内部 attempt 边界无缝）。中途 partial 块从没落 wire。`@anthropic-ai/sdk` / `openai` SDK 累积得完整、无重复、无协议破坏（§8 oracle 验证）。

---

## 5. 重试语义、预算、终局

### 5.1 重试窗口扩展 = 新增 driver 状态机分支（承重；审查 Critical-2 确认）

前 spec 的硬不变量（已核实）：`driver.ts:1283` `const retryable = (thrown ? classifyStreamError(thrown)==="other" : true) && !committedAny`——一旦 `committedAny===true` 强制走 :1330 的 `partial-degrade`/`exhausted`，**永不进 retry 分支**。本 spec 不是「放宽一个布尔门」，而是**新增一条与现有 buffer-replay 循环结构不同的 driver 分支**，须在实现前定清：

- **门改造**：加平行分支「`committedAny && continuation 可行 && 预算未耗 → 续写路径」`，而非弱化 `!committedAny`（terminal-only 路径 committedAny 恒 false，其语义须逐字不变，R1）。
- **replay vs append 语义差异**：现循环体（`flushBufferedFrames` + buffer-then-flush，driver.ts:1090-1145）设计前提是「buffer 全部→drain 后按块提交」。续写是「已提交块**已不在 buffer**、新构造追加了合成轮的 env 跑**新 exchange**、其输出帧接到**同一个已在推进的 sink**」——是 append 非 replay。这条新路径的 `attempt`/`buffer`/`committedAny`/index-offset（§3.3）各自的新语义须画清。
- **generation/coordinator 语义**：`coordinator.runRecovery(parent.candidate, ...)`（:1300-1314）+ `bind`/`selectGenerationWinner` 假设「recovery = 同一 candidate 恢复」。续写是「部分内容已交付、逻辑上延续的**新** exchange」——与现有 hedged-candidate 语义是否兼容须显式论证（否则计划期会撞「续写套不进现有 retry 循环」而被迫推翻实现路径）。

**归属**：本节列为**计划期首要架构设计项 + Phase 结构骨架**，不是 §5 的一句话扩展。

### 5.2 共享预算 + 反向饥饿（诚实取舍；审查 Important 确认缺失）

一个 exchange 的首块前透明重试 + 首块后续写重试**合计** ≤ `buffered_retry.max_retries`（默认 3）。不设独立续写预算旋钮。

**已知限制（反向饥饿，须记录非隐藏）**：首块前透明重试可能先烧光预算，导致真正命中 mid-stream 截断时续写配额为 0、直接进 `continuation-exhausted`。incident req_162 未踩（前段纯静默非频繁 cut），但「上游偶发抖动、频繁 transport-close」的会话会踩。裁决选项（计划期定其一并记录）：(a) 续写保底最小次数（≠ 独立旋钮，只是共享预算内为续写预留 ≥1）；(b) 显式接受此顺序敏感限制。**本 spec 倾向 (a) 保底 1 次**——incident 类的价值主张不应被首块前重试饿死；最终计划期定。

### 5.3 终局分类（扩展前 spec §9.2）

- `success` — 完整终止符到达（含续写后成功）。
- `partial-degrade` — 首块后失败**且**续写不可行（格式门未过 / CC tool_calls 尾随约束 / `continuation.enabled=false`）：已发块保留 + error 帧，不重试。**不再是首块后的默认终局，而是续写不可行时的兜底。**
- `continuation-exhausted`（新细分）— 续写重试耗尽预算仍未完成：便于观测「续写生效但没救回」vs「压根没续写」。

**telemetry 维度（审查 Minor 确认，勿留实现顺手加）**：前 spec §9.2 的 `retriesBeforeDegrade` 在续写语境须**拆两个独立计数**——「首块前透明重试次数」与「续写次数」——否则无法区分「成功靠透明重试还是靠续写」（项目 `telemetry-architecture`「不可重算因子拆最细」）。字段设计在 spec 阶段定，不留实现。

---

## 6. 配置（退役 whole + 续写子块）

### 6.1 退役整响应

- 删除 `protect_streaming_generation` 的 whole-response 语义。`schema.ts:637-645` 文档重写为块级 + 顺序 anchor。
- Anthropic 块级不可用（300s 门 FAIL）→ 回退 **live**（现有 pre-response keepalive），**永不回退 whole**。schema 中不再有任何 whole 枚举/兜底路径。
- 沿用前 spec §6.1 命名铁律（`buffered_retry` 恒为 map）。

### 6.2 续写配置

```yaml
buffered_retry:
  max_retries: 3            # 已存在；续写与首块前透明重试共享
  buffer_cap_bytes: 16777216
  heartbeat_sec: 15
  continuation:             # 新增子块
    enabled: true           # 默认 ON（全格式）
    message: "network issue. please continue"   # 合成 user 轮内容，可配置
```
per-vendor 可覆盖 `<vendor>.buffered_retry.continuation.{enabled,message}`；解析优先级 per-vendor > 共享 > 内置默认。配置哲学独立（记忆 `config-philosophy-separate`）：`message` 键改名留旧别名、热重载绝不因配置杀进程。

### 6.3 默认翻转

- Anthropic `protect_streaming_generation`：`false` → **块级默认 on**（§3.4 300s 门通过后的 commit）。
- `continuation.enabled`：默认 **true**（全格式）。

---

## 7. 各端点接入

- **Anthropic**：顺序 anchor（§3）+ 续写（§4）。300s 长-idle 门 + Anthropic 续写已验证。
- **Responses HTTP**：已块级；加续写 builder + Responses 续写形状门。
- **Responses WS**：升块级（复用 `output_item.done` 谓词，移出 terminal-only）+ 续写（与 HTTP 共 builder）+ **WS 传输门**：续写在长连接上重新派发上游轮 + `sendErrorAndClose`/1011 close-code 与增量 commit 的时序对齐（前 spec §7.3 backlog:300-306 四点）。
- **CC**：升块级——`cc-commit-boundaries.ts` 从 terminal-only 扩为真块级（index 跳变 + text→tool 过渡边界重建）+ 续写。**CC index 串行性门** + **CC tool_calls 尾随约束门**。末块仍靠 finish_reason（固有退化角落，非 bug）。
- **Gemini**：排除，保持 live。

---

## 8. 测试策略

- **单元**：committed-blocks-ledger（只记 commit 块、丢 partial、onAttemptReset 不清）；三 continuation-builder 形状组装；CC 块边界谓词（index 跳变 / text→tool / 末块 finish_reason）；顺序 anchor sink（pre-content close-on-first-real、gap 新开）。
- **客户端 oracle**（wire 正确性不自洽）：`@anthropic-ai/sdk` / `openai` SDK 消费缝合流（已发块 + 续写块重编号），断累积连续、无重复、无协议破坏。
- **e2e（mock upstream）**：`upstream-hook-mocking` 造「首块后 mid-block NGHTTP2_CANCEL」→ 断代理发出续写请求（含合成轮）→ mock 续写响应 → 客户端 SDK 拿完整拼接。
- **CLI e2e**：顺序 anchor 短 wire（已 PASS，`exp/block-level-anchor-sequential/`）；补长-idle（>300s）死线重置门。
- **时序/flaky**：续写触发依赖 mid-stream 掐断时序，FakeClock + test 持 ReadableStream controller 精确控帧（skill `empirical-verification`）；连跑 10–25 次证确定性。

## 9. 计划期 PoC 门（均 mock upstream 可跑，非阻塞本 spec）

1. 顺序 anchor 300s 死线重置（长-idle 真 CLI）。
2. CC tool_call index 串行性（真实并行工具调用 CC 流）。**先验风险偏高**（审查确认）：`stream-accumulator.ts:114-131` 的 `acc.toolCallMap` 是 **index 为 key 的 Map**（非顺序 push），说明现有作者已为「容忍乱序更新同一 index」设计——乱序非纯假设性风险。此门**不建议临实施才测**，早跑。
3. CC 续写 tool_calls 尾随约束（含已 commit tool_call 时上游是否接受）。
4. Responses 续写形状（GHC 接受 prior-output 续写；HTTP/WS 共用）。
5. WS 传输时序（续写重派上游轮 + close-code 对齐）。

任一门 FAIL → 该格式/角落回退 partial-degrade，不牺牲其余（沿用前 spec §4.5「主/备/兜底之一通过即保默认可交付」精神，但兜底是 live 非 whole）。

## 10. 已实证（PoC 闭环）

- ✅ GHC 拒绝 assistant-prefill（haiku + opus-4.8）；合成 continuation 轮可行——**text-only 前缀** + continue 指令下模型会续出 tool_use（`/tmp/poc_*.json`）。**未验证**：已 commit **完整 tool_use 块**作 assistant 前缀是否被上游接受（§4.3 补 PoC）。
- ✅ 顺序 anchor **wire 形状被 CLI 接受**：真 claude CLI + mock upstream，numTurns=1、不 stall、两真实块保全（`exp/block-level-anchor-sequential/FINDINGS.md`）。**未验证**：代理**能否产出**该 wire（§3.3 index 分配重写 + 代理产出侧 PoC 门）；顺序 anchor 重置 300s 死线（§3.4 长-idle 门）。
- ✅ 前 spec landed 状态与 Anthropic default-OFF 根因（§1.2/1.3）经 config/schema/code 实测。

## 11. ADR / doc-sync 目标

- ADR `docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md`：决策核 = 退役 whole（回退 live 非 whole）+ 顺序 anchor 取代 coexist + 续写换保真度（client 优先完整响应）。
- doc-sync（landing 必更）：前 spec 加「Anthropic 部分由本 spec 完成/取代」注解；`DESIGN.md` 活的架构现状行；`docs/streaming.md`；`config.yaml`/`schema.ts` 文档；前 spec plan README 状态注解。

## 12. 非采纳记录

- **native prefill 续写**：上游 haiku+opus-4.8 双拒，无可用绕过，弃。
- **续写独立预算旋钮**：增旋钮 + 总上限变两者之和，弃，用共享预算。
- **Anthropic 保留 whole 兜底**：用户裁决彻底退役，回退 live。
- **CC/WS 也纳入续写**：用户裁决纳入（CC 升块级后具备结构前提；WS 复用 Responses builder）。

## 13. 审查发现整合记录（异模型 gpt-souls:reviewer，2026-07-22）

主线亲自核对 reviewer 引用的每个 file:line 后采纳：
- **Critical-1（采纳）** 顺序 anchor 打破「anchor@0 固定 +1」index 模型（`keepalive-anchor.ts:16` + `driver.ts:1095/1142` + `live-reconcile.ts:132` 硬编码 offset 1，已核实）；PoC 是裸帧未走产线、只证 CLI 接受非代理产出 → 升级为 §3.3 承重设计项 + 代理产出侧 PoC 门。
- **Critical-2（采纳）** 续写与 `driver.ts:1283` `!committedAny` 硬门冲突、replay vs append 语义差异、generation/coordinator 候选语义 → 升级为 §5.1 新增 driver 状态机分支。
- **Important（采纳）**：300s 门因果链（门 FAIL → 续写不触发 → incident 无解，§3.4）；Anthropic tool_use 保真度 PoC 过度概括（逐字核 `/tmp/poc_tool.json` 前缀纯文本，§4.3/§10 收窄）；共享预算反向饥饿（§5.2 倾向保底 1 次）；CC index 串行门先验风险偏高（`toolCallMap` Map-based，§9）；telemetry 维度须拆两计数（§5.3）。
- **Important（部分修正采纳）**：CC tool_calls 尾随约束覆盖率**比原措辞窄**——只「多 tool_call 链非首个被截断」触发，单/纯文本不受影响（§4.3 表格改）。reviewer 软化了此项严重性，采纳其更精确边界。

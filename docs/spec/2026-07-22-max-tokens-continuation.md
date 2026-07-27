# Spec: `max_tokens` 续传（max-tokens continuation）

> 状态：**草案（两轮异模型对抗审查已消化、Q1/Q2 用户已裁决 2026-07-23、续写底座已 landed master 已对齐——可进 plan 阶段；plan 首要产出 = §5.3 terminal ownership matrix）**
> 日期：2026-07-22
> 关系：**姊妹并列** [`2026-07-22-continuation-retry-and-sequential-anchor.md`](2026-07-22-continuation-retry-and-sequential-anchor.md)（下称「续写 spec」）。**复用**其 §4 续写机制（committed-blocks-ledger + 合成 continuation 轮 + per-format builder），但**触发路径相反**：续写 spec 处理**错误截断**（mid-stream `NGHTTP2_CANCEL`，成功路径外的 throw），本 spec 处理**成功路径的预算截断**（`stop_reason=max_tokens`，干净终止）。
> 实测取证：4141 History API，近 1200 条中 5 例 `max_tokens`（~0.4%），全 `claude-sonnet-5` 流式、`state=completed`、`output_tokens` 精确 = 客户端自设 `max_tokens`（下详）。

---

## 1. 背景与问题（Why）

### 1.1 实证画像（4141 History API，5 例）

近 1200 条 anthropic-messages 里 5 例 `upstreamResponse.stopReason=max_tokens`，全部**成功干净收尾**（`message_delta{stop_reason:max_tokens}` + `message_stop`，`state=completed`、`responseSuccess=true`）。全部 `claude-sonnet-5`、`req.max_tokens=32000`、`output_tokens=32000`（精确撞客户端自设预算；模型真实 `max_output_tokens=64000`——**是客户端主动设的预算，不是模型极限**）。每轮 `cache_read_input_tokens` 均 30 万+（满上下文）。

**承重发现：截断位置分三类，wire 形状不同 → 三种正确动作，不能一刀切。**

| 例 | 截断在 | 终止 wire 形状 | 悬挂开块？ | output/thinking token |
|---|---|---|---|---|
| `req_..._183` | tool_use[Write] input JSON | `start@0 stop@0 start@1 MΔ STOP` | **是**（`start@1` 无 `stop@1`） | 32000 / 0 |
| `req_..._182` | tool_use[Write] input JSON | 同上 | 是 | 32000 / 0 |
| `req_..._44` | text（12483 字符） | `start@0 stop@0 start@1 stop@1 MΔ STOP` | 否（text 块已闭合） | 32000 / 24171 |
| `req_..._91` | thinking（0 可见文本） | `start@0 stop@0 MΔ STOP` | 否 | 32000 / 31998 |
| `req_..._82` | thinking（0 可见文本） | 同上 | 否 | 32000 / 31999 |

- **A 类（截断在 text）**：已发文本合法可提交；截断前有完整闭合块。**唯一真正适合 proxy 续写的子集。**
- **B 类（截断在 tool_use input）**：留**非法悬挂块**（partial JSON 不完整）；`start@1` 有 start 无 stop。
- **C 类（截断在 thinking、0 答案）**：最贵（32k token 全烧在思考、**0 可用答案**）但续写最不可靠。

### 1.2 现状：干净透传，无任何 max_tokens 续传逻辑

全仓 grep：`max_tokens` 作为 stop_reason 只出现在**格式翻译映射**（`anthropic-to-cc.ts:143` `max_tokens→length`、`cc-to-anthropic-stream.ts:111` `length→max_tokens`、`anthropic-to-responses.ts:176` `max_tokens→incomplete+max_output_tokens`），**无任何触发分支、无 backlog 条目**。当前行为 = **把 `max_tokens` 如实透传给客户端**（实测 clientResponse 含完整 `message_delta{stop_reason:max_tokens}` + `message_stop`）。这是 API 契约正常工作——客户端 SDK / agent-loop 本就被设计来处理预算截断。

### 1.3 为何这**不是**续写 spec 的场景（承重区分）

续写 spec 的重试门在 `src/lib/pipeline/driver.ts:1366` 的 `committedAny`：`const retryable = (thrown ? classifyStreamError(thrown)==="other" : true) && !committedAny`（已 grep 核实）——**仅错误 throw 路径**。`max_tokens` 是**成功路径**：`message_stop` 已干净到达、无 throw、driver 正常收尾（master `driver.ts:1327-1358` 对 `sawMessageStop()` 走 terminal drain flush）。故 max_tokens 续写**不是放宽一个布尔门**，而是**成功路径上一条全新的 post-success 续写分支**（§5）——须在 terminal drain 写客户端**之前**插入截获，master 现有 continuation 走的是 cut/transport-close 的 append 路径（`driver.ts:1401-1453`），**不覆盖成功终止**。

**底座已 landed master（2026-07-23 复核纠正）**：续写 spec 的机制**已合并入 master**（`feat/continuation-retry` worktree 已移除）——`committed-blocks-ledger.ts` / `committed-block-extractor.ts` / `continuation-builder.ts` 模块 + `driver.ts:1279` ledger 喂养快照 + `driver.ts:1300` `recordCommitted` + `driver.ts:1412-1453` 续写触发（`canContinue` 门 + `buildRequest` + `coordinator.runContinuation`）+ `handler-v4.ts:1219` `createCommittedBlocksLedger()`/`extractAnthropicCommittedBlocks` 接线 + `continued` verdict（`model-operation-record.ts:246/250`）全在 master。**A 类续写 = 直接复用这套已 landed 底座 + 换触发点（成功终止而非 cut）**。依赖已满足（§11）。

---

## 2. 目标与非目标

**目标：**
- G1 **A 类（text 截断）proxy 侧自动续写**：复用续写 spec §4 机制，成功路径新触发分支，把预算截断的 text 续到自然终止（`end_turn`/`tool_use`）。
- G2 **B 类（tool_use 截断）安全兜底 + PoC 门**：默认**不自动续、如实透传 max_tokens**；PoC 验证「悬挂 tool_use 前缀续写能否忠实重建同一工具调用」通过后再评估纳入。
- G3 **C 类（thinking-only、0 答案）识别 + 兜底策略**：默认如实透传；探索「提高预算重试」而非「续写」的正确解，PoC 门定夺。
- G4 **客户端可见性策略（已裁决，§4）**：默认 transparent 缝合（藏掉 max_tokens、藏不掉透传），多策略可配置；**透明只对客户端、后端记录忠实**。
- G5 **独立预算模型**（§6）：每轮续写是满上下文（实测 cache_read 30 万+ token、极贵），不与首块前透明重试共享预算旋钮。
- G6 覆盖 Anthropic `/v1/messages` + Chat Completions + Responses（HTTP/WS），per-format terminal 检测（§7）。
- G7 vendor 中立配置 + 可观测性（history + telemetry）。

**非目标：**
- N1 **不含 Gemini**（结构不兼容，沿用续写 spec §7.4 / 本项目多处 Gemini 排除；保持透传）。
- N2 不保护非流式路径（首版；见 §8.4）。
- N3 **默认不静默替客户端抬 `max_tokens` 请求预算**——但**用户裁决（2026-07-23）：抬预算是允许的可配置策略**（C 类 `retry_with_budget`，§6 `thinking_retry_budget`）；默认仍不抬（`passthrough`），opt-in 开启后可抬到模型 cap。用户明确不在乎下游预算约束被突破。
- N4 不改非 max_tokens 类终局分类（`end_turn`/`tool_use`/`refusal` 不动）。
- N5 **不追求续写完美保真**：合成 continuation 轮是「重构的意图」，续写块可有降级（诚实标注，沿用续写 spec N4）。

---

## 3. 三分型的正确续传策略（核心）

**共同前提**：`max_tokens` 是合法完成，预算是客户端自设。故**默认保守 = 如实透传**；proxy 侧续写是 **opt-in 增强**，且**按截断分型分档启用**——每型只在其风险可控时默认可用。

### 3.1 A 类（截断在 text）—— 主目标，可默认 opt-in

已发文本块**已闭合、合法可提交**，续写只需在其后追加剩余内容。

- **数据源**：复用续写 spec §4.2 committed-blocks-ledger（只喂已过 `commitBoundaries` 并落 wire 的闭合块）。A 类天然满足——截断前的 text 块有 `content_block_stop`（实测 `_44`：`stop@1` 在 `MΔ` 前）。
- **请求组装**：复用续写 spec §4.3 Anthropic builder——`messages[…, {role:assistant, content:[已commit块]}, {role:user:<续写消息>}]`。**text-only 前缀已被续写 spec §10 PoC 实证**（GHC 从文本前缀干净续写、不重复、能续出后续块）。
- **缝合与客户端视角**：复用续写 spec §4.4/§4.5——一条连续流，块 index 连续递增跨内部 attempt 边界；合成结构帧打 `synthetic:"continuation"` 标记；上游原始轨绝不污染。

**A 类是本 spec 唯一「续写机制直接可用」的分型。** B/C 需各自 PoC 门。

### 3.2 B 类（截断在 tool_use input）—— 高危，默认透传，PoC 门后评估

**为何默认不自动续**：
1. **悬挂块非法**：`start@1`（tool_use）无 `stop@1`，partial_json 不完整。按 ledger 铁律（续写 spec §4.2）partial 块**绝不入账、直接丢弃重生成**。**零-delta 退化子情形**：`content_block_start`（tool_use）后未产生任何 `input_json_delta` 就被截断（连半截 JSON 都没有）同样归 B——判定「最后块 tool_use 且无 `content_block_stop`」已吸收此情形，但实现须显式测该边界。
2. **重生成 ≠ 续写**：合成轮里模型从**已 commit 的前缀**（此例是前面的 text 块 + 一个被丢弃的半截工具意图）**从头重规划**这个工具调用——极可能吐出**不同的 tool / 不同的 input**，而非「接着写原来那半个 JSON」。这与「续写文本」的语义完全不同。**这是 B 类的真正 hazard**（发散），下面第 3 点澄清它**不是**「上游是否接受 tool_use 前缀」的问题。
3. **前缀接受性已验证、发散风险仍在（更正过时引用）**：续写 spec 正文 §10 曾标「已 commit 完整 tool_use 块作前缀**未验证**」，但 PoC 门 **G3 已 PASS**（master `exp/continuation-shape/FINDINGS.md`：GHC 接受「完整 tool_use 块作 assistant 前缀 + user 续写轮」、返回正常 text+tool_use、无 400）。**但 G3 验证的是「完整未截断 tool_use 块作前缀被接受」，≠ B 类场景**——B 类的 partial tool_use 被**丢弃**、前缀退化为其前的已闭合块（多为 text；若前缀末是完整 interactive tool_use 则按 B-closed/ADR D3 正常终止不续，§5.2）。故 G3 只消除了「前缀不被接受」这一 hazard，**发散 hazard（第 2 点）仍在、仍需门 B**。
4. **客户端本就正确处理**：agent 客户端（Claude Code）拿到 `stop_reason=max_tokens` + 截断的 tool_use，本就被设计来重试 / 追加 max_tokens。

**PoC 门 B（§9-2）通过后**可评估的形状：丢弃 partial tool_use → 合成轮请模型「继续」→ 断言模型是否忠实产出**语义等价**的完整工具调用（而非发散）。门 FAIL → B 类永久兜底透传（不牺牲 A 类）。

### 3.3 C 类（截断在 thinking、0 可用答案）—— 最贵最不可靠，retry-with-budget 探索

**特征**：`output_tokens=32000` 几乎全是 `thinking_tokens`（实测 31998/31999），可见答案 = 0。客户端烧满预算、拿到**零产出**。这是**最痛的**（钱花了、啥也没有），但：

- **thinking 无法干净回喂**：被打断的 thinking 带签名、且模型在续写轮会**重新思考**（发散，不接续）。合成「已 commit thinking 块 + continue」既有签名风险（参考 skill `ghc-anthropic-upstream` thinking signature quarantine）又语义不接续。
- **正确解可能是「提高预算重试」而非「续写」**：客户端设的 32000 < 模型 64000；C 类的真问题是**预算不足以容纳 thinking + 答案**。**用户裁决（2026-07-23）：抬预算是允许的可配置策略**（不再是 N3 铁律禁区）。

**C 类多策略（用户裁决：支持多种策略、可配置，§6 `classes.thinking`）**——两种并存、按配置选：
- `passthrough`（**默认兜底**）：如实透传，靠 telemetry/history 让 C 类可见（诊断价值：谁在烧满预算思考却零产出）。
- `retry_with_budget`（opt-in，门 C PASS 后）：对 C 类**重发**（非续写——因 thinking 不可续）并抬高本次 upstream 的 max_tokens（`thinking_retry_budget`，默认模型 cap）。visibility 策略决定客户端可见性（默认 transparent 缝合）。
- **无 `continue` 选项**：master ADR D3 已固化——extractor 把 thinking 块从 ledger 排除、上游拒 thinking 作前缀，故 thinking 续写在现架构下不可实现（`driver.ts:1434` `ledger.snapshot()` already excludes thinking）。若真要支持须先推翻 ADR D3 的 thinking-quarantine，不在本 spec 范围。

**门 C 先验风险高**——thinking round-trip 是本项目历史雷区（多个 400 incident），`retry_with_budget` 不应临实施才测；默认 `passthrough` 始终安全。

---

## 4. 客户端可见性策略（G4，**用户已裁决 2026-07-23**）

**问题**：续写把内部多轮缝合成**一条连续流**，客户端最终看到的 `stop_reason` 是续写完成后的 `end_turn`/`tool_use`——`max_tokens` 信号被藏掉。客户端设了 `max_tokens=32000`、proxy 静默交付更多 token（双重计费 + 突破客户端显式预算约束）。

**用户裁决（2026-07-23）**：**能藏就藏、藏不掉才透传**。理由：本项目下**下游预算约束当前并不被客户端强制遵守、proxy 无义务确保其完美**，用户明确**不在乎双重计费**。这落在项目 `internal-tool-security-posture`（不为假想顾虑阻塞任务、以功能价值为先）+「无向后兼容负担」的哲学内——「藏掉 max_tokens 给客户端一条完整响应」对续写分型是**严格更好的 UX**（客户端本就想要完整输出），代价（预算/计费诚实性）用户已显式放弃。

**默认策略 = 透明缝合（transparent-stitch）**：
- 续到自然终止（`end_turn`/`tool_use`）→ **抑制**首轮的 `message_delta{stop_reason:max_tokens}` + `message_stop`（不转发），保持流 open，续写轮块重编号接续，以续写轮的**真实终止符**收尾。客户端看到一条干净的完整流，不知发生过续写。
- **藏不掉 → 透传**：若续到 `max_rounds` 仍是 `max_tokens`（预算真耗尽、无干净终止可替换），或分型不续写（B/C 默认），则**如实转发** terminal `max_tokens`（无可藏之物）。这是诚实兜底、非纠结取舍。

**多策略可配置（用户裁决：支持多种策略，§6 `visibility`）**：默认 `transparent`，但保留 `passthrough`（永不缝合、始终透传 max_tokens，等于关掉可见性隐藏）与 `marker`（**与 transparent 一样抑制被替代的首轮 terminator**、区别仅为在续写前注入一个可辨识且格式合法的 marker，给想要「完整答案 + 知道被截过」的场景）作为可选策略。选 `transparent` 时无 marker、无双计费提示——用户要的就是「藏掉」。**`marker` ≠ 不抑制终止符**：一旦首轮 `message_stop`/`[DONE]`/`response.incomplete` 转出、流已合法终止、无法同流续写；故 marker 必须与 transparent 同样抑制首轮 terminator，仅额外注 marker（门 D 须以此真实 producer wire 作 SDK oracle）。

**`usage.output_tokens` 呈现（简化，用户不在乎下游预算）**：transparent 缝合流报**各轮真实总和**（richest-data-flow：末端拿真数据；`output_tokens > max_tokens` 是真实消耗、用户已接受下游可能不识）。无需为「下游误判超预算」做特殊处理（下游本就不强制预算）。marker 策略下 marker 文本计入 output_tokens。

**注：透明只对客户端、后端必须忠实（用户强调 2026-07-23；richest-data-flow 硬规则）**——此策略**独立于分型**（A/B/C 若续写共用同一 visibility 策略）。「藏」**只作用于转发给客户端的 wire**；**本程序内部 history/telemetry/日志一律忠实完整记录**：真实轮数、每轮 upstreamRequest（含合成 continuation 轮，打 `synthetic:"continuation"` 标记）、每轮 upstreamResponse（原始轨绝不含合成物）、被抑制的首轮 `max_tokens` 终止、每轮真实 usage/总 token、分型。即诊断/计费真相归后端双轨保全，缝合隐藏只在客户端呈现层——这正是 richest-data-flow「后端存储必须完整、前端可选择性呈现、合成物必打标记」（§9 详列）。

---

## 5. 触发机制：成功路径新分支（承重，非布尔门放宽）

### 5.1 与 `committedAny` 错误门正交

`src/lib/pipeline/driver.ts:1366` 的 `committedAny` 门（`retryable = … && !committedAny`）在**错误 throw 路径**。max_tokens 无 throw、走**成功收尾**。故须**新增 post-success 分支**：

- **触发条件**：成功终止 + terminal `stop_reason==max_tokens`（per-format 检测，§7）+ 分型 ∈ 已启用档（§3）+ 续写预算未耗（§6）+ `max_tokens_continuation.enabled`。
- **append 非 replay**（沿用续写 spec §5.1）：已提交块已不在 buffer；新构造合成轮 env 跑**新 exchange**，输出帧接到**同一个已在推进的 sink**、index 从已 commit 块数续编。
- **与 generation/coordinator 语义 + settle/finalize 时序契约（承重架构项，非核实项；审查 major）**：max_tokens 走成功路径，**success 已在 settle 点冻结 history entry 快照**（skill `persistence-async-invariants` §2、记忆 `settle 冻结 history entry`），coordinator 已 `whenModelOperationFinalized`。post-success 再启新 exchange 接同一 sink 会撞两处硬约束：(a) **finalize race**（记忆 `V3 direct-driver async finalize race`——getEntry 撞异步 finalize，须 `await whenModelOperationFinalized`）；(b) **已冻结记录能否追加 attempts[]**。故本 spec 必须**在实现前**定清「settle/finalize 与 post-success 续写的时序契约」：要么把 settle **推迟**到续写循环真正终止（`end_turn`/预算耗尽）之后（则续写期 entry 保持 open、attempts[] 可追加），要么定义「已 settle entry 的续写补记」协议。这与续写 spec §5.1 把 `committedAny` 门升为承重 driver 状态机分支**对等**——本 spec 是其 **success 侧变体**，同等承重，不降格。

**依赖已 landed、接口已固化（2026-07-23 复核纠正）**：`continued` verdict **已在 master** `DispatchVerdict`/`CandidateVerdict`（`model-operation-record.ts:246/250`：`"committed"|"discarded"|"failed"|"cancelled"|"continued"`），且是 **named type**（`request.ts:691` `settleGenerationAttempt(verdict: DispatchVerdict)` 从 model-operation-record import，非内联字面量联合——改一处定义即传播）。`coordinator.runContinuation`（`coordinator.ts:143-154`：结算 parent 后建 continuation candidate）也在 master。故本 spec 的 post-success 触发**直接复用既有 `continued` 语义 + `runContinuation`**，无「接口再变需同步复核」的悬置。**唯一新增**：把触发从 cut 路径（`driver.ts:1401`）扩到成功终止路径（terminal drain 前截获，§5.3）——这是本 spec 的承重实现工作，非接口变更。

### 5.2 分型判定点

分型判定依据 = **terminal 时刻最后一个块的类型 + 是否闭合**。判定树须**穷尽**（每条终止形态都有归属，无 fall-through）：

| 最后块 | 是否闭合（有 `content_block_stop`） | 分型 | 动作 |
|---|---|---|---|
| text | 闭合 | **A** | 可续写（已闭合合法前缀） |
| text | **未闭合**（悬挂） | **A'** | **须核实的角落**：Anthropic 在 max_tokens 时是否总先发 `content_block_stop` 再 `message_delta`？实测 5 例中唯一 A 类样本 `_44` 是闭合的（n=1，**不足以当协议不变量**）。若上游可能留悬挂 text → 按 ledger 铁律丢弃 partial → 前缀退化为「上一个已闭合块」，等同 A（可能丢一小段未闭合文本，诚实标注）。**列为门 A 附带核实项**。 |
| tool_use | 未闭合（悬挂） | **B** | 默认透传（§3.2） |
| tool_use | 闭合 | **B-closed** | **正常 client turn boundary、不续写**（对齐 master 已固化 ADR D3：完整 interactive tool_use 是合法回合边界——客户端须执行工具并带 `tool_result` 返回，proxy 不能越过它续生成）。转发 `tool_use` + 真实 max_tokens 终止形态，交客户端接续。master `driver.ts:1423` 的 `!hasCompleteInteractiveToolUse(ledger.snapshot())` 门本就拦此情形。若未来要支持 server_tool_use / 非交互工具续写，须按工具类型另立分型 + PoC + 显式 ADR 修订，**不复用 A 类**。 |
| thinking | 任意 | **C** | 默认透传（§3.3）；master extractor 已从 ledger 排除 thinking（不可作续写前缀，ADR D3） |

**C 类判据优先级（消歧，审查建议）**：以**「最后块 == thinking」为唯一判据**，不用「thinking_tokens ≈ output_tokens」比例判据。理由：比例判据在「已 commit 可见 text + 其后 thinking 截断」场景会**误判为 A**（text 消耗了 token、thinking 占比被稀释、达不到「≈ output_tokens」阈值），而该场景**最后块是被截断的 thinking → 正确分型是 C**（thinking 无法干净续写、ADR D3，保守走 passthrough 安全）。即「最后块 kind」判据对此场景给出正确的 C、比例判据给错的 A。thinking_tokens 占比仅作 telemetry **辅助**维度、不参与分型。（P0 实现已按此判据落 C，reviewer 实测 thinking→thinking 一致。）

判定须在**独立 per-format terminal observer** 上做（记最后 wire 块 kind + 是否闭合 + thinking，§11 P0——**不是** continuation ledger：后者丢 thinking + 只记已闭合 committed 块，无法判 A'/B/C），不重解析 wire。per-format 分型判定（CC/Responses 无 content_block 概念，靠 finish_reason=length + 累积块类型推断，§7）。**混合块序列**（text→tool_use、多 tool_use 链）归「最后块」所属分型。**CC tool_calls 尾随约束不适用（master FINDINGS G5a PASS 已证伪）**：`exp/continuation-shape/FINDINGS.md` G5a 实测 GHC 接受 `assistant{tool_calls}` 直接接 user（无 tool role）、返回正常 completion 非 400——OpenAI 标准的 tool_calls 尾随约束在 GHC 上不成立，故 CC 续写不撞该 hazard、无需 partial-degrade fallback（推翻续写 spec §4.3 CC 行旧约束）。G4 PASS 亦证 CC 并行 tool_call index 严格串行（块边界判据成立，§7）。

### 5.3 transparent-stitch wire 机制 + terminal ownership matrix（承重；审查 major）

`visibility:transparent` 缝合的 wire 层关键：**首轮的成功终止符必须被抑制**（不转发给客户端），保持流 open，续写轮的块以 §3.1 index 续编接续，最终以**续写轮的真实终止符**（`end_turn`/`tool_use`/或藏不掉时的 `max_tokens`）收尾。

**⚠️ terminator 抑制 ≠ commit boundary（审查 major，纠正上版过简）**：master pipeline 里 commit boundary、upstream 终止检测、client-facing terminal emission 是**不同层、不同时点**的概念，不能折叠成一个机制。例如 Anthropic `codec/anthropic/commit-boundaries.ts` **只把 `content_block_stop`/`error` 当 commit boundary、明确排除 `message_stop`**（后者留在 terminal drain，`driver.ts:1327-1358`）；CC 的 `message_delta` 被 `anthropic-to-cc-stream.ts` 当场翻译成 finish chunk、而 `[DONE]` 由 handler 另处补写；Responses 不同 leg 的 `response.completed/.incomplete` 产出点各异。故 transparent 分支须在**各自的 terminal emission 层之前**截获，改 `commitBoundaries` 不足以完成。

**交付物：terminal ownership matrix（plan 首要产出）**——每个 `(inbound format × outbound client format × direct/translate/fallback/WS) leg` 一格，明确四件事：① upstream completion 信号在哪层被 accumulator 记录；② client-visible terminator 由哪个 codec/translator/handler 构造；③ transparent 分支在该构造**之前**在哪层截获；④ continuation 最终 completion 时**谁且只谁**发唯一终局。无此矩阵，CC/Responses/WS 的 wire 拦截点无法唯一确定（P3 不能只靠 per-format PoC）。

**⚠️ 截获层的前提：Anthropic 必须走 buffered（承重决策，2026-07-27 用户裁决 + 设计审查 blocker）**——设计审查实测发现：`handler-v4.ts:1105-1113` 的 `buffered` **只由** `state.protectStreamingGeneration`（默认 `false`）决定，`max_tokens_continuation.enabled` 不参与；且 ledger 喂养（`driver.ts:1279/1300`）与续写触发（`:1412`）**全在 `runResponseBufferedSink` 内**，live 路径 `runResponseSink`（:912-988）两者皆无。故只开本特性开关时，Anthropic 走 live → **截获点永不可达、特性静默失效**。

**裁决（用户 2026-07-27）**：本项目**基于块级 buffered 工作与设计、完全放弃流式**。故解法**不是**「需要缝合时才有条件强切 buffered」的条件耦合补丁（那会制造配置交互复杂度 + 把 live 留成二等半死路径 + 两套截获语义），而是**完成姊妹 spec §6.3 早已定下的默认翻转**：Anthropic `protect_streaming_generation` → **块级默认 on**（姊妹 `plan-4-7-remaining.md:75` 已列待办、卡在 G1+G2 门未执行）。翻转后 buffered 是**真实前提**，本特性截获点自然可达、零条件耦合、零双轨。

**前置门（承重因果链，勿藏）**：翻转卡在 **G2（>300s 静默的 client↔proxy keepalive）**，见 `docs/todo/2026-07-22-client-proxy-keepalive-300s.md`。该门最新实测已**翻转裁决**：first-party 路径上空 `text_delta` 与空 `thinking_delta` **都能**重置 CC 300s 死线，但**经代理**路径 302s stall 且报文不同（`Response stalled mid-stream` vs CC 的 `no chunks received`）→ 强烈提示掐断源是**代理自身的上游 stall 检测**而非 CC 死线，且**可能是现网回归**。在「全面 buffered」前提下，长静默（opus 长 thinking 数百秒）正是要害场景，故 G2 是本特性 Anthropic 落地的**前置**，非可选细节。

**Responses HTTP 的截获点是另一层（设计审查 major）**：Responses 的 `isResponsesCommitBoundary` **把 `response.completed/failed/incomplete` 三个 lifecycle terminal 也当 commit boundary**（`codec/openai-responses/commit-boundaries.ts:5-24`），故 `response.incomplete` 会在 `driver.ts:1240` 的 boundary 分支**提前 flush 给客户端**，等到 `:1336` terminal drain 再截获**已经太晚**（客户端已收合法终局，再写续写帧 = 双终局、破坏 transparent-stitch 契约）。修法二选一（plan 期定）：① 把 max_tokens terminal 判定放到 boundary flush **之前**（accumulator 已更新、frame 未写 sink 处）；② max-tokens 模式生效时，Responses commit predicate **只提交中间 item boundary**、把 lifecycle terminal 留给 terminal drain。须配 producer oracle：断言第二轮 dispatch 前 sink **从未**收到首轮 `response.incomplete`。**WS 因故意不传 `commitBoundaries`，`:1336` 对其 terminal-only 路径仍成立**——HTTP 与 WS 不可写成同一结论。

- **抑制点（Anthropic direct，P1 主目标）**：terminal drain（`driver.ts:1327-1358`）写客户端**前**插入截获——检测 `sawMessageStop()` + 终止 `stop_reason==max_tokens` + 分型可续 + 预算未耗 → 不 flush 首轮 `message_delta{max_tokens}`+`message_stop`、转触发续写轮 append 同一 sink（§5.1）。这是**新增的成功终止截获**，master 现有 continuation（`driver.ts:1401-1453`）只处理无终止符的 cut，**不能拿它的 append 测试当成功路径 wire 正确性证明**。前提是上面的 buffered 翻转（否则该分支不可达）。
- **藏不掉的兜底**：续到 `max_rounds` 仍 `max_tokens`、或分型/visibility 不续写 → 该轮 terminator **正常转发**（无续写轮可接、无可藏之物）。
- **多轮 usage 缝合语义（审查建议）**：Anthropic `message_delta.usage.output_tokens` 是累积语义；抑制首轮 message_delta 后，客户端可见流须保持 usage **单调递增**、末轮 message_delta 报**各轮真实总和**（§4；门 D 验 `output_tokens > max_tokens` SDK 不抛错 + 单调性）。marker 策略下 marker 文本计入。
- **后端忠实**：被抑制的首轮 terminator **仍完整写入 history**（§9 `perRoundStopReason`）——抑制只对客户端 wire。

---

## 6. 独立预算模型（G5）

**为何独立**：每轮 max_tokens 续写是**满上下文重发**（实测 cache_read 30 万+ token/轮）。与续写 spec §5.2「首块前透明重试 + 首块后续写共享 `max_retries`」不同——那些是同一 exchange 内的抖动重试；max_tokens 续写是**成功后主动加轮**，成本模型和触发语义都不同。

```yaml
max_tokens_continuation:            # 新顶层 vendor 中立段
  enabled: false                    # 总开关（opt-in，默认不改既有 max_tokens 透传行为）
  max_rounds: 1                     # 续写轮数上限（默认 1；每轮满上下文极贵，保守）
  classes:                          # 分型分档策略（用户裁决：多策略可配置）
    text: "continue"                # A 类：continue（续写）| passthrough
    tool_use: "passthrough"         # B 类：passthrough（默认）| continue（仅 server_tool_use/非交互工具，须 PoC 门 B + ADR 修订；完整 interactive tool_use 恒不续，ADR D3）
    thinking: "passthrough"         # C 类：passthrough（默认）| retry_with_budget（门 C PASS 后；无 "continue"——thinking 被 ledger 排除、不可作前缀，ADR D3）
  message: "Please continue where you left off."   # 合成 user 轮内容，可配置
  visibility: "transparent"         # transparent（默认，能藏则藏）| passthrough（永不缝合）| marker（缝合+可辨识标记）
  thinking_retry_budget: null       # C 类 retry_with_budget 抬到的 max_tokens（null=模型 cap；仅 thinking:retry_with_budget 生效）
```
per-vendor 可覆盖 `<vendor>.max_tokens_continuation.*`；解析优先级 per-vendor > 共享 > 内置默认。配置哲学独立（记忆 `config-philosophy-separate`）：键改名留旧别名、热重载绝不因配置杀进程。

**visibility × class 组合矩阵（承重；审查 major——协议约束、非自由组合）**：同一 SSE 流的自动续写要求「不把首轮终止符转给客户端」；而 `passthrough` 定义就是「始终透传终止符」——一旦 `message_stop`/`[DONE]`/`response.incomplete` 转出，流已合法终止、**不能**在同连接续写。故：

| visibility | `classes.*:"continue"/"retry_with_budget"` | 语义 |
|---|---|---|
| `transparent` / `marker` | 允许 | 同流续写（transparent 抑制终止符 / marker 抑制 + 注标记） |
| `passthrough` | **不启动续写**、如实透传终止符 | 配置解析须**显式拒绝或降级**该组合，并在 history/telemetry 记 `strategy-prevented-stitch`——**绝不静默吞掉** `continue` 设置（诚实配置语义） |

（`passthrough` 下若要「续写结果旁路提供」需另定真实 side-channel API，非本 spec 目标。）

**默认全关（`enabled:false`）**：不 opt-in 时**零行为变更、max_tokens 逐字节透传**（对齐续写 spec 的 disabled 字节等价精神）。

---

## 7. per-format terminal 检测（G6）

max_tokens 在各格式 wire 上形态不同，续传触发须 per-format 识别（映射已存在，本 spec 只是**读**它们判触发）：

| 格式 | terminal 信号 | 已存在映射 |
|---|---|---|
| Anthropic `/v1/messages` | `message_delta.delta.stop_reason=="max_tokens"` | 原生 |
| Chat Completions | `choices[].finish_reason=="length"` | `cc-to-anthropic-stream.ts` `length→max_tokens`（反向 `anthropic-to-cc.ts`） |
| Responses HTTP/WS | `status=="incomplete"` + `incomplete_details.reason=="max_output_tokens"` | `anthropic-to-responses.ts`（映射所在段）/ `responses-to-anthropic.ts:311` |

（注：上述行号指向映射所在段/JSDoc，可执行 case 就近——如 `anthropic-to-responses.ts` 的实际 case 在 :201；plan 期以真实 case 行为准。）

**per-format 分型判定的角落**：CC/Responses 无 Anthropic 的 `content_block_start/stop` 悬挂概念，B 类「悬挂 tool_use」判定须靠各格式的累积器状态（CC `stream-accumulator.ts` toolCallMap；Responses `output_item.done` 缺失）。**列为计划期 per-format 核实项**。

---

## 8. 各端点接入与边界

- **Anthropic**：三分型 §3 + 触发 §5 + builder（复用续写 spec Anthropic builder）。
- **Chat Completions**：`finish_reason=length` 触发；A 类续写复用续写 spec CC builder；B 类默认透传（CC **无** tool_calls 尾随约束——master FINDINGS G5a 已证伪，§5.2；B 类透传理由是发散 hazard、非尾随约束）。
- **Responses HTTP/WS**：`incomplete+max_output_tokens` 触发；A 类复用 Responses builder；WS 续写重派上游轮的传输时序（续写 spec §7 WS 门）叠加。
- **Gemini**：排除，透传（N1）。
- **8.4 非流式**（N2）：首版不做。非流式 max_tokens 同样常见（`max_non_streaming_output_tokens=16000` 更低、更易撞），但走 `runResponseWhole`、不经流式续写循环——独立第二挂载点，列 backlog。
- **8.5 abort/cancel**：续写进行中客户端断连 → 丢弃续写、不写已关闭 sink（沿用续写 spec §3.3 / persistence-async-invariants never-throw）。

---

## 9. 可观测性（承重——后端忠实 + 分型 + 双计费必须可见）

**总纲（用户强调 2026-07-23）**：无论客户端 visibility 策略如何（即便 `transparent` 藏掉了 max_tokens），**后端记录一律忠实**——history/telemetry 反映真实内部发生的一切，与「客户端看到什么」解耦。缝合隐藏是**呈现层**行为、不回写记录层。

- **history `pipelineInfo.maxTokensContinuation`**：`{ truncationClass: "text"|"tool_use"|"thinking", roundsAttempted, roundsSucceeded, continuedTokens, perRoundStopReason: [...], clientVisibleStopReason, suppressedMaxTokens: boolean, visibilityMode }`。**`perRoundStopReason` 忠实记每轮真实终止**（含被抑制的首轮 `max_tokens`）、`clientVisibleStopReason` 记客户端实际看到的（缝合后 `end_turn`），两者**并存**以显式区分「真实 vs 客户端可见」。落 `pipelineInfo` 唯一诊断通道（记忆 `plan-verify-interface-location`）。
- **每轮续写 = 新 attempt**（沿用续写 spec §4.4）：`attempts[]` 完整记录合成轮 upstreamRequest（打 `synthetic:"continuation"`）+ ledger 快照引用 + upstreamResponse（含首轮真实 `max_tokens` 终止 + usage）。**上游原始轨绝不含合成物**。
- **telemetry 维度**（`telemetry-architecture`「不可重算因子拆最细」）：
  - **分型 counter**：`max_tokens_truncation{class=text|tool_use|thinking}`——即便 `enabled:false` 也应记录（诊断价值：C 类零产出烧满预算的频率）。
  - **续写 counter**：`max_tokens_continuation{class, outcome=succeeded|exhausted|degraded}` + `continuedTokens` sum（**双计费可见性**——多烧的 token 独立成维，不混入正常 usage）。
- **`/api/hooks`**：若续写走 hook 挂载点，暴露 builtin hook 可见性（沿用重复截断 spec §9）。

**C 类零产出是独立高价值观测**——即便不实现任何续写，仅 §9 的分型 counter 就能回答「有多少预算烧在思考却零答案」，值得**先行落地**（P0）。

---

## 10. 测试策略

- **单元**：分型判定器（A/B/C，含悬挂 tool_use 识别、thinking-only 识别）；per-format terminal 检测（Anthropic max_tokens / CC length / Responses incomplete+max_output_tokens）；A 类 continuation builder 组装（复用续写 spec 测试资产）。
- **客户端 oracle**（wire 正确性不自洽，skill `client-proxy-e2e-testing`）：`@anthropic-ai/sdk` / `openai` SDK 消费 transparent 缝合流（首轮 max_tokens terminator 被抑制 + 续写块重编号），断客户端**只看到干净 `end_turn`、无 max_tokens、累积连续无重复无协议破坏**；`passthrough`/`marker` 策略各自断言。
- **后端忠实 oracle（用户强调）**：独立断言 history `perRoundStopReason` 含被抑制的首轮 `max_tokens`、`clientVisibleStopReason=end_turn`、attempts[] 含合成轮 + 真实 usage 总和——即「客户端藏掉 ≠ 后端藏掉」（skill `verifying-authoritative-claims`：后端记录用独立 oracle、不靠客户端 wire 自证）。
- **e2e（mock upstream，skill `upstream-hook-mocking`）**：造「A 类 text 撞 max_tokens」→ 断代理发续写请求（含合成轮）→ mock 续写响应 → 客户端拿完整拼接 + marker。造 B 类悬挂 tool_use → 断**默认透传**（不续）。造 C 类 thinking-only → 断透传 + telemetry 记 class=thinking。
- **golden 字节等价**：`enabled:false` 时四格式 max_tokens 透传逐字节等价（disabled = 零变更）。
- **真相域按 skill `choosing-test-type` 归位**：wire 正确性用 producer oracle；分型判定纯函数走 unit；双计费用 telemetry 断言。
- **flaky/时序**：续写触发依赖 terminal 检测时点，FakeClock + 持 ReadableStream controller 精确控帧；连跑 10–25 次证确定性（skill `empirical-verification`）。

---

## 11. Sequencing（依赖与落地顺序）

**底座已 landed master（2026-07-23 复核纠正——原 spec 误称「仅在分支、master 尚无」被实测证伪）**：续写 spec 的 committed-blocks-ledger + extractor + continuation-builder + `continued` verdict + `runContinuation` **全部已合并入 master**（`git grep committedBlocksLedger master -- src/` 命中 `driver.ts`/`types.ts`/`handler-v4.ts`；`.worktrees/continuation-retry/` 已移除）。**根因**：起草时（会话早期）该基建确在分支、`grep` 确零命中；期间并发会话把续写工作 landed 到 master + 移除 worktree，ground truth 在我脚下变了——教训是**并发仓库里，修订期须 re-verify landed state，不复用早期 grep 快照**（记忆 `verify-running-server-has-fix-before-diagnosing` / `remerge-stale-feature-across-subsystem-rewrite`）。故：

- **P0（识别 + 观测层，可独立先行）**：分型判定器 + per-format terminal 检测 + §9 分型 telemetry counter（`class=text|tool_use|thinking`）+ history `truncationClass`/`perRoundStopReason`/`clientVisibleStopReason` 字段。**纯识别、零续写、零行为变更**——立即产出 C 类零产出可见性价值。**分型数据源须新建独立 terminal observer，不能复用 continuation ledger（审查 blocker 纠正）**：master `committed-blocks-ledger.ts` 的 `CanonicalBlock` 仅 `text|tool_use`、**丢弃 thinking**（extractor `committed-block-extractor.ts:54-60`）、且只记**已闭合 committed** 块——分型需要的「最后 wire 块的 kind + 是否闭合 + thinking」它一概没有，拿 `ledger.snapshot()` 末项判分型会把「text 后 thinking 截断」误判为 text→可能违反 ADR D3。故 P0 须建**独立轻量 per-format terminal observer**（记最后 wire 块 kind / 是否收到 `content_block_stop` / 是否有可 replay committed prefix；CC/Responses 记 tool-call/output-item 的打开与完成状态），在 candidate-session `onRenderedFrame` / 原始 accumulator 旁更新、保留原始 wire 顺序、单测覆盖 A'/zero-delta B/B-closed/thinking-after-text 反例。**continuation ledger 只继续承担「可回放已提交前缀」职责**（续写时用），与分型 observer 分工。**P0 须接真实 terminal 调用点**（正常 terminal 时 `recordMaxTokensTruncation`，非仅加类型槽位）——否则「enabled:false 也记分型 counter」无生产路径、验收不成立（审查 major）。
- **P1（依赖已满足）**：A 类续写触发分支——**成功终止截获**（§5.3，terminal drain 前）+ 复用已 landed 的 `continuation.buildRequest`/`runContinuation`/`continued` verdict + visibility 契约（§4，**默认 transparent**）+ 独立预算（§6）。默认 `enabled:false` → 字节等价。**唯一新增实现**：成功路径 terminal 截获（master 现有 continuation 仅覆盖 cut 路径，§5.3）。**visibility×class 非法组合校验须随 P1 首次消费落地**（passthrough+continue 在同流会写「已终止流后继续」的协议错误），不可延到 P2（审查 major）。
- **P2（PoC 门后）**：B 类（门 B PASS 后、仅非交互工具 + ADR 修订）/ C 类 `retry_with_budget`（门 C PASS 后）分档启用。
- **P3（须先出 §5.3 terminal ownership matrix）**：CC / Responses / WS 接入——各自的 terminator 拦截点由矩阵唯一确定，配 producer/client oracle；不能只靠 per-format PoC。

依赖已满足，无「续写底座不在 master」的阻塞。

---

## 12. 计划期 PoC 门（均 mock/真实上游可跑，非阻塞本 spec）

1. **门 A（低风险，复用续写 spec §10 已 PASS）**：text-only 前缀续写——GHC 从 text 前缀干净续写。续写 spec 已双模型实证，本 spec 直接继承，仅补「A 类 max_tokens 场景」端到端一发。
2. **门 B（高风险，早跑）**：丢弃 partial tool_use → 合成轮续写 → 断模型是否忠实产出**语义等价**的完整工具调用（vs 发散成不同工具/input）。**先验风险高**。FAIL → B 类永久透传。（注：G3 已证「完整 tool_use 前缀被接受」，门 B 测的是 partial 丢弃后的**发散**，两者不同。）
3. **门 C（高风险，早跑）**：C 类策略验证——(b) retry-with-raised-budget 是否真能在更高预算下产出答案（而非再次烧满 thinking）；thinking round-trip 签名安全（参考 skill `ghc-anthropic-upstream`）。FAIL → C 类仅 (a) 识别+透传。
4. **门 D（客户端缝合接受性）**：`transparent` 缝合流（首轮 terminator 抑制 + 续写块重编号，最终 `end_turn`）被 `@anthropic-ai/sdk` / `openai` / 真 Claude CLI 正确接受（不 stall、不破协议、`output_tokens > max_tokens` 不抛错）；`marker` 策略帧亦然。
5. **门 E（per-format 分型）**：CC toolCallMap / Responses output_item 状态能否可靠判 B 类悬挂（§7 角落）。

任一门 FAIL → 该分型/格式回退透传，不牺牲其余（沿用续写 spec「主/备/兜底之一通过即保默认可交付」）。

---

## 13. 未决问题（进 plan 前须闭合）

- **~~Q1 客户端可见性契约~~ 已裁决（2026-07-23，§4）**：默认 `transparent`（能藏则藏、藏不掉透传），支持多策略可配置（transparent/passthrough/marker）。用户不在乎双计费/下游预算。**透明只对客户端；后端 history/telemetry 忠实完整**（§9）。
- **~~Q2 C 类策略~~ 已裁决（2026-07-23，§3.3/§6）**：多策略可配置（`passthrough` 默认 / `retry_with_budget` opt-in 抬预算），非二选一。无 `continue`（thinking 被 ledger 排除、不可作前缀，ADR D3）。
- **Q3 默认档（已定初始默认、观测后可调）**：§6 `classes` 默认 `text:"continue", tool_use:"passthrough", thinking:"passthrough"`、`visibility:"transparent"`、`max_rounds:1`——A 类续、B/C 透传。这些是**已裁决的初始默认值**（非阻塞 plan 的未决项），未来通过观测再调整。
- **Q4 max_rounds 多轮语义（计划期技术项）**：A 类续写后可能再撞 max_tokens → 是否需多轮 vs 成本爆炸（每轮满上下文）。默认 1，plan 期定多轮时的预算/usage 累积语义。
- **Q5 三方合并态交互**（审查 major：原只画两方）：一个 exchange 可能**三套 client-egress 机制叠加**——① 续写 spec 的**错误续写**（mid-stream CANCEL 续回）+ 顺序 anchor 的**运行时递增 index offset**（续写 spec §3.3，本身未闭合承重项）；② 本 spec 的 **max_tokens post-success 续写**（块 index 连续递增跨 attempt）；③ 重复截断 spec 的**有状态 client.outbound**（下沉到 `delivery/session.ts`、eager-forward `content_block_start` + 块内缓冲折叠）。三者同 exchange 时的 **index 账**（三层重编号来源）、**挂载层次**（本 spec 续写缝合在哪层 vs repetition 折叠在 delivery 层的相对次序）、**预算/attempt 账**均须画清。计划期须出三方叠加时序图 + 显式声明相对次序与 index 归属，否则撞集成缝（记忆 `cross-phase-integration-seam-only-caught-at-merged-state`）。

---

## 14. 风险登记

- R1 客户端可见性（已裁决 transparent）→ §4；风险转为「后端记录须保持忠实、抑制只作用客户端 wire」（§5.3/§9），R1' = 缝合抑制误伤后端记录 → §9 `perRoundStopReason` 忠实 + 独立 oracle 断后端记录含真实 max_tokens。
- R2 B 类续写发散（重建不同工具）→ §3.2 默认透传 + 门 B。
- R3 C 类 thinking round-trip 签名 400（历史雷区）→ §3.3 默认透传 + 门 C 早跑。
- R4 成本爆炸（每轮满上下文 30 万+ token）→ §6 独立预算 max_rounds 保守默认 1。
- R5 缝合破协议（客户端 stall）→ §10 客户端 oracle + 门 D。
- R6 底座依赖（**已 landed master、依赖满足**）→ §11；残留风险 R6' = 修订期未 re-verify landed state 致陈旧（本轮已犯并修正）→ 复审前 re-grep master。
- R7 `enabled:false` 非零变更 → §10 golden 字节等价 invariant。

---

## 15. 术语

- **A/B/C 分型**：按 max_tokens 截断位置——A=text（已闭合可续）、B=tool_use input（悬挂非法）、C=thinking-only（0 答案）。
- **post-success 分支**：成功路径（`message_stop` 已到）上的续写触发，区别于续写 spec 的错误 throw 路径 `committedAny` 门。
- **visibility 契约**：续写缝合的客户端可见性策略（`transparent`/`passthrough`/`marker`，§4/§6）。
- **retry-with-budget**：C 类专属——**重发**（非续写，因 thinking 不可续）并抬高本次 upstream max_tokens。

---

## 16. 审查采纳记录

两轮**异模型对抗审查**（GPT-souls reviewer + Claude opus reviewer，独立并行收敛）。判据轴：长远正确 + 完整（非 ROI/YAGNI）。两份报告：`2026-07-22-max-tokens-continuation-review-gpt.md` / `-review-claude-a.md`。**两 reviewer 强收敛**（`ln` 虚构 + settle-freeze 张力两项独立同时命中）。

> **注（chronological record）**：本节是**第一轮**采纳记录，其中部分前提（committed-blocks-ledger「master 尚无」、旧行号 `driver.ts:1283/1233/1255`）**已被 §16.1 第二轮复审据实推翻纠正**（底座已 landed master、行号刷新）——以 §16.1 + 正文为准，本节保留作过程记录。

**采纳（全部主要发现）**：
- **[两 reviewer BLOCKER/major 收敛] `ln` 变量虚构** → 全文改回 `committedAny`（`driver.ts:1283` 已亲手 grep 核实，master 与分支一致；根因=起草时误用 `rg -r ln` 替换 flag 把 `committedAny` 显示成 `ln`）。删「已核实重命名」伪叙事。
- **[两 reviewer major 收敛] §5.1 post-success settle-freeze 张力被降格** → 从「计划期核实项」升为**承重架构设计项**，补 settle/finalize 时序契约（推迟 settle vs 已 settle 补记）。
- **[Claude major] §5.2 分型判定树未闭合分支** → 改为穷尽判定表，补 A'（未闭合 text 终止）+ B-closed + 零-delta tool_use 退化子情形；C 类改「最后块==thinking」唯一判据、消歧 thinking_tokens 比例误标。
- **[Claude major] Q5 只画两方** → 扩为三方（+ 重复截断 spec 的 delivery 层有状态 client.outbound），补 index/挂载层次/预算三层账 + 计划期时序图要求。
- **[GPT major] §11 P0「无依赖」与 §5.2 ledger 依赖自相矛盾** → committed-blocks-ledger master 尚无（已核实），P0 二选一（倾向 (a) 自建轻量累积器），不被续写 spec 合并进度绑架。
- **[GPT major] §5.1「复用同结论」掩盖续写 spec 接口仍 in-flight** → 明确依赖是 `continued` verdict **接口形状**（plan-2b、`request.ts:690-693`），非二元 landed。
- **[GPT major，独立核实推翻] §3.2 B 类第 3 点引用姊妹 spec「未验证」已过时** → 亲自核对分支 `exp/continuation-shape/FINDINGS.md` 确认 **G3 PASS**（完整 tool_use 前缀被 GHC 接受），更正引用；**保留「G3 通过 ≠ B 类已解决」区分**（B 类是发散 hazard、非前缀接受 hazard）。
- **[GPT 建议] §4 `usage.output_tokens` 缝合流呈现策略** → 补入 §4 末 + Q1（倾向报真实总和 + 门 D 验 SDK 不抛错）。
- **[Claude 建议] marker 污染下游对话上下文** → 补入 Q1 额外裁决维度（marker 走注释/元数据 vs 正文）。
- **[Claude 建议] per-format 锚点指向 JSDoc** → §7 加注「映射所在段、可执行 case 就近、plan 期以真实 case 行为准」。

**独立核实纠偏（`verifying-authoritative-claims`）**：GPT reviewer 引用的 `HANDOFF.md §3 G3 PASS` 在 master 的 `docs/plan/` **不存在**（HANDOFF.md 仅在分支 worktree）。未直接采信，亲自 `ls`/`grep` 分支 worktree 的 `exp/continuation-shape/FINDINGS.md` 确认 G3 确 PASS 后才更正 §3.2——避免拿一份未核实的引用改 spec。

**未采纳**：无（方向性发现全采纳；纯排期建议转入 §11 phasing）。

---

### 16.1 第二轮复审采纳记录（2026-07-23，用户裁决后 + 修订版）

同两 reviewer resume 复审修订版（报告 `-rereview-gpt.md` / `-rereview-claude.md`）。**两轮上轮发现确认良好消化**；核心设计（三分型、transparent-stitch 默认 + 后端忠实双轨、独立预算、PoC 门）**两 reviewer 均认可**。新发现全部采纳（均为「对齐已成 master 事实 + 修正过时前提」，非结构重做）：

- **[两 reviewer 收敛，Claude 定为 blocker] 续写底座已 landed master、spec「仅在分支/master 尚无」被证伪**——又一处「已核实 grep」与实测相反（同 `ln` 模式）。**根因不同**：`ln` 是我误用 `rg -r` 替换 flag；本次是**并发会话在起草后把续写工作 landed 到 master + 移除 worktree、ground truth 在脚下变了**，我复用了早期 grep 快照。已亲手 `git grep committedBlocksLedger master` + 读 `driver.ts:1412` 据实重写 §11/§1.3/§5.1/R6：底座已 landed、P0 直接复用 ledger（无需自建）、P1 依赖满足；删所有 `.worktrees/continuation-retry/` 失效路径。**教训**：并发仓库修订期须 re-verify landed state。
- **[两 reviewer 收敛] §5.2 B-closed「可续」+ §6 `thinking:"continue"` 撞 master 已固化 ADR D3** → B-closed 改「完整 interactive tool_use 是正常 client turn boundary、不续写」（对齐 `driver.ts:1423` `!hasCompleteInteractiveToolUse` 门）；删 thinking `continue`（extractor 已从 ledger 排除 thinking，`driver.ts:1434`）。
- **[Claude major] CC tool_calls 尾随约束已被 master FINDINGS G5a 证伪未吸收** → §5.2/§8 吸收 G5a（GHC 无该约束、CC 续写不撞 hazard）+ G4（CC index 串行已证）。
- **[GPT major] §6 `visibility:passthrough` × 同流续写协议不可兼容** → 补 visibility×class 组合矩阵：`passthrough` 时续写**不启动**、显式拒绝/降级该组合、记 `strategy-prevented-stitch`，绝不静默吞 `continue`。
- **[GPT major] §5.3 把 terminator 抑制等同 commit boundary 与架构不符** → §5.3 升为 **terminal ownership matrix**（每 `(inbound×outbound×leg)` 一格、四要素）+ 明确「成功终止截获是新增实现」（master continuation 仅覆盖 cut 路径 `driver.ts:1401`）。
- **[Claude major] §5.1 `continued` verdict 依赖前提过时** → 更新：已 landed named type（`model-operation-record.ts:246/250`）、非 in-flight 内联联合；直接复用。
- **[两 reviewer minor/建议] 陈旧清理** → 删重复 Q4；§11 P1「默认 marker」→ transparent；§15 P1/P2/P3 → transparent/passthrough/marker；行号刷新（`driver.ts:1283`→`:1366`、ledger `:1233/:1255`→`:1279/:1300`）；Q3/Q4 明确为「已定初始默认、观测后调」；§4/§5.3 补多轮 usage 单调/总和语义。

**两轮 verdict**：修订闭合上述后**可进 plan 阶段**（Q1/Q2 用户已裁决、无需重开）。plan 首要产出 = §5.3 terminal ownership matrix；P0 识别观测 + Anthropic direct transparent A 类可作前两阶段。

**仍开放（须用户裁决，非审查新增）**：~~§13 Q1（客户端可见性契约）+ Q2（C 类策略）~~ **已于 2026-07-23 裁决**（见下）。

**用户裁决记录（2026-07-23）**：
- **Q1 客户端可见性 → transparent 默认**：能藏就藏、藏不掉才透传；用户不在乎双重计费、下游预算约束当前不被客户端强制、proxy 无义务确保其完美。支持多策略可配置（transparent/passthrough/marker），默认 transparent。→ §4 从「承重伦理未决」改为已裁决决策；放弃原「倾向 P2 marker」。
- **关键约束（用户强调）：透明只对客户端；本程序内部 history/telemetry/日志一律忠实完整**——缝合隐藏是呈现层行为、不回写记录层。→ §9 补 `perRoundStopReason`（记真实每轮终止含被藏的 max_tokens）+ `clientVisibleStopReason` 并存；对齐 ADR `richest-data-flow`（后端完整、前端选择性呈现）。
- **Q2 C 类 → 多策略可配置**：`passthrough`（默认）/ `retry_with_budget`（opt-in 抬预算，N3 铁律相应放宽为可配置）。非二选一。无 `continue`（thinking 不可作续写前缀，ADR D3）。
- **doc-sync 待办（landing 时）**：本决策触及「proxy 不为维护 client 预算契约负责」，属决策级——landing 时新建/更新 ADR（`docs/decisions/`），可挂靠既有 `2026-07-05-internal-tool-security-posture` + `2026-07-05-richest-data-flow`。

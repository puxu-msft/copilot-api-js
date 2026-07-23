# Spec: `max_tokens` 续传（max-tokens continuation）

> 状态：**草案（brainstorming + 实测取证产出，两轮异模型对抗审查已消化，待用户过目）**
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

续写 spec 的重试门在 `src/lib/pipeline/driver.ts:1283` 的 `committedAny`：`const retryable = (thrown ? classifyStreamError(thrown)==="other" : true) && !committedAny`（已 grep 核实变量名，master 与 feat/continuation-retry 分支一致）——**仅错误 throw 路径**。`max_tokens` 是**成功路径**：`message_stop` 已干净到达、无 throw、driver 正常收尾。故 max_tokens 续写**不是放宽一个布尔门**，而是**成功路径上一条全新的 post-success 续写分支**（§5）。

**为何仍复用续写 spec 机制**：`feat/continuation-retry` 分支已在 `driver.ts:1233` 铺好 committed-blocks-ledger 喂养 + `driver.ts:1255` committed settle 点记录 + per-format continuation-request-builder + 合成 continuation 轮（GHC 拒 assistant-prefill 的绕过，已双模型 PoC 实证）。A 类续写 = 复用这套底座 + 换触发点。**故本 spec 依赖续写 spec 先 landed**（§11 sequencing）。

---

## 2. 目标与非目标

**目标：**
- G1 **A 类（text 截断）proxy 侧自动续写**：复用续写 spec §4 机制，成功路径新触发分支，把预算截断的 text 续到自然终止（`end_turn`/`tool_use`）。
- G2 **B 类（tool_use 截断）安全兜底 + PoC 门**：默认**不自动续、如实透传 max_tokens**；PoC 验证「悬挂 tool_use 前缀续写能否忠实重建同一工具调用」通过后再评估纳入。
- G3 **C 类（thinking-only、0 答案）识别 + 兜底策略**：默认如实透传；探索「提高预算重试」而非「续写」的正确解，PoC 门定夺。
- G4 **客户端可见性契约定清**（承重决策，§4）：续写会把 `max_tokens` 信号从缝合流里藏掉——是否/如何让客户端仍能观测「预算被突破」。
- G5 **独立预算模型**（§6）：每轮续写是满上下文（实测 cache_read 30 万+ token、极贵），不与首块前透明重试共享预算旋钮。
- G6 覆盖 Anthropic `/v1/messages` + Chat Completions + Responses（HTTP/WS），per-format terminal 检测（§7）。
- G7 vendor 中立配置 + 可观测性（history + telemetry）。

**非目标：**
- N1 **不含 Gemini**（结构不兼容，沿用续写 spec §7.4 / 本项目多处 Gemini 排除；保持透传）。
- N2 不保护非流式路径（首版；见 §8.4）。
- N3 **不静默替客户端抬 `max_tokens` 请求预算**——客户端自设 32000（模型允许 64000）是主动选择，proxy 不擅改请求体的 max_tokens 字段（§4.3 例外：C 类 retry-with-budget 仅在 opt-in + 显式标注下探索）。
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
3. **前缀接受性已验证、发散风险仍在（更正过时引用）**：续写 spec 正文 §10 曾标「已 commit 完整 tool_use 块作前缀**未验证**」，但其分支 PoC 门 **G3 已 PASS**（`.worktrees/continuation-retry/exp/continuation-shape/FINDINGS.md`：GHC 接受「完整 tool_use 块作 assistant 前缀 + user 续写轮」、返回正常 text+tool_use、无 400）。**但 G3 验证的是「完整未截断 tool_use 块作前缀被接受」，≠ B 类场景**——B 类的 partial tool_use 被**丢弃**、前缀退化为其前的已闭合块（多为 text 或完整 tool_use），故 G3 只消除了「前缀不被接受」这一 hazard，**发散 hazard（第 2 点）仍在、仍需门 B**。
4. **客户端本就正确处理**：agent 客户端（Claude Code）拿到 `stop_reason=max_tokens` + 截断的 tool_use，本就被设计来重试 / 追加 max_tokens。

**PoC 门 B（§9-2）通过后**可评估的形状：丢弃 partial tool_use → 合成轮请模型「继续」→ 断言模型是否忠实产出**语义等价**的完整工具调用（而非发散）。门 FAIL → B 类永久兜底透传（不牺牲 A 类）。

### 3.3 C 类（截断在 thinking、0 可用答案）—— 最贵最不可靠，retry-with-budget 探索

**特征**：`output_tokens=32000` 几乎全是 `thinking_tokens`（实测 31998/31999），可见答案 = 0。客户端烧满预算、拿到**零产出**。这是**最痛的**（钱花了、啥也没有），但：

- **thinking 无法干净回喂**：被打断的 thinking 带签名、且模型在续写轮会**重新思考**（发散，不接续）。合成「已 commit thinking 块 + continue」既有签名风险（参考 skill `ghc-anthropic-upstream` thinking signature quarantine）又语义不接续。
- **正确解可能是「提高预算重试」而非「续写」**：客户端设的 32000 < 模型 64000；C 类的真问题是**预算不足以容纳 thinking + 答案**。但 **N3 铁律**：proxy 不静默抬客户端请求预算。

**C 类候选策略（PoC 门 C，§9-3 定夺其一）**：
- (a) **纯识别 + 透传**（默认兜底）：如实透传，靠 telemetry/history 让 C 类可见（诊断价值：谁在烧满预算思考却零产出）。
- (b) **opt-in retry-with-raised-budget**：显式开关下，对 C 类**重发**（非续写——因 thinking 不可续）并抬高本次 upstream 的 max_tokens（≤ 模型 cap），合成物打标记、telemetry 记「预算突破」。**须客户端可见性契约（§4）覆盖**——不能静默双计费。
- (c) 拒绝介入：C 类交客户端。

**倾向 (a) 默认 + (b) opt-in**，最终 PoC 门定。**先验风险高**——thinking round-trip 是本项目历史雷区（多个 400 incident），C 类续写不应临实施才测。

---

## 4. 承重决策：客户端可见性契约（G4）

**问题**：续写把内部多轮缝合成**一条连续流**，客户端最终看到的 `stop_reason` 是续写完成后的 `end_turn`/`tool_use`——**`max_tokens` 信号被彻底藏掉**。客户端明确设了 `max_tokens=32000`、期望「最多 32000 token」，proxy 静默交付更多 → **未经同意的双重（多重）计费 + 违反客户端显式预算约束**。这与本项目「no silent behavior change」直接张力。

**候选（spec 阶段须定或列为首要未决问题 Q1）**：
- **(P1) 透明缝合**：客户端完全不知发生了续写，看到一条超预算的完整流。**最不诚实**，违 N3 精神。
- **(P2) 缝合 + 可辨识 marker**：续写块前注入可见 marker（如 `\n\n(budget exceeded; continued)`），并在 history/telemetry 记录真实轮数/总 token。客户端看到完整答案**且**知道预算被突破。**倾向此项**（对齐 richest-data-flow「合成物必打可辨识标记」+ 诚实）。
- **(P3) 不缝合、保留 max_tokens、旁路提供续写**：如实透传 `max_tokens`，把续写结果放 side channel（history / 响应头），客户端自选是否取用。最诚实但对现有客户端**无自动收益**（等于不续）。

**注**：此决策**独立于分型**——A/B/C 若续写都撞同一可见性问题。且与「双重计费」耦合：续写多烧的 token 记谁账、telemetry 如何拆（§9）。**这是本 spec 最承重的价值/伦理取舍，不可藏在实现里。**

**响应体 `usage.output_tokens` 呈现策略（审查建议，须与 Q1 一并定）**：P2 缝合流下最终 `message_delta.usage.output_tokens` 该报什么？——(i) 各轮之和（诚实反映总消耗，但可能 > 客户端 `max_tokens`、下游可能误判为「超预算异常」）；(ii) 只报末轮（隐藏总量、与 telemetry 双计费维度不一致）。**倾向 (i) 报真实总和 + marker 显式说明**（richest-data-flow：末端拿到真数据自行判断），但须验证主流客户端 SDK 不因 `output_tokens > max_tokens` 抛错（门 D 附带）。marker 文本本身也是 `output_tokens` 的一部分、须计入。

---

## 5. 触发机制：成功路径新分支（承重，非布尔门放宽）

### 5.1 与 `committedAny` 错误门正交

`src/lib/pipeline/driver.ts:1283` 的 `committedAny` 门（`retryable = … && !committedAny`）在**错误 throw 路径**。max_tokens 无 throw、走**成功收尾**。故须**新增 post-success 分支**：

- **触发条件**：成功终止 + terminal `stop_reason==max_tokens`（per-format 检测，§7）+ 分型 ∈ 已启用档（§3）+ 续写预算未耗（§6）+ `max_tokens_continuation.enabled`。
- **append 非 replay**（沿用续写 spec §5.1）：已提交块已不在 buffer；新构造合成轮 env 跑**新 exchange**，输出帧接到**同一个已在推进的 sink**、index 从已 commit 块数续编。
- **与 generation/coordinator 语义 + settle/finalize 时序契约（承重架构项，非核实项；审查 major）**：max_tokens 走成功路径，**success 已在 settle 点冻结 history entry 快照**（skill `persistence-async-invariants` §2、记忆 `settle 冻结 history entry`），coordinator 已 `whenModelOperationFinalized`。post-success 再启新 exchange 接同一 sink 会撞两处硬约束：(a) **finalize race**（记忆 `V3 direct-driver async finalize race`——getEntry 撞异步 finalize，须 `await whenModelOperationFinalized`）；(b) **已冻结记录能否追加 attempts[]**。故本 spec 必须**在实现前**定清「settle/finalize 与 post-success 续写的时序契约」：要么把 settle **推迟**到续写循环真正终止（`end_turn`/预算耗尽）之后（则续写期 entry 保持 open、attempts[] 可追加），要么定义「已 settle entry 的续写补记」协议。这与续写 spec §5.1 把 `committedAny` 门升为承重 driver 状态机分支**对等**——本 spec 是其 **success 侧变体**，同等承重，不降格。

**依赖的是接口形状、非二元「是否 landed」（审查 major）**：续写 spec 的续写/hedged-candidate 兼容结论**仍在迭代**——其 `docs/plan/.../plan-2b-continuation-executor.md` 显示需新增第 5 个 `DispatchVerdict`/`CandidateVerdict` 值 `"continued"`，且类型传播（`src/lib/context/request.ts:690-693` `settleGenerationAttempt` 内联字面量联合、多处调用点）是其 reviewer 对抗审才补漏发现的真实挡编译点。故本 spec 对续写 spec 的依赖**不是「landed 与否」一个布尔**，而是 `continued` verdict 的**具体接口形状**——若该接口在计划落地前再变，本 spec 的 post-success 触发点设计须同步复核。计划期须比照续写 spec plan-2b 的显式类型改动清单处理 success 侧触发。

### 5.2 分型判定点

分型判定依据 = **terminal 时刻最后一个块的类型 + 是否闭合**。判定树须**穷尽**（每条终止形态都有归属，无 fall-through）：

| 最后块 | 是否闭合（有 `content_block_stop`） | 分型 | 动作 |
|---|---|---|---|
| text | 闭合 | **A** | 可续写（已闭合合法前缀） |
| text | **未闭合**（悬挂） | **A'** | **须核实的角落**：Anthropic 在 max_tokens 时是否总先发 `content_block_stop` 再 `message_delta`？实测 5 例中唯一 A 类样本 `_44` 是闭合的（n=1，**不足以当协议不变量**）。若上游可能留悬挂 text → 按 ledger 铁律丢弃 partial → 前缀退化为「上一个已闭合块」，等同 A（可能丢一小段未闭合文本，诚实标注）。**列为门 A 附带核实项**。 |
| tool_use | 未闭合（悬挂） | **B** | 默认透传（§3.2） |
| tool_use | 闭合 | **B-closed** | 罕见（闭合工具后立即撞预算）；等同 A 语义可续，但受续写 spec「完整 tool_use 块作前缀」未验证门约束（§3.2） |
| thinking | 任意 | **C** | 默认透传（§3.3） |

**C 类判据优先级（消歧，审查建议）**：以**「最后块 == thinking」为唯一判据**，不用「thinking_tokens ≈ output_tokens」——后者在「已 commit 可见 text + 其后 thinking 截断」时会误标（该场景有可见答案、应归 A' 而非 C）。thinking_tokens 占比仅作 telemetry **辅助**维度、不参与分型。

判定须在 commit-boundary 累积器 / ledger 上做（已知块结构），不重解析 wire。per-format 分型判定（CC/Responses 无 content_block 概念，靠 finish_reason=length + 累积块类型推断，§7）。**混合块序列**（text→tool_use、多 tool_use 链）归「最后块」所属分型——多 tool_use 链非首个被截断的 CC 尾随约束叠加续写 spec §4.3，默认透传。

---

## 6. 独立预算模型（G5）

**为何独立**：每轮 max_tokens 续写是**满上下文重发**（实测 cache_read 30 万+ token/轮）。与续写 spec §5.2「首块前透明重试 + 首块后续写共享 `max_retries`」不同——那些是同一 exchange 内的抖动重试；max_tokens 续写是**成功后主动加轮**，成本模型和触发语义都不同。

```yaml
max_tokens_continuation:            # 新顶层 vendor 中立段
  enabled: false                    # 总开关（opt-in，默认不改既有 max_tokens 透传行为）
  max_rounds: 1                     # 续写轮数上限（默认 1；每轮满上下文极贵，保守）
  classes:                          # 分型分档启用
    text: true                      # A 类（enabled 时默认可用）
    tool_use: false                 # B 类（PoC 门 B 前恒 false）
    thinking: false                 # C 类（PoC 门 C 前恒 false）
  message: "Please continue where you left off."   # 合成 user 轮内容，可配置
  visibility: "marker"              # P1 transparent | P2 marker | P3 sidecar（§4，默认 marker）
```
per-vendor 可覆盖 `<vendor>.max_tokens_continuation.*`；解析优先级 per-vendor > 共享 > 内置默认。配置哲学独立（记忆 `config-philosophy-separate`）：键改名留旧别名、热重载绝不因配置杀进程。

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
- **Chat Completions**：`finish_reason=length` 触发；A 类续写复用续写 spec CC builder；B 类 CC tool_calls 尾随约束（续写 spec §4.3）叠加本 spec B 类风险，默认透传。
- **Responses HTTP/WS**：`incomplete+max_output_tokens` 触发；A 类复用 Responses builder；WS 续写重派上游轮的传输时序（续写 spec §7 WS 门）叠加。
- **Gemini**：排除，透传（N1）。
- **8.4 非流式**（N2）：首版不做。非流式 max_tokens 同样常见（`max_non_streaming_output_tokens=16000` 更低、更易撞），但走 `runResponseWhole`、不经流式续写循环——独立第二挂载点，列 backlog。
- **8.5 abort/cancel**：续写进行中客户端断连 → 丢弃续写、不写已关闭 sink（沿用续写 spec §3.3 / persistence-async-invariants never-throw）。

---

## 9. 可观测性（承重——分型 + 双计费必须可见）

- **history `pipelineInfo.maxTokensContinuation`**：`{ truncationClass: "text"|"tool_use"|"thinking", roundsAttempted, roundsSucceeded, continuedTokens, finalStopReason, visibilityMode }`。落 `pipelineInfo` 唯一诊断通道（记忆 `plan-verify-interface-location`）。
- **每轮续写 = 新 attempt**（沿用续写 spec §4.4）：`attempts[]` 完整记录合成轮 upstreamRequest（打 `synthetic:"continuation"`）+ ledger 快照引用 + upstreamResponse。**上游原始轨绝不含合成物**。
- **telemetry 维度**（`telemetry-architecture`「不可重算因子拆最细」）：
  - **分型 counter**：`max_tokens_truncation{class=text|tool_use|thinking}`——即便 `enabled:false` 也应记录（诊断价值：C 类零产出烧满预算的频率）。
  - **续写 counter**：`max_tokens_continuation{class, outcome=succeeded|exhausted|degraded}` + `continuedTokens` sum（**双计费可见性**——多烧的 token 独立成维，不混入正常 usage）。
- **`/api/hooks`**：若续写走 hook 挂载点，暴露 builtin hook 可见性（沿用重复截断 spec §9）。

**C 类零产出是独立高价值观测**——即便不实现任何续写，仅 §9 的分型 counter 就能回答「有多少预算烧在思考却零答案」，值得**先行落地**（P0）。

---

## 10. 测试策略

- **单元**：分型判定器（A/B/C，含悬挂 tool_use 识别、thinking-only 识别）；per-format terminal 检测（Anthropic max_tokens / CC length / Responses incomplete+max_output_tokens）；A 类 continuation builder 组装（复用续写 spec 测试资产）。
- **客户端 oracle**（wire 正确性不自洽，skill `client-proxy-e2e-testing`）：`@anthropic-ai/sdk` / `openai` SDK 消费缝合流（已发块 + 续写块重编号），断累积连续、无重复、无协议破坏；断 visibility marker（P2）被 SDK 正确接受。
- **e2e（mock upstream，skill `upstream-hook-mocking`）**：造「A 类 text 撞 max_tokens」→ 断代理发续写请求（含合成轮）→ mock 续写响应 → 客户端拿完整拼接 + marker。造 B 类悬挂 tool_use → 断**默认透传**（不续）。造 C 类 thinking-only → 断透传 + telemetry 记 class=thinking。
- **golden 字节等价**：`enabled:false` 时四格式 max_tokens 透传逐字节等价（disabled = 零变更）。
- **真相域按 skill `choosing-test-type` 归位**：wire 正确性用 producer oracle；分型判定纯函数走 unit；双计费用 telemetry 断言。
- **flaky/时序**：续写触发依赖 terminal 检测时点，FakeClock + 持 ReadableStream controller 精确控帧；连跑 10–25 次证确定性（skill `empirical-verification`）。

---

## 11. Sequencing（依赖与落地顺序）

**硬依赖**：本 spec 的 A 类续写**复用续写 spec §4 的 committed-blocks-ledger + continuation-request-builder + 合成 continuation 轮**（`feat/continuation-retry` 分支已实现 P0+P1，`.worktrees/continuation-retry/…/driver.ts:1227` ledger 喂养——**该基建仅在分支、master 尚无**，已核实 `grep committedBlocksLedger src/` on master 零命中）。故：

- **P0（识别层，须解决累积器来源）**：分型判定器 + per-format terminal 检测 + §9 分型 telemetry counter（`class=text|tool_use|thinking`）+ history `truncationClass` 字段。**纯识别、零续写、零行为变更**。**⚠️ 内部一致性修正（审查 major）**：§5.2 称分型判定「在 commit-boundary 累积器 / ledger 上做」，而 committed-blocks-ledger **master 尚不存在**（仅在分支）。故 P0 的「无依赖」须二选一并在计划期拍板：**(a)** 分型判定不依赖续写 ledger——自建独立轻量累积器（读 codec 已有的 commit-boundary accumulator，Anthropic 端点也有），**风险：防止与未来续写 ledger 两套逻辑分叉**；**(b)** 承认 P0 的 Anthropic 分型判定间接依赖续写 ledger、只能 CC/Responses（各有独立累积器）先行。**倾向 (a)**——分型判定本就只需「最后块类型 + 是否闭合」，比续写 ledger（需 canonical 块快照）轻得多，用 codec accumulator 足够，且 C 类可见性价值不该被续写 spec 合并进度绑架。
- **P1（依赖续写 spec landed master）**：A 类续写触发分支（成功路径 post-success，§5）+ 复用 Anthropic builder + visibility 契约（§4，默认 marker）+ 独立预算（§6）。默认 `enabled:false` → 字节等价。
- **P2（PoC 门后）**：B 类（门 B PASS 后）/ C 类 retry-with-budget（门 C PASS 后）分档启用。
- **P3**：CC / Responses / WS 接入（各自叠加续写 spec 的 per-format 门）。

**若续写 spec 迟迟不合并**：P0 走 (a) 仍可独立交付（识别 + 观测），P1+ 阻塞——spec 显式记录此依赖，避免计划期撞「续写底座不在 master」。

---

## 12. 计划期 PoC 门（均 mock/真实上游可跑，非阻塞本 spec）

1. **门 A（低风险，复用续写 spec §10 已 PASS）**：text-only 前缀续写——GHC 从 text 前缀干净续写。续写 spec 已双模型实证，本 spec 直接继承，仅补「A 类 max_tokens 场景」端到端一发。
2. **门 B（高风险，早跑）**：丢弃 partial tool_use → 合成轮续写 → 断模型是否忠实产出**语义等价**的完整工具调用（vs 发散成不同工具/input）。**先验风险高**（续写 spec 已标 tool_use 前缀未验证）。FAIL → B 类永久透传。
3. **门 C（高风险，早跑）**：C 类策略验证——(b) retry-with-raised-budget 是否真能在更高预算下产出答案（而非再次烧满 thinking）；thinking round-trip 签名安全（参考 skill `ghc-anthropic-upstream`）。FAIL → C 类仅 (a) 识别+透传。
4. **门 D（客户端可见性）**：P2 marker 帧被 `@anthropic-ai/sdk` / `openai` / 真 Claude CLI 正确接受（不 stall、不破协议）。
5. **门 E（per-format 分型）**：CC toolCallMap / Responses output_item 状态能否可靠判 B 类悬挂（§7 角落）。

任一门 FAIL → 该分型/格式回退透传，不牺牲其余（沿用续写 spec「主/备/兜底之一通过即保默认可交付」）。

---

## 13. 未决问题（进 plan 前须闭合）

- **Q1（承重）客户端可见性契约**（§4）：P1 transparent / P2 marker / P3 sidecar 三选一 + 双计费记账方式 + `usage.output_tokens` 呈现（§4 末）。**本 spec 倾向 P2 marker**（诚实 + 有收益），但这是**用户价值/伦理取舍**，须用户裁决。**额外裁决维度（审查建议）**：marker 是**可见文本注入 text 块**，对 agent-loop 客户端（Claude Code）会随续写内容进入**下一轮对话历史、污染下游上下文**（与重复截断 spec §1.1「垃圾文本进对话历史」同类顾虑）。故 Q1 不只权衡「诚实 vs 收益」，还须权衡「marker 污染下游 context」——可能倾向「marker 走 SSE 注释/元数据而非正文 text_delta」或 P3 sidecar。
- **Q2 C 类策略**（§3.3）：(a) 纯透传 / (b) opt-in retry-with-budget / (c) 拒绝介入——门 C + 用户裁决。
- **Q3 默认启用范围**：`enabled` 默认 false 已定；但 opt-in 时 A 类是否默认 on、B/C 是否恒需显式开——§6 config `classes` 默认 `text:true, tool_use:false, thinking:false`，待确认。
- **Q4 max_rounds 默认**（§6）：1 轮是否够（A 类续写后可能再撞 max_tokens → 需多轮）vs 成本爆炸（每轮满上下文）。
- **Q5 三方合并态交互**（审查 major：原只画两方）：一个 exchange 可能**三套 client-egress 机制叠加**——① 续写 spec 的**错误续写**（mid-stream CANCEL 续回）+ 顺序 anchor 的**运行时递增 index offset**（续写 spec §3.3，本身未闭合承重项）；② 本 spec 的 **max_tokens post-success 续写**（块 index 连续递增跨 attempt）；③ 重复截断 spec 的**有状态 client.outbound**（下沉到 `delivery/session.ts`、eager-forward `content_block_start` + 块内缓冲折叠）。三者同 exchange 时的 **index 账**（三层重编号来源）、**挂载层次**（本 spec 续写缝合在哪层 vs repetition 折叠在 delivery 层的相对次序）、**预算/attempt 账**均须画清。计划期须出三方叠加时序图 + 显式声明相对次序与 index 归属，否则撞集成缝（记忆 `cross-phase-integration-seam-only-caught-at-merged-state`）。

---

## 14. 风险登记

- R1（承重）客户端可见性 / 双计费 → §4 Q1 契约 + §9 telemetry 双计费维度。
- R2 B 类续写发散（重建不同工具）→ §3.2 默认透传 + 门 B。
- R3 C 类 thinking round-trip 签名 400（历史雷区）→ §3.3 默认透传 + 门 C 早跑。
- R4 成本爆炸（每轮满上下文 30 万+ token）→ §6 独立预算 max_rounds 保守默认 1。
- R5 缝合破协议（客户端 stall）→ §10 客户端 oracle + 门 D。
- R6 依赖续写 spec 未合并 → §11 P0 走路线 (a) 自建轻量累积器可独立先行。
- R7 `enabled:false` 非零变更 → §10 golden 字节等价 invariant。

---

## 15. 术语

- **A/B/C 分型**：按 max_tokens 截断位置——A=text（已闭合可续）、B=tool_use input（悬挂非法）、C=thinking-only（0 答案）。
- **post-success 分支**：成功路径（`message_stop` 已到）上的续写触发，区别于续写 spec 的错误 throw 路径 `committedAny` 门。
- **visibility 契约**：续写缝合后客户端能否观测「预算被突破」的决策（P1/P2/P3，§4）。
- **retry-with-budget**：C 类专属——**重发**（非续写，因 thinking 不可续）并抬高本次 upstream max_tokens。

---

## 16. 审查采纳记录

两轮**异模型对抗审查**（GPT-souls reviewer + Claude opus reviewer，独立并行收敛）。判据轴：长远正确 + 完整（非 ROI/YAGNI）。两份报告：`2026-07-22-max-tokens-continuation-review-gpt.md` / `-review-claude-a.md`。**两 reviewer 强收敛**（`ln` 虚构 + settle-freeze 张力两项独立同时命中）。

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

**仍开放（须用户裁决，非审查新增）**：§13 Q1（客户端可见性契约）+ Q2（C 类策略）——两 reviewer 均确认这是 spec 自承的、进计划阶段前的用户裁决门。

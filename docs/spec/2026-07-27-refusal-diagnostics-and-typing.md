# Contentless refusal：抑制到客户端、忠实到后端

> 状态：**设计定稿**（2026-07-28），已经三轮 subagent（取证 / 架构讨论 / 对抗评审）+ 主会话逐条复核。
> 触发事故：`req_1785187727725_842`。
> 关联：[docs/refusal-recovery.md](../refusal-recovery.md)（现状契约，本 spec 落地后需改写）、skill `ghc-anthropic-upstream`、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)。

## 0. 目标（用户 2026-07-28 裁定）

> 「下游处理得很烂，我们的主要目的就是避免下游因此中断对话轮次，因此需要抑制此类响应。」

**首要目标：contentless refusal 绝不允许中断客户端的对话轮次。** 代理对客户端**抑制** refusal 形态——既不透传原生 `refusal`，也不发 `event: error`，而是合成一个正常完成的轮次。

**次要目标（不得与首要目标冲突）：后端忠实。** 上游的 `stop_details`（`category` / `explanation`）必须完整进入 History / TUI / 遥测，请求终态诚实记为失败。这是 richest-data-flow 的标准分工：**后端存储完整、客户端呈现按需**。

## 1. 事故取证与样本总体（一手实测）

三个已恢复的真实 refusal 样本（取证详情 [exp/refusal-samples/FINDINGS.md](../../exp/refusal-samples/FINDINGS.md)，主会话独立复核其中 2 条）：

| id | 日期 | model | `stop_details.category` | content blocks | usage |
|---|---|---|---|---|---|
| `req_1782214935133_68` | 06-23 | opus-4-8 | `null` | 1 个 thinking（signature 3112 字符有效） | `output_tokens:1097`，**无** `output_tokens_details` |
| `req_1783947618475_731` | 07-13 | opus-4-8 | `"bio"` | 1 个 thinking | `output_tokens:25848`，`thinking_tokens:25636` |
| `req_1785187727725_842` | 07-27 | opus-5 | `"cyber"` | **零个** | `output_tokens:1`，`thinking_tokens:0` |

三条共同点：**全部无 `text`/`tool_use`**（现有门控 `stop_reason==="refusal" && !sawRealContent` 覆盖全部已观测形态）。`explanation` 三条中有两条是完全相同的零信息量样板句，只有 `cyber` 那条带真实信息。

**被证伪、已从设计中删除的断言**（原草案曾把它们写成事实）：

- ~~「带 category 的 refusal 多在推理前拦截」~~ —— `bio` 样本烧了 25,636 thinking token 才拒绝。
- ~~「重发相同内容必再被拒」~~ —— 三个样本都没做过重放实验。
- ~~「`category` 缺失 vs 存在是可重试性分型」~~ —— 真实形态是 `category: null`（键在值为 null），且无任何证据表明两者可重试性不同。

## 2. 为什么「抑制」是对的（客户端行为实测）

Claude Code 2.1.207 打包源码逐行核实（`~/.claude/refs/claude-code-2.1.207/app.pretty.js`）：

| 客户端收到什么 | CC 的行为 | 对话轮次 |
|---|---|---|
| 原生 `refusal`（透传） | `BTt()` 渲染 refusal 消息（`:170302`，流式 `:298342` 读 `delta.stop_details`、非流式 `:298061`），`yield {type:"refusal_no_fallback"}` | **中断** |
| `event: error` | Anthropic SDK 抛 `APIError`、流内错误零重试 | **中断** |
| `end_turn` + **非空** text | 正常完成轮，agent loop 继续（`num_turns=1`） | **不中断** ✅ |
| `end_turn` + **空** text | 实测 CC 空转再发一轮、`result=""`（`exp/cli-e2e-stall/FINDINGS.md`） | 中断（「继续」循环） |

结论：**只有「`end_turn` + 非空合成文本」能达成首要目标**。故：

- **D-1：默认 `anthropic.refusal_sse_rewrite` 从 `error` 改为 `end_turn`。** `error` 与 `refusal` 保留为显式可选模式（用户想要诚实报错时可切）。
- **D-1a：抑制模式下合成文本不得为空。** 空串仍是合法配置值（零包装契约不变），但默认非空，且文档必须写明空串会让 CC 空转。

## 3. 未采纳方案（record-not-adopted）

### 3.1 原生 refusal 透传 + failed verdict（架构讨论员 ADR-B）

**未采纳，理由：用户 2026-07-28 明确裁定下游对 refusal 的处理很烂、首要目标是不中断轮次。** 该提案的论据（CC 有 category 感知的原生渲染、有客户端自动 fallback）经主会话逐行核实**属实**：CC 对 `category==="cyber"` 有专门文案与 Cyber Verification Program 入口，且 `stop_reason==="refusal"` 且备有 `refusalFallbackModel` 时会 `yield {type:"fallback_request", trigger:"refusal"}` 自动换模型重发（`app.pretty.js:298050-298063`）。但这些路径的终点仍是**结束当前轮**（`refusal_no_fallback`）或**依赖用户已配置 fallback 模型**，不满足首要目标。

### 3.2 代理侧自动 fallback 重试（换模型重发）

**本轮不做，转 backlog。** 上游 `explanation` 样板句自己建议的正是这条（"configuring a fallback model"），CC 也内建了它。它比合成文本更接近「轮次不中断且真的产出内容」。但用户上一轮在范围选择中选了 B 档（不含自动重试），本轮裁定聚焦「抑制」。→ 记入 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)，含本 spec 的取证与 CC 源码位置。

### 3.3 按 category 分型的模式旋钮（原草案 §2.3 的 3 个新 config 键）

**未采纳。** 取证证明分型的**语义**前提不成立（见 §1 被证伪断言），两位评审独立判定为把未验证分类固化成公共配置契约。category 只作**诊断维度**与**模板变量**，不驱动模式分叉。

## 4. 设计

### 4.1 命名与概念（D-2）

- `isThinkingOnlyRefusal` → **`isContentlessRefusal`**（语义不变：`refusal` 且无 client-visible `text`/`tool_use`）。覆盖全部三个已观测样本形态。
- 日志 / `ctx.fail` 的 Error 文案 / 客户端默认文案里**一律删除**「thinking-only」「仅思考块」的措辞。
- **不引入** `policy | empty` 之类隐含机制的 kind 类型。

### 4.2 `stop_details` 无损存储 + 归一化视图分离（D-3）

对抗评审 [HIGH] 采纳：**容错解析不得成为有损持久化边界。**

- **持久层**：accumulator / `ResponseData` / History 存**完整 raw `stop_details`**（原样对象，未来上游加 `recommended_model` 等字段自动跟随）。
- **决策/展示层**：另建归一化视图，保留 provenance 区分：

| 真实形态 | 归一化 | 语义 |
|---|---|---|
| `{category:"cyber",...}` | `category: "cyber"` | 上游命名类别 |
| `{category:null,...}` | `category: null` | 上游明确「未映射到命名类别」 |
| `stop_details` 缺失 / 为 `null` | `category: undefined` | 旧协议形态或上游未给 |
| `category` 非 string | `category: undefined` + `invalid` 标记 | 畸形上游 |

判据一律是「`category` 是**非空 string**」，绝不是「字段是否存在」。

### 4.3 thinking tokens：未知就是未知（D-4）

对抗评审 [BLOCKER] 采纳，**实证支撑**：`bio` 样本只有一个 thinking 块，但 `output_tokens=25848` 而 `thinking_tokens=25636`，差 212 —— **「content 只有 thinking」推不出「output 全是 thinking」**。旧 `null` 样本更是完全没有 `output_tokens_details`。

- `thinkingTokens: number | undefined` —— **仅当** `usage.output_tokens_details.thinking_tokens` 是有限非负数时赋值，**绝不回落 `output_tokens`**。
- `{output_tokens}` 作为独立占位符保留。
- 模板占位符 `{thinking_tokens}` 在未知时渲染为字面 `unknown`（文档明写），不填总 output。

### 4.4 策略按请求冻结（D-5）

对抗评审 [BLOCKER] 采纳，主会话已复核：改写层在 [response-processor.ts:71](../../src/lib/pipeline/stream/response-processor.ts#L71) 构造时读 `state`，handler 在流结束时读 **live** `state`（[handler-v4.ts:1407](../../src/routes/messages/handler-v4.ts#L1407)），而 [handler-v4.ts:384](../../src/routes/messages/handler-v4.ts#L384) 每个带 `system` 的请求都会 `applyConfigToState()` —— 并发请求可在长流中途改写全局配置，使两层判反。

- 在请求配置确定后**只解析一次**，生成不可变的 request-scoped 快照，挂 `ctx`；改写层、非流式 `transformWhole`、handler 终态分支**全部读同一快照**。
- buffered retry / continuation 的新 candidate **继承**该快照，不得每个 attempt 重读全局 state。

### 4.5 exactly-one-terminal 状态机（D-6，**默认路径，必修**）

对抗评审 [BLOCKER] 采纳，主会话已对着代码复核这是**既有缺陷**：`end_turn` 模式在 refusal delta 当场发合成 text + `message_delta(end_turn)`；若上游随后 clean EOF **无 `message_stop`**，handler 会跳过 refusal 分支、落进 [handler-v4.ts:1463](../../src/routes/messages/handler-v4.ts#L1463) 的截断分支再补一个 `event: error` —— 客户端收到「完成 delta 后又报错、且始终无 `message_stop`」的畸形序列。

**默认改成 `end_turn` 后这条从罕见模式变成默认路径，必须在同一批修掉。**

显式状态转移表（每条输入流**恰好产生一个**客户端终态）：

| 状态 | 输入 | 动作 | 新状态 |
|---|---|---|---|
| `open` | 非终态帧 | 原样转发 | `open` |
| `open` | `message_delta`（非 contentless refusal） | 原样转发 | `open` |
| `open` | `message_delta`（contentless refusal） | 按模式发终态（抑制模式：合成 text 三帧 + 改写 `end_turn` delta） | `terminated` |
| `open` | EOF 无 `message_stop` | 现有截断分支（不变） | — |
| `terminated` | `message_stop` | 抑制模式转发；error 模式抑制 | `terminated` |
| `terminated` | 重复 `message_delta` | **抑制**（不重复合成） | `terminated` |
| `terminated` | 任何 content 帧 | **抑制**（malformed upstream，记诊断） | `terminated` |
| `terminated` | EOF 无 `message_stop` | handler **不得**再补第二个终态 | — |

最后一行是修 Blocker 4 的关键：handler 的截断分支必须先判「本流是否已由 refusal 抑制层产出终态」。用 request-scoped 快照上的 refusal 终态标记（不是重新读 `acc`）。

### 4.6 客户端合成文案（D-7）

- 默认文案携带 `{refusal_category}`（短、有区分度），**不带** `{refusal_explanation}`。理由采纳架构员的修正版（可证的**语义边界**，而非未证的「回灌会复触发分类器」）：`end_turn` 合成 text 是一条**成功 assistant 消息**、会被 CC baked 进后续对话历史，而 explanation 是上游诊断元数据、不是模型对用户任务的回答，写进去污染语义上下文。
- 「回灌 explanation 是否提高再次 refusal 概率」标注为**未验证假设**，不作为设计前提；如需裁决走受控重放 PoC。
- 用户模板仍可显式使用 `{refusal_explanation}`（零包装原则不变）。
- 占位符全集：`{model}` `{request_id}` `{thinking_tokens}` `{output_tokens}` `{refusal_category}` `{refusal_explanation}`。未知占位符原样保留。

### 4.7 终态 verdict：与 wire 解耦（D-8）

客户端拿到正常轮 ≠ 请求成功。沿用既有不变量「上游语义失败必记 `ctx.fail`、不谎报成功」：

- **客户端 wire**：抑制后的正常 `end_turn` 轮（首要目标）。
- **代理 verdict**：`failed`，failureReason 为结构化 refusal 摘要（含 category）。上游腿仍 `success:true`（上游确实完整返回了 200 refusal）—— 既有 `ctx.fail(..., {upstreamSucceeded:true})` 正是为此设计。
- 这是**行为变更**：现状 `end_turn` 模式记 complete。变更理由：抑制是**呈现策略**，不改变「上游拒绝了、本轮没有真实产出」这一事实。

## 5. 接线点（穷尽表，按 producer 而非「文件×次数」）

对抗评审 [HIGH] 采纳，原草案的「7 处」清单不完整：

| # | producer / 消费面 | 位置 |
|---|---|---|
| 1 | accumulator raw capture（新增 `stopDetails`） | `stream-accumulator.ts`（对齐既有 `appliedContextEdits` 先例） |
| 2 | streaming builder | `recording.ts` `buildAnthropicResponseData` |
| 3 | **non-streaming inline builder**（不经 #2） | `handler-v4.ts:937-950` |
| 4 | `ResponseData` | `context/types.ts` |
| 5 | **`PartialResponseInfo`**（`ctx.fail` 入参） | `context/types.ts:119-132` |
| 6 | `fail()` 两支手工重建 `_response` | `context/request.ts:1714-1734` |
| 7 | `abort()` 第三个重建点 | `context/request.ts` |
| 8 | `legFromUpstreamResponse` 显式投影 | `context/request.ts:159-180` |
| 9 | canonical `responseMetadata` 显式枚举 | `context/request.ts:764-780` |
| 10 | V3 projection metadata 类型 + 输出白名单 | `history/v3/projection.ts:214-226,318-336` |
| 11 | `HistoryUpstreamResponseData` / 公开 `UpstreamResponseData`（锁步双 owner） | `context/types.ts:267-286`、`history/types.ts:411-432` |
| 12 | TUI 完成行结构化 token（`refusal:cyber` / `refusal:uncategorized`） | `tui/render/lifecycle.ts:86-138`（失败行当前刻意不显示 stop reason，需专门加） |
| 13 | entry-view 派生器 + ui-v4 详情展示 | `history/entry-view.ts`、`ui-v4/.../MetaSegment.tsx`、`ResponseSegment.tsx` |
| 14 | config 全链（`refusal_sse_rewrite` 默认值变更） | `schema.ts`、`config.ts`、`state-defaults.ts`、`state.ts`（interface/patch Pick/init/reset）、`config.yaml`、生成物 `config.schema.json`（由 `.describe()` 生成、不可手改）、`config-hot-reload.it.test.ts` 完整性矩阵 |
| 15 | 遥测 `refusal_category` 维度（**capped** 非 bounded，上游是开放字符串） | `telemetry-dimensions.ts` |
| 16 | `recordFeature` detail `{category, disposition}`（不拼进 `FeatureKind` 枚举） | `observability/events.ts` |
| 17 | 跨协议翻译降级留痕（Anthropic→CC `content_filter` / →Responses `incomplete_details`，均丢 category） | `translate/anthropic-to-cc.ts:142-166`、`anthropic-to-responses.ts:180-212` |

**分阶段**：#1-#11 + #14 是本批必做（数据不落盘则后面全是空谈）；#12-#13、#15-#17 是消费面，可紧随其后单独成 commit，但**不得省略**（否则 D2 的目标不闭环——用户仍要去 raw SSE 挖诊断）。

## 6. 测试策略（防同源假绿）

对抗评审 [HIGH] 采纳——现有 golden **直接 import 生产常量 `DEFAULT_REFUSAL_END_TURN_TEXT` 作为 expected**（`response-rewrite-golden.http.test.ts:48-52`），生产文案和 expected 一起改时测试仍绿，**无裁决力**。

1. **expected 一律手写字面量**，禁止 import 被测生产常量。
2. **正向 mutation control**：临时改生产默认文案一个字，旧 golden 必须变红；不变红说明测试没咬住。
3. **三条真实样本字节**作为只读 fixture 输入（`category:null` / `bio` / `cyber`），expected 手写。
4. **状态机转移表逐格覆盖**：重复 refusal delta、refusal 后还有 content 帧、每种模式下缺 `message_stop`、EOF。
5. **exactly-one-terminal 不变量**：每条输入流断言客户端恰好收到一个终态。
6. **热重载缝**：流中途 `applyConfigToState()` 改配置、buffered retry attempt 间热重载 —— 断言 wire 与 verdict 不打架。
7. **真实 SDK oracle**：把 `cyber` 样本（零 content block）三帧原字节喂进完整 proxy，用真实 `@anthropic-ai/sdk` `.finalMessage()` 断言合成 text@index0 + `end_turn` 能正确累积。
8. **真实 CLI oracle（首要目标的唯一裁决者）**：用真 `claude` CLI 跑抑制后的轮次，断言 `num_turns=1`、不进「继续」循环 —— 这是「不中断对话轮次」这个目标本身的 oracle，不能靠状态机单测代替。
9. 投影测试覆盖每种 settle 形态：complete / proxy-introduced fail / 普通 fail / abort / 非流式。

## 7. 仍未验证（诚实标注，不作为设计前提）

1. explanation 回灌是否提高再次 refusal 概率 —— 无重放实验。
2. categorized / uncategorized 是否有稳定不同的重试成功率 —— 无重放实验。
3. 当前 CC 版本对「抑制后的 end_turn 轮」的真实 agent-loop 行为 —— 旧 e2e（`exp/cli-e2e-stall`）证明非空文本不 stall，但需用当前 CC 复验（测试策略 #8）。

---

## 8. 第三轮复审的 blocker（**未修，合并前必须解决**）

对抗评审员对本改稿的复审又报 3 条 blocker，**主会话已逐条核实成立**。它们推翻了 §4.4「request-scoped 快照」与 §4.5 状态机的部分实现选择：

### B-1 exactly-one-terminal ≠ exactly-one **complete** terminal

§4.5 要求「抑制层已产出终态时 handler 不得再补第二个终态」。但抑制层产出的是 `message_delta(end_turn)` —— 若上游随后 EOF 而**没有** `message_stop`，客户端就永远等不到协议终止符。评审用真实 `@anthropic-ai/sdk` 探针实测抛：

```
AnthropicError: stream ended without producing a Message with role=assistant
```

**修法**：该场景必须补一个**合成 `message_stop`**（打 synthetic 标记），而不是「什么都不做」。§4.5 转移表最后一行需改写为「补齐完整终止符」而非「不再补终态」。

### B-2 causal observation 会被 hedge candidate 污染（**已实现代码的正确性缺陷**）

`generationHedgeEnabled` **默认 `true`**（`src/lib/state-defaults.ts:148`，主会话已核实）。primary 与 hedge candidate **各有独立的 ResponseProcessor / rewriter**，但当前实现让它们写入**同一个 request 级** `ctx.refusalObservation` —— 落败 candidate 的 refusal 可以覆盖胜出 candidate 的正常结果，把一个成功请求错判成 refusal 失败。

**修法**：observation 必须是 **candidate/dispatch 作用域**，只有 winner 的 receipt 能驱动 handler settle。评审同时指出 causal observation 与 immutable policy snapshot **不是替代关系**：
- **policy snapshot**（request 级、不可变）保证同一请求的 primary / hedge / retry / continuation 用**同一策略**；
- **causal observation**（candidate 级）回答「winner 实际做了什么」。
两者都需要。§4.4 写成「用因果信号替代快照」是错的。

另：`terminalEmitted` 回调发生在 sink write 与 winner 选择**之前**，它实际只是 `terminalPlanned`，不能证明客户端已收到终态——命名与语义都要改。

### B-3 continuation 会清掉 observation

抑制合成的 `content_block_stop` 是 commit boundary；随后缺 `message_stop` 时可能进入 continuation 路径，而 `resetRepairOutcomesForAttempt()`（本次实现在其中一并清空了 observation）会把 refusal 判定抹掉 —— handler 随后既可能误记 complete，也可能再补 truncation error。

**修法**：contentless refusal 的抑制应成为 driver 认可的 **terminal boundary**，禁止偶然进入网络 continuation，并配合 B-1 补齐 `message_stop`。

### 其余需处理的发现

- **`failed` + `upstreamResponse.success=true` 会破坏既有聚合**：遥测按 upstream success 把该 `request.failed` 记成成功；History stats 会让同一请求**同时**递增 success 与 failure。§4.7 的解耦必须连带修聚合口径。
- **CLI oracle 不足**：当前只证明一次 `claude -p` 正常退出且不空转，**未**证明同一 session 的**后续用户轮**可继续 —— 而「不中断对话轮次」正是首要目标。需要**双轮 session oracle**。
- **默认值 oracle**：测试必须**省略** `refusal_sse_rewrite` 才能证明默认真的翻转；显式写 `end_turn` 的测试证明不了默认值。

## 9. 实施进度

| 项 | 状态 |
|---|---|
| 纯逻辑层（provenance 解析 / 诚实 thinking tokens / 改名 / 新占位符 / 去谎报默认文案） | ✅ 已实现，41 unit 通过 |
| 合并 rewriter + 三模式统一观测 | ⚠️ 已实现，但受 B-2 / B-3 影响，作用域错误 |
| handler 两分支改读因果信号 + verdict 解耦 | ⚠️ 同上 |
| 合成 `message_stop`（B-1） | ❌ 未做 |
| candidate 作用域 observation + policy snapshot（B-2） | ❌ 未做 |
| continuation terminal boundary（B-3） | ❌ 未做 |
| 默认翻成 `end_turn` + config 全链（§5 #14） | ❌ 未做 |
| `stop_details` 无损存储贯通（§5 #1-#11） | ❌ 未做 |
| 消费面（§5 #12-#17：TUI / UI / 遥测 / 翻译降级） | ❌ 未做 |
| 测试策略 §6（真实样本 fixture / mutation control / 双轮 CLI oracle） | ❌ 未做 |

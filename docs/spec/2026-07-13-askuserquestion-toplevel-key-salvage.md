# AskUserQuestion 顶层多余键抢救与剥离

> 状态：**landed**（2026-07-14；5-task TDD 实现 + spec/plan 各一轮对抗 subagent 审查，plan review 的 1 BLOCKER + 2 HIGH + 4 MED 全采纳）。骑既有 config 键 `anthropic.tool_backfill_question`（默认 true），**不新增 config 键**。落地为既有 AskUserQuestion 规范化腿（`src/lib/anthropic/decode-tool-input-core.ts` 的 `normalizeAskUserQuestionInput`）的能力扩展。姊妹 spec：[anthropic-malformed-tool-input-repair.md](anthropic-malformed-tool-input-repair.md)（字节级畸形修复）——本 spec 治**schema-shape 畸形**，机制与人群与它互补、不重叠。现状见 [DESIGN.md](../DESIGN.md)「活的架构现状」`backfillQuestionFromHeader` 行。

## 1. 问题（实测取证）

opus-4.8 偶发把 AskUserQuestion 的 tool_use input 发成**外层合法 JSON、但违反工具 schema 形状**的结构：把本应嵌在 `questions[0].question` 的问题文本**提到了顶层** `question` 键，同时 `questions[0]` 反而缺 `question`。触发案例 `req_1783955598578_439`：

```jsonc
{
  "questions": "[{\"header\":\"范围\",\"multiSelect\":false,\"options\":[…]}]",  // stringified，item 缺 question
  "question": "\\u8fd9\\u6b21\\u91cd\\u6784\\u7684\\u8303\\u56f4…"                    // 顶层多余键，双重转义的真问题文本
}
```

AskUserQuestion 工具 schema 是 `additionalProperties:false`，顶层只允许 `questions/answers/annotations/metadata`。代理逐字节转发这个形状后，客户端（Claude Code）报：

```
InputValidationError: AskUserQuestion failed due to the following issue: An unexpected parameter `question` was provided
```

**与姊妹 spec 的字节畸形本质不同**：这里外层 `JSON.parse` 通过、`questions` 内层经既有 jsonrepair 也能解回数组——现有 decode/repair 全链只负责「让字节能 parse」，**从不做 schema 校验**，故这一类完全没被覆盖，被静默转发、客户端拒收。

### 1.1 全人群量化（实测，`exp/askuserquestion-decode/toplevel_extrakey_scan.ts`）

扫描保留库全部 `upstream_response` blob 的 sseEvents，重建 AskUserQuestion input：161 条外层可解析的 input 里 **9 条带 schema 非法的顶层多余键，全部涉及顶层 `question`**（其中 `req_1783820512212_1614` 额外 hoist 了顶层 `header`/`multiSelect`），**9 条状态全 `completed`**——即代理静默转发、9 条全被客户端拒。考虑 reaper 对 completed 记录的激进回收，真实发生率只会更高。

9 例形态完全一致（`exp/askuserquestion-decode/shape_dump.ts` 亲验）：

- 顶层 `question` **都装着真实、完整的问题文本**（`_98/_572/_1049/_42/_432` 是干净中文；`_1614/_439/_459` 是双重转义 `\\uXXXX`、un-escape 后完美还原中文）；
- `questions` 内层解回长度 1 的数组，item[0] 有 `header/multiSelect/options` 但**缺 `question`**；
- `req_1783820512212_1614` 的顶层 `header`/`multiSelect` 是 item[0] 已有字段（header="推进方式"）的**冗余复制**。

**结论**：模型真实意图 = 顶层 `question` 就是这唯一问题的文本。既有的 `header` 回填会把问题写成 `"范围"`（**丢掉真实文本**），而顶层 `question` 才是最富的真相源——按 richest-data-flow / no-data-loss，正确修复应**抢救**顶层 `question` 进 item，而非简单剥离。

## 2. 设计（定向抢救 + 剥离）

**落点**：**新拆姊妹函数** `normalizeAskUserQuestionInput`（编排 salvage/backfill/strip 三步），不把三种语义塞进已被文档化为「header 回填」的 `backfillAskUserQuestionHeaders`——命名反映实际职责（项目 coding-conventions）。原 `backfillAskUserQuestionHeaders` 作为其中的「兜底 header 回填」步保留、单一职责与原引用返回约定不变。放在 `decode-tool-input-core.ts`，零依赖约束不变（re-export 进前端 bundle），un-escape 用手写、不引依赖。运行时机沿用现有：decode（stringified `questions` 解回数组）之后，流式 `finalize` + 非流式 `decodeToolInputBlocksInResponse` 两处已接线。gate 沿用 `state.backfillQuestionFromHeader`（config `tool_backfill_question`，默认 true）——同属「让 AskUserQuestion 对客户端合法」这一关切，**不新增 config 键**。

**前提声明（承重）**：salvage 与兜底 header 回填**均以 `questions` 已 decode 成数组为前提**。`decodeToolInputFields`（默认 `{AskUserQuestion:["questions"]}`）与 `backfillQuestionFromHeader` 是**两个独立 config 键**——若用户置 `tool_decode_input_fields: {}` 而留 `tool_backfill_question: true`，`questions` 仍是 stringified 字符串（`Array.isArray` false），salvage 与兜底**均跳过**。此降级路径下 strip 仍会剥掉顶层非法键——见 §2.1 第 3 点的**留痕规则**，保证降级也绝不静默丢文本。

### 2.1 规范化顺序（对 AskUserQuestion input，decode 后）

1. **Salvage（抢救顶层 `question`）**：当顶层存在 `question` 且为**非空** string：
   - `questions` 恰 1 个 item 且该 item **缺 `question`** → 把顶层 `question` 搬进 `item[0].question`；值含 `\uXXXX` 字面转义时 **un-escape 还原**（干净值原样通过，见 §2.2）。
   - `questions` **>1 item** → **打 WARN log，不 hoist**（归属歧义，无法确定配给哪个 item）。
   - 顶层 `question` 为**空串** → 不视作可救文本，直接留给兜底 header 回填（避免用 `""` 覆盖、阻断更有意义的 header 兜底）。
2. **兜底 header 回填（保留现有行为）**：salvage 未填上的 item（多 item、或无顶层 `question`、或 salvage 分支未命中）——对**缺 `question`** 且 `header` 非空的 item，仍用 `header` 回填。即现有 `backfillAskUserQuestionHeaders` 行为**不退化**。
3. **Strip（剥离 schema 非法顶层键）**：剥掉所有不在 `{questions, answers, annotations, metadata}` 的顶层键（`question`／hoist 的 `header`／`multiSelect` 等）。剥离在 salvage **之后**，保证抢救先读到顶层 `question` 再删。
   - **留痕规则（承重、no-data-loss）**：当 strip 将剥掉一个**装非空文本的顶层 `question`** 却**未能 salvage 进任何 item**时（0-item、`questions` 非数组、item 非 object 等退化形态，或 §2 声明的 questions-未-decode 降级路径）——必须（a）`consola.warn` 明示丢弃 + requestId，且（b）把被剥的 `question` **值**记进落盘诊断通道（§3），保证 history/日志留痕、绝不静默丢真相源。剥仍要剥（否则客户端拒收），但不许无声。

### 2.2 un-escape 的触发与边界

顶层 `question` 值在双重转义案例里是字面 `这次…`（外层 JSON.parse 后仍是含 `\u` 序列的普通字符串）。un-escape = 再做一次 JSON 字符串转义解码，把 `\uXXXX` 还原成对应字符。

- **仅在检测到字面 `\uXXXX` 转义时触发**（正则 `/\\u[0-9a-fA-F]{4}/`）；不含转义的干净中文问题文本（`_98` 等）**原样通过、绝不破坏**。
- 解码失败（无法作为合法 JSON 字符串解释）时**回落原值**，never-throw。
- 只解码 `\uXXXX`（及必要的标准 JSON 转义），不做任何结构性 repair——那是姊妹 spec 的字节修复域。

### 2.3 承重不变量

- **零扰动通过**：干净 AskUserQuestion（无非法顶层键、item 已有 `question`）返回**原引用**，转发字节逐字不变（沿用现有 `===` 引用检测 → 原始帧 replay）。
- **History 只改 forwarded wire**：上游原始字节写进 history 不动（沿用现有 record 分层，salvage/strip 只作用于转发流）。
- **兜底不退化**：现有 header 回填在 salvage 不适用时照常工作。
- **抢救优先于兜底**：单 item 场景，顶层 `question`（真文本）胜过 `header`（如 `"范围"`）。
- **降级不静默丢**：任何形态下 strip 剥掉非空顶层 `question` 而未 salvage，必走 §2.1 第 3 点留痕规则（WARN + 落盘记值）。

**已知局限（un-escape 是启发式）**：§2.2 的 un-escape 理论上会误伤**合法含 `\uXXXX` 4-hex 字面**的问题文本——例如模型问「应该用 `中` 还是直接写中文？」，问题文本本身含字面 `中`，正则命中、un-escape 把它错还原成「中」，破坏原意；此时 `JSON.parse` 成功、`never-throw` 兜不住（它只兜 parse 失败、**不兜语义误伤**）。真实人群目前无此形态。保留 §3 的 `unescaped:boolean` 遥测以便事后审计误伤率；若日后出现，再考虑更强判据（仅当 value 整体呈「多余一层 JSON.stringify」特征时才 un-escape）。此处先把断言改诚实：un-escape **不是**无误伤面的无损变换。

## 3. 可观测性

**落盘要求（承重）**：salvage/strip 的诊断必须**落 history**，供事后全人群取证（§1.1 立项依据）。**实测确证的持久化通道 = `PipelineInfo`**（经 `ctx` 的 pipelineInfo merge → `request.context_updated`(field:`pipelineInfo`) 事件 → history sink 的 in-flight `updateEntry({pipelineInfo})` 落 SQLite，就是 req_439 里那个带 `preprocessing`/`sanitization` 的字段）。

**不用**以下两个通道，二者实测都**不落 history**：① `recordFeature`（history sink 对 `request.feature_applied` 显式 `return` 丢弃，[history.ts:157](../../src/lib/observability/sinks/history.ts)）；② 既有畸形修复的 `recordRepairOutcome` → `flushToolInputRepairObservability`——实测它**只**做内存 counter（`/api/status`）+ `recordFeature` + consola log，**从不写 history `attempts`**（[tool-input-repair-stats.ts:65](../../src/lib/anthropic/tool-input-repair-stats.ts)）。故「对齐既有 repair 通道就能落盘」的直觉是**错的**——既有 repair 诊断本身就不落 history；本 spec 的 salvage 诊断改走真正落盘的 `PipelineInfo` merge。落地细节（新 `PipelineInfo` 字段 + `ctx` setter 须 publish `context_updated`，仿 `setStreamTimeouts`）交 plan，但**必须可从 history 审计**。

- salvage 命中：记 `pipelineInfo.askUserQuestionNormalization`（含 `salvaged`/`unescaped`，供审计 un-escape 误伤率 / 命中率）。
- 多 item WARN-only strip：记 `multiItemAmbiguous` + `consola.warn` 明确「顶层 question 归属歧义、只剥离未 hoist、requestId=…」；被剥的非空 question 值仍记 `droppedQuestionValue`（no-data-loss，多 item 也是丢真文本）。
- **strip 丢弃非空顶层 question（未 salvage）**：§2.1 第 3 点留痕规则——WARN + 落盘记 `droppedQuestionValue`（internal-tool 全量暴露、不脱敏）。
- 剥离非法顶层键：记 `strippedKeys`（诊断价值）。

## 4. 测试（TDD）

`decode-tool-input-core` 单元 + 两条 wire 路径（流式 `finalize` / 非流式 `decodeToolInputBlocksInResponse`）集成：

1. **单 item salvage — 干净**：顶层 `question`（干净中文）+ item 缺 question + 1 item → item.question = 顶层值，顶层键被剥，无 un-escape。
2. **单 item salvage — 双重转义**：顶层 `question` = `这…` → un-escape 还原中文进 item，顶层键剥。取真实样本 `req_1783955598578_439` 作 golden。
3. **多 item WARN-only**：顶层 `question` + questions 2 item → WARN log、不 hoist、顶层键仍剥、缺 question 的 item 走兜底 header 回填。
4. **冗余顶层 header/multiSelect 剥离**：`req_1783820512212_1614` 形态 → 顶层 header/multiSelect（item 已有）被剥，question 被 salvage。
5. **零扰动通过**：干净合法 AskUserQuestion（item 有 question、无非法顶层键）→ 返回原引用，字节不变。
6. **兜底不退化**：item 缺 question、无顶层 question、header 非空 → 仍 header 回填（现有测试保持绿）。
7. **un-escape 不误伤（含真实反斜杠）**：顶层 question 含真实反斜杠/无 `\u` → 原样。
8. **退化形态留痕不静默丢**：顶层 question（非空）+ 0-item / questions 非数组 / item 非 object → salvage 与兜底均不命中，strip 剥掉顶层 question 时断言留痕（WARN + 落盘记值），不静默丢。
9. **空串 salvage 让位兜底**：顶层 question="" + 单 item 缺 question + header 非空 → 不写空 question、走 header 兜底。
10. **un-escape 语义误伤固化断言**：问题文本合法含 `中` 字面 → 断言当前 un-escape 会误还原成「中」（作为**已知局限**的固化用例，防未来误判为 bug；见 §2.3）。
11. **非默认 config 降级**：`tool_decode_input_fields:{}` + `tool_backfill_question:true` + 顶层 question → questions 未 decode（仍 string），salvage/兜底跳过，strip 剥顶层 question 时走留痕规则。

## 5. 非目标（记 backlog，不在本 spec）

- **通用 schema 驱动顶层键剥离**（方案 C 的通用腿）：把每个工具 `input_schema` 穿进 rewrite、`additionalProperties:false` 时剥所有非 `properties` 顶层键，工具无关、防未来任意工具幻觉参数。additive、不阻塞、不制造错数据，故记 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md) 作追加增强。本 spec 只治 AskUserQuestion（唯一实测受累工具）。
  - **与本 spec 抢救逻辑不重叠、须并存**：通用腿是工具无关的**剥离**（只剥不救、无 tool-specific 语义），防未来任意工具的幻觉参数；本 spec 的「顶层 `question` → item」是 AskUserQuestion 专属**语义抢救**启发式。通用腿落地后本 spec 抢救逻辑仍须保留——一个防幻觉参数（剥）、一个治语义错位（救）。
- 字节级畸形修复：姊妹 spec [anthropic-malformed-tool-input-repair.md](anthropic-malformed-tool-input-repair.md) 已覆盖。

# Anthropic 上游对 assistant 消息内 thinking 布局的三条硬约束

日期：2026-07-26
状态：**已实施**（L1 修复 landed；L2 兜底 matcher 扩展 landed）
相关：[2026-07-07-thinking-signature-quarantine.md](2026-07-07-thinking-signature-quarantine.md)（三层架构 L1/L2/L3 的原始 spec）、skill `ghc-anthropic-upstream`

## 触发事故

两个连续请求以同一个 400 每轮必败（`req_1785016294183_896` / `req_1785016294884_897`，2026-07-26 21:51）：

```
HTTP 400: messages.27: The final block in an assistant message cannot be `thinking`.
```

`attemptCount = 1` —— 无任何重试兜底，400 直接透传给客户端。

**根因是我方自造**：客户端历史里 `messages[28]`（assistant）形如 `[thinking, thinking, tool_use]`（CC 把本应交替的 thinking 累积成相邻块 baked 进历史）。L1 de-stack 的 `move_blocks` 策略为满足「两个 thinking 不得相邻」，把唯一可用的非 thinking 块（`tool_use`）挪到两个 thinking 之间，产出 `[thinking, tool_use, thinking]` —— 消灭了 C1 违规，却制造了 C2 违规。

> 上游报的索引 `messages.27` 比我方数组索引 28 小 1（我方 payload 含 3 条内联 `role:"system"` 消息，上游对其中一条做了折叠）。**别按上游索引直接定位我方消息**——按形状（哪条 assistant 消息末块是 thinking）定位才可靠。

## 实测确立的约束（全部亲手实测，非文档推断）

方法：把生产 400 的 upstream payload 原样重放到隔离测试服务器（`XDG_DATA_HOME` 隔离 + `thinking_destack_strategy: passthrough` 保证我方不再改写），逐变体只改 `messages[28]` 的块排列，打真实 GHC 上游。探针：`exp/thinking-terminal-block/`。

| # | 约束 | 违规形态 | 上游 400 文本 |
|---|---|---|---|
| C1 | 最新 assistant 消息内两个 thinking 块不得相邻 | `[T, T, tool]` | ``` `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified``` |
| C2 | 任一 assistant 消息的**末块**不得是 thinking | `[T, tool, T]` | ``` The final block in an assistant message cannot be `thinking` ``` |
| C3 | 含 `tool_use` 的 assistant 消息**必须以 `tool_use` 收尾** | `[T, tool, T, text]` | `This model does not support assistant message prefill. The conversation must end with a user message.`（措辞误导，实际是 tool_use 之后还有块） |

同批实测确立的**合法**形态（用于确定修复的可行解空间）：

| 形态 | 结果 | 意义 |
|---|---|---|
| `[T, SEP, T, tool]` | 200 | 合成分隔符居中 + tool_use 收尾 —— **采用的修复形状** |
| `[T, SEP, T, SEP]`（消息无 tool_use） | 200 | 合成 text marker **可以合法收尾** → 纯 thinking 消息有解 |
| `[T, tool1, T, tool2]` | 200 | `tool_use` 夹在两个 thinking 之间**合法**，C3 只约束末块 → 多 tool_use 时只需最后一个收尾，其余仍可当分隔符 |

复验（修复后）：把**客户端原始** payload（`[T, T, tool]`）发给跑新码 + 默认 `move_blocks` 的隔离服务器 → HTTP 200，wire 上 `messages[28] = [thinking, "[copilot-api: thinking separator]", thinking, tool_use]`。

## 修复

### L1：`destackAdjacentThinking`（`src/lib/anthropic/sanitize/destack-adjacent-thinking.ts`）

1. **触发条件扩展**：`hasAdjacentThinking(content) || endsWithThinking(content)`。旧实现只在检出相邻 thinking 时才动手，因此客户端原生就以 thinking 收尾的消息（如 `[text, T]`、`[T]`，thinking 阶段被 `max_tokens` 截断的轮次会产生）直接漏过去撞 C2。
2. **`move_blocks` 先预留收尾块，再把剩下的发给交错逻辑**：收尾块优先取**最后一个 `tool_use`**（满足 C3），否则取最后一个真分隔符，两者都没有才补合成 marker。交错阶段照旧按原序消耗真分隔符、不足补 marker。
   - `[T,T,tool]` → `[T, SEP, T, tool]`（1 个合成）
   - `[Ta,Tb,Tc,text,tool1,tool2]` → `[Ta, text, Tb, tool1, Tc, tool2]`（0 个合成，与旧行为一致）
   - `[T,T]` → `[T, SEP, T, SEP]`（2 个合成）
   - `[text, T]` → `[T, text]`（0 个合成，纯重排）
3. **`insert_text`**：末块是 thinking 时追加 marker（保 C2）。已知边界：该策略契约是「真实块不移位」，故 `[tool, T]` 这种形态它只能产出 `[tool, T, SEP]`（违反 C3）。C3 由默认策略 `move_blocks` 负责；`insert_text` 保持诊断/对照腿定位。
4. **`passthrough` 保持完全不动**（诊断对照价值）。
5. 新增统计 `DestackStats.terminalRepairs`：因 C2 而被重新收尾的消息数（与 `insertedMarkers` 分开计，落进 `pipelineInfo.sanitization[].destack`）。

**幂等性**：满足 C1+C2 的消息按引用原样返回（逐字节不变）。

### L2：matcher 扩展（`src/lib/anthropic/poisoned-thinking-match.ts`）

旧 matcher 只认 "cannot be modified"（C1），认不出 C2 的措辞 → 事故当天完全无兜底。现更名 `isThinkingModifiedRejection` → **`isThinkingLayoutRejection`**（`matchesThinkingModifiedRejection` → `matchesThinkingLayoutRejection`），并集覆盖两种措辞：

- `cannot be modified` **且**提到 thinking/redacted_thinking，或
- `final block in an assistant message cannot be`（要求完整线索，避免任何一句带 "thinking" 的 400 都触发 strip-all）

两种拒绝由同一个补救（strip ALL thinking 后重试一次）治愈，故共用一个谓词；L3 quarantine 逻辑不变。

## 明确未做（记录以免被误读为遗漏）

- **不主动修复 C3 违规本身**。destack 只保证自己不制造 C3 违规。客户端原生产出 `[T, tool, text]` 这种形态在观测中从未出现（Anthropic 响应总是 text 在 tool_use 之前），真要修就得移动客户端的真实块、语义风险大于收益。若将来观测到，再按同样的实测流程立案。
- **`insert_text` 的 C3 边界**（见上）不修，理由同上，且它不是默认策略。
- **L2 strip-all 可能留下 `content: []` 的 assistant 消息**（邻域审查发现，非本次根因）：L2 `handle` 不走 `resanitize`，`stripAllThinking` 又只 filter 不丢空消息，故纯 thinking 的 assistant 消息被 strip 后成空 content 原样上送。已记入 [docs/todo/deferred-backlog.md](../todo/deferred-backlog.md)（含两条修法与触发条件），未实测复现。

## 教训

- 「满足约束 A 的修复制造了约束 B 的违规」——修复一条上游布局约束时，必须把**同一对象上的其它已知约束**一起当作输出的不变量来断言，而不是只针对被修的那一条写测试。
- 上游 400 的索引口径可能与我方数组不一致（内联 system 消息折叠），**按形状定位、别按索引定位**。
- 上游 400 的错误措辞可能误导（C3 报的是 "prefill" 而实际原因是 tool_use 之后有块），**分类靠可复现的最小变体实测，不靠错误文本的字面解读**。

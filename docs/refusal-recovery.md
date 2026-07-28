# Contentless refusal 的处理：抑制到客户端、忠实到后端

把上游 Anthropic 的 **contentless refusal**（`stop_reason:"refusal"` 且无 client-visible `text`/`tool_use`）按配置 `anthropic.refusal_sse_rewrite` 三选一处理。**默认抑制**，避免客户端的对话轮次被中断。

> 命名注意：本文不再使用「thinking-only refusal」。三个一手样本里有一个（`req_1785187727725_842`）**零 content block**、且请求带 `thinking:{"type":"disabled"}`——「thinking-only」断言了这个条件并不拥有的身份。判据是 `isContentlessRefusal`。

## 首要目标（用户 2026-07-28 裁定）

> 「下游处理得很烂，我们的主要目的就是避免下游因此中断对话轮次，因此需要抑制此类响应。」

**contentless refusal 绝不允许中断客户端的对话轮次。** 这是取舍时的第一判据；后端忠实度是次要目标，且不得与之冲突。

## 三个一手样本（实测，取证见 exp/refusal-samples/FINDINGS.md）

| id | 日期 | model | `stop_details.category` | content blocks | usage |
|---|---|---|---|---|---|
| `req_1782214935133_68` | 2026-06-23 | opus-4-8 | `null` | 1 × thinking | out 1097，**无** `output_tokens_details` |
| `req_1783947618475_731` | 2026-07-13 | opus-4-8 | `"bio"` | 1 × thinking | out 25848 / thinking 25636 |
| `req_1785187727725_842` | 2026-07-27 | opus-5 | `"cyber"` | **零个** | out 1 / thinking 0 |

**已被证伪、不要再写进设计的说法**：「带 category 的 refusal 是推理前拦截」（`bio` 烧了 25,636 thinking token 才拒）；「重发相同内容必再被拒」（三个样本都没做过重放实验）；「`category` 有无 = 可重试性分型」（真实形态是 `category: null`，无任何证据支持行为差异）。

## 为什么默认是「抑制」（客户端行为逐行实测）

Claude Code 2.1.207 打包源码核实（`~/.claude/refs/claude-code-2.1.207/app.pretty.js`）：

| 客户端收到 | CC 行为 | 对话轮次 |
|---|---|---|
| 原生 `refusal` 透传 | `BTt()` 渲染 refusal 消息（`:170302`；流式 `:298342` 读 `delta.stop_details`、非流式 `:298061`），`yield refusal_no_fallback` | **中断** |
| `event: error` | Anthropic SDK 抛 `APIError`、流内错误零重试 | **中断** |
| `end_turn` + **非空** text | 正常完成轮，agent loop 继续 | **不中断** ✅ |
| `end_turn` + **空** text | 实测 CC 空转再发一轮、`result=""`（`exp/cli-e2e-stall/FINDINGS.md`） | 中断（「继续」循环） |

CC 确实有 category 感知的原生渲染（对 `cyber` 有 Cyber Verification Program 专属文案）与客户端自动 fallback（`stop_reason==="refusal"` 且备了 `refusalFallbackModel` 时 `yield {type:"fallback_request"}`），但这些路径的终点仍是**结束当前轮**或依赖用户已配置 fallback 模型，不满足首要目标。

## 三模式（`anthropic.refusal_sse_rewrite`，默认 `end_turn`）

| 值 | 客户端 wire | 请求终态 |
|---|---|---|
| **`end_turn`（默认）** | **抑制**：合成 text 块（`maxIndex+1`）+ `stop_reason: refusal→end_turn`（清 `stop_details`）+ **代理自己的 `message_stop`** | `failed` |
| `refusal` | 原样透传，逐字节等价 | `failed` |
| `error` | 发 Anthropic `event: error` 帧替换终止符，抑制其后的 `message_stop` | `failed` |

**三种模式终态一律 `failed`**：抑制是**呈现策略**，不改变「上游拒绝了、本轮没有真实产出」这一事实（对齐既有不变量「上游语义失败必记 `ctx.fail`、不谎报成功」）。上游腿仍记 `success:true`（上游确实完整返回了 200 refusal），靠 `ctx.fail(..., {upstreamSucceeded:true})` 分离两个概念。

**配了 CC `refusalFallbackModel` 的用户请注意**：默认 `end_turn` 与 `error` **都**会让 Claude Code 看不见 `stop_reason:"refusal"`，它的原生自动换模型 fallback 因此**永不触发**。这是明知的取舍（CC 的 fallback 依赖用户已配置该项，且其失败终点仍是结束当前轮），不是遗漏。想保留 CC 那条腿请显式设 `refusal_sse_rewrite: refusal`——代价是被拒的轮次会中断。代理侧自己做 fallback 重试记在 [deferred-backlog](todo/deferred-backlog.md)。

**门控**：`stop_reason==="refusal"` **且**整条响应无 client-visible `text`/`tool_use`（**排除 `server_tool_use`**）。带真内容或非 refusal 一律透传。判据 `isContentlessRefusal`（`recover-refusal.ts`）。

## exactly-one-COMPLETE-terminus（承重不变量）

抑制模式**必须**发自己的 `message_stop`，上游那个当重复丢弃。理由是实测的：合成 `end_turn` delta 而不给终止符时，真实 `@anthropic-ai/sdk` 抛

```
AnthropicError: stream ended without producing a Message with role=assistant
```

——正是抑制要防的那种中断。上游的 contentless refusal **不保证**后面跟 `message_stop`。

状态机（`createRefusalRewriter`，一个状态机管三种模式）：`open` → 转发一切并跟踪 `maxIndex` / 是否出现 client-visible 块；命中 contentless refusal 的 `message_delta` → 按模式发终态 → `terminated`；此后**一切帧都抑制**（重复 delta、终态后 content 帧、上游的 `message_stop`）。`refusal` 模式永不 terminate，保持恒等透传。

配套：driver 的提交门把 contentless refusal 与 `message_stop`、上游 error 帧**并列**为终态判据（`sawContentlessRefusal`）。否则缺终止符的 refusal 会被当成截断，去重试或续写一个客户端已经拿到完整终止符的轮次。

## 策略按请求冻结（并发安全）

`RefusalPolicy`（mode + 三个模板）在**首次读取时冻结**、此后不可变，挂在 ctx 上（`ctx.refusalPolicy`）。改写层（processor 构造时）与 handler（流 drain 后）读**同一份快照**。

两个原因：① 任何带 `system` 的并发请求都会 `applyConfigToState()`，两次独立读取热重载全局配置无法保证一致；② **generation hedge 默认开启**，并发 candidate 各有独立 rewriter——共享一个可变裁决会让落败 candidate 的 refusal 覆盖胜出者的正常结果。冻结策略 + 各层从**各自的 accumulator** 推导，两个问题一起消掉。

## 可配置文本（零包装 + 占位符）

| 配置键 | 类型 | 作用 |
|---|---|---|
| `refusal_end_turn_text` | string（模板） | 抑制模式注入的 text 块内容 |
| `refusal_error_message` | string（模板） | `error` 帧 message（客户端 `APIError.message`） |
| `refusal_error_type` | string（纯字面） | `error` 帧 `error.type`；空串回落 `api_error` |

**占位符**：`{model}` `{request_id}` `{thinking_tokens}` `{output_tokens}` `{refusal_category}` `{refusal_explanation}`。未知占位符**原样保留**（防手滑丢文本）。

**未知值的渲染是文档化的、不是偶然的**：值缺失渲染 `unknown`；`category` 为上游显式 `null`（「未映射到命名类别」）渲染 `uncategorized`——provenance 一路保留到用户可见文本。

**`{thinking_tokens}` 只认权威字段**：仅当 `usage.output_tokens_details.thinking_tokens` 是有限非负数时取值，**绝不回落 `output_tokens`**。理由是实测的：`bio` 样本只有一个 thinking 块，却是 `output_tokens=25848` vs `thinking_tokens=25636`（差 212）——「唯一的块是 thinking」推不出「所有 output token 都是 thinking token」。旧上游（2026-06-23 样本）根本没有这个字段，答案就是「未知」。

**默认文案的分工**：抑制文本带 `{refusal_category}` 但**不带** `{refusal_explanation}`——它是一条**成功 assistant 消息**、会被 CC baked 进对话历史，而 explanation 是上游诊断元数据、不是模型对用户任务的回答，写进去污染语义上下文。`error` 帧不进对话历史，故带完整 explanation。（「回灌 explanation 会不会再次触发分类器」是**未验证假设**，不作为设计前提。）

**空串 = 零包装的极致**：`refusal_end_turn_text=""` 时不追加任何 text 块，仍发 `end_turn` + `message_stop`。⚠️ **实测空串会让 Claude Code 空转一轮**（`exp/cli-e2e-stall/FINDINGS.md`），等于主动放弃抑制的保护。

## 合成帧记录层打标（richest-data-flow §3）

抑制/改写产生的 forwarded 帧（合成 text 三帧 + 改写的 delta + 合成 `message_stop`、error 帧）在 forwarded 轨打 `SseEventRecord.synthetic:"refusal-recovery"`。**只碰记录层元数据、不碰客户端可见字节**。上游轨 `sseEvents` 绝不含合成物（driver 在 S5 前采样）。

## History 保真

只改**转发/渲染**响应。History 的 `sseEvents` 与记录的 `stop_reason` / `stop_details` 保留真实上游 refusal：客户端看到正常轮，History 看到原始拒绝。accumulator 以 **raw 对象**捕获 `stop_details`（`acc.stopDetails`）——归一化视图只用于展示/决策，**绝不**作为持久化边界（否则 `category: null` / 字段缺失 / 畸形类型三种 provenance 被压成同一个空值）。

## 请求计数口径

一个被抑制的 refusal 是 `failed` 终态 + `success:true` 上游腿。请求计数以**裁决**为唯一权威、桶互斥（`requestBucket()`，`src/lib/history/stats.ts`）；遥测 registry 的 `success` 记的是**客户端请求是否成功**，不是上游腿。两个概念不再互相覆盖。

## compat 迁移

旧布尔 `anthropic.refusal_recover_text` → 枚举 `anthropic.refusal_sse_rewrite`：`true→"end_turn"`、`false→"refusal"`。见 `compat.ts`。

## 实现

- 纯逻辑：[recover-refusal.ts](../src/lib/anthropic/recover-refusal.ts) —— `isContentlessRefusal` 门控 + `extractRefusalDetail`（provenance 保留）+ `refusalThinkingTokens` + `createRefusalRewriter`（三模式单状态机）+ `recoverRefusalInResponse`（非流式）。
- 策略类型叶子：[refusal-policy.ts](../src/lib/anthropic/refusal-policy.ts) —— **零依赖**，因为从 context 引用它会把 `recover-refusal` 拖进 19 模块巨型 SCC（`circular-deps-ratchet` 会咬）。
- 接入：第 5 条 Anthropic `ResponseRewrite`（`order 400`）[response-rewrite-adapters.ts](../src/lib/codec/anthropic/response-rewrite-adapters.ts)；终态与可观测性在 [handler-v4.ts](../src/routes/messages/handler-v4.ts) 的单一 settle 点。
- 合成帧契约：error 帧与 `message_stop` 都带 `event:` 行（否则 Anthropic SDK 静默丢弃 eventless data 帧）。

## 测试

- 纯函数：[refusal-detail.unit.test.ts](../tests/anthropic/refusal-detail.unit.test.ts)（provenance 真值表 / 诚实 thinking tokens / 占位符渲染）。
- 终态不变量 + 三个真实样本：[refusal-terminal-invariants.unit.test.ts](../tests/anthropic/refusal-terminal-invariants.unit.test.ts)。
- 状态机：[recover-refusal.unit.test.ts](../tests/anthropic/recover-refusal.unit.test.ts)。
- golden 字节锁：[response-rewrite-golden.http.test.ts](../tests/anthropic/response-rewrite-golden.http.test.ts) —— expected **不得** import 被测生产常量（否则改默认文案时两边一起变、恒绿）。
- 真 SDK oracle：[anthropic-sdk.it.test.ts](../tests/e2e-client/anthropic-sdk.it.test.ts) —— 含「refusal 无 `message_stop` 时 SDK 仍能 finalize」。
- 计数口径：[stats-verdict-buckets.unit.test.ts](../tests/history/stats-verdict-buckets.unit.test.ts)。

## 诊断消费面

- TUI 失败完成行显示 `refusal:<category>`，命名类别逐字保留，显式 `null` / 缺失 / 畸形统一显示 `refusal:uncategorized`；完整 explanation 只留详情面，不污染单行。
- History UI 的 Meta 段显示 category，Response 段显示完整 explanation + raw `stopDetails`。
- 遥测 registry 提供 **capped** `refusal_category` 维度；非 refusal 不计入该维度，refusal 未命名类别归 `uncategorized`。
- 三个 refusal feature 带 `{category}` detail；跨协议 Anthropic→CC / Responses 在 category 无法进入客户端 wire 时额外记录 `translated-refusal-category-dropped`（detail `{category,target}`）。History 的 raw upstream `stopDetails` 保持不变，包括 reverse `@messages` 的流式与非流式路径。

## 已知缺口

- reverse `@messages` 的 Chat Completions / Responses / Gemini **非流式**腿已统一裁决为 `failed`，记录 `refusal-passthrough`，并以 `{upstreamSucceeded:true}` 保持上游腿 `success:true`；但这三条腿目前只把 Anthropic refusal 翻译成目标协议的 `content_filter` / `incomplete` 形态，尚未执行 `anthropic.refusal_sse_rewrite` 的三模式呈现策略，也就尚未把默认 `end_turn` 抑制转换成各目标协议的正常完成轮。根因是 refusal whole-response rewrite 发生在 Anthropic wire 层，而 reverse codec 先把原始 Anthropic body 翻成目标协议，三个 route settle 点此前又只做 truncation 判定；理想架构应让 refusal disposition 在 Anthropic→目标协议翻译前统一裁决并产生协议无关的呈现结果。当前批次先修后端事实与计数口径，避免继续生成“成功的 refusal”；完整抑制需同时设计 CC / Responses / Gemini 三套合法 wire、History raw/forwarded 双轨、feature mode 与真实客户端 oracle，故作为独立任务暂缓，详见 [deferred backlog](todo/deferred-backlog.md)。
- web_search 双跳旁路走 legacy direct、不经 driver/S5，三模式对该路径无效（与既有 web_search bypass 暂缓清单一致）。
- **代理侧 fallback 重试**（换模型重发）未做，记在 backlog；上游 explanation 的样板句自己建议的正是这条，CC 也内建了它。进度见 [docs/plan/2026-07-28-refusal-suppression-remaining-tasks.md](plan/2026-07-28-refusal-suppression-remaining-tasks.md)。

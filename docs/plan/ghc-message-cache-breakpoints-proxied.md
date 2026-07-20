# 移植 GHC 的 message 级 cache 断点策略进 proxied 模式

> **实施状态：已完成**
> **落地**：7751bed
> **现状锚点**：运行时选项 `cacheControlMode`（proxied 缓存对话历史）；request-preparation.ts addMessageCacheControl
> **备注**：GHC message-优先断点注入 + inline system 跳过 + string→text 转换全落地

## Context（为什么做）

实测发现：`cacheControlMode:"proxied"`（默认）把 Claude Code 自带的 message 级 `cache_control` 断点剥光，只在 last-tool + last-system 注入两个断点。结果对话历史（agentic loop 的大头，单轮十几万~八十万 token）**每轮全价重算**，长会话缓存率仅 2–3% 且随对话增长递减。

实测证据（同会话 2b6050a0，热切 `passthrough` 透传客户端断点）：input_tokens 从 ~120K 砍到 **2**，cache_read 从冻结的 14503 跳到 **174242→174810**（随对话增长），缓存率 **3%→99.7%**。证明上游认 message 断点，proxied 是元凶。

代码注释声称"match GHC behavior"，但 GHC 官方 [cacheBreakpoints.ts](../../src/copilot-api-js/refs/github-copilot-chat/src/extension/intents/node/cacheBreakpoints.ts) 的 `addCacheBreakpoints` 恰恰**把 4 个断点优先花在 messages 上**（每轮 tool_result + 当前 user 消息 + 终态 assistant），tools+system 只是余位兜底。proxied 只复刻了兜底、丢了主策略。

**目标**：在 proxied 模式下移植 GHC 的 message 级断点注入，让所有客户端（不止 CC）都获得对话缓存，与 GHC 完全对齐。预期把 agentic loop 缓存率拉到 ~99%。仅作用于 Anthropic 路径（cache_control 是 Anthropic 概念；OpenAI 走自动缓存）。

## 核心映射洞察（GHC role 模型 → Anthropic block 模型）

GHC 操作 OpenAI 风格 `messages[]`（role System/User/Assistant/**Tool**）。Anthropic wire 里 **tool_result 是 user-role 消息内的 block**，tool_use 是 assistant 内的 block。映射：

| GHC role | Anthropic 判定 |
|---|---|
| `Tool`（工具结果） | user 消息 **含** `tool_result` block → `isToolResultMessage` |
| `User`（真实提问） | user 消息 **不含** tool_result → `isPlainUserMessage` |
| `Assistant` 无 toolCalls | assistant 消息无 `tool_use` block → `isAssistantWithoutToolUse` |

**关键**：不能用 `role==="user"` 找"当前用户消息"（会误判最后一个 tool_result）。`isBelowCurrentUserMessage` 的翻转、以及"当前 user 消息"断点，都只认 `isPlainUserMessage`。tool_result 走 GHC Tool 分支。

### merge 形态差异（对抗 review 核心更正）

GHC `addCacheBreakpoints` 跑在 **merge 前的 `Raw.ChatMessage[]`**（[agentIntent.ts:676](../../src/copilot-api-js/refs/github-copilot-chat/src/extension/intents/node/agentIntent.ts)，每个 tool result 是独立 `Raw.ChatRole.Tool` 消息）；本仓 `applyCacheControlMode` 跑在 **S4 prepare、即 merge 后** 的 Anthropic wire（并行 tool_result 已合进单条 user 消息的多个 block——**实测 entry `req_..._185` 索引 6/9/11/14/16 均为 `[tool_result, tool_result]`**）。

**因此**：GHC 的 `isLastToolResultInRound`（per-Tool 逐条、一轮并行只认最末一个）在本仓 merged 形态下"一轮 = 单条 user 消息"天然只下一个断点——**两者断点数恰好一致，但等价来自 merge 抹平、不是 `later=messages[i+1]` 复现了 GHC 的 wrap-around**（原计划此论证已删，见下）。维护者须持此心智模型，否则会基于错误前提改坏。

### inline `role:"system"` 消息（默认存活，必须显式处理）

默认 `systemMessagesSanitize:false`（[state.ts:1033](../../src/copilot-api-js/src/lib/state.ts)）→ `sanitizeInlineSystemMessages` 早退原样保留，inline `role:"system"` 消息**活到 wire**（实测每会话 ~5 条，**含最末消息**）。算法须显式：`msg.role==="system"` → **惰性跳过**（不下断点、**不翻转 `isBelowCurrentUserMessage`**），对齐 GHC 第一循环对 `Raw.ChatRole.System` 的处理。`messageHasToolUse`/`isPlainUser` 对 system content 自然为 false（不崩），但须显式 guard 表意清晰 + 测试覆盖"末尾 inline system"形态。

## 实现

### 改动点：[src/lib/anthropic/request-preparation.ts](../../src/copilot-api-js/src/lib/anthropic/request-preparation.ts) proxied 分支

`applyCacheControlMode` 的 `case "proxied"`（line 681）改为：
```
walkCacheControl(wire, () => undefined)        // 既有：剥光客户端断点
addMessageCacheControl(wire.messages)          // 新增：GHC 主策略（messages 优先）
addToolsAndSystemCacheControl(wire)            // 既有不动：余位兜底
```
`addToolsAndSystemCacheControl`（line 698）内部 `countExistingCacheBreakpoints` 已统计 messages+system+tools，故 message 断点注入后它自动按剩余配额工作，**无需改它、无需手动 thread remaining**。

### 新增 `addMessageCacheControl(messages)`——忠实移植 GHC `addCacheBreakpoints`

逆序遍历 messages，预算 `CACHE_CONTROL_BREAKPOINT_LIMIT`（=4，line 101）减去已有断点（剥光后通常=4）：
```
isBelowCurrentUserMessage = true
for i = len-1 down to 0:
  if remaining <= 0: break
  msg = messages[i]; later = messages[i+1]   // later = 时间上更晚的消息
  if msg.role === "system": continue          // inline system：跳过，不下断点、不翻转 isBelow
  if messageHasCacheControl(msg): continue    // 防御（proxied 已剥，不会命中）
  isToolResultMsg = isToolResultMessage(msg)
  isLastToolResultInRound = isToolResultMsg && !isToolResultMessage(later)   // later undefined → true
  isPlainUser = msg.role==="user" && !isToolResultMsg
  isAsstNoTools = msg.role==="assistant" && !messageHasToolUse(msg)
  if (isBelowCurrentUserMessage && (isLastToolResultInRound || isPlainUser)) || isAsstNoTools:
    if placeCacheControlOnLastBlock(msg): remaining -= 1
  if isPlainUser: isBelowCurrentUserMessage = false
```
对照 GHC 原逻辑 `(isBelow && (isLastToolResultInRound || isUser)) || isAsstMsgWithNoTools`，仅把 GHC 的 role 判定换成上表 Anthropic 判定 + 显式 system 跳过。

**`later` vs GHC wrap-around（边角分歧，已核验不可达）**：GHC 用 `reversedMsgs.at(idx-1)`，idx=0 时 wrap 到**最旧**消息；本计划用 `messages[i+1]`（末尾→undefined→last-in-round=true）。二者仅在"最新消息是 tool_result **且**最旧消息也是 tool_result"时发散 1 个断点。但 Anthropic 协议要求 tool_result 引用在先的 tool_use，**最旧消息不可能是 tool_result**（`ensureAnthropicStartsWithUser` 仅 auto-truncate 路径调，非主链保证；真正的保证来自协议），故该分歧对合法 payload **不可达**；即便畸形 payload 漏入，1 断点差异无害。不复制 GHC 的 wrap quirk（它是 bug 非设计）。

### helpers（复用优先）

- `isToolResultMessage(msg)` = `Array.isArray(content) && content.some(isToolResultBlock)`——复用 [types/api/anthropic.ts:199](../../src/copilot-api-js/src/types/api/anthropic.ts) 的 `isToolResultBlock`。
- `messageHasToolUse(msg)` = `Array.isArray(content) && content.some(b => b.type==="tool_use")`（同 [recover-tool-call/response.ts:24](../../src/copilot-api-js/src/lib/anthropic/recover-tool-call/response.ts) 既有 inline 写法）。
- `placeCacheControlOnLastBlock(msg)`：
  - content 是 **string** 且非空 → 转为 `[{type:"text", text:content, cache_control:EPHEMERAL_CACHE_CONTROL}]`，return true。**等价证据（参考实现 oracle，非推断）**：GHC merge 时正是把 string content 转 `[{type:'text', text}]`（[messagesApi.ts:341](../../src/copilot-api-js/refs/github-copilot-chat/src/platform/endpoint/node/messagesApi.ts)），证明上游认二者等价。空 string → false。
  - content 是 **array** → `findLastIndex`（line 780 复用）找最后一个 **支持 cache_control** 的 block（`type!=="thinking" && type!=="redacted_thinking"`，已 Explore + SDK 类型证实），命中则原地挂 `EPHEMERAL_CACHE_CONTROL` return true；无可挂 block（极罕见，全 thinking）→ false 不减预算。**有意分歧**：GHC 在无可挂块时注入 `{text:' '}` 占位（messagesApi.ts:421），本计划选择跳过——proxied 下全-thinking user/assistant 消息极罕见，且 GHC 占位是为其 CacheBreakpoint part 模型服务，本仓直接挂 block 无此需要。
- 原地 mutate 与既有 `walkCacheControlArray`（line 804 原地 delete/assign）一致——wire 已被 `buildWirePayload` deep-clone（line 331/337），不污染客户端 payload/history。

### 预算策略（忠实 GHC）

messages 优先消费，tools+system 取余位。长 agentic 会话若 messages 用满 4，tools+system 靠最新 message 断点**隐式覆盖**（Anthropic 缓存层级 tools→system→messages，GHC messagesApi.ts:482 注释明确）。**不**人为给 tools+system 预留 slot（GHC 不预留；context-editing/auto-truncate 导致早期消息变动时 tools+system 独立层的价值留作未来 telemetry 驱动的 open question，YAGNI 不投机）。

**system spare-slot 映射是近似、非严格等价（对抗 review 更正）**：GHC 第二循环（[cacheBreakpoints.ts:62-79](../../src/copilot-api-js/refs/github-copilot-chat/src/extension/intents/node/cacheBreakpoints.ts)）给 messages 里**前导 System/User 消息**下断点；本仓 `addToolsAndSystemCacheControl` 只碰 **top-level `wire.system`**，覆盖不到 inline `role:"system"` 消息。因第一循环在 agentic 热路径常用满 4 槽、第二循环基本不触发，故此不等价无实际影响。

## 测试（[tests/anthropic/anthropic-request-preparation.it.test.ts](../../src/copilot-api-js/tests/anthropic/anthropic-request-preparation.it.test.ts) `describe("proxied")` line 561）

**先改既有断言**（编码旧行为，必须更新）：line 171 与 561 块原断言"proxied 后 messages 断点=0"→ 改为断言 GHC 式注入位置。`disabled`/`passthrough`/`sanitize` 三模式测试**保持全绿不动**（未改其行为，golden 不变性）。

**新增用例**（用 [tests/helpers/factories.ts](../../src/copilot-api-js/tests/helpers/factories.ts) 的 `mockToolUseMessage`/`mockToolResultMessage`/`mockThinkingMessage`/`mockAnthropicPayload`，`setStateForTests({cacheControlMode:"proxied"})`）。**用真实 agentic 形态**（对抗 review 警告）：活跃 loop 里 assistant 几乎全带 tool_use、末尾常是 tool_result——别构造"末尾无 tool_use assistant"的不真实形态：
1. agentic 会话（plain user → 多轮 assistant(tool_use)/user(tool_result) → 末尾 tool_result）→ 断点落最新 tool_result + 当前 plain user +（若存在）终态 assistant；tool-use 的 assistant 不挂；上限 4。
2. tool_result（user role）走 Tool 分支、**不**被当作 plain user 翻转 `isBelowCurrentUserMessage`（核心映射回归）。
3. **inline `role:"system"` 消息（含末尾是 system）→ 跳过、不翻转 isBelow、不崩**（默认配置真实形态回归）。
4. thinking 消息 → 断点落最后一个非 thinking block，绝不落 thinking。
5. string content 的 plain user → 转 text block 并带 cache_control。
6. 4 断点上限：messages 优先、tools+system 取余位；messages 用满则 tools+system 不再注入。

**step 顺序**不变（改动在 `applyCacheControlMode` 内部），[anthropic-prepare-steps.unit.test.ts](../../src/copilot-api-js/tests/anthropic/anthropic-prepare-steps.unit.test.ts) 不动。

## 验证

1. **离线 dry-run oracle（主验证）**：`/api/debug/dry-run-pipeline` `stopAfter=prepare-wire` 喂**真实 `entryId`**（live history 满是真实 agentic 样本，比手构 fixture 忠实），看 `inspection.stages["prepare-wire"].body.messages` 注入位置（[dry-run-pipeline.ts:308](../../src/copilot-api-js/src/routes/debug/dry-run-pipeline.ts)，读 live `state.cacheControlMode`，零触上游）。
2. `bun run test:backend`（含上面新/改测试）+ `bun run typecheck`。
3. **subagent 对抗 review**（第二轮）：拿 GHC `cacheBreakpoints.ts` 逐行核对最终实现忠实度 + 上面 6 修正是否落地（裁判轴=忠实+完整，非 ROI）。
4. **端到端实测**（默认 proxied，无需改配置）：实现后观察某新 agentic 会话 live `cache_read` 是否跳到 ~99%（对照已实测的 passthrough 99.7%）；用 `/history/api/entries` 读，不直读 DB。

## 收尾（completion-includes-doc-sync）

- 更新 [request-preparation.ts](../../src/copilot-api-js/src/lib/anthropic/request-preparation.ts) `applyCacheControlMode` JSDoc（proxied 现含 message 注入）。
- DESIGN.md `cacheControlMode` 配置行 + config.example.yaml 注释：proxied 现缓存对话历史（GHC 对齐）。
- 写 memory：proxied 曾丢对话缓存的实测发现 + GHC 主策略是 message 优先 + 实测方法（passthrough 热切对照）。
- 一阶段一 commit（`feat: ...`），细粒度暂存。

## 范围边界

仅 Anthropic proxied 模式。不碰 disabled/passthrough/sanitize 行为，不碰非 Anthropic 格式，不改 step 顺序、不改 tools+system 既有函数、不动 web_search 旁路（其复用同一 prepare，自动受益）。

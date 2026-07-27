# 响应侧 server-tool 块按来源分流：客户端声明的原样转发，我方注入的降级保留

日期：2026-07-26
状态：**待评审**（决策已由用户拍板，见 §2）
前置：[2026-07-26-thinking-terminal-block-layout.md](2026-07-26-thinking-terminal-block-layout.md)（本 spec 的触发事故与三条上游约束）
相关 ADR：[richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、skill `ghc-anthropic-upstream`

## 1. 问题

### 1.1 事故因果链（已实证，非推断）

```
① GHC 上游返回   [thinking, server_tool_use{tool_search}, tool_search_tool_result, thinking, tool_use]   ← 合法
② 我方 filter 无条件剥离中间两块 + 索引压密 → 转发 [thinking, thinking, tool_use]                       ← 我方制造违规
③ 客户端把它 baked 进本地历史
④ 下一轮回传 → 撞 C1（相邻 thinking）→ 400 "cannot be modified"
⑤ L1 destack 修 C1（tool_use 挪中间）→ 撞 C2（末块 thinking）→ 400 "final block ... cannot be `thinking`"
```

第 ⑤ 步就是 `req_1785016294183_896` / `req_1785016294884_897` 两次每轮必败的 400（`claude-opus-5`，直连 `/v1/messages`，`translated:false`）。

**取证**：`req_1785016247905_895` 的两条腿逐块对比 —— 上游轨 `thinking,server_tool_use,tool_search_tool_result,thinking,tool_use`，客户端轨 `thinking,thinking,tool_use`。同 session 14 条请求中含 server-tool 块的只有 1 条，**而它 100% 制造了相邻 thinking**：只要上游把 server-tool 块夹在两个 thinking 之间，[server-tool-filter.ts:136-141](../../src/lib/anthropic/server-tool-filter.ts#L136) 必然把两个 thinking 并拢。

### 1.2 三层 thinking 修复机制的真实定位

L1 destack / L2 strip-all / L3 quarantine **全部是在下游收拾这个 filter 制造的烂摊子**。它们治的是症状；病灶在响应侧的剥离。这也解释了为什么 destack 是「每轮重复施加」的 —— 坏形态已写进客户端本地历史，每一轮都要重新修补同一批消息。

### 1.3 被忽视的信息丢失

`tool_search_tool_result` 携带的是模型刚刚搜到的工具引用（实例：`Task` / `Agent` / `SendMessage`）。模型在**第二段 thinking** 里会引用这次搜索的结果，但结果被我方丢弃了 —— 后续轮次里模型看到自己说「我搜索到了 Task」，上下文却没有任何搜索痕迹。这违反 [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)（数据以最丰富形式流动、决策交给末端），属于**中途裁剪**。

### 1.4 `tool_search` 是我方注入的，客户端从未声明

实测（`req_1785016247905_895`）：

| | tool_search 声明 |
|---|---|
| 客户端请求 `tools` | **无** |
| 我方发出的上游请求 `tools` | `{"name":"tool_search_tool_regex","type":"tool_search_tool_regex_20251119"}` |

注入条件（[message-tools.ts:177-186](../../src/lib/anthropic/message-tools.ts#L177)）是三者合取：config `tool_search_enabled`（默认 true）× 模型能力表支持 × **请求带 tools**（整个 `processToolPipeline` 只在请求带 tools 时跑）。同 session 实测 14/15 轮注入，唯一例外正是 `clientTools=0` 的那条。

注入目的是开启 `defer_loading`（把非核心工具标记为延迟加载以省 prompt token）—— 这是**纯代理侧优化**，客户端既不知情也不参与。

## 2. 已定决策（用户拍板，不再重开）

1. **不如实暴露**：我方注入的 server-tool 块**不能**原样转发给客户端（客户端从未声明过它，转发会泄漏内部优化为客户端契约，且回传后依赖「每轮都注入同样声明」这一脆弱前提）。
2. **降级而非丢弃**：把这些块降级成客户端能理解的形式，保留其携带的信息。
3. **分流判据不是模型族**：用户的原始表述是「仅对 claude models 处理」，但模型族只是代理变量 —— 采用更本质的判据见 §3。
4. **存量坏数据必须有修复机制**（§5）。
5. **`tool_search` 注入本身值不值，必须量化后裁决，不得无限期搁置**（§7 backlog，用户要求本任务收尾后立即启动）。

## 3. 核心判据：按「谁声明的」分流，而非按模型族

| server-tool 块引用的 tool | 客户端认识它吗 | 处理 | 回流风险 |
|---|---|---|---|
| **在客户端原始 `tools` 声明里**（如 GPT 客户端请求 `web_search`） | 认识，是它主动要的 | **原样转发** | 零 —— 客户端回传时自己会重新声明 |
| **不在**（我方注入的 `tool_search_tool_regex`） | 完全不知情 | **降级成 text 块** | 零 —— text 块永远合法 |

判据可精确编程：客户端原始声明来自 `ctx.originalRequest.tools`（[types.ts:469](../../src/lib/context/types.ts#L469)，"client's raw payload, immutable"），我方注入的产物来自 `processToolPipeline`。

**为什么优于按模型族硬编码**：自动覆盖 GPT 场景（GPT 客户端声明 `web_search` → 原样转发）与 Claude 场景（我方注入 `tool_search` → 降级），且将来 Claude 支持客户端声明 server tool、或 GPT 侧我方也要注入什么，规则都不用改。**能力的归属，而不是模型的品牌，才是决定可见性的东西。**

## 4. 方案

### 4.1 响应侧分流降级（替换现有无条件剥离）

改造 [server-tool-filter.ts](../../src/lib/anthropic/server-tool-filter.ts) 及其 adapter [response-rewrite-adapters.ts:317-345](../../src/lib/codec/anthropic/response-rewrite-adapters.ts#L317)（`order 300`，`appliesTo: ANTHROPIC`）：

- **原样转发分支**：块引用的 tool 在客户端声明里 → 不 suppress、不重映射索引。
- **降级分支**：否则 → 把 `server_tool_use` + 配对的 `*_tool_result` 降级成**单个 text 块**，文本由现有渲染逻辑产出。
- **降级形式只能是 text**：绝不能降级成 `tool_use` —— 那会让客户端真的去执行一个它没有的工具。（请求侧的 `downgrade` 模式转 `tool_use` 是正确的，因为那是喂给上游的历史；两侧目标不同，不可照搬。）

**流式索引连续性**：现有 filter 用 `clientIndexMap` 把索引压密。降级分支产出一个块（替代原来的两个），索引重映射逻辑仍需保留，但映射关系变为「N 块 → 1 块」而非「N 块 → 0 块」。

**渲染复用**：[rewrite-server-tool-blocks.ts:70](../../src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts#L70) 的 `stringifyServerToolResultContent(content, query)` 目前是 module-private，需提升为共享导出（或下沉到中性叶子），供两侧复用 —— **同一份渲染逻辑，杜绝两侧文案漂移**。

### 4.2 合成标记（ADR 合规）

降级产出的 text 块是**改写产物**，必须可辨识（ADR「合成/改写帧必打可辨识标记」）。需新增 synthetic kind（如 `"server-tool-downgrade"`），**三处穷尽点必须同步**：

- [frame-origin.ts:29](../../src/lib/pipeline/frame-origin.ts#L29) `SyntheticOriginKind`
- [model-operation-record.ts:28](../../src/lib/context/model-operation-record.ts#L28) `OperationSyntheticKind`（超集）
- client-sink 的 `sampleForwarded` 站点 + ui-v4 若有穷尽 `Record`

> 记忆 [[methodology-plan-verify-interface-location-and-wiring-channel]]：新 union 成员会打爆 ui-v4 的穷尽 Record。实施时以 `typecheck:ui-v4` + `build:ui` 为权威门，根 `typecheck` 不覆盖 ui-v4。

**双轨语义**：history 上游轨（`attempts[].upstreamResponse.sseEvents`）保留原始 server-tool 块不变；forwarded 轨（`clientResponse.sseEvents`）记降级形态并打标记。两轨 diff 即完整记录。

### 4.3 配套保障：历史 server-tool 引用的无条件重新声明

原样转发分支使客户端历史可能持有 `server_tool_use`。若某轮请求未声明对应 server tool，上游 400（`server_tool_use block references X, but X is not defined in tools as a server tool`）。

**保障**：只要历史中存在引用某 server tool 的 `server_tool_use` 块，就**无条件重新声明**该 server tool —— 不受 `state.toolSearchEnabled`、模型能力表、请求是否带 tools 的影响。

这与现有的普通-tool 安全网**同构**，直接复用其模式（[message-tools.ts:117-143](../../src/lib/anthropic/message-tools.ts#L117) 的 `collectHistoryToolNames` / `buildHistoryToolStubs`），其注释已阐明同一道理：

> an orphaned historical tool_use gets rejected by GHC whether or not tool_search is on, so this must NOT be gated on toolSearchEnabled

### 4.4 客户端 SDK 接受度（原样转发分支的前提）

原样转发只发生在「客户端自己声明了该 server tool」时，理论上 SDK 必然认识。仍需 e2e 实测坐实（mock 上游 + 真 `@anthropic-ai/sdk`，离线免费，skill `client-proxy-e2e-testing`）：客户端声明 server tool → 上游返回对应 server-tool 块 → 断言 SDK 正常拼装、不抛错。

## 5. 存量坏数据的修复机制

已 baked 进客户端本地历史的相邻 thinking **无法还原原始内容**（客户端那边只剩两个 thinking 块，被剥离的 server-tool 块已不在其历史中）。

- **L1 destack 保留**（已 landed，见前置 spec）：它是存量坏数据唯一的修复路径，职责正当，不因本 spec 而退役。
- **不从 history 反查还原**：技术上可行（我方上游轨存着原始块，可按 signature 匹配），但引入「请求路径依赖 history 可用性」的耦合，且对已归档/已降温的记录不可靠。**明确不做**，理由记录于此。
- 本 spec 落地后，**新产生**的对话不再出现此形态，destack 对新历史将趋于 no-op。

## 6. 验收标准

1. 客户端声明的 server tool → 响应侧原样转发（e2e 断言 SDK 接受）。
2. 我方注入的 `tool_search` → 响应侧降级为单个带标记的 text 块，文本含真实工具引用（`Task` / `Agent` / `SendMessage` 等）。
3. **上游 `[thinking, server_tool, server_tool_result, thinking, tool_use]` 经我方转发后，客户端轨不得出现相邻 thinking** —— 用 `req_1785016247905_895` 的真实上游帧作 fixture 回归。
4. 历史含 `server_tool_use` 时，即便 `tool_search_enabled=false`，出站请求仍声明该 server tool。
5. history 上游轨保留原始块；forwarded 轨带 `server-tool-downgrade` 标记。
6. 全后端测试绿 + `typecheck:ui-v4` 绿。

## 7. 明确未做 / 待办

- **`tool_search` 注入的成本收益量化 —— 已裁决（2026-07-27）：保留，不退役。** 实测每轮省 **16,157 prompt token（62.7%）**，而实际触发 tool_search 往返的轮次仅 **0.83%（1/120）**；A/B 同时坐实了「deferred 工具 schema 确实不进 prompt」这一承重假设。完整证据、探针与踩坑见 [exp/tool-search-cost-benefit/FINDINGS.md](../../exp/tool-search-cost-benefit/FINDINGS.md)。**推论：本 spec 的工作仍然必要**（不存在「等 tool_search 退役就自动消失」的退路），需按评审的 3 个 CRITICAL 重写。
- **因裁决为「保留」而升级为必修的现存缺陷**：[rewrite-server-tool-blocks.ts:70-94](../../src/lib/anthropic/sanitize/rewrite-server-tool-blocks.ts#L70) 的 `stringifyServerToolResultContent` 是 web-search 专用的，`tool_search_tool_search_result` 会被渲染成 `"Web search failed: unknown"` + `isError: true`（谎报失败、丢光真实工具引用）。请求侧 downgrade 模式被 learned 开启即触发。**非本 spec 引入，但本 spec 必须替换它**（评审 CRITICAL-1）。
- **架构张力记录**：「代理侧优化的副产品要不要对客户端可见」—— 本 spec 选择「不可见但不丢信息（降级）」。若未来 `tool_search` 退役，这条张力随之消失。
- 请求侧 `rewrite-server-tool-blocks` 的 `downgrade` 模式与本 spec 的响应侧降级**不合并**：两侧目标不同（请求侧喂上游、可转 `tool_use`；响应侧喂客户端、只能转 text），仅共享渲染函数。

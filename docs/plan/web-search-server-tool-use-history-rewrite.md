# Plan: 修复 web_search double-hop 自产 `server_tool_use{web_search}` 回传导致上游 400

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：运行时选项 `rewriteHistoryServerTools`（config 键 tool_rewrite_history_server）；sanitize/rewrite-server-tool-history.ts
> **备注**：消息拆分式 downgrade 落地；另有 always-on 兜底 downgradeEmptyEncryptedSearchResults 叠加

## Context（为什么要做）

### Bug 现象

GHC 上游对 `POST /v1/messages` 拒绝：

```
HTTP 400: messages.17.content.81: `server_tool_use` block references `web_search`,
but `web_search` is not defined in `tools` as a server tool.
Use a `tool_use` block for client-executed tools.
```

### 根因（闭环自产 — 两轮 subagent review 确认）

`web_search.enabled: true` 时形成自产链：

1. 第 N 轮：客户端带 `WebSearch` 工具 → 走 `orchestrateWebSearch` double-hop
2. `src/lib/anthropic/web-search/synthesize.ts:78-82` 把 `server_tool_use{name:"web_search"} + web_search_tool_result + text` 合成到**同一条 assistant 消息**
3. `src/routes/messages/web-search-handler.ts:18-21` **故意绕过 server-tool-filter** 把这串 block 原样发给客户端（让搜索结果可见 — feature 核心价值）
4. 客户端把它存进对话历史
5. 第 N+1 轮：原样回传 → 请求方向 sanitize（`tool-blocks.ts:124-130`）只过滤孤儿，这对配对完整，畅通无阻
6. orchestrator first/second hop 用 `toFirstHopTools`（`orchestrator.ts:100-107`）把 tools 里的 `web_search` 降级成普通 function tool，但**不动消息历史里已存在的 server_tool_use block**
7. 上游看到 `server_tool_use{web_search}` 但 tools 里无 server tool 定义 → 400

### 受影响路径（确认）

`sanitizeAnthropicMessages` 的 callsite —— 单点修复全覆盖：

- `src/routes/messages/handler.ts:320` / `:252` — 主路径初始 sanitize + retry resanitize
- `src/lib/anthropic/web-search/orchestrator.ts:270` / `:346` / `:398` — orchestrator 两个 hop

**不受影响**：count_tokens（走真实 Anthropic API，原生支持 server_tool_use）、Gemini（输入无此形态）。

### 修复策略

新增 sanitize 子步骤 `rewriteServerToolHistory`，挂在 `sanitizeAnthropicMessages` 内、`processToolBlocks` **之前**。config 开关控制，默认关闭（用户决策）。string enum 形态保留扩展性，当前只实现 `"downgrade"`。

---

## ⚠️ 关键架构约束（第二轮 review 发现，决定设计形态）

**`tool_result` 必须位于 user 消息，不能在 assistant 消息内。**

证据：`orchestrator.ts:198-211` 的 `buildSecondHopMessages` 把 web_search 拆成 assistant `tool_use` + **独立 user 消息**的 `tool_result`；`types/api/anthropic.ts:193` 注释明确 plain tool_result 是 "standard user-side tool result"。

但 synthesize 把三块塞在**一条 assistant 消息**里。因此 downgrade **不能原地改**（原地会产生 assistant 内 tool_result → 换一个新 400）。

**正确做法：downgrade 必须拆分消息**——

```
改写前（一条 assistant 消息）:
  assistant: [ server_tool_use{web_search,id}, web_search_tool_result{id, content}, text ]

改写后（拆成 assistant + user 两条，镜像 buildSecondHopMessages）:
  assistant: [ tool_use{web_search,id}, text ]
  user:      [ tool_result{tool_use_id:id, content:<formatted text>} ]
```

拆分会改变消息数量/索引——下游 `processToolBlocks`、auto-truncate、message-mapping 都按内容重新扫描配对（不依赖固定索引），已验证兼容。

---

## 实施步骤

### 1. 新增 `src/lib/anthropic/sanitize/rewrite-server-tool-history.ts`

```typescript
export type RewriteServerToolHistoryMode = false | "downgrade"

export interface RewriteResult {
  messages: Array<MessageParam>
  rewroteCount: number   // 改写的 server_tool_use 对数
}

export function rewriteServerToolHistory(
  messages: Array<MessageParam>,
  mode: RewriteServerToolHistoryMode,
): RewriteResult
```

**核心逻辑（消息拆分式 downgrade）：**

- `mode === false` → 原样返回（identity，no-op）
- 遍历消息；对每条 **assistant** 消息：
  - **immutable thinking 保护**：`isImmutableThinkingMessage(msg)` 为 true → 整条不动（含签名 thinking 的消息不拆）。文档化此边界：含 thinking 的真实 web_search 历史在 `immutable` policy 下不修。
  - 扫描 content：若含 `server_tool_use`（按 **type** 匹配，非 name —— 覆盖 web_search/web_fetch/code_execution 等所有 server tool）：
    - `server_tool_use{id,name,input}` → `tool_use{id,name,input}`（id 保留，前缀 `srvtoolu_` 无害，已验证上游不校验 id 格式）
    - 配对的 `*_tool_result{tool_use_id, content}` → 提取出来，转成 `tool_result{tool_use_id, content: <formatted>}`，**移到紧跟其后的一条新 user 消息**
    - 其余 block（text 等）留在 assistant 消息
  - 一条 assistant 可能含多个 server_tool_use 对 → 全部提取的 tool_result 汇集到同一条新 user 消息，顺序对应
- **content 字符串化**：历史里的 result content 是 synthesize 产物形态 `Array<{type:"web_search_result", title, url, ...}>`（无 snippet），**不是** `SearchResult[]`，不能直接喂 `formatSearchResultsText`。新写一个小 helper 从 `{title, url}` item 重建文本，保留 `Web search results for query: "..."` 前缀（降低模型重复搜索倾向）；错误形态 `{type:"web_search_tool_result_error", error_code}` → `tool_result{is_error:true, content:<error string>}`
- **孤儿处理**：
  - 孤儿 server_tool_use（无配对 result）→ 只改 use 为 tool_use，不造假 result（留给 processToolBlocks 当孤儿正常处理）
  - 孤儿 *_tool_result（无配对 use，可能在 user 消息里）→ 单独转成 tool_result（留在原 user 消息）
- **纯函数 + immutable**：不 mutate 输入

### 2. 修改 `src/lib/anthropic/sanitize.ts`

在 `removeAnthropicSystemReminders` 之后、`processToolBlocks` **之前**插入：

```typescript
const rewriteResult = rewriteServerToolHistory(messages, state.rewriteHistoryServerTools)
messages = rewriteResult.messages
const toolResult = processToolBlocks(messages, payload.tools)   // 看到改写后形态
```

顺序约束（rewrite 必须在 processToolBlocks 前）由集成测试断言保护。

### 3. state：`src/lib/state.ts`

```typescript
readonly rewriteHistoryServerTools: false | "downgrade"
```

- `CONFIG_MANAGED_DEFAULTS.rewriteHistoryServerTools: false`
- 加入 `setAnthropicBehavior` 的 `Pick<>` allowlist
- 加入 reset 路径（L948 一带）

### 4. zod schema：`src/lib/config/schema.ts`（AnthropicConfigSchema 内）

```typescript
rewrite_history_server_tools: z
  .union([z.literal(false), z.literal("downgrade"), z.null()], {
    error: "Must be one of: false, downgrade",
  })
  .optional()
  .transform((v) => v ?? undefined),
```

### 5. 配置应用：`src/lib/config/config.ts`（applyConfigToState anthropic 段）

```typescript
if (a.rewrite_history_server_tools !== undefined) {
  setAnthropicBehavior({ rewriteHistoryServerTools: a.rewrite_history_server_tools })
}
```

### 6. ⚠️ hot-reload 守卫登记（CI 硬性要求，原 plan 漏掉）

`tests/config/config-hot-reload.it.test.ts` 有完整性守卫（每个 leaf key 必须在 FIELDS 或 EXEMPT，否则 CI fail）。该字段可热重载，必须加入 FIELDS（镜像 `system_messages_sanitize` 条目，L294-300）：

```typescript
{
  configKey: "anthropic.rewrite_history_server_tools",
  stateKey: "rewriteHistoryServerTools",
  sampleYamlValue: "downgrade",
  expectedStateValue: "downgrade",
  defaultStateValue: CONFIG_MANAGED_DEFAULTS.rewriteHistoryServerTools,
},
```

### 7. 注释加固

- `truncation.ts:341` `processToolBlocks(result, undefined)` 上方："此处独立调用不再做 server_tool 改写；依赖**上游 sanitize 已改写**，此时 server_tool_use 已是 tool_use，安全"
- `web-search-handler.ts` 顶部追加："synthesize 产物会在下一轮请求经 sanitize 的 rewriteServerToolHistory 降级（若启用），避免上游 400"

### 8. 文档：`docs/DESIGN.md`

- 运行时选项表加 `rewriteHistoryServerTools` 行
- web_search 段加"已知陷阱（自产回传 400）+ 推荐配置 + immutable thinking 边界"小节
- `config.example.yaml` / bundled `config.yaml` 的 `anthropic:` 段加注释 + 默认 `false`

### 9. 测试（TDD）

**`tests/anthropic/request-server-tool-history-rewrite.unit.test.ts`：**

- downgrade：单 server_tool_use + 配对 result → 验证**拆成 assistant(tool_use+text) + user(tool_result)**，content 文本含 query 前缀
- downgrade：错误形态 result → `tool_result{is_error:true}`
- downgrade：一条 assistant 含**多个** server_tool_use 对 → 全部 tool_result 汇入同一新 user 消息
- downgrade：覆盖 web_fetch / code_execution（按 type 匹配证据）
- **immutable thinking message（含 server_tool_use）不被改写**（policy=immutable）
- stripped policy 下含 thinking + server_tool_use → 改写生效
- false 模式 = identity no-op
- 孤儿 server_tool_use（无 result）→ 只改 use
- 孤儿 *_tool_result（在 user 消息）→ 单独转 tool_result
- server_tool_use.input 为字符串（与 parseStringifiedInput 边界一致）
- result content 为字符串（边界）
- 幂等：跑两次结果相同

**`tests/anthropic/request-server-tool-history-rewrite.it.test.ts`：**

- `rewriteHistoryServerTools:"downgrade"` + 完整 `sanitizeAnthropicMessages`：验证 processToolBlocks 不把改写后 tool_use 当孤儿
- **断言 sanitize 输出无 assistant 内 tool_result**（#1 blocker 回归保护）
- **顺序约束**：rewrite 在 processToolBlocks 之前（构造一个只有 rewrite 在前才正确的场景）
- 复现根因 fixture：含 `server_tool_use{web_search}` + 配对 result + 后续多轮 tool_use → sanitize 后无 server_tool_use 残留、消息结构合法
- false 时整管道不动
- 配合 dedup_tool_calls / system_messages_sanitize 组合健壮性

用 `autoRestoreState()` 还原 state（项目隔离纪律）。

---

## 文件改动清单

**新增：**
- `src/lib/anthropic/sanitize/rewrite-server-tool-history.ts`
- `tests/anthropic/request-server-tool-history-rewrite.unit.test.ts`
- `tests/anthropic/request-server-tool-history-rewrite.it.test.ts`

**修改：**
- `src/lib/anthropic/sanitize.ts` — 插入改写步骤
- `src/lib/state.ts` — 字段 / defaults / allowlist
- `src/lib/config/schema.ts` — zod 字段
- `src/lib/config/config.ts` — applyConfigToState 分支
- `tests/config/config-hot-reload.it.test.ts` — FIELDS 登记（CI 硬性）
- `src/lib/anthropic/auto-truncate/truncation.ts` — 注释（无行为改动）
- `src/routes/messages/web-search-handler.ts` — 注释（无行为改动）
- `docs/DESIGN.md` — 选项表 + web_search 陷阱说明
- `config.example.yaml` / `config.yaml`（bundled）— 新字段示例

---

## 暂缓项（按原则5 文档化）

- **`web_search.enabled` 自动联动改写**：当前需用户显式同时配两项。理想是 enabled 时自动开 downgrade，但引入派生配置层、破坏"配置项=行为开关"纯净语义。暂缓，文档交叉引用。
- **`"strip"` 模式**：YAGNI（损坏 result 已被孤儿过滤兜底）。enum 形态保留扩展位，未来真需要再加。
- **immutable thinking 边界**：含签名 thinking 的真实 native web_search 历史在 `immutable` policy 下不被改写（早退保护优先）。本 bug 的自产块无 thinking，不受影响；该边界仅理论存在，文档化不声称全覆盖。
- **搜索路径 outboundRequest 不记录改写形态**：orchestrator 的 hop 用 `requestContext: undefined`（`orchestrator.ts:279`），`web-search-handler` 只记 synthesized response，不调 setAttemptWireRequest。故搜索路径的改写后 wire **不进 history.outboundRequest**（仅 pass-through 路径可见）。不在本次修复范围；若需诊断搜索 hop 的 wire，另开任务给 hop 接 wire-request recording。
- **证据缺口**：原失败 entry `req_1781107963672_238` 已被 reaper 清除，未能 1:1 复算索引偏移。根因机制链路完整，修复后端到端验证关闭。

---

## 验证方式

1. `bun run test:unit -- request-server-tool-history-rewrite` 全绿
2. `bun run test:it -- request-server-tool-history-rewrite` 全绿（含 #1 回归断言 + 顺序约束）
3. `bun run test:backend` 无新失败（特别是 config-hot-reload 守卫通过）
4. `bun run typecheck` + `bun run lint:all` 全过
5. **手工端到端**（用户启动）：
   - config 加 `anthropic.rewrite_history_server_tools: "downgrade"`，重启
   - 跑一轮触发 web_search 的对话（生成 server_tool_use 历史）→ 继续至少一轮
   - 验证：上游不再 400；模型正常接续（不重复搜索）
   - history `inboundRequest.messages` 仍含 server_tool_use（客户端原样），改写仅作用于 wire
6. **subagent code review**：实施完起 reviewer 复核 diff，重点验消息拆分正确性 + 无 assistant 内 tool_result

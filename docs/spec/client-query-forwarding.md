# 客户端 query string 忠实转发 — 实现交接文档

> 状态：进行中（Step 1 + Step 2 的 state.ts 部分已落地 master）。本文件自包含，接手人无需原会话上下文即可独立执行。
> 关联：原始 plan 见 `~/.claude/plans/snuggly-wibbling-yeti.md`（内容已并入本文件）。

## 1. 背景与目标

客户端访问带 query 的完成端点（如 `/v1/messages?beta=true`）时，proxy 当前用固定模板 `${copilotBaseUrl(state)}${endpointPath}` 重建上游 URL（见 `src/lib/transport/send.ts` 的 `sendUpstreamHttp`），**客户端 query string 在这一步被静默丢弃**——既不转发给 GHC 上游，也不记入 history。

根因：`c.req.path`（Hono）不含 query（query 在 `c.req.url`/`c.req.query()`）；`RawHttpRequest`（`src/lib/pipeline/types.ts`）只携带 `path`；`wire.url` 是无 query 的 `ENDPOINT.*` 裸常量。

**目标**：让 proxy 把客户端入站 query string 忠实转发到 GHC 上游，覆盖所有 LLM 完成端点；剥离敏感/冲突 query；history 双记录「客户端原始 query」+「上游实发 query」。

## 2. 范围与策略（已与需求方确认，勿擅自更改）

- **范围**：所有 LLM 完成端点 —— Anthropic `/v1/messages`、OpenAI Chat Completions、OpenAI Responses（HTTP）、Gemini。**不含** count_tokens / embeddings / Gemini countTokens / web_search Copilot 搜索后端（见 §7 边界）。
- **策略**：忠实转发，但**始终剥离**敏感/冲突 query 键（见 §5 排除清单）。
- **配置**：默认开启 + 顶层 config 开关（类比项目 header passthrough 默认透传 + strict 开关），可热重载、登记 config 完整性矩阵。
- **「忠实」= 语义等价，非逐字节**：`URLSearchParams` 重序列化会规范化（`%20`→`+`、`?flag`→`?flag=`），对 GHC 标准 URL 解析无可观测差异；history 的 inbound 存原貌、outbound 存规范化实发，两者皆记，故原始形态不丢失。

## 3. 当前进度

### 已落地到 master
- **`1240ef4`** — Step 1：`src/lib/transport/query-forward.ts`（`filterUpstreamQuery` + `UPSTREAM_QUERY_EXCLUDE`）+ `tests/transport/query-forward.unit.test.ts`（17 测试，绿）。
- **`e424bbf`** — Step 2(部分)：`src/lib/state.ts` 加 `forwardClientQuery`（默认 `true`）+ `forwardClientQueryExclude`（默认 `[]`）字段，接进 `State` interface + `CONFIG_MANAGED_DEFAULTS` + `resetConfigManagedState` + `mutableState` + 新增 `setForwardClientQuery` setter。typecheck 绿。

### 待做
Step 2 剩余（schema.ts + config.ts + hot-reload 矩阵）+ Step 3–10。详见 §6。

### 遗留问题（需处理，勿忽略）
- **`a27cd13`** 是一个**张冠李戴**的 commit：commit message 写的是本 feature 的 forwardClientQuery，**实际内容却是另一会话（peer）的 `recoverRefusalText`→`refusalSseRewrite` 改名**（state.ts 6 行增 6 行删）。成因是共享 worktree 下 peer 的 lint-staged `reset --hard` 在「写回↔git add」间冲掉了本地改动，`git commit -- <pathspec>` 遂提交了该文件当时剩下的 peer 改动。**非数据丢失**（peer 改动安全在 commit 里），但 message 文不对题。**接手前请与仓库其他会话/维护者确认怎么处理**（留着 / 改 message / revert 重提）。

## 4. 架构：注入点与数据流

### 注入点 = 两个 driver transport adapter（覆盖三大完成端点的天然汇聚处）
两者都用 `wire.url`（= endpointPath，如 `/v1/messages`）+ `env.ctx` 调 `sendUpstreamHttp`：
- `src/lib/transport/http-transport.ts`（`createUpstreamHttpTransport` 的 `send`）—— 覆盖 Anthropic `/v1/messages`、CC `/chat/completions`、Gemini（翻译为 CC）、CC↔Responses fallback。
- `src/lib/transport/responses-transport.ts`（`sendViaHttp`）—— 覆盖 Responses `/responses` HTTP。

### 注入链（关键：主路径 ctx 在 codec.parse 内，不在 handler 入口）
1. handler 入口从 `c.req.url` 取 raw query → 经 state 开关 + `filterUpstreamQuery` 算 forwarded → 塞进构造的 `RawHttpRequest.query`。
2. `driver.runRequest(raw)` 已把 raw 整体透传给 `codec.parse(raw)`（见 `src/lib/pipeline/driver.ts` 的 `runRequest`），**driver 本体无需改**。
3. 4 个 `codec.parse` 内的 `manager.create(...)` 透传 query 给 ctx（codec 文件：`src/lib/codec/anthropic/codec.ts`、`openai-cc/codec.ts`、`openai-responses/codec.ts`、`openai-gemini/codec.ts`）。
4. web_search 旁路第 5 处 `manager.create`（`createWebSearchContext`，在 `src/routes/messages/handler-v4.ts`）同样传 query。
5. transport adapter 拼 `endpointPath: wire.url + ctx.query.forwarded`。
6. web_search 第二跳上游（独立 `src/lib/anthropic/client.ts` 的 `createAnthropicMessages`，不走 adapter）从 `reqCtx.query.forwarded` 单独拼接。

forwarded 在入口即可算（纯过滤、不依赖 retry/per-attempt 状态），故 ctx 用**只读属性** `query: { raw, forwarded }`（仿现有 `readonly path`），无需 setter。

## 5. 排除清单（敏感/冲突，安全底线，已在 `src/lib/transport/query-forward.ts` 实现）

```
UPSTREAM_QUERY_EXCLUDE = {        // 大小写不敏感比对键名
  "api-version",   // Azure 经典格式被有意忽略；GHC 非真 Azure（load-bearing：azure route 复用 CC/Responses handler）
  "key",           // Gemini/OpenAI query 形式 API key —— auth secret
  "access_token",  // Google OAuth query 凭证 —— auth secret
  "alt",           // Gemini 流式标志（alt=sse）—— proxy 用 path method 判流式
}
```

- 内置常量是**安全底线**：auth 类键恒剔除，config 只能**追加**（`forward_client_query_exclude`），不能移除内置项。
- `filterUpstreamQuery(rawSearch, extraExclude?)`：用 `URLSearchParams` 解析 → 删（内置 ∪ extraExclude）→ 重序列化；非空带 leading `?`，空返回 `""`。

## 6. 实现步骤（剩余）

### Step 2 剩余 — 配置接线
- **schema.ts**（`src/lib/config/schema.ts`）：在顶层 ConfigSchema（与 `sanitize_tool_names: nullableBoolean()` 同层）加 `forward_client_query: nullableBoolean()` + `forward_client_query_exclude: z.array(z.string()).optional()`。
- **config.ts**（`src/lib/config/config.ts` 的 `applyConfigToState`）：仿 `if (config.sanitize_tool_names !== undefined) setAnthropicBehavior(...)`，加 `if (config.forward_client_query !== undefined) setForwardClientQuery({ forwardClientQuery: config.forward_client_query })`，以及 exclude 的应用（`setForwardClientQuery({ forwardClientQueryExclude: ... })`）。每请求在 handler 入口读 `state.forwardClientQuery`，**天然热重载**。
- **hot-reload 矩阵**：登记进 `tests/config/config-hot-reload.it.test.ts` 的表驱动矩阵（否则完整性守卫 fail）。
- **DESIGN 运行时选项表**：加 `forward_client_query` / `forward_client_query_exclude` 两行（config 完整性守卫硬要求）。

### Step 3 — ctx + RawHttpRequest 携带 query
- `src/lib/pipeline/types.ts` 的 `RawHttpRequest`：加 `readonly query?: { raw: string; forwarded: string }`（仿现有 `path` 注释风格）。
- `src/lib/context/types.ts` 的 `RequestContext` 接口 + `src/lib/context/request.ts` 的 `createRequestContext`（create opts / 捕获 / 只读属性）+ `src/lib/context/manager.ts`（create 透传）。仿现有 `readonly path`（set-once、无 setter）。

### Step 4 — handler 入口提取（4 主路径 + web_search）
4 个 handler-v4（`src/routes/messages/handler-v4.ts`、`chat-completions/handler-v4.ts`、`responses/handler-v4.ts`、`gemini/handler-v4.ts`）构造 `RawHttpRequest` 处，+ `createWebSearchContext`，同一模式：
```
const raw = new URL(c.req.url).search   // 含 leading "?"，无则 ""
const forwarded = state.forwardClientQuery ? filterUpstreamQuery(raw, state.forwardClientQueryExclude) : ""
// → RawHttpRequest.query / manager.create({ query: { raw, forwarded } })
```

### Step 5 — codec.parse 透传（4 处）
4 个 `codec.parse` 的 `manager.create` 透传 `raw.query`（codec 文件见 §4 步骤 3）。

### Step 6 — transport adapter 拼上游 URL（2 处）
`http-transport.ts` 与 `responses-transport.ts`：`endpointPath: wire.url + (env.ctx.query?.forwarded ?? "")`。
**易碎契约 —— 绝不修改 `wire.url` 本身**：`errorLabelFor(wire.url)`（在 `http-transport.ts`）用 `=== ENDPOINT.*` 精确比对，必须看到干净 path；只拼到传给 `sendUpstreamHttp` 的 `endpointPath` 字段。

### Step 7 — web_search 第二跳（一致性，唯一漏网的完成端点）
`src/lib/anthropic/client.ts` 的 `createAnthropicMessages` 硬编码 `${copilotBaseUrl(state)}/v1/messages`、不走 adapter，但其调用方 `src/routes/messages/web-search-direct.ts` 的 `handleDirectAnthropicCompletion` 持 `reqCtx`。把 `reqCtx.query.forwarded` 经 `CreateAnthropicMessagesOptions` thread 进 URL 拼接，使 web_search 路径与主路径一致。

### Step 8 — history 双记录（richest-data-flow，后端完整存）
两份都进现有 gzip blob，无需新 SQLite 列：
- **inbound（raw，客户端原貌）**：`src/lib/history/types.ts` 的 inbound inline 对象加 `query?: string`；构建处在 `src/lib/context/request.ts`（读 `ctx.query?.raw`）；sink insert 投影在 `src/lib/observability/sinks/history.ts`。
- **outbound（forwarded，上游实发）**：`src/lib/history/types.ts` 的**共享 `RequestLegData`** 加 `query?: string`（outbound/effective/wireRequest 一处三生效）。`legFromWire` 的 wire 无 query 故从 ctx 读 `forwarded`——照 `outboundRequest.headers` 的两段显式投影模式（HistoryEntryData 中间表示 + sink `onTerminal`）。forwarded 入口已知，**建议 insert-time 也投影**，使流式 entry finalize 前即可见。
  - ⚠️ 已知陷阱（DESIGN「HTTP header 捕获」段有载）：sink `onTerminal` 的 outbound 投影是**逐字段显式列举**，加 leg 字段必须同步该投影点，否则 stage round-trip 丢字段。

### Step 9 — 测试
- Step 1 单元测试已含（`tests/transport/query-forward.unit.test.ts`）。
- **http 层**：仿 `tests/anthropic/anthropic-v4.http.test.ts` 的 upstream-URL 捕获 mock（mock 第一参数即完整上游 URL），把 `url.endsWith("/v1/messages")` 改 `url.includes` 并断言 `new URL(url).searchParams`：`beta=true` 出现、`api-version=x` 不出现。CC、Responses 各加一例（`tests/openai/chat-completions.http.test.ts`、`tests/responses/responses-v4.http.test.ts`）。
- **history `.it`**（用 `tests/helpers/isolated-fixture.ts` 的 `useIsolatedRuntime()`）：断 entry 的 inbound `query`=原始、outbound `query`=过滤后。
- **开关 off**：一例断不附加 query（byte-identical）。

### Step 10 — 文档同步
- DESIGN 运行时选项表加 `forward_client_query` / `forward_client_query_exclude` 行（Step 2 已要求）。
- DESIGN「活的架构现状」/「HTTP header 捕获」附近补 query 转发机制（注入点 + 排除清单 + history 双记录）。
- DESIGN「Azure 兼容端点」处「api-version 被忽略」→「被显式排除转发」。
- 评估 `docs/anthropic-compat.md`/`gemini-compat.md`/`api-endpoints` skill 是否需补。
- 收尾跨文档 grep 扫描（旧「被丢弃/忽略」措辞清零 + 新 config 项逐个核对）。

## 7. 边界（明确不转发）

- `count_tokens`（`src/routes/messages/count-tokens.ts` 打 api.anthropic.com、无 ctx）、`embeddings`（`src/lib/openai/embeddings.ts` 独立 fetch）、Gemini countTokens（本地估算，无上游）。
- **web_search Copilot 搜索后端**（第 3 个 `sendUpstreamHttp` 调用点，`src/lib/openai/responses-client.ts` 的 `createResponsesViaHttp`，被 `src/lib/anthropic/web-search/backends.ts` 消费）—— proxy 自造搜索 payload，无客户端 query 语义，不转发。
- `src/lib/openai/chat-completions-client.ts` 的 `createChatCompletions` —— 死代码（无活跃消费者），不动。
- Responses 上游 WS —— 独立连接，无 HTTP URL query 语义，跳过。

## 8. 验证

```
bun run test:backend         # 全 offline 套件（含新增 unit/http/it + config 矩阵）
bun run typecheck            # 改 .ts 必须过
bun run lint:all             # eslint --fix（项目用 eslint --fix，不直接 prettier）
```

端到端（需启动服务器，遵守项目 no-auto-server——让维护者启动）：客户端发 `/v1/messages?beta=true`，经 `/history/api/*` 查该 entry，确认 outbound leg 的 query 含 `beta=true`；发 Azure `?api-version=x` 确认 outbound 不含、inbound 含原貌；config 关闭后确认不附加。

收尾派 subagent code-review（显式裁判轴：长远正确 + 完整 + richest-data-flow，按本项目原则而非默认 YAGNI），并对 reviewer 结论亲自对照 file:line 核验。

## 9. 执行环境注意（重要 —— 这次卡住的主因不是方案）

本仓库**多并发会话共享同一主 worktree**，会有 peer 高频 `commit` / `reset --hard` / `clean -fd`，对单文件（尤其 `src/lib/state.ts`）的增量改动极度敌对：

- peer 的 lint-staged 回滚（`reset --hard HEAD`）会在你「写入↔git add」之间冲掉未提交改动。
- `git commit -- <pathspec>` 提交的是该文件**当前工作区内容**（可能已被 peer 替换），不是你刚写的——**提交前必须 `git diff --cached --name-status` 验证暂存集只有你的**（a27cd13 就是漏了这步的恶果）。
- 输出会被并发写入污染（成片 `the the the` 噪声、Read overlap 伪影、grep `binary file matches`、字节数跳变）——这是**测量被污染非文件损坏**，锚定 `git diff`/`git show` 裁决，别解读污染输出。

**建议**：接手时**第一步就开隔离 worktree**（`.worktrees/` 下，已证安全；其他会话的 worktree 存活其中），私有 index/HEAD，peer 的 reset/clean 碰不到，做完再 merge 回 master。别在 peer 活跃改 state.ts 时硬刚主树。

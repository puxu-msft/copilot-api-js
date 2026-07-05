# 忠实转发客户端 query string 到上游

## Context（为什么做）

客户端访问 `/v1/messages?beta=true`（或任何带 query 的完成端点）时，proxy 当前用固定模板 `${copilotBaseUrl(state)}${endpointPath}` 重建上游 URL（[send.ts:118](src/lib/transport/send.ts#L118)），**客户端 query string 在此被静默丢弃**——既不转发给 GHC，也不记入 history。根因：`c.req.path` 不含 query，且 `RawHttpRequest`（[types.ts:199](src/lib/pipeline/types.ts#L199)）只携带 `path`、`wire.url` 是无 query 的 `ENDPOINT.*` 裸常量。

用户希望 query 被忠实转发。已确认：**范围**=所有 LLM 完成端点（`/v1/messages` + CC + Responses HTTP + Gemini）；**策略**=排除敏感/冲突 query；**配置**=默认开启 + 顶层 config 开关（类比项目 header passthrough 默认透传 + strict 开关，可热重载、登记完整性矩阵）。

预期结果：客户端 query（如 `?beta=true`）原样到达 GHC；敏感/冲突项（`api-version`/`key`/`access_token`/`alt`）剥离；history 双记录「客户端原始 query」+「上游实发 query」。

> 本计划已经两轮对抗 subagent review + 主线实测核验修订：注入链事实、第3个 `sendUpstreamHttp` 调用点、history 共享 `RequestLegData`、`access_token` 安全缺口、测试目录归属均已订正。

## 方案概览

**注入点 = 两个 driver transport adapter**（覆盖三大完成端点的天然汇聚处，都用 `wire.url` + `env.ctx` 调 `sendUpstreamHttp`）：
- [http-transport.ts:71](src/lib/transport/http-transport.ts#L71) —— Anthropic `/v1/messages`、CC、Gemini（翻译为 CC）、CC↔Responses fallback
- [responses-transport.ts:115](src/lib/transport/responses-transport.ts#L115) —— Responses HTTP

**注入链（关键——主路径 ctx 在 codec.parse 内，非 handler 入口）**：
1. handler 入口（4 个 handler-v4 + web_search）从 `c.req.url` 取 raw query → 经 state 开关 + `filterUpstreamQuery` 算 forwarded → 塞进构造的 `RawHttpRequest.query`。
2. `driver.runRequest(raw)` 已把 raw 整体透传给 `codec.parse(raw)`（[driver.ts:138](src/lib/pipeline/driver.ts#L138)），driver 本体**无需改**。
3. 4 个 `codec.parse` 内的 `manager.create`（[anthropic:286](src/lib/codec/anthropic/codec.ts#L286)、openai-cc:286、openai-responses:311、openai-gemini:252）透传 query 给 ctx。
4. web_search 旁路第 5 处 `manager.create`（`createWebSearchContext` [messages/handler-v4.ts:237](src/routes/messages/handler-v4.ts#L237)）同样传 query。
5. transport adapter 拼 `endpointPath: wire.url + ctx.query.forwarded`。
6. web_search 第二跳上游（独立 [client.ts:126](src/lib/anthropic/client.ts#L126)，不走 adapter）从 `reqCtx.query.forwarded` 单独拼接。

forwarded 在入口即可算（纯过滤、不依赖 retry/per-attempt 状态），故 ctx 用**只读属性** `query: { raw, forwarded }`（仿 `readonly path`），无需 setter。

## 排除清单（敏感/冲突，安全底线恒生效）

新建 `src/lib/transport/query-forward.ts`：

```
UPSTREAM_QUERY_EXCLUDE = {        // 大小写不敏感比对键名
  "api-version",   // Azure 经典格式被有意忽略；GHC 非真 Azure（load-bearing，azure route 复用 CC/Responses handler）
  "key",           // Gemini/OpenAI query 形式 API key——auth secret
  "access_token",  // Google OAuth query 凭证——auth secret（reviewer 安全补漏）
  "alt",           // Gemini 流式标志（alt=sse）——proxy 用 path method 判流式
}
// 内置常量是安全底线：auth 类键恒剔除，不可经 config 移除
filterUpstreamQuery(rawSearch, extraExclude?): string
  // URLSearchParams 解析 → 删 (内置 ∪ extraExclude) → 重序列化；空返回 ""
```

**注（忠实=语义等价非逐字节）**：`URLSearchParams` 重序列化会规范化（`%20`→`+`、`?flag`→`?flag=`），对 GHC 标准 URL 解析无可观测差异。history inbound 存**原貌 raw**、outbound 存**规范化 forwarded**，两者皆记，符合 richest-data-flow。

## 实现步骤

### Step 1 — 过滤 primitive（纯函数，先 TDD）
`src/lib/transport/query-forward.ts` + `tests/transport/query-forward.unit.test.ts`（**归属 tests/transport/**，被测在 `src/lib/transport/`）：`?beta=true` 保留、`?api-version=x`/`?key=s`/`?access_token=t`/`?alt=sse` 剥离、混合仅留非敏感键、空返回 ""、大小写变体、extraExclude 并集。

### Step 2 — 配置开关（默认开 + 可关 + 可加排除）
- 顶层 config `forward_client_query: boolean`（默认 `true`）+ 可选 `forward_client_query_exclude: string[]`（默认 `[]`，与内置常量取并集）。
- `src/lib/config/` 类型 + `applyConfigToState` → `state.forwardClientQuery` / `state.forwardClientQueryExclude`。每请求在 handler 入口读 state，**天然热重载**。
- **登记 [tests/config/config-hot-reload.it.test.ts](tests/config/config-hot-reload.it.test.ts) 矩阵**（否则完整性守卫 fail）+ DESIGN 运行时选项表加行。

### Step 3 — ctx + RawHttpRequest 携带 query
- [pipeline/types.ts:199](src/lib/pipeline/types.ts#L199) `RawHttpRequest` 加 `readonly query?: { raw: string; forwarded: string }`（仿现有 `path` 注释风格）。
- [context/types.ts](src/lib/context/types.ts) `RequestContext` 接口 + [request.ts:127](src/lib/context/request.ts#L127) create opts/捕获/只读属性 + [manager.ts](src/lib/context/manager.ts) 透传。

### Step 4 — handler 入口提取（4 主路径 + web_search）
4 个 handler-v4 构造 `RawHttpRequest` 处 + `createWebSearchContext`，同一模式：
```
const raw = new URL(c.req.url).search                              // 含 leading "?"，无则 ""
const forwarded = state.forwardClientQuery ? filterUpstreamQuery(raw, state.forwardClientQueryExclude) : ""
// → RawHttpRequest.query / manager.create({ query: { raw, forwarded } })
```

### Step 5 — codec.parse 透传（4 处）
4 个 `codec.parse` 的 `manager.create` 透传 `raw.query`（[anthropic:286](src/lib/codec/anthropic/codec.ts#L286)、openai-cc:286、openai-responses:311、openai-gemini:252）。

### Step 6 — transport adapter 拼上游 URL（2 处）
[http-transport.ts:71](src/lib/transport/http-transport.ts#L71)、[responses-transport.ts:115](src/lib/transport/responses-transport.ts#L115)：`endpointPath: wire.url + (env.ctx.query?.forwarded ?? "")`。
**易碎契约——绝不修改 `wire.url` 本身**：`errorLabelFor(wire.url)`（[http-transport.ts](src/lib/transport/http-transport.ts) `errorLabelFor`）用 `=== ENDPOINT.*` 精确比对，必须看到干净 path；只拼到传给 `sendUpstreamHttp` 的 `endpointPath` 字段。

### Step 7 — web_search 第二跳（一致性，唯一漏网完成端点）
[client.ts:126](src/lib/anthropic/client.ts#L126) 从 `reqCtx.query.forwarded` 经 `CreateAnthropicMessagesOptions` thread 进 URL 拼接（reqCtx 在 [web-search-direct.ts:125](src/routes/messages/web-search-direct.ts#L125) 可达）。

### Step 8 — history 双记录（richest-data-flow）
两份都进现有 gzip blob，无新 SQLite 列：
- **inbound（raw，客户端原貌）**：[history/types.ts:271](src/lib/history/types.ts#L271) inbound inline 对象加 `query?: string`；构建处 [request.ts:569](src/lib/context/request.ts#L569) 读 `ctx.query?.raw`；sink insert 投影 [history.ts:195](src/lib/observability/sinks/history.ts#L195)。
- **outbound（forwarded，上游实发）**：[history/types.ts:190](src/lib/history/types.ts#L190) **共享 `RequestLegData`** 加 `query?: string`（outbound/effective/wireRequest 一处三生效）；`legFromWire` 的 wire 无 query 故从 ctx 读 `forwarded`——照 `outboundRequest.headers` 的两段显式投影模式（HistoryEntryData 中间表示 + `onTerminal` [history.ts:266/284](src/lib/observability/sinks/history.ts#L266)）；forwarded 入口已知，**insert-time（history.ts:195）也投影**使流式 entry finalize 前即可见。

### Step 9 — 测试
- Step 1 单元测试（已含）。
- http 层：仿 [anthropic-v4.http.test.ts:147](tests/anthropic/anthropic-v4.http.test.ts#L147) 的 upstream-URL 捕获 mock（mock 第一参数即完整上游 URL），`url.includes("/v1/messages")` + `new URL(url).searchParams` 断 `beta=true` 在、`api-version` 不在。CC、Responses 各一例。
- history `.it`（**用 `useIsolatedRuntime()`**）：断 entry inbound `query`=原始、outbound `query`=过滤后。
- 开关 off 时 byte-identical（不附加 query）一例。

### Step 10 — 文档同步（completion-includes-doc-sync）
- DESIGN **运行时选项表加 `forward_client_query` / `forward_client_query_exclude` 行**（config 完整性守卫硬要求）。
- DESIGN「活的架构现状」/「HTTP header 捕获」附近补 query 转发机制（注入点 + 排除清单 + history 双记录）。
- DESIGN Azure 处「api-version 被忽略」→「被显式排除转发」；`gemini-compat.md`/`anthropic-compat.md` 评估是否补。
- **收尾跨文档 grep 扫描**（旧「被丢弃/忽略」措辞清零 + 新 config 项逐个核对）。

## 边界（明确不转发）

- `count_tokens`（[count-tokens.ts:50](src/routes/messages/count-tokens.ts#L50) 打 api.anthropic.com、无 ctx）、`embeddings`（[embeddings.ts:22](src/lib/openai/embeddings.ts#L22) 独立 fetch）、gemini countTokens（本地估算）。
- **web_search Copilot 搜索后端**（第3个 `sendUpstreamHttp` 调用点 [responses-client.ts:94](src/lib/openai/responses-client.ts#L94)，被 [backends.ts:230](src/lib/anthropic/web-search/backends.ts#L230) 消费）——proxy 自造搜索 payload，无客户端 query 语义，不转发。
- `chat-completions-client.ts:56`——死代码（无活跃消费者），不动。
- Responses 上游 WS——独立连接，无 HTTP URL query 语义。

## 验证

```
bun run test:backend         # 全 offline 套件（含新增 unit/http/it + config 矩阵）
bun run typecheck
bun run lint:all             # eslint --fix
```

端到端（需用户启动服务器，遵守 no-auto-server）：客户端发 `/v1/messages?beta=true`，经 `/history/api/*` 查 entry，确认 outbound leg query 含 `beta=true`；发 Azure `?api-version=x` 确认 outbound 不含、inbound 含原貌；config 关闭后确认不附加。

收尾派 subagent code-review（显式裁判轴：长远正确 + 完整 + richest-data-flow，按本项目原则非默认 YAGNI），reviewer 结论亲自对照 file:line 核验。

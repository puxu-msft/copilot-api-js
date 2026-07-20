# 借鉴 copilot-bridge 的四项特性 — 设计文档

> 日期：2026-06-05
> 来源对标：[`betaHi/copilot-bridge`](https://github.com/betaHi/copilot-bridge)（`betaHi/copilot-api` 的后继项目，已废弃 copilot-api）
> 状态：设计已与用户确认，待 spec 评审后进入实现

## 背景

竞品 copilot-bridge 在「请求兼容性适配」层有几处本项目缺失的能力。本设计移植其中 4 项，**适配本项目既有架构与原则**（不照搬其架构——它没有我们的 History/WebSocket/TUI/sanitize 管道/config 热重载）。

四项特性彼此独立，按复杂度分 4 个 phase 实现。

| Phase | 特性 | 默认 | 配置开关 |
|---|---|---|---|
| 1 | #2 上游 schema 诊断 | **常开** | 无开关 |
| 2 | #1 按模型 tool name 清洗映射 | **关闭** | `anthropic.sanitize_tool_names` |
| 3 | #4 setup-codex 命令 | N/A（CLI 子命令） | 无 |
| 4 | #3 web_search 双跳实现 | **关闭** | `web_search.{enabled,backend}` |

## 已确认的设计决策（用户拍板）

1. **#3 web_search 后端** = Copilot Responses 搜索模型 + 本地 SearXNG（**不含** Copilot CLI）。
2. **#3 质量模型** = 双跳（真 Anthropic 语义：搜索结果回填后由主模型二次生成）。
3. **#3 路径范围** = 仅 Anthropic/Claude 路径做双跳编排；**codex/Responses 路径保持现状透传**给上游 gpt-5.5（原生支持 web_search_preview）。
4. **#1 路径范围** = 三条路径全覆盖（Anthropic + Chat Completions + Responses）。
5. **#4 配置路径** = `~/.codex/config.toml`（尊重 `CODEX_HOME`），并修正 README（现写 `~/.openai/config.toml` 有误）。
6. **默认状态** = #1/#3 默认关闭（opt-in，保持现有行为）；#2 诊断常开无开关。

---

## Phase 1 — #2 上游 tool-schema 诊断（常开）

### 目标
当上游返回模糊 400 时，自动扫描发送的 tools，标记 Copilot 上游容易拒绝的 JSON Schema 关键字和非法 tool name，把诊断信息附到错误日志、错误响应与 History，帮助用户定位 400 根因。**仅提示（suspicious），不阻断、不改写请求。**

### 新建模块 `src/lib/upstream-diagnostics.ts`
纯函数，无 fs/网络。复用 `src/lib/gemini/schema-normalize.ts:48` 的递归遍历 + 深度/循环守卫模式（`MAX_SCHEMA_DEPTH`、`WeakSet`）。

```
export interface ToolDiagnostics {
  count: number
  invalidNames?: Array<string>                       // 不匹配 ^[A-Za-z0-9_-]{1,64}$
  suspiciousSchemas?: Array<{ name: string; keys: Array<string> }>  // path 形式，如 "$.properties.x.oneOf"
}
```

- suspect 关键字集合：`$defs`、`oneOf`、`allOf`、`patternProperties`、`if`、`then`、`else`、`not`、`definitions`、`dependentRequired`、`dependentSchemas`。
- 两个 extractor 归一化 tool 形态：
  - Anthropic：`{ name, input_schema }`
  - OpenAI：`{ function: { name, parameters } }`
- 输出上限：每类最多 `MAX_DIAGNOSTIC_ITEMS = 8` 条，避免日志爆炸。
- `count === 0` 或非数组 → 返回 `undefined`。

### 数据流（遵循richest-data-flow：数据以最丰富形式流动）
诊断必须在 **client 层**生成（此处 wire tools 最完整；到 `forwardError` 已丢失 tools）。

1. **生成点**（三个 client 的 400 分支）：
   - `src/lib/anthropic/client.ts:111-127`（`!response.ok && status === 400`）
   - `src/lib/openai/chat-completions-client.ts:66-69`
   - `src/lib/openai/responses-client.ts:309-312`
   仅在 `status === 400` 时跑诊断（避免无谓开销）。
2. **传播**：扩展 `src/lib/error/http-error.ts` 的 `HTTPError`，加可选字段 `diagnostics?: ToolDiagnostics`（构造参数 + 字段）。client 抛错时附上。
3. **消费（日志 + 响应）**：`src/lib/error/forward.ts` 通用 400 分支（`:424-430`）读取 `error.diagnostics`，`consola.warn` 输出，并可选附进错误响应 body（放入 error 详情字段，不破坏标准错误信封）。
4. **持久化（History）**：在 route catch 处经 `RequestContext.addWarningMessage()`（`src/lib/context/request.ts:199`）写入 `HistoryEntry.warningMessages`，`code: "upstream_schema_diagnostic"`，message 携带诊断 JSON。**零 DDL 改动**，复用现有 WebSocket 推送与前端渲染。

### 改动清单
| 文件 | 改动 |
|---|---|
| `src/lib/upstream-diagnostics.ts` | 新增 |
| `src/lib/error/http-error.ts` | 加 `diagnostics?` 字段 + 构造参数 |
| `src/lib/anthropic/client.ts` | 400 分支调用诊断、附进 HTTPError |
| `src/lib/openai/chat-completions-client.ts` | 同上 |
| `src/lib/openai/responses-client.ts` | 同上 |
| `src/lib/error/forward.ts` | 通用 400 分支消费 diagnostics |
| route handler（messages / chat-completions / responses） | catch 处写入 `reqCtx.addWarningMessage`（可选但推荐） |
| `tests/` | 诊断单测（关键字检测、非法 name、两格式归一） |

### 风险
- **误报**：部分模型支持 `$defs/allOf`。文案严格用 "suspicious" 非 "invalid"（best-complete-solution 命名反映职责）。
- **诊断对象**：必须跑在发上游的 **wire tools**（已经过 stub 注入/stripServerTools）而非客户端原始 tools，否则与上游实际收到的不一致。client 层注入点正好满足。

---

## Phase 2 — #1 按模型 tool name 清洗映射（默认关闭）

### 目标
当 tool 名含非法字符（点号等）、超长（>64/128）或冲突时，按目标模型的约束清洗成合法名发往上游，响应里再还原为客户端原始名。覆盖 Anthropic + Chat Completions + Responses 三条路径。

### 核心洞察：确定性 → 无状态多轮一致
清洗是**确定性**的（同一原始名 → 同一清洗名，基于 sha1 截断）。Claude Code/客户端每轮都发完整 tool 定义，所以**每请求用当前 tool 定义无状态重建双向映射表**即可，跨轮自动一致，无需持久化。请求侧用映射表改名，响应侧用同一张重建的表反查还原。

### 新建：模型分类
`src/lib/models/resolver.ts` 加 `getModelClass(modelId, vendor?) → "gemini" | "gpt" | "claude" | "default"`。判定优先用运行时 `Model.vendor`（`state.modelIndex.get(model)?.vendor`），name 启发式（`/^gpt-/`、`/gemini/`）作为模型不在 index 时的回退。

per-model 规则（移植竞品 `tool-names.ts`）：

| class | 允许点号 | name 上限 |
|---|---|---|
| gemini | 是 | 128 |
| gpt | 是 | 128 |
| claude / default | 否 | 64 |

### 新建：tool-name mapper
新建模块（如 `src/lib/tool-name-mapper.ts`），移植竞品逻辑：
- 清洗：非法字符 → `_`、压缩连续 `_`、首尾去 `_`、空则 `"tool"`。
- 超长：`前缀_sha1(name)[:10]`。
- 冲突去重：候选已占用则追加 `_sha1(name:index)` 后缀循环。
- `createToolNameMapper(tools, { allowDots, maxNameLength })` → `{ toUpstream(name), toClient(name) }` 双向。

### 关键约束：只清洗客户端原始自定义 tool
**绝不触碰**系统注入的 stub（Task/Bash 等 PascalCase）、`tool_search_tool_regex`、server tool（web_search 等）——它们是上游协议契约，改名会破坏功能。映射快照必须在 `preprocessTools`（`src/lib/anthropic/message-tools.ts:272`）注入 stub **之前**对客户端原始 tools 建立。

### 与现有 name 修正合并（最高耦合点）
`src/lib/anthropic/sanitize/tool-blocks.ts:43-116` 已有 tool_use name 的大小写修正逻辑（`nameMap` + `fixedNameCount`）。新的清洗映射也改 tool_use name——**两套 name 改写必须在同一处统一定序**，避免「先清洗成 X，又被大小写修正改回 Y」。在 `tool-blocks.ts` 内整合。

### Mapper 挂载点
方案 A（推荐，改动小）：扩展 `RequestContext`（`src/lib/context/types.ts` + `request.ts`）加 `toolNameMapper?` 字段 + setter/getter。流式/非流式 response handler 已接收 `reqCtx`，可从中取回 mapper 还原。
> 注：会给以 history 为主职责的 RequestContext 加非 history 字段。实现 agent 若认为污染过重，可改用方案 B（函数参数显式穿透），二者皆可，留实现时定。

### 三条路径的请求改名 / 响应还原点

| 协议 | 请求改名点 | 响应还原点（非流式） | 响应还原点（流式） |
|---|---|---|---|
| Anthropic | `tool-blocks.ts` + tool 定义 | `messages/handler.ts:642-672`（`content[].name`） | `messages/handler.ts:630` `serverToolFilter.rewriteEvent`（**现成钩子**，`content_block_start.content_block.name`） |
| Chat Completions | `openai/sanitize.ts` 前后新建步骤（`tools[].function.name`、`tool_calls[].function.name`） | `chat-completions/handler.ts:510-527`（`choices[].message.tool_calls[].function.name`） | `chat-completions/handler.ts:604`（**透传，需新建逐事件 data 改写**） |
| Responses | 请求 `tools[].name` | `responses/handler.ts:237-257`（`function_call.name`） | `responses/handler.ts:295-313`（**透传，仿 `stream-id-sync.ts` 的 fixStreamEventIds 模式新建**） |

**translate 层（`src/lib/openai/translate/`）不做映射**——它只搬运 name，在协议入口改名、出口还原，translate 层透明传递。

### 配置开关 `anthropic.sanitize_tool_names`（默认 false）
标准 anthropic 布尔开关，6+1 处改动（以 `strip_read_tool_result_tags` 为模板）：
1. `src/lib/config/schema.ts` `AnthropicConfigSchema` 加 `sanitize_tool_names: nullableBoolean()`
2. `src/lib/state.ts` State 接口加 `readonly sanitizeToolNames: boolean`
3. `setAnthropicBehavior` 的 Pick 联合加 `| "sanitizeToolNames"`
4. `CONFIG_MANAGED_DEFAULTS` 加 `sanitizeToolNames: false`
5. `mutableState` 初始化加字段
6. `resetConfigManagedState` 加重置项
7. `src/lib/config/config.ts` `applyConfigToState` 加 apply
   + `tests/component/config-hot-reload.test.ts` 登记新字段（完整性守卫，不登记 CI fail）
   + bundled `config.yaml` / `config.example.yaml` 加键
   + `docs/DESIGN.md` 运行时选项表加行

### 风险
- 流式还原不对称：Anthropic 有现成 `rewriteEvent`；CC/Responses 流式是字节透传，需新建逐事件「解析 data → 改写 name → 重序列化转发」机制（Responses 仿 `src/lib/openai/stream-id-sync.ts` 的成熟先例）。
- 冲突去重需考虑 sha1 截断碰撞（竞品已处理）。
- 历史消息中的 tool_use name：因映射确定性，历史轮的名字与当前轮一致重建，无需特殊处理。

---

## Phase 3 — #4 setup-codex 命令

### 目标
新增 `copilot-api setup-codex` 子命令，自动把本代理写入 `~/.codex/config.toml` 的托管块，使 Codex CLI 无需手动配置即可指向本代理。

### 新建 `src/setup-codex.ts`（citty command）
镜像 `src/setup-claude-code.ts` 结构（args/run、模型解析、port/host 拼 URL）。数据获取链复用：`ensurePaths` → `applyConfigToState` → `cacheVSCodeVersion` → `initTokenManagers` → `cacheModels` → `state.models.data`。`src/main.ts` 注册子命令（import + `subCommands` 加一行）。

### 新建 `src/lib/codex-config.ts`（手写 managed-block，不引 TOML 依赖）
理由：保留用户注释/排版（best-complete-solution），对齐竞品，TOML 序列化器无法 round-trip 注释。

```
# >>> copilot-api managed block — auto-generated, do not edit between markers >>>
[model_providers.ghc]
name = "ghc"
base_url = "http://localhost:4141/v1"
wire_api = "responses"
preferred_auth_method = "apikey"
# <<< copilot-api managed block — edits outside this block are preserved <<<
```

写入算法：
1. 读 `~/.codex/config.toml`（不存在→空串；**读失败→保留原文件不覆盖**，比现有 setup-claude-code 退回空对象更稳健）。
2. 识别并迁移 legacy marker（若有旧版标记，整块删除避免重复）。
3. 正则切出当前版本 marker 块替换；无则追加。
4. **duplicate-key 防护**：user-owned scalar（`model`、`model_reasoning_effort`）排除在托管块外；轻量正则探测块外是否已有这些顶层 key，避免 TOML duplicate-key。
5. 块外用户内容逐字节保留。
6. 原子落盘。

### 新建 `atomicWriteText(path, content)`
从 `src/lib/atomic-fs.ts` 的 `atomicWriteJson` 提取 temp+rename 骨架，参数改为已序列化字符串，JSON/TOML 共用（DRY）。

### codex 路径解析（放 `src/lib/config/paths.ts`）
```
const codexHome = process.env.CODEX_HOME?.length ? process.env.CODEX_HOME : path.join(os.homedir(), ".codex")
// PATHS.CODEX_CONFIG_TOML = path.join(codexHome, "config.toml")
```

### reasoning effort
默认从 `model.capabilities.supports.reasoning_effort`（`src/lib/models/capabilities-mapper.ts:100`）取，交互可选；写入托管块外的 user-owned scalar 或交由用户。

### README 修正
`README.md:117-139` 的 codex 段：`~/.openai/config.toml` → `~/.codex/config.toml`，并说明可用 `setup-codex` 自动写入。

### 不回填 managed-block 给 setup-claude-code
JSON 键级合并已够，YAGNI。（可顺手修 setup-claude-code 解析失败退回空对象丢用户内容的隐患——独立小修，与本特性无关，留待用户单独确认。）

---

## Phase 4 — #3 web_search 双跳（默认关闭，仅 Anthropic 路径）

### 目标
当客户端请求含 native web_search server tool 且 `server_tool_web_search.enabled` 时，拦截请求、执行真实搜索、把结果回填后由主模型二次生成，合成标准 Anthropic 响应（含 server_tool_use + web_search_tool_result + text）返回。

### 配置（顶层 section `server_tool_web_search`，默认关闭）
```yaml
server_tool_web_search:
  enabled: false
  backend: ""   # "" / "<copilot-responses-search-model, 如 gpt-5.5>" / "searxng"
```
新建 `WebSearchConfigSchema`（参考 `HistoryConfigSchema`），注册到 `ConfigSchema`，State 接口 + `CONFIG_MANAGED_DEFAULTS` + apply + `resetConfigManagedState` + 热重载测试登记 + bundled config + DESIGN.md。
> 注意：`config.yaml` / `ghc_api_base_url` / `rate_limiter` 不热重载的字段不受影响；web_search 走标准热重载。

### 触发与拦截点
`src/routes/messages/handler.ts:118` `handleMessages` 内，model 解析 + reqCtx 创建 + preprocess 之后、`handleDirectAnthropicCompletion`（`:198`）之前：
- 判断 `server_tool_web_search.enabled` 且 payload.tools 含 `isServerToolType(t.type)` 且 `type.startsWith("web_search_")`（或 Claude Code `WebSearch` 工具）。
- 命中 → 走新建的 `handleWebSearchCompletion`，否则原路。

### 双跳流程（新建 `src/lib/anthropic/web-search/` 模块）
1. **第一跳**：把 native web_search 替换为普通 `web_search(query)` function tool，经正常 `executeRequestPipeline` 调主模型（**保留 token 刷新/限流/重试**）。检测响应是否含 web_search 的 tool_call（参考竞品 `getClaudeWebSearchToolCallFromChatResponse`）。
2. **执行搜索**（backend 二选一）：
   - **Copilot Responses 搜索模型**：复用 `createResponses`（`src/lib/openai/responses-client.ts:83`），强制非流式 HTTP（`createResponsesViaHttp`），payload `{ model: <search-model>, input, tools:[{type:"web_search_preview"}], stream:false }`。复用 `copilotBaseUrl`/`copilotHeaders`。
   - **SearXNG**：全局 `fetch(http://localhost:8080/search?q=...&format=json)` + `createFetchSignal()`（代理/超时自动）。可达性预检（800ms readiness）。
   - 解析结果为 `Array<{ title, url, snippet? }>`（上限 8）。
3. **回填 + 第二跳**：把 `web_search_tool_result` 注入对话 messages，再调主模型（同样走 pipeline）生成最终文本。
4. **合成响应**（模板抄 `src/lib/anthropic/warmup.ts` 的流式+非流式合成）：
   - block 序列：`server_tool_use`（query）→ `web_search_tool_result`（results）→ `text`（第二跳输出）。
   - 字段形状照 `src/lib/anthropic/stream-accumulator.ts:224-258`（保证 accumulator 能回读、History 正确）。

### 关键设计点
- **绕过 server-tool-filter**：`src/lib/anthropic/server-tool-filter.ts` 无条件过滤 `server_tool_use`/`*_tool_result`。web_search 合成路径**不走** `handleDirectAnthropic*Response`（它们在 `:630`/`:670` 强制过滤），用独立发送函数让结果 block 对客户端可见。
- **流式时序**：立即发 `message_start`（避免客户端 `streamIdleTimeout`/undici bodyTimeout），搜索完发 result block，第二跳真流式转发 text。
- **计费合并**：两跳 + 搜索的 usage 合并进最终 `usage`（参考 `usage.server_tool_use`）。
- **History 完整性**：合成路径正确调 `reqCtx.complete(buildAnthropicResponseData(acc, model))` + `setSseEvents`；搜索子请求的 payload/timing 也记录（richest-data-flow）。流式路径自己 accumulate（合成事件喂 `accumulateAnthropicStreamEvent`）。
- **搜索轮数 v1 上限 = 1 轮**（一次搜索 → 一次生成；多轮搜索循环留后续）。
- **第二跳复用 pipeline**：搜索是独立子请求，但回填后的主模型生成调用复用 `createAnthropicMessages` + pipeline，保证 token 刷新/限流不失效。

### codex/Responses 路径
**保持现状透传**（`src/routes/responses/` 的 web_search_preview 已透传给上游 gpt-5.5，原生支持）。v1 不改。

### 实现实况与暂缓项（v1 落地后更新，architecture-health-first）

已落地（含 review 修复）：
- 拦截、双跳编排、两后端（Copilot Responses / SearXNG）、合成（server_tool_use→result→text）、绕过 server-tool-filter、关闭态短路、配置 + 热重载、History warning 记录。
- **H1 修复**：两跳经 `callMainModel` 包装 `createAnthropicMessages`，在 401/403 时复用 `getCopilotTokenManager().refresh()` 做一次 token 刷新重试（此前 createAnthropicMessages **不做** token 刷新，token 过期会高频失败）。
- **H2 修复**：第一跳与第二跳都跑 `sanitizeAnthropicMessages`，避免历史孤儿 tool block 触发上游 400（此前仅第二跳 sanitize，不对称）。
- **M1 修复**：流式路径先进入 `streamSSE` 再发 `ping` 事件 flush 响应头并复位客户端 idle 时钟，然后才跑编排（此前编排在进入 stream 前跑完，期间零字节）。
- **M2 修复**：`transition("streaming")` 移到 `complete()` 之前，符合正常流式状态机顺序。

**暂缓项（需未来决策，完整记录）：**

1. **两跳走完整 `executeRequestPipeline`**（最大暂缓）。
   - 当前行为：两跳走 `callMainModel`（= `createAnthropicMessages` + 一次性 token 刷新）。**已有** token 刷新；**缺** 自适应限流（adaptive rate limit）、network-retry、auto-truncate、deferred-tool-retry、unsupported-beta-retry。
   - 根因：`executeRequestPipeline` 与单请求的 `reqCtx`/adapter/strategies 深度耦合（adapter 闭包持有 headersCapture/betaProbe，pipeline 内部驱动 reqCtx 状态机与 history 记录）。在双跳内对每一跳再起一条 pipeline，会与 orchestrator 自身管理的 reqCtx.complete 冲突（双重记录、状态机错乱）。
   - 理想架构：抽出一个「无 reqCtx 副作用的 runOneAnthropicCompletion(payload, strategies)」纯执行器，pipeline 与 history 记录解耦，使子完成（hop）可独立复用全套 strategies；orchestrator 只在最终合成时记一次 history。
   - 为何暂缓：该解耦是 request pipeline 的结构性重构，影响所有 Anthropic 请求路径，超出本特性范围，需单独 spec + 回归。
   - 实际影响：web_search 双跳在上游限流/网络抖动/超长上下文时不会自动退避/截断重试，会直接失败（普通请求有这些兜底）。token 过期已兜底。

2. **搜索子请求的完整 payload/timing 入 History**（M3）。
   - 当前：搜索子请求仅以 `web_search_subrequest` warning 摘要（backend/query/model/resultCount/usage）记录，**无** wire payload / 原始响应 / 逐阶段 timing。
   - 理想（richest-data-flow 完整存储）：History schema 增加「子请求」关联结构，记录搜索的完整请求/响应/timing，供前端 debug 视图复盘「为什么搜索没返回结果」。
   - 为何暂缓：需扩展 History schema（types + sqlite/serialize + 前端类型 re-export），是 History 系统的结构性变更，超出本特性范围。

3. **SearXNG base URL 可配**（L2）。
   - 当前：`DEFAULT_SEARXNG_BASE_URL = "http://localhost:8080"` 硬编码（与设计一致）。
   - 理想：`web_search.searxng_url` 配置项覆盖端口/地址。
   - 为何暂缓：v1 仅支持本地默认部署；多 SearXNG 实例/远程部署是后续需求。

### 风险（v1 已知）
- 暂缓项 1 导致的限流/重试缺失（见上，token 刷新已兜底）。
- 流式为「合成一次性输出」而非真实增量流（设计有意降风险）；超过客户端 idle 超时（undici 默认 5min）的极慢双跳理论上仍可能断连——`ping` 仅在进入 stream 时发一次，未做周期心跳。
- 双跳计费合并依赖两跳 + 搜索 usage 字段齐全。

---

## 测试策略（所有 phase）
- 单元测试（Bun，`tests/`）：诊断扫描、name 清洗/去重/还原、managed-block 写入/迁移/duplicate-key、web_search 后端解析/结果解析/合成事件序列。
- 组件测试：config 热重载矩阵（#1 开关、#3 section 必须登记）。
- 不自动启动服务器（no-auto-server-no-kill）；服务器行为验证交用户。
- 修改 `.ts`/`config schema` 后运行 `bun run typecheck`、`bun run lint:all`、`bun test`（verify-only-on-executable-changes）。

## 实现顺序
Phase 1 → 2 → 3 → 4（复杂度递增，彼此独立）。每个 phase：实现 → code-review → 独立审核（reviewer 输出再批判性复核，见 memory）。

# 设计文档

编码风格、注释规范与编码/架构约定见 [coding-conventions.md](./coding-conventions.md)。

## 架构

### 运行时兼容（Bun-first / Node-compatible）

项目同时支持 Bun 与 Node 两个运行时，但**优先级不对称**：

- **Bun 是一等公民**——默认/推荐运行时。所有开发与运行命令（`dev` / `start` / `test:*`）都走 `bun`，`bun test` 是唯一被 CI 实测的后端套件。
- **Node 仅是有意维护的兼容目标**——分流路径靠运行时逻辑保证，但实测覆盖弱于 Bun（Node 专属分支在 `bun test` 下走不到，例如 driver.ts 的 `nodeFactory()`）。

所有运行时差异都收敛到单一判别点 `typeof globalThis.Bun !== "undefined"`，分流出独立实现：

| 子系统 | Bun 路径 | Node 路径 | 文件 |
|--------|----------|-----------|------|
| HTTP 服务器 | `Bun.serve()` | `@hono/node-server` | `lib/serve.ts` |
| WebSocket | `hono/bun` | `@hono/node-ws` | `lib/ws/adapter.ts` |
| SQLite | `bun:sqlite` | `node:sqlite`（Node ≥22.5） | `lib/history/sqlite/driver.ts` |
| 上游 fetch / keepalive | **https → `node:http2`**（h2 session 池 + Response 适配器 + createConnection `setKeepAlive`）；http → `undici/index.js`（子路径绕 Bun shim） | https → `node:http2`；http → `undici/index.js`（Node 本就真 undici） | `transport/http2-client.ts` / `transport/upstream-fetch.ts` / `lib/proxy.ts`，见 [bun-runtime-timeout.md](bun-runtime-timeout.md) |
| 代理 | undici dispatcher（ProxyAgent / EnvProxyDispatcher，经 upstream-fetch 显式传） | 同左 + `setGlobalDispatcher` | `lib/proxy.ts` |

#### 依赖选型原则：bun-first

所选外部库本身**必须能在 Bun 下原生工作**——判据是"Bun 热路径上的库 Bun 原生可跑"，而非"禁止任何 node-only 依赖"：

- **拒绝 node-gyp 原生绑定（`binding.gyp`）**——Bun 兼容性最大的雷区。标杆实例：driver.ts 刻意不用 `better-sqlite3`（Bun 1.3 加载时直接拒绝 "not yet supported in Bun"），改用两端各自的内建 SQLite，避免用户在安装时被迫二选一。
- **node-only 库可作兼容路径，但不得进 Bun 热路径**——`@hono/node-server`、`@hono/node-ws` 只在 Node 分支被动态 `import()`。**上游 https 热路径走内建 `node:http2`**（`transport/http2-client.ts`）：Bun 的 undici HTTP 解析层对 GHC h2 端点的 chunked HTTP/1.1 响应永久挂（裸 `node:tls` 收齐字节、Node 同码 0.4s、curl 0.4s——是 undici-on-Bun 的解析 bug），而所有 https 上游皆 h2-native，故改走 node:http2（h2 + `createConnection` 上 `setKeepAlive`，`ss` 实证 idle socket 带 keepalive timer）。**`undici` 经 `undici/index.js` 子路径仅留给明文 `http://`**（本地 SearXNG）——纯 JS、无 node-gyp；走子路径是因为 Bun 把裸 `undici` 替换为内建 shim 会静默丢弃 dispatcher。pin undici 7（8 的 index.js 在 Bun 崩）。详见 [bun-runtime-timeout.md](bun-runtime-timeout.md) 与 [rfc/upstream-http2-transport.md](rfc/upstream-http2-transport.md)。
- **审计手段（实测，非推断）**：`find node_modules -name binding.gyp` 应为空（零 node-gyp 依赖）；`find node_modules -name "*.node"` 命中的 `@rollup` / `@rolldown` / `@oxc-*` 都是**构建工具**预编译产物，只在构建期用、不进运行时 dist，不算违反。

### 入口点

- `src/main.ts` - CLI 入口（citty），子命令：`start`、`login`（别名 `auth`）、`logout`、`debug`、`list-claude-code`、`setup-claude-code`
- `src/start.ts` - 服务器启动：认证、模型缓存，启动 Hono 服务器（经 `lib/serve.ts`：Bun → `Bun.serve()`，Node → `@hono/node-server`）
- `src/server.ts` - Hono 应用配置，注册所有路由

### 请求流程

v4 管线：路由按前缀选 **codec**（每格式一个）+ 构建 per-request **driver**，由 driver 编排七阶段（S1–S7）。详见 [v4 设计文档](v4/01-architecture.md) 与 [03-spec/](v4/03-spec/)。

1. 请求进入 `src/routes/` 中的 Hono 路由（`route.ts` 薄包装：try/catch + forwardError，直调 v4 handler）。
2. handler 按接入格式选 codec（`lib/codec/`：`anthropic` / `openai-cc` / `openai-responses` / `openai-gemini`）+ 构建 driver（`createPipelineDriver`，consume codec + transport + retry strategies + rewrite registry），调 `driver.runRequest` / `driver.runResponse`。
3. driver 编排**七阶段**（`lib/pipeline/driver.ts`，详见 [03-spec/envelope-driver.md](v4/03-spec/envelope-driver.md)）：
   - **S1 parse** — `codec.parse(raw)` → `RequestEnvelope`（model 解析、body 提取、建 RequestContext）
   - **S2 route/translate** — `codec.decideRoute`（透传/翻译/拒绝，统一 4 格式判断）+ `codec.translateOut`（透传=identity）
   - **S3 rewrite-in** — `runRewriteIn`：请求改写链（registry 按 format+config+order 装配）
   - **S4 exchange** — `runExchange`：错误驱动重试循环（`codec.prepareWire` → `transport.send` → 失败时首个匹配 strategy 改写 env 重试；429 由 adaptive rate-limiter 在 transport 内消化）
   - **S5 rewrite-out** — 响应改写链（逐帧 transform/buffer/flush）
   - **S6 render** — `codec.renderResponse` 翻回客户端协议（透传=identity）
   - **S7 forward** — handler 写回客户端（streamSSE / JSON / WS frame）
4. driver 在阶段边界采样原始数据 → observability bus → sinks（History/Ws/Console/Telemetry/File）：S1 入站、S4 per-attempt 双轨（effective/wire + queueWaitMs）+ **上游原始 sseEvents**（循环顶逐帧，所有格式统一）；客户端 forwarded 由 handler 在写回点采样（Gemini 整流翻译 / Anthropic heartbeat 不经 driver yield 点，见 [03-spec/envelope-driver.md §4](v4/03-spec/envelope-driver.md)）。
5. Anthropic 直连为 **bypass-direct**（translate/render=identity，driver 逐字透传上游 SSE）；非 Anthropic vendor 模型在 S2 拒绝 400（无降级）。
6. **Azure**：`injectDeploymentModel` 从 URL path 注入 `azureModelOverride`，复用 CC/Responses 的 v4 handler（不新增 codec）。
7. **例外**（不进 driver）：web_search 双跳（Anthropic opt-in，正交控制流，走 legacy direct-completion `handleDirectAnthropicCompletion`，P2.6-D1 暂缓）；`count_tokens`（Anthropic/Gemini，本地 tokenizer，无管线）；embeddings（无 history/重试需求）。
8. 请求完成 / 失败时一次性写入 SQLite，否则仅更新内存 in-flight 映射并推送 WebSocket。

### 核心模块

```
src/lib/
├── state.ts               # 全局运行时状态（所有配置集中管理）
├── error.ts               # HTTPError 类，错误转发与格式化，Retry-After 解析
├── stream.ts              # 通用流工具（raceIteratorNext、StreamIdleTimeoutError、combineAbortSignals）
├── shutdown.ts            # 优雅关闭（drain + abort signal）
├── copilot-api.ts         # Copilot API 公共工具（endpoint URL 构建等）
├── fetch-utils.ts         # HTTP fetch 封装（超时、代理、错误处理）
├── proxy.ts               # HTTP/HTTPS 代理配置
├── repetition-detector.ts # 流式重复性检测（KMP 算法）
├── adaptive-rate-limiter.ts # 自适应速率限制器（3 模式：Normal/Rate-limited/Recovering）
├── system-prompt.ts       # System prompt override 应用（config.yaml 规则）
├── sanitize-system-reminder.ts  # <system-reminder> 标签解析与提取
├── anthropic/
│   ├── client.ts          # Anthropic API 客户端（直连 + Copilot 代理）
│   ├── pipeline.ts        # runAnthropicPipeline + buildAnthropicStrategies（web_search 双跳复用 executeRequestPipeline）
│   ├── request-rewrites.ts # 请求改写 registry（preprocessTools + sanitize 包成 RequestRewrite，driver S3 消费）
│   ├── request-preparation.ts # prepareAnthropicRequest（B1-B12：wire payload + beta/effort/cache_control + headers）
│   ├── sanitize.ts        # 消息清洗管道（2 阶段：预处理 + 可重复清洗）
│   ├── auto-truncate.ts   # Anthropic 格式的 auto-truncate 适配
│   ├── message-mapping.ts # 消息映射（原消息 ↔ 清洗后消息索引对应）
│   ├── message-tools.ts   # Tool 预处理管道（注入、defer_loading、server tool 剥离）
│   ├── stream-accumulator.ts # Anthropic SSE 事件累积器
│   ├── features.ts        # 模型特性检测（thinking 支持等）
│   └── recover-tool-call/      # 上游 tool-call 文本降级的透明恢复（core 纯函数 + SSE transform + 非流式 helper）
├── auto-truncate/
│   └── index.ts           # 响应式 auto-truncate（token 限制学习 + 预检查）
├── config/
│   ├── config.ts          # config.yaml 类型定义、加载与热重载
│   └── paths.ts           # 配置文件路径解析（`APP_DIR` 尊重 `XDG_DATA_HOME` 环境变量；`PATHS.HISTORY_DB` 数据库与 `PATHS.COPILOT_LOG` 文件日志由此派生）
├── context/
│   ├── manager.ts         # 请求上下文管理器（活跃请求跟踪 + stale reaper）
│   ├── request.ts         # RequestContext（请求生命周期状态机）
│   └── consumers.ts       # 请求上下文消费者注册
├── history/
│   ├── store.ts           # Barrel re-export（含前端公开 type API：types + entries + queries + sessions + state + stats + in-flight）
│   ├── types.ts           # 类型定义（HistoryEntry、ContentBlock、Session、HistoryStats 等）
│   ├── entries.ts         # 条目 CRUD（insertEntry、updateEntry、finalizeEntry、clearHistory）+ 增量持久化（persistEntryEager/Status/Stages）
│   ├── queries.ts         # 查询（getEntry、getHistory、getHistorySummaries、getSummary）
│   ├── sessions.ts        # Session 聚合（getSession、getSessions、getSessionEntries 等）
│   ├── stats.ts           # 聚合统计（getStats）
│   ├── state.ts           # 模块级状态（historyState、initHistory、shutdownHistory）
│   ├── in-flight.ts       # 进行中请求的内存映射（仅用于 WebSocket 实时推送）
│   ├── sqlite/
│   │   ├── connection.ts  # SQLite 连接管理（bun:sqlite）+ 启动期孤儿回收（pending→interrupted）+ 启动期 VACUUM 空间回收（auto_vacuum=INCREMENTAL 须早于 WAL；freelist≥25% 且≥64MB 触发全量 VACUUM，全程 try/catch 不阻断启动）
│   │   ├── compression.ts # blob 存储 codec：写 zstd L3（比 gzip 砍半），读按 magic bytes 自动判别 gzip(legacy,1f8b)/zstd(28b52ffd)，既有 gzip 行透明可读零迁移
│   │   ├── schema.ts      # 表 DDL 与索引定义（权威 schema：entries_v2 head 表 + entry_stages 子表）
│   │   ├── serialize.ts   # head-meta/stage 拆分序列化 + assembleFullEntry（head + stage 行重组）+ request_group 合并帧 dedup（同 entry 的 inbound/effective/outbound 请求体 >90% 冗余，finalize 时打包进单个 zstd 帧；读侧 decodeStageRows 透明展开，等价个体行）
│   │   ├── write.ts       # 写入操作（upsertHeadRow ON CONFLICT / upsertStageRow / insertCompletedEntry 终态，finalize 经 partitionStagesForWrite 打包请求组）
│   │   ├── read.ts        # 查询操作（分页、过滤、head+stage 批量组装防 N+1）
│   │   ├── stats.ts       # 聚合统计查询（排除活跃行）
│   │   └── reaper.ts      # 定期清理（按状态分桶维持 success/failure 行数上限 + 运行期 stale-pending 回收 + incremental_vacuum 持续还空间给 OS）
│   └── index.ts           # Barrel re-export
├── observability/        # 请求生命周期 + 系统日志的 event-bus + sinks（见 docs/rfc/observability-rewrite.md）
│   ├── bus.ts            # publish/subscribe 总线（命名空间 scoped publisher，同步 fan-out）
│   ├── events.ts         # ObservabilityEvent 联合（request.* / history.* / system.*，含 system.log）
│   ├── republish.ts      # 唯一 consola hijack 点：每条 consola 日志 → system.log 事件投到 bus（重入守卫断 disk-full→日志风暴的环）
│   └── sinks/            # console（stdout + footer）/ history（SQLite）/ telemetry / ws（WebSocket）/ file（copilot-api.log 轮转）
├── ws/
│   ├── adapter.ts         # 共享 WebSocket adapter（Node/Bun）
│   ├── broadcast.ts       # Topic-aware WS 总线（history / status / shutdown 事件统一推送）
│   └── index.ts           # Barrel re-export
├── models/
│   ├── resolver.ts        # Model 解析：别名 → 规范名 → overrides → family 回退
│   ├── client.ts          # Copilot models API 客户端
│   ├── endpoint.ts        # 模型端点支持检查
│   └── tokenizer.ts       # 模型 tokenizer 信息
├── openai/
│   ├── client.ts          # OpenAI Chat Completions 客户端
│   ├── sanitize.ts        # OpenAI 消息清洗
│   ├── auto-truncate.ts   # OpenAI 格式的 auto-truncate 适配
│   ├── embeddings.ts      # Embeddings API 客户端
│   ├── responses-client.ts      # OpenAI Responses API 客户端
│   ├── responses-conversion.ts  # Responses API 数据格式转换（input/output → history）
│   ├── responses-stream-accumulator.ts # Responses SSE 事件累积器
│   ├── stream-accumulator.ts    # Chat Completions SSE 事件累积器
│   ├── stream-error.ts    # 流式生命周期错误 → OpenAI SSE error.type 映射（共享于 chat-completions/responses）
│   └── orphan-filter.ts   # OpenAI 消息孤儿 tool call 过滤
├── codec/                 # v4 每格式编解码器（FormatCodec：parse/decideRoute/translateOut/renderResponse/prepareWire/sampleRequest/createResponseAccumulator）
│   ├── anthropic.ts       # Anthropic codec（bypass-direct，translate/render=identity）
│   ├── openai-cc.ts       # Chat Completions codec（翻译中枢：CC↔Responses via-responses）
│   ├── openai-responses.ts # Responses codec（直连 + Responses→CC fallback）
│   ├── openai-gemini.ts   # Gemini codec（薄翻译层，工厂内委托 cc codec 处理 CC payload）
│   └── *-strategies.ts    # 各格式重试策略组装（anthropic/openai-cc/openai-responses）
├── pipeline/              # v4 driver 骨架（七阶段编排）
│   ├── driver.ts          # createPipelineDriver：编排 S1-S7 + 错误驱动重试 + 阶段边界采样（上游原始 sseEvents 循环顶逐帧）
│   ├── envelope.ts        # RequestEnvelope / ClientFormat / UpstreamEndpoint
│   ├── types.ts           # FormatCodec / Transport / RetryStrategy / RouteDecision 接口
│   ├── rewrite-registry.ts # 请求/响应改写 registry（按 format+config+order 装配过滤）
│   └── legacy-strategy-adapter.ts # 旧 RetryStrategy → driver env-based 适配
├── transport/             # v4 格式无关收发层（retry-transport.md）
│   ├── http-transport.ts  # createUpstreamHttpTransport（fetch→SSE|JSON + guardSseIterable + header 捕获）
│   ├── send.ts            # 格式无关收发骨架
│   ├── upstream-fetch.ts  # 上游 fetch 统一入口（undici dispatcher / keepalive 显式传）
│   ├── http2-client.ts    # node:http2 客户端（Bun 下 GHC https 热路径，见 bun-runtime-timeout.md）
│   └── responses-transport.ts # Responses 上游传输（HTTP vs 上游 WS 二次选择）
├── request/
│   ├── pipeline.ts        # 旧请求重试管道（executeRequestPipeline，策略模式；现仅 web_search 双跳 + countTokens 等非 driver 路径用）
│   ├── payload.ts         # Payload 构造与大小日志
│   ├── recording.ts       # 请求/响应历史记录
│   ├── truncation.ts      # 消息截断逻辑
│   ├── response.ts        # 响应处理工具
│   └── strategies/        # 重试策略：auto-truncate、token-refresh、network-retry、deferred-tool-retry（driver 经 legacy-strategy-adapter 复用）
├── token/                 # Copilot token 获取与管理
└── tui/                   # 终端 UI（请求日志、token 统计、中间件）
```

### 路由

#### OpenAI 兼容端点

所有 OpenAI 端点同时注册在无前缀、`/v1` 前缀和 `/openai/v1` 前缀下。

| 路由 | 说明 |
|------|------|
| `/chat/completions`、`/v1/chat/completions`、`/openai/v1/chat/completions` | OpenAI Chat Completions API |
| `/models`、`/v1/models`、`/openai/v1/models` | 模型列表（OpenAI 兼容格式：基线字段 `id`/`object`/`created`/`owned_by` 不变，附加 `display_name`/`context_window`/`max_input_tokens`/`max_output_tokens`/`vision`/`tool_calls`/`parallel_tool_calls`/`reasoning_effort`/`family`/`vendor` 信息字段） |
| `/models/:model`、`/v1/models/:model`、`/openai/v1/models/:model` | 单个模型详情（同上扩展字段） |
| `/embeddings`、`/v1/embeddings`、`/openai/v1/embeddings` | OpenAI Embeddings API |
| `/responses`、`/v1/responses`、`/openai/v1/responses` | OpenAI Responses API（HTTP POST + WebSocket GET） |

#### Azure OpenAI 兼容端点

经典部署格式——模型名在 URL 路径中，`api-version` query parameter 被忽略。

| 路由 | 说明 |
|------|------|
| `/openai/deployments/:deployment/chat/completions` | Azure 经典格式 Chat Completions（deployment → model） |
| `/openai/deployments/:deployment/embeddings` | Azure 经典格式 Embeddings |
| `/openai/deployments/:deployment/responses` | Azure 经典格式 Responses |

#### Anthropic 兼容端点

| 路由 | 说明 |
|------|------|
| `/v1/messages`、`/anthropic/v1/messages` | Anthropic Messages API |
| `/v1/messages/count_tokens`、`/anthropic/v1/messages/count_tokens` | Anthropic Token 计数 |
| `/anthropic/v1/models` | Anthropic 形状的模型列表（`ModelInfo` + `ModelCapabilities`，过滤 `vendor=Anthropic`） |
| `/anthropic/v1/models/:id` | Anthropic 形状的单个模型详情（仅 Anthropic 厂商；非 Anthropic 或不存在 → 404） |

#### Google Gemini 兼容端点

| 路由 | 说明 |
|------|------|
| `/v1beta/models/:model:generateContent` | Gemini 非流式生成（翻译为内部 OpenAI 格式后走通用管线） |
| `/v1beta/models/:model:streamGenerateContent` | Gemini 流式生成（SSE） |
| `/v1beta/models/:model:countTokens` | Gemini Token 计数（基于 `gpt-tokenizer` 估算） |

#### 管理 API

| 路由 | 说明 |
|------|------|
| `/api/models` | 模型列表（内部格式：完整 Copilot 模型数据） |
| `/api/models/:model` | 单个模型详情（内部格式） |
| `/api/status` | 服务器状态 |
| `/api/tokens` | Token 信息 |
| `/api/config` | 配置信息 |
| `/api/config/yaml` | config.yaml 编辑 |
| `/api/logs` | 请求日志 |
| `/api/event_logging` | Anthropic 事件日志（静默消费） |
| `/api/debug/dry-run-truncate` | 离线 dry-run：复用真实 tokenize+truncate 函数（短路发 GHC），并排返回三套 token 口径（gpt-tokenizer / char÷4 / 上游报告值）+ pre-check + 截断结果。输入为内联 payload 或已存 history entry（`entryId`） |

#### 基础设施

| 路由 | 说明 |
|------|------|
| `/health` | 健康检查（容器编排用） |
| `/history/api/*` | History REST API |
| `/ws` | History WebSocket |
| `/ui/*` | History UI v3 静态文件 |

### 前端子项目

```
ui/
├── src/types/         # 类型定义（re-export 自 ~backend/lib/history/store）
└── tests/             # 前端测试（bun test）
```

路径别名：后端 `~/*` → `src/*`，前端 `@/*` → `ui/src/*`，前端引用后端 `~backend/*` → `../src/*`。
前端类型统一从后端 re-export，不重复定义。
前端依赖与脚本由仓库根 `package.json` 统一管理。

### 测试组织（按域 + 隔离后缀两维度）

后端测试按**两个正交维度**组织：

1. **功能域目录**（镜像 `src/lib/` 结构，按"被测模块"归属）：
   ```
   tests/
   ├── anthropic/  openai/  responses/  gemini/  models/  history/
   ├── config/  pipeline/  streaming/  shutdown/  context/  infra/
   ├── e2e/         # 真实网络/需 token（getE2EMode 门控，不进 offline 全集）
   ├── e2e-ui/      # Playwright（浏览器）
   ├── helpers/     # 共享测试基建（mock-fetch、state-fixture、test-bootstrap、factories、sse、history-fixtures、ws-mock…）
   └── fixtures/    # 磁盘样本 payload
   ```
   归属规则：看被测行为所属的 `~/lib/<域>/` 路径，机械可判；新增 src 模块时测试自动有归属。`history/sqlite/` 镜像 src 子目录。

2. **隔离级别后缀**（控制"按速度跑"）：
   - `*.unit.test.ts` — 纯函数，无运行时
   - `*.it.test.ts` — 起 state/history runtime（bootstrapTestRuntime/autoTestRuntime/initHistory/setStateForTests）
   - `*.http.test.ts` — 起 Hono app 或 server（createFullTestApp/Bun.serve）

   于是域靠**目录**索引、速度靠**后缀**索引（`bun run test:unit` 只跑快测试）。

**脚本**（`bun run`，非 `npm run`——项目用 bun）：`test:backend` = `bun test .unit.test .it.test .http.test`，三后缀 OR 覆盖全部 offline、天然排除 e2e、新增域零枚举漂移。`test:unit`/`test:it`/`test:http` 按后缀跑；`test:e2e`/`test:e2e-ui`/`test:ui` 单列。

**隔离纪律**：bun 单进程跑全套件，全局单例（state、history、upstream-WS manager、`mock.module`）会跨文件泄漏。因此：测试用 DI/fetch-mock 而非 `mock.module`（仅 `tui-format` 的 picocolors 是已证良性的例外）；mutate 全局 state 的测试用 `autoRestoreState()` 还原；带 fs I/O 的测试（如 setup-claude-code）用注入的临时目录，绝不碰真实 `$HOME`。

## 运行时选项

所有运行时状态集中在 `lib/state.ts`，通过 CLI 参数或 config.yaml 设置。

### 配置加载层级

`loadConfig()` 在每次调用时产生**生效配置 = bundled defaults 深合并 user overrides**（user 优先）：

1. **Bundled 默认** — 包根目录的 [`config.yaml`](../config.yaml)（`PATHS.BUNDLED_CONFIG_YAML`），随 npm 包发布；项目推荐的默认配置。
2. **用户覆盖** — `$XDG_DATA_HOME/copilot-api/config.yaml`（默认 `~/.local/share/copilot-api/config.yaml`，对应 `PATHS.CONFIG_YAML`），稀疏覆盖文件；缺省键自动回退到 bundled。

合并规则：
- 顶层嵌套 section（`anthropic` / `history` / `shutdown` / `openai_responses` / `rate_limiter` / `web_search` / `auto_truncate` / `timeouts`）— 按字段合并
- 自由形式 map（`model_overrides`、`anthropic.effort_overrides` 等）— 按 key 合并
- 数组与标量 — user 整体替换

代码里残留的硬编码（`CONFIG_MANAGED_DEFAULTS` / `DEFAULT_MODEL_OVERRIDES`）仅作为 bundled config 无法读取时的安全兜底。

### Hot-reload 语义（统一约定）

`config.yaml` 的字段在 `applyConfigToState()` 中按合并后的 effective config 应用，并保留 retain-on-absence 兜底：

- **用户键存在** → 替换运行时值
- **用户键缺省 + bundled 有该键** → 使用 bundled 值（深合并已注入）
- **用户键缺省 + bundled 也无该键** → 保留上次运行时值（兜底，避免空 bundled fixture 下意外清空）
- **集合显式为空**（如 `disabled_models: []`、`model_overrides: {}`）→ 清空
- **回到内置默认** → 删除用户文件中的对应键即可；下次 reload 自动从 bundled 取值。`PUT /api/config/yaml` 仍调用 `resetConfigManagedState()` + 重新 apply 全表以保证幂等

不参与 hot-reload 的字段（修改需重启）：
- `proxy` — `initProxy()` 在 `start.ts` 启动期执行一次
- `ghc_api_base_url` — 在 `start.ts` 启动期读取一次；mid-flight 切换上游会让进行中的请求路由错位
- `rate_limiter.*` — `AdaptiveRateLimiter` 是 stateful singleton，启动期构造

完整字段覆盖由 [tests/config/config-hot-reload.it.test.ts](../tests/config/config-hot-reload.it.test.ts) 的表驱动测试 + 完整性守卫验证；新增字段未登记到测试矩阵或豁免清单会立刻 fail。

| 选项 | 来源 | 类型 | 默认值 | 说明 |
|------|------|------|--------|------|
| `autoTruncate` | `--auto-truncate` / `--no-auto-truncate` / config `auto_truncate.enabled` | boolean | `false` | 响应式 auto-truncate：限制错误时用截断 payload 重试。CLI flag 显式传入时覆盖 `enabled`；支持热重载（off→on 时懒加载 learned limits）。strategy 用与 truncate 内部同源的 gpt-tokenizer 计数，并把上游报告的 limit 按 `current/gptCount` 比例换算到 gpt 口径再截断（消除口径错配，详见 [request-pipeline.md](request-pipeline.md)） |
| `autoTruncateTargetFactor` | config `auto_truncate.target_factor` | number | `0.9` | 截断目标 = 上游报告 limit × factor。范围 (0, 1]，越小越激进（删更多）/越安全，越大越省 token 但更贴近 limit。0 非法 |
| `autoTruncateMaxRetries` | config `auto_truncate.max_retries` | number | `5` | 单请求最大响应式截断重试次数。0 = 仅一次尝试、不重试 |
| `autoTruncateCompressThreshold` | config `auto_truncate.compress_threshold` | number | `10000` | tool_result 内容压缩的字符长度阈值（非 token）。0 = 全部压缩 |
| `compressToolResultsBeforeTruncate` | config `auto_truncate.compress_tool_results` | boolean | `true` | 截断消息前先压缩旧的 tool_result 内容 |
| `sanitizeToolNames` | config `sanitize_tool_names` | boolean | `false` | 按目标模型约束清洗非法/超长/冲突 tool name 发往上游，响应里还原客户端原始名（跨 Anthropic + Chat Completions + Responses 三条路径，顶层标量） |
| `stripServerTools` | config `anthropic.strip_server_tools` | boolean | `false` | 全局无条件剥离请求中的服务端工具（web_search 等）。注：实际剥离集合是**三源并集**——本全局开关 ∪ 反应式学习的 negotiation 账本（`server-tool-rejection-retry` 策略捕获上游 400「web search tool is not supported」后写入 per-(endpoint,model)）∪ 单次重试 hint（`PrepareHints.excludeServerToolTypes`）。即使本开关为 `false`，被上游拒绝过的 server tool 仍会对后续同模型请求 pre-emptively 剥离。详见 [v4/03-spec/server-tool-rejection-retry.md](v4/03-spec/server-tool-rejection-retry.md) |
| `recoverToolCallText` | config `anthropic.recover_tool_call_text` | boolean | `false` | 透明恢复上游 tool-call 文本降级（`call<invoke>…` 纯文本无 tool_use block）：检测后重建为标准 tool_use block 转发给客户端。流式（CANDIDATE/COMMIT 两阶段）+ 非流式双路径；仅作用于 forwarded 流（history 保留上游降级原貌）。按 stop_reason 分两档检测（A=tool_use 协议矛盾强信号 / B=end_turn 弱信号需残留+终结门控）+ whitespace-tolerant 位置不变量防 content 含 `</parameter>` 字面量腰斩。详见 [tool-call-text-recovery.md](tool-call-text-recovery.md)。注：合成 tool_use 经下游 serverToolFilter 还原 name |
| `anthropicFakeSseHeartbeat` | config `anthropic.fake_sse_heartbeat` | number | `0` | 客户端方向 SSE 合成心跳间隔秒数（0=禁用）。>0 时若距上次真实转发帧 ≥N 秒,handler 主动注入一帧 Anthropic `event: ping`,避免客户端（如 Claude Code ~258s）在上游静默期（典型:opus-4.8 adaptive thinking 在 `content_block_start` 后停滞）超时断开。**不重置上游 idle-timeout**——上游真死仍按 `timeouts.stream_idle` 失败。心跳只记入 `forwardedSseEvents`(客户端实收侧),不污染原始 `sseEvents`。所有写入(真实帧 + 心跳)通过单一 Promise chain 串行化,避免帧字节交错 |
| `thinkingBlockMessagePolicy` | config `anthropic.thinking_block_message_policy` | `"preserve" \| "stripped"` | `"preserve"` | 含 thinking blocks 的 assistant 消息处理策略。Anthropic thinking signature **自包含**(加密 thinking 内容本身,与上下文/位置无关——已通过 opus-4.8 实测验证),故保护是**块级**而非消息级。`preserve`=保留 thinking 块逐字不变 + 不重排连续 thinking,但允许周围一切清理(删孤儿 tool、降级 server tool、编辑/删非 thinking 块);`stripped`=主动从旧消息删 thinking 块。旧值 `immutable`/`fixed-index` 由 [compat.ts](../src/lib/config/compat.ts) 自动迁移到 `preserve` |
| `thinkingBlockSanitizeCheck` | config `anthropic.thinking_block_sanitize` | `false \| "empty_thinking" \| "empty_any"` | `"empty_thinking"` | 发送上游前剥离损坏的 thinking block。有效性由 **signature** 判定（合法加密 thinking 文本为空但有有效 signature，永远保留）。`empty_thinking`=仅移除双空块（thinking 文本与 signature 都空）；`empty_any`=移除任何 signature 为空的 thinking block |
| `coerceAdaptiveThinking` | config `anthropic.coerce_adaptive_thinking` | `false \| "basic" \| "best_effort"` | `"basic"` | 旧版 thinking 适配：仅支持 adaptive 的模型（opus 4.6/4.7/4.8）收到旧版 `thinking.type="enabled"` 时强制转为 `"adaptive"`，解决上游 400。`basic`=转为纯 adaptive 丢 budget_tokens（对齐 GHC）；`best_effort`=并把 budget_tokens 启发式换算为 `output_config.effort`（仅客户端未显式发 effort 时）；`false`=透传不改写。双层防御：prepare 预检（元数据+模型名兜底）+ 反应式 `legacy-thinking-retry` strategy（捕获 400 自愈） |
| `thinkingSignatureCompat` | config `anthropic.thinking_signature_compat` | `false \| "signature_delta" \| "redacted_thinking"` | `"signature_delta"` | 客户端兼容 shim：部分 Copilot 上游的非标准 thinking 帧——`content_block_start{type:"thinking", thinking:"", signature:S}` 紧跟 `content_block_stop`、**无 signature_delta**。上游才是协议权威；标准客户端（Claude Code/SDK）只从 `signature_delta` 取 signature、忽略 start 上的 signature 字段，故会丢签名并回传 `{thinking:"", signature:""}` 双空块被上游拒。本配置**仅作用于客户端转发流**对该帧重整形（history 的 `sseEvents` 保留上游原始帧，shim 体现在 `inboundResponse.sseEvents`）。`signature_delta`=拆成空 thinking start + 合成标准 signature_delta（默认，贴合协议）；`redacted_thinking`=改写为 `redacted_thinking{data:S}`（与客户端回传形态殊途同归）；`false`=透传。仅流式路径（非流式 JSON 里 signature 字段客户端直接可读，无需 shim） |
| `systemMessagesSanitize` | config `anthropic.system_messages_sanitize` | `false \| "drop_invalid" \| "merge" \| "as_user" \| "as_assistant"` | `false` | 处理 `messages` 数组里混入的 `role:"system"` 消息——Anthropic Messages API 不接受（system 须为顶层参数），否则上游回 `Unexpected role "system"` 400。这类 inline system 来自 OpenAI 习惯客户端或 Claude Code 中途注入的 system 级上下文（hook 输出/规则/提醒）。`as_user`=改 role 为 user 保留对话位置（**推荐**，对带位置语义的注入最忠实）；`merge`=提取文本追加到顶层 system 并删消息（破坏时序、巨大化、显著降低 prompt cache 命中）；`drop_invalid`=直接删除（丢失上下文）；`as_assistant`=改 role 为 assistant（**实验性、不推荐**——把注入上下文伪装成模型输出，且可能并入 tool 调用 turn）；`false`=透传（默认，存在时会 400）。在 `sanitizeAnthropicMessages` 内于 `removeAnthropicSystemReminders` 之后执行；转换模式复用相邻同 role 合并（保护带签名 thinking）+ `ensureAnthropicStartsWithUser` 保证 messages[0] 合法；提取文本为空一律 drop，不产生空 content。`count_tokens` 与 web_search 双跳路径同样应用 |
| `rewriteHistoryServerTools` | config `anthropic.rewrite_history_server_tools` | `false \| "downgrade"` | `false` | 改写消息历史里残留的 native server-tool block（`server_tool_use{*}` + 配对 `*_tool_result`）。web_search 双跳故意把合成的 `server_tool_use{web_search}` + `web_search_tool_result` 发给客户端（让搜索结果可见），客户端下一轮原样回传；但双跳会把 tools 里的 `web_search` 降级为普通 function tool，于是上游看到孤立的 server_tool_use 报 400（`references web_search but not defined as a server tool`）。`downgrade`=把这对降级为普通 `tool_use` + `tool_result`——因 `tool_result` 必须位于 user 消息（协议约束，对齐 `buildSecondHopMessages`），改写会**拆分 assistant turn**：`tool_use`（及 text/thinking）留在 assistant，`tool_result` 移到紧随的新 user 消息；`false`=透传（默认，残留 server_tool_use 时会 400）。按 block **type** 匹配（非 name），统一覆盖 web_search/web_fetch/code_execution 等所有 server tool。在 `sanitizeAnthropicMessages` 内于 `processToolBlocks` **之前**执行（让 tool 引用校验看到已降级形态）；含签名 thinking 的 `immutable` 消息整条早退不改写。**推荐与 `web_search.enabled` 同时开启**。仅作用于 wire payload——history `inboundRequest` 保留客户端原始形态 |
| `fetchTimeout` | config `timeouts.response_header` | number | `300` | 请求超时：请求开始到收到 HTTP 响应头的秒数（0 = 无超时） |
| `streamIdleTimeout` | config `timeouts.stream_idle` | number | `300` | 流空闲超时：连续 SSE 事件间最大等待秒数（0 = 无超时） |
| `upstreamKeepaliveDelay` | config `timeouts.upstream_keepalive` | number | `15` | 上游 TCP keepalive 首探针延迟秒数（0 = 用 undici 内置默认 60s）。设到上游连接路径的空闲回收窗口（NAT/防火墙/LB,常见 ~30s）以下,让内核在上游静默期周期性发 TCP 探针,持续重置中间设备的空闲计时器,避免连接在 opus 长 thinking 沉默期（`content_block_start` 后停滞几十秒~数百秒）被回收为 `terminated (cause: other side closed)`。undici 默认 60s 太长:~30s 回收时首探针尚未发出。经 `setTimeoutConfig` 应用并触发 undici dispatcher 重建（与 `fetchTimeout`/`streamIdleTimeout` 同机制,支持热重载）。**Bun 与 Node 均生效**——所有上游请求统一经 `upstreamFetch`（`transport/upstream-fetch.ts`）走 undici 并显式传 `getUpstreamDispatcher()` 的 dispatcher,故 Bun 全局 fetch 不消费 `setGlobalDispatcher` 的旧限制已不适用。**关键**:import 走 `undici/index.js` 子路径而非裸 `undici`——Bun 把裸 `undici` 替换为内建 shim,其 fetch 静默丢弃 dispatcher(keepalive 不生效);子路径绕过 shim 加载真 undici,Bun 下经 `ss` 实测确认 socket 带 `timer:(keepalive,...)`。pin **undici 7**:undici 8 的 index.js 顶层 eager 构造 CacheStorage,在 Bun 1.3.14 加载即崩。SOCKS 代理路径在自定义连接器内对隧道 socket 调 `setKeepAlive` 单独覆盖 |
| `modelRefreshInterval` | config `model_refresh_interval` | number | `600` | 模型列表后台刷新周期秒数（0 = 禁用） |
| `dedupToolCalls` | config `anthropic.dedup_tool_calls` | `false \| "input" \| "result"` | `false` | 去重重复的 tool_use/tool_result 对 |
| `toolSearchEnabled` | config `anthropic.tool_search` | boolean | `true` | 是否注入 Copilot `tool_search` 工具 |
| `cacheControlMode` | config `anthropic.cache_control` | `"disabled" \| "passthrough" \| "sanitize" \| "proxied"` | `"proxied"` | Cache control 处理模式：disabled=剥离、passthrough=透传、sanitize=清洗非标准字段、proxied=代理注入 |
| `nonDeferredTools` | config `anthropic.non_deferred_tools` | `string[]` | `[]` | 额外的不延迟工具名称列表 |
| `stripReadToolResultTags` | config `anthropic.strip_read_tool_result_tags` | boolean | `false` | 剥离 Read 结果中的 system-reminder 标签 |
| `decodeToolInputFields` | config `anthropic.decode_tool_input_fields` | `Record<string, string[]>` | `{ AskUserQuestion: ["questions"] }` | 响应侧将指定 tool_use 的指定顶层 input 字段从 stringified JSON decode 回结构化形式（仅改转发给客户端的流/响应，history 保持原始）。key 为工具名，逐字匹配不归一化；replace 语义 |
| `decodeAllToolInputFields` | config `anthropic.decode_all_tool_input_fields` | boolean | `false` | 对所有 tool_use 的所有顶层 string 字段尝试 decode（忽略上表）。`server_tool_use` 永不受影响 |
| `backfillQuestionFromHeader` | config `anthropic.backfill_question_from_header` | boolean | `true` | 响应侧把 `AskUserQuestion` 工具调用里「有 `header` 但**缺** `question` 键」的 `questions[]` item 回填 `question = header`（Claude Code 客户端拒收缺 `question` 的 item，报「必须有 question」）。仅在 `question` 键缺失且 `header` 为非空字符串时触发；present-but-empty 不动。流式 + 非流式均生效，在 `decodeToolInputFields` 之后运行（先把 stringified `questions` 还原成数组再回填）。history 保留 upstream 原始形态 |
| `rewriteSystemReminders` | config `anthropic.rewrite_system_reminders` | `boolean \| Array<{from, to, method?}>` | `false` | 重写消息中的 system-reminder 标签 |
| `contextEditingMode` | config `anthropic.context_editing` | `'off' \| 'clear-thinking' \| 'clear-tooluse' \| 'clear-both'` | `'off'` | 服务端上下文编辑模式 |
| `contextEditingTrigger` | config `anthropic.context_editing_trigger` | number | `100000` | `clear_tool_uses` 的触发 token 阈值 |
| `contextEditingKeepTools` | config `anthropic.context_editing_keep_tools` | number | `3` | 清理后保留的最近 tool_use 对数量 |
| `contextEditingKeepThinking` | config `anthropic.context_editing_keep_thinking` | number | `1` | 清理后保留的最近 thinking turn 数量 |
| `historySuccessLimit` | config `history.success_limit` | number | `50` | SQLite 中保留的成功（非 failed）历史条目上限（0 = 无限制）。reaper 按状态分桶独立淘汰,失败请求刷屏不会挤掉成功历史 |
| `historyFailureLimit` | config `history.failure_limit` | number | `200` | SQLite 中保留的失败历史条目上限(0 = 无限制)。默认大于 success_limit——失败记录诊断价值更高。旧 `history.limit` 仍被接受为兼容键,缺省时 success/failure 回退到它 |
| `historyReaperInterval` | config `history.reaper_interval` | number | `600` | SQLite reaper 定期清理秒数（0 = 禁用），两桶共用 |
| `historyDbPath` | config `history.db_path` | string | `""` | 覆盖默认 SQLite 数据库路径（空字符串表示使用 `PATHS.HISTORY_DB`） |
| `webSearchEnabled` | config `web_search.enabled` | boolean | `false` | 启用 web_search 双跳实现（仅 Anthropic 路径）：拦截含 native web_search server tool 的请求，执行真实搜索后由主模型二次生成。**注意**：合成的 `server_tool_use{web_search}` 会回流到客户端历史，下一轮回传时若未配 `anthropic.rewrite_history_server_tools: "downgrade"` 会触发上游 400，建议同时开启 |
| `webSearchBackend` | config `web_search.backend` | string | `""` | 搜索后端：`""`=禁用、`searxng`=本地 SearXNG（`http://localhost:8080`）、其它非空=Copilot Responses 搜索模型 id（如 `gpt-5.5`） |
| `modelOverrides` | config `model_overrides` | `Record<string, string>` | opus→claude-opus-4.6 等 | Model 名称映射 |
| `shutdownGracefulWait` | config `shutdown.graceful_wait` | number | `60` | Phase 2 超时秒数：等待活跃请求自然完成 |
| `shutdownAbortWait` | config `shutdown.abort_wait` | number | `120` | Phase 3 超时秒数：发送 abort signal 后等待处理完成 |
| `staleRequestMaxAge` | config `timeouts.stale_request_max_age` | number | `600` | 活跃请求最大存活秒数（0 = 禁用） |
| `normalizeResponsesCallIds` | config `openai_responses.normalize_call_ids` | boolean | `true` | 将 Responses API input 中的 `call_` 前缀 ID 转换为 `fc_` 前缀 |
| `upstreamWebSocket` | config `openai_responses.upstream_ws` | boolean | `false` | 启用上游 WebSocket 传输（Responses API，仅模型支持时）。半开熔断 + 连续失败回退由 manager 处理；运行时状态在 `/api/status.upstream_ws` 暴露 |
| `fixResponsesStreamIds` | config `openai_responses.fix_stream_ids` | boolean | `true` | 修复 Copilot Responses 上游在 `response.output_item.added` 与 `.done` 之间 item ID 不一致的问题（`@ai-sdk/openai` 校验 ID 连续性需要） |
| `stripImageGenerationTool` | config `openai_responses.strip_image_generation_tool` | boolean | `false` | 从入站 Responses 请求中剥离 `image_generation` 内置工具（Copilot 上游拒收并整请求 400；Codex CLI 会自动注入）。剥离前 history 已 snapshot，因此 `inboundRequest.tools` 仍保留客户端原始数组 |
| `clientWebsocketKeepOpen` | config `openai_responses.client_ws_keep_open` | boolean | `false` | 客户端侧 Responses WS 在 `response.completed` 后保持连接以接受后续 `response.create`。false（默认）为 HTTP-like 一次性语义（code 1000 关闭） |
| `maxWsFrameBytes` | config `openai_responses.max_ws_frame_bytes` | number | `1048576` | 客户端侧 Responses WS 入站帧字节上限（默认 1 MiB；0 = 无限制）。约束公网部署上过大 `response.create` 的堆压力 |
| `maxClientWsConnections` | config `openai_responses.max_client_ws_connections` | number | `256` | 客户端侧 Responses WS 并发连接上限（0 = 无限制）。约束 `client_ws_keep_open=true` 下的 fd 使用 |
| `maxUpstreamWsConnections` | config `openai_responses.max_upstream_ws_connections` | number | `32` | 上游 WS 连接池软上限（0 = 无限制）。达到上限且有 idle 时驱逐最旧 idle；全忙时记 warn 并分配 overflow |
| `ghcApiBaseUrl` | `--ghc-api-base-url` / config `ghc_api_base_url` | string | `""` | 显式覆盖上游 GHC API base URL；非空时优先于 `accountType` 派生的 URL。**修改需重启** |

## 模块文档

各子系统的详细设计文档：

| 文档 | 说明 |
|------|------|
| [authentication.md](authentication.md) | Copilot 认证、账户类型、Token 管理 |
| [sanitize-pipeline.md](sanitize-pipeline.md) | 消息清洗管道（2 阶段）、Tool blocks 处理 |
| [request-pipeline.md](request-pipeline.md) | 请求重试管道、错误分类、速率限制 |
| [model-resolution.md](model-resolution.md) | Model 解析、别名、Override 系统 |
| [tool-use.md](tool-use.md) | Tool Use 机制、server tools、tool_search |
| [anthropic-compat.md](anthropic-compat.md) | Anthropic API 兼容性、功能矩阵 |
| [gemini-compat.md](gemini-compat.md) | Gemini API 兼容性、客户端配置、限制 |
| [history.md](history.md) | History 系统、存储、WebSocket、Memory Pressure |
| [streaming.md](streaming.md) | 流式处理、WebSocket Transport、重复性检测 |
| [shutdown.md](shutdown.md) | 优雅关闭、请求生命周期、Stale Reaper |
| [bun-runtime-timeout.md](bun-runtime-timeout.md) | Bun 原生 fetch 内建 300s 超时陷阱、`timeout: false` 修复 |

## UI 设计原则

### Console UI（日志）

- **使用固定宽度 ASCII 前缀**对齐日志，不用 emoji/图标（如 `[....]`、`[<-->]`、`[ OK ]`、`[FAIL]`、`[RETRY-n]`）
- **日志格式**：`[PREFIX] HH:MM:SS METHOD /path ...` — 状态前缀在前，时间戳在后
- **只显示相关信息**：非模型请求（如 `/health`）不应显示模型名、token 数或 "unknown"
- **流式指示器**：长时间运行的请求显示 `streaming...` 状态，使用 `[<-->]` 前缀
- **诚实展示 retry**：每次被 retry strategy 接受的请求失败都打印一行 `[RETRY-n]`（n=1-based 失败次数），由 `executeRequestPipeline` 在 budget gate 通过后统一发射。格式示例：`[RETRY-1] 12:34:56 429 POST /v1/messages claude-opus-4.8 (3x) 1.2s ↑15KB: rate_limited (retryable: network-retry, wait 1.0s)`。前缀黄色、状态码红色、`(retryable: ...)` dim；之后仍照常打印最终 `[ OK ]` / `[FAIL]` 行。包含 token-refresh、learning probe（额外 `, learning` 后缀）、deferred-tool、unsupported-beta 等所有重试策略；无策略接受的错误直接进入 `[FAIL]`，不出 `[RETRY-n]`

### History Web UI

- **显示实际请求内容**：如果最后一条消息是 `tool_result`，显示 `[tool_result: id]` 而非向前查找用户文本
- **文本优先于 tool_use**：对于同时包含 text 和 tool_use 的 assistant 消息，优先显示文本内容；仅在没有文本时显示 `[tool_use: ToolName]`
- **过滤系统标签**：从预览文本中移除 `<system-reminder>`、`<ide_opened_file>` 等系统标签

### 通用原则

- **减少噪音**：不显示冗余或不可用的信息
- **一致格式**：控制台输出使用固定宽度列对齐
- **信息丰富的预览**：历史预览应反映请求的实际性质
- **信息丰富的日志**：所有日志消息应包含足够的上下文（模块标签、模型名、具体值）以便采取行动

# API 参考（对客户端暴露的入站端点）

本项目把 GitHub Copilot（**GHC**）的模型能力，暴露为多种主流 AI API 兼容端点。本文是**端点的单一事实源**（single source of truth）——覆盖 vendor 兼容端点、管理 API、基础设施、History REST 与 WebSocket。

> **方向**：本文是**入站 / 我们暴露给客户端**的 HTTP 面。**上游 / 我们消费的 GHC/Copilot API**（模型目录、能力、beta header、wire 格式）见 skill `ghc-api-reference`。

## 真相源与关联文档

- **活的全表面（最权威）**：运行中实例的 `GET /openapi.json`（OpenAPI 3.1，覆盖全部端点）+ `GET /docs`（Scalar 交互页）。端点漂移时以运行实例为准；本文提供人读的目录与字段级备注。
- **路由/codec 分派的架构现状**：[DESIGN.md](DESIGN.md)「架构」「活的架构现状」「核心模块」节。
- **body 契约的权威在外部官方 spec**：vendor 兼容端点**镜像三家上游既有契约**，故 request/response body 的字段级 schema **以各厂商官方 API 文档为准**（[OpenAI](https://platform.openai.com/docs/api-reference) / [Anthropic](https://docs.anthropic.com/en/api) / [Google Gemini](https://ai.google.dev/api)）——刻意不在项目内镜像这些庞大且厂商自维护的契约。
- **我们相对官方的偏差（项目内活文档）**：[openai-compat.md](openai-compat.md)、[anthropic-compat.md](anthropic-compat.md)、[gemini-compat.md](gemini-compat.md)——只记我们特有的 shim / 转换 / 差异行为；请求管线 [request-pipeline.md](request-pipeline.md)、流式 [streaming.md](streaming.md)、工具调用 [tool-use.md](tool-use.md)。
- **agent 快速定位**：skill `proxy-api-reference`。

## 调用基础

- **默认 base URL**：`http://localhost:4141`（端口经 `--port` 或 config 调整）。
- **客户端认证**：入站 `Authorization` / `x-api-key` **不被校验**——客户端传占位符即可（如 `dummy`）。真正的认证发生在**上游**（GitHub OAuth token → Copilot token，自动刷新），见 [authentication.md](authentication.md)。
- **出站腿后缀（通用翻译矩阵）**：任意端点的**模型名**可加后缀 `@cc` / `@responses` / `@messages`（大小写不敏感）显式钉出站腿——让任意客户端 SDK 用任意 GHC 模型（如 OpenAI 客户端 `claude-opus-4.8@messages` 经 Anthropic `/v1/messages` 上游、Anthropic 客户端 `gpt-5.5@cc` 经 Chat Completions 上游）。**无后缀 anthropic 客户端发非-Anthropic 模型会自动 forward-translate**（优先级 `messages > responses > cc`，故 Claude Code 直接写 `gpt-5.6-sol` 即可、无需后缀）；无后缀 cc/responses/gemini 走各自默认腿。后缀经 `resolveModelTarget` 剥离，路由决策在 `pipeline/router.ts`，翻译经 `pipeline/hub-translate.ts`——详见 DESIGN.md「活的架构现状」通用翻译矩阵行 + [rfc/2026-07-11-anthropic-via-openai-translation.md](rfc/2026-07-11-anthropic-via-openai-translation.md)。`count_tokens` 端点同样剥离后缀（`resolveModelName`）；Anthropic 腿默认路由到 GHC 上游 count_tokens、本地估算兜底（不进翻译矩阵/driver）。

---

## OpenAI 兼容端点

所有 OpenAI 端点同时注册在**无前缀**、`/v1` 前缀和 `/openai/v1` 前缀下。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/chat/completions`、`/v1/chat/completions`、`/openai/v1/chat/completions` | POST | OpenAI Chat Completions API |
| `/models`、`/v1/models`、`/openai/v1/models` | GET | 模型列表（OpenAI 兼容格式：基线字段 `id`/`object`/`created`/`owned_by` 不变，附加 `display_name`/`context_window`/`max_input_tokens`/`max_output_tokens`/`vision`/`tool_calls`/`parallel_tool_calls`/`reasoning_effort`/`family`/`vendor` 信息字段） |
| `/models/:model`、`/v1/models/:model`、`/openai/v1/models/:model` | GET | 单个模型详情（同上扩展字段） |
| `/embeddings`、`/v1/embeddings`、`/openai/v1/embeddings` | POST | OpenAI Embeddings API |
| `/responses`、`/v1/responses`、`/openai/v1/responses` | POST（+ WebSocket GET） | OpenAI Responses API（HTTP POST + WebSocket GET，见下「WebSocket」节） |

兼容行为细节（内部规范格式、Responses 直连/回退、Codex tier-1、工具名还原等）见 [openai-compat.md](openai-compat.md)。

## Azure OpenAI 兼容端点

经典部署格式——模型名在 URL 路径中，`api-version` query parameter 被忽略。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/openai/deployments/:deployment/chat/completions` | POST | Azure 经典格式 Chat Completions（deployment → model） |
| `/openai/deployments/:deployment/embeddings` | POST | Azure 经典格式 Embeddings |
| `/openai/deployments/:deployment/responses` | POST | Azure 经典格式 Responses |

## Anthropic 兼容端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `/v1/messages`、`/anthropic/v1/messages` | POST | Anthropic Messages API。**需要 Anthropic-vendor 模型**——直连 Copilot 原生 Anthropic 端点（非-Anthropic 模型经出站腿后缀 / 自动 forward-translate 走翻译矩阵） |
| `/v1/messages/count_tokens`、`/anthropic/v1/messages/count_tokens` | POST | Anthropic Token 计数 |
| `/anthropic/v1/models` | GET | Anthropic 形状的模型列表（`ModelInfo` + `ModelCapabilities`，过滤 `vendor=Anthropic`） |
| `/anthropic/v1/models/:id` | GET | Anthropic 形状的单个模型详情（仅 Anthropic 厂商；非 Anthropic 或不存在 → 404） |

兼容行为细节（thinking / tool_use / cache_control / sanitize 等）见 [anthropic-compat.md](anthropic-compat.md)。

## Google Gemini 兼容端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `/v1beta/models/:model:generateContent` | POST | Gemini 非流式生成（翻译为内部 OpenAI 格式后走通用管线） |
| `/v1beta/models/:model:streamGenerateContent` | POST（SSE） | Gemini 流式生成（SSE） |
| `/v1beta/models/:model:countTokens` | POST | Gemini Token 计数（基于 `gpt-tokenizer` 估算） |

兼容行为细节见 [gemini-compat.md](gemini-compat.md)。

---

## 管理 API（`/api/*`）

精确 zod schema（经各 router `.openapi()` 注册，`/openapi.json` 里为高保真档）。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/models` | GET | 模型列表（内部格式：**全量未过滤** Copilot 目录——含被 `config.disabled_models` 禁用的模型，供 UI 可见）+ envelope 顶层 `disabled: string[]`（config-disabled 的实际目录 id，`getConfigDisabledIds()` 归一化匹配）。**与 vendor 端点（`/v1/models`、`/anthropic/v1/models`）正交**：那些仍返 `state.models`（过滤后可用集）；仅内部管理视图看全量。合成标记 `disabled` 只在 envelope，不污染 Model 形状。类型 `InternalModelsResponse`（`src/lib/models/client.ts`，前端 `~backend` re-export）。见 [spec/2026-07-08-models-drawer-and-disabled-visibility.md](spec/2026-07-08-models-drawer-and-disabled-visibility.md) |
| `/api/models/:model` | GET | 单个模型详情（内部格式）；对**全量目录**解析（`modelIndex.get` 命中可用集，未命中回退 raw 全量 find）→ 禁用模型详情也返 200 |
| `/api/status` | GET | 服务器状态（含 `requestTelemetry` 的 **model 维度摘要**——运营 stats 的其余维度故意不塞此 health-poll，见 `/api/stats`；另含 feature-specific 计数器 `protect_streaming`、`tool_input_repair`〔strip/jsonrepair/unrepairable〕；另含 `thinking_blocks`〔thinking 块空/非空三桶〕——**注：这是 telemetry `agentKind` 维度 sum 的投影（`getThinkingBlockTotals`），非独立 module-global 计数器**） |
| `/api/stats` | GET | 运营 stats：`?dimension=<model\|endpoint\|client\|agentKind\|tool\|…>&window=<sinceStart\|7d\|30d\|90d\|lifetime>&limit=<N>` 返回任意注册维度的泛型 breakdown（server-side top-N + `"other"`）。**window 层路由**：`sinceStart`/`7d` 读进程内内存（counters + series，**7d histograms 已退役出空 `{}`**——old `ui/` 专用能力、当前 ui-v4 不用）；`30d`/`90d` 读 SQLite 分层（≤hourly.retention→`tel_hourly`、更长→`tel_daily`）、`lifetime`→`tel_cumulative`——这三个长窗附 **`distributions`**（每 key 每分布度量 DDSketch 分位 p50/p90/p99+count/sum/min/max）+ **`preMigrationSketchGap`**（迁移前时段无 sketch 精度标注）。持久 telemetry registry（`lib/request-telemetry.ts` + `lib/telemetry/`）的唯一泛型读出口。设计见 [spec/2026-07-13-telemetry-tiered-storage.md](spec/2026-07-13-telemetry-tiered-storage.md) + [spec/operational-stats-and-lineage-removal.md](spec/operational-stats-and-lineage-removal.md) |
| `/api/tokens` | GET | GitHub + Copilot Token 信息（masked，除非 `--show-github-token`） |
| `/api/config` | GET | 有效运行时配置 |
| `/api/config/yaml` | GET / PUT | 读取 / 替换 `config.yaml`（PUT 触发全量 re-apply） |
| `/api/negotiation` | GET / POST | 反应式学习记录（feature-negotiation 缓存）TTL 生命周期管理：`GET` 返分组快照（10 分类 + 每条四态 status `active`/`expired`/`pinned`/`manually_expired` + 时间戳，含过期行）；`POST /renew`（续约刷新 `lastConfirmedAt`）/`/expire`（立即失效保留行）/`/pin`（pin 永不过期）/`/entry/delete`（删除，不存在均 `404 {error:"entry not found"}`）；`GET /export` 全量 v2 数据集 JSON 附件。前端 ui-v4 `Learned` 页消费。详见 [spec/2026-07-08-negotiation-learning-lifecycle.md](spec/2026-07-08-negotiation-learning-lifecycle.md) |
| `/api/logs` | GET | 请求日志（内存 ring buffer） |
| `/api/event_logging/batch` | POST | Anthropic 事件日志 beacon（静默消费） |
| `/api/hooks` | GET / POST | 上游 hook 中间件管理：`GET` 返回常驻生效态（`declaredModule`/`loadedModule`/`loadedAt`/`version`/`exports`/`lastReloadError?`，与 `/api/config` 的声明态脱钩对账）；`POST /reload` 用 data-URL 机制重新加载 `hooksUpstreamModule`（`hooks.enabled`/`hooks.upstream_module` config），失败保留旧 hook + warn-continue + 记 `lastReloadError`，绝不杀进程。见 [spec/2026-07-12-upstream-hook-middleware.md](spec/2026-07-12-upstream-hook-middleware.md) §6 |
| `/api/debug/dry-run-truncate` | POST | 离线 dry-run：复用真实 tokenize+truncate 函数（短路发 GHC），并排返回三套 token 口径（gpt-tokenizer / char÷4 / 上游报告值）+ pre-check + 截断结果。输入为内联 payload 或已存 history entry（`entryId`） |
| `/api/debug/dry-run-pipeline` | POST | 离线 pipeline dry-run（**全格式 anthropic/openai-cc/openai-responses/gemini，请求侧 + 响应侧**）：把合成/回放的请求或上游响应喂进真实 v4 driver，短路 GHC，按 `stopAfter` 输出选定阶段中间态。详见 [archive/2606-landed-rfcs/pipeline-dry-run-inspector.md](archive/2606-landed-rfcs/pipeline-dry-run-inspector.md) |

---

## 基础设施

| 路由 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查（容器编排 readiness——token/models 未就绪返 503；等价 `/health/readiness`） |
| `/health/readiness` | GET | Readiness 探针（K8s 风格，与 `/health` 共享 handler）——token/models 就绪返 200、否则 503，编排器据此摘/放流量 |
| `/health/liveness` | GET | Liveness 探针——仅反映进程可响应，恒 200 `{status:"alive"}`；注册在 config/token 中间件**之前**，不触上游、不受 stale token / 优雅关机影响（drain 用 readiness，liveness 失败会触发重启） |
| `/metrics` | GET | **Prometheus 文本 exposition**（v0.0.4）——telemetry registry 的通用投影 `copilot_api_*_total{dimension,key}` counters + **标准 Prometheus histogram**（`copilot_api_<duration_ms\|queue_wait_ms\|input_tokens\|output_tokens\|upstream_first_token_ms\|client_first_real_ms\|buffer_hold_ms>_bucket{le}`/`_sum`/`_count`,scraper 用 `histogram_quantile()` 自算分位；后三个是首包/时序埋点 ADR `2026-07-14`,boundaries 顶到 400_000ms 覆盖客户端可见首包 max≈356s）（与 `/api/stats` 同源、`sinceStart` 累积窗口；常开、零依赖、不引 OTel SDK）。`src/lib/metrics-exposition.ts` + `src/routes/metrics/route.ts`,设计见 [spec/operational-stats-and-lineage-removal.md](spec/operational-stats-and-lineage-removal.md) §6 + [archive/2606-landed-rfcs/telemetry-histograms.md](archive/2606-landed-rfcs/telemetry-histograms.md) |
| `/openapi.json` | GET | **全 API 表面**的 OpenAPI 3.1 文档。两档保真度：管理 API（`/api/*`）经各 router `.openapi()` 的**精确 zod schema**；其余（OpenAI/Anthropic/Gemini/Azure compat、History REST、dry-run-pipeline、event_logging、health）经 `openAPIRegistry.registerPath()` 的**简单 open-object schema**（纯文档、不绑 handler、不校验，故 plain-Hono 路由原封不动照常工作）。根 app 改 `OpenAPIHono<BlankEnv>`；装配见 `src/routes/openapi.ts`（doc31+Scalar+管理 router 聚合）与 `src/routes/openapi-compat.ts`（compat/history/诊断的 registerPath）。vendor compat 端点的 request/response body 契约以**各厂商官方 API spec** 为准（外部权威，见本文头部「真相源与关联文档」），项目内只记相对官方的偏差 |
| `/docs` | GET | Scalar 交互式 API 文档页（消费 `/openapi.json`，与 Vue 前端 `/ui` 分离） |
| `/` | GET | 根路径——302 重定向到 `/openapi.json` |
| `/ui/*` | GET | 旧 Vue History UI 静态文件（**legacy，正逐页退役到 `/ui-v4`**；`/models` 已退役 2026-07-10；退役路线图 [vue-ui-retirement.md](vue-ui-retirement.md)） |
| `/ui-v4/*` | GET | 当前活的 React History UI 静态文件 |

### 未知端点行为（404 / 405）

打到代理但没匹配任何业务路由的请求，由全局 `notFound` 三态分类（见 [spec/2026-07-14-unknown-endpoint-logging.md](spec/2026-07-14-unknown-endpoint-logging.md)）：

| 情形 | 状态 | body | 头 |
|------|------|------|----|
| 路径存在但 HTTP method 不对 | **405** | `{ "error": "Method Not Allowed" }` | `Allow: <methods>` |
| 真正未匹配的路径 | **404** | `{ "error": "Not Found" }` | — |
| 已匹配 handler 主动 `c.notFound()`（如 UI 静态资源缺失） | 404 | handler 自身 body | — |
| 浏览器探针（`/favicon.ico` / devtools） | 204 | 空 | —（静默、不进日志） |

405 检测从公开 `server.routes` 派生影子 router（绕开全局中间件污染）。unknown endpoint 的日志级别由 config `unknown_endpoint_logging.{not_found,method_not_allowed}` 控制（`silent|debug|info|warn|error`，默认 `warn`；见 [CONFIG 参考](../config.example.yaml)）。全局 `cors()` 对所有 OPTIONS 返 204，故 unknown OPTIONS 不进本管线（明确例外）。

---

## History REST（`/history/api/*`）

内置三层降温归档已整体退役（History V2 removal，2026-07-16 起）——config 层不存在任何 `history.archive.*` 键（无需关闭开关，从未有过对应键），任何 `?tier=archive` 查询固定返回 **400** `{"error":"The built-in archive tier has been retired"}`（`src/routes/history/handler.ts` `rejectsRetiredArchiveTier`，代码层硬拒绝，与 config 无关）。旧 archive-now/archive-cooldown 端点随之一并移除。

| 路由 | 方法 | 说明 |
|------|------|------|
| `/history/api/entries` | GET | V3 canonical operation 分页列表（默认 `operationKind=generation`，可显式取 bypass operation）；支持 model / endpoint / state / session / agent / pid / time 过滤与 `terminalOnly=true`。`tier=archive` 明确 400，不回读旧 archive。 |
| `/history/api/entries/:id` | GET | 从 V3 canonical store 投影完整 entry；未知 id 返回 404。 |
| `/history/api/entries/:id/export` | GET | 将 V3 `getEntry` 投影服务端 zstd 压缩为 `.json.zst` 附件。 |
| `/history/api/entries/:id/pin`、`.../unpin` | POST | 更新 `v3_operations.pinned` 专列；详情和 summary 均立即反映。 |
| `/history/api/stats` | GET | 从 V3 列表与 in-flight 合并视图聚合计数、token 与 model breakdown。 |
| `/history/api/sessions` | GET | 从 V3 generation records 聚合 Session 列表；不读 `entries_v2`。 |
| `/history/api/search`、`/history/api/search/contains` | GET | V3 unique semantic payload 搜索与 object→operation companion；绝不回读 V2 `search_index`。 |
| `/history/api/export` | GET | 从 V3 facade 导出 JSON / CSV。 |


存储结构 / blob 压缩 / 迁移见 [history.md](history.md) 与 skill `history-sqlite-schema`。

---

## WebSocket

OpenAPI 3.1 无一等 WebSocket 建模，`/openapi.json` 里以 `GET` upgrade 端点呈现。

| 路由 | 说明 |
|------|------|
| `/ws` | History WebSocket——topic-aware bus，携带：`history`（new entries / updates / finalize / delete 事件）、`status`（服务器状态变化）、`shutdown`（drain begin / phase transitions）、以及（per-request）in-flight 请求的 live SSE replay。见 [ws-webui.md](ws-webui.md) |
| `/responses`、`/v1/responses`、`/openai/v1/responses` | OpenAI Responses 的 WebSocket 升级（与 HTTP POST 同路径，`GET` + `Upgrade: websocket`）。见 [ws-openai-responses.md](ws-openai-responses.md) |

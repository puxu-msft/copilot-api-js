# RFC: 可扩展运营 stats 框架 + 删除 lineage/sessions 物化表

**Status:** 已落地（2026-06-23）。9 commit 序列完成（删除阶段 3 + agentId 1 + telemetry registry 框架 1 + 维度/成本/cap 1 + `/api/stats`+dashboard 1 + 本文档 1）。
**Author:** ECC，grounded in 读码 + `localhost:4141` live history 实测 + 2 轮对抗 subagent review（扩展性视角 + registry 数据结构视角）。
**Driver:** 用户发现 anthropic 请求带 `x-claude-code-session-id`/`x-claude-code-agent-id`，需求从"按 session 聚合"逐步收敛为：**删 lineage（死）+ 删 sessions 物化表（drift）+ 把运营 stats 做成可长远扩展的持久 telemetry**（用户明确指示弱化 YAGNI、优先长远灵活）。

---

## 1. 背景与动机

`request-telemetry.ts` 早有持久 per-model 遥测（per-model + global counters，5min×7d buckets，独立 JSON 文件持久、**不随 SQLite GC 蒸发**），前端 `VDashboardPage` 已展示。但内部是 5 个硬编码 `let` map + 指标在 6 处手抄——不可扩展，加维度/指标要改六处。

三条独立诉求在此交汇：

1. **lineage 已死**——内容哈希重建对话树，实测 500 root ≈ 500 entry 零聚类（rootHash 含每轮漂移的 `system[0]`）；仅 anthropic 路径、UI 零消费、codex 已有 `previous_response_id`。删。
2. **sessions 物化表 drift**——浏览价值低（GC 后不需浏览），且与 entries 表是冗余物化（可 `GROUP BY session_id` derive）。删表、改 entries-derived。
3. **统计应持久且可扩展**——用户洞察：统计在 entries GC 后仍要保留（"这与投影不同"），真正值得持久的是**运营 stats**。telemetry 不做 N 个硬编码维度，做**可扩展 registry 框架**：加维度/指标/导出格式 = 注册一行，非六处编辑。

## 2. 为什么不用 OpenTelemetry

调研后明确**不引 OTel 作引擎**，理由是场景不匹配 + Bun 运行时损坏：

- **Bun 自动 instrumentation 损坏**——OTel 的 auto-instrumentation 在 Bun 下不工作（Bun #29586/#32472/#30669）；手动 metrics API 虽 Bun-safe，但 in-memory、无持久、无内建 UI。
- **自包含场景不匹配**——OTel metrics 要外部 Prometheus + Grafana 才有价值，与本项目"自包含 + 内建 WebUI + 文件持久"的定位冲突。我们要的是开箱即用的持久遥测 + 内建 dashboard，不是把可观测性外包给一套独立基础设施。

OTel 的形状仍可后续以 **`/metrics` Prometheus-text 桥**桥接（见 §6），但那是可选导出口，不是引擎。

## 3. 架构：dimension/measure registry 框架

分两层，关注点分离：

### 3.1 sink 层维度 registry（`observability/telemetry-dimensions.ts`）

维度 = 注册的 key-extractor，签名 `(entry: HistoryEntryData, ctx: RequestContextSnapshot) => string | string[] | null`。提取在 sink 层做——这里 entry/ctx 类型 in-scope——算出 per-dimension 的 key-bag 交给 `request-telemetry.ts`，使后者保持 type-light（只 import `UsageData`，永不 import entry/ctx）。这是 review C1 的核心结论（提取下沉 sink、telemetry 收 key-bag）。

当前注册 5 维度：

| 维度 | extract | cardinality | 备注 |
|---|---|---|---|
| `model` | `outboundResponse?.model ?? inboundRequest.model ?? "unknown"` | capped | back-compat 维度，投影到 `modelsSinceStart`/`modelsLast7d`。**capped**：key 取自 client 可控的原始 model 串（未知 model 原样转发、上游 400、仍 settle failed 被记），故须有界（见 §3.6 + CRITICAL-1 修复 `1da0cf5`） |
| `endpoint` | `entry.endpoint`（EndpointType，恒存在） | bounded | |
| `client` | `normalizeClient(httpHeaders?.inboundRequest)` | capped | user-agent 归一到产品 token（`claude-cli/1.2.3`→`claude-cli`，折叠版本号），无 UA→`null`（跳过） |
| `agentKind` | `entry.agentId ? "subagent" : "main"` | bounded | 来自 `x-claude-code-agent-id`，已端到端 plumb 并落 `entries_v2.agent_id` 列 |
| `tool` | `extractToolNames(entry)`（**multi-key**） | capped | 见 §3.4 caveat |

`null` 语义：extractor 返回 `null` = "对本请求不适用" → 该请求不计入此维度，故各维度的请求总数可合法不同（如 `tool` 只计调了工具的请求）。`model`/`endpoint`/`agentKind` 永不 `null`，故其总数恒等于 settled 请求数。空/whitespace key 归一到 `"unknown"`。

**加第 6 维**（per-stop-reason / per-status / per-git-sha…）= `TELEMETRY_DIMENSIONS` push 一行 + 给 `cardinality`，record/persist/load/breakdown 全靠遍历 registry，零其它编辑。

### 3.2 measure = 开放 counters bag（`request-telemetry.ts`）

`StatAccumulator { counters: Record<string, number> }`——开放 bag 而非固定 struct。`createAccumulator()` 把 `MEASURE_NAMES`（9 核心 + 5 成本）全初始化为 0（结构性保证全 measure 存在，避免 `undefined → NaN`——本项目 tsconfig 无 `noUncheckedIndexedAccess`，`Record<string,number>` 索引类型是 `number`，靠 createAccumulator 把这个类型谎言变诚实，而非到处 `?? 0`，那会被 lint 判死代码，review M1）。

`BASE_MEASURE_NAMES`（9 核心）与 `MEASURE_NAMES`（核心 + 成本）拆分：前者用于 V2 文件校验（`isValidPersistedModelTelemetry` 不能要求 V2 文件预存的成本字段）+ model 聚合；后者用于 createAccumulator 初始化。

加 measure = `MEASURE_NAMES` 一行 + `applySettledMeasures` 一行；**开放 bag + 泛型 (de)serializer 使其无持久版本 bump**（review L2：泛型 counters 复制器 `{...acc.counters}`，非字段枚举）。

### 3.3 成本 per-token-type（measure 扩展）

成本**拆分 per token type**（`costInputTokens`/`costOutputTokens`/`costCacheReadInputTokens`/`costCacheCreationInputTokens`/`costReasoningTokens`），而非单标量 `estCost`。理由（review HIGH-2）：billing `multiplier` per-request 变化（不同模型不同倍率），**聚合后无法重算**——per-type 拆分是唯一能保留"未来差异化 per-token-type 定价"的形态。`multiplier` 从 `ctx.multiplier`（sink 读 ctx 快照，非 entry——倍率在 ctx 不在 entry）。token-based 账户 `multiplier` undefined → 成本段全 0（cost 段省略）。

### 3.4 tool 维度的 wire-name caveat（暂缓 restored-name 投影）

一个 entry 可含多个 tool_use → 多 key（extractor 返回 `string[]`，record 按 distinct key 去重累加一次）。从 `entry.outboundResponse.content` 提取（兼容 Anthropic content-block 数组 `type:"tool_use"` 与 OpenAI/Responses `tool_calls[].function.name` 两种形态）。

**caveat**：tool 名是**wire 名**——还原名 mapper 在 `ctx.toolNameMapper` 非 entry/snapshot。本框架记 wire 名（`sanitizeToolNames` 默认 `false` 时 wire == client 名）。**暂缓**"finalize 时把 restored 名投影进 entry"——避免为一个默认关闭的配置给 finalize 路径背契约（YAGNI 边界：默认配置下无差异，开启 sanitize 时记 wire 名 + 本文档化）。

### 3.5 通用持久 envelope（无版本 treadmill）

```jsonc
{ version: 3, buckets: {ts: count}, dimensions: { [name]: { buckets: {ts: {key: {counters}}} } } }
```

维度是数据非 schema：加维度/measure = 数据，**无 V4 bump、无 loader 分支**。loader V3 泛型迭代所有维度名（无 allow-list，未知未来维度 round-trip forward-compat）；V2 `modelBuckets` → `model` 维度 buckets 一次性迁移；V1 buckets-only。**`dimSinceStart` 加载后保持空**（进程生命周期、从不持久——与旧 `modelStatsSinceStart` 同语义，review C2 不变量）。

### 3.6 基数 cap（高基数维度内存/JSON 防护）

`model`/`client`/`tool` 都是 client 可控、潜在无界（`model` 的 key 是 client 原始 model 串——未知 model 原样转发、上游 400、仍 settle failed 被 telemetry sink 记，故与 user-agent/tool 名同样可被滥用，CRITICAL-1）。capped 维度的 key 数 ≥ `CARDINALITY_CAP`（200）时新 key 并入 `"other"`。cap **按 store 独立解析**——`dimSinceStart` 与目标 bucket 各为自己的 cap 权威，故每个 bucket 的 key 数独立有界 `CAP + 1`，且**无视进程重启**：load 时 `dimSinceStart` 重置为空、`dimBuckets` 却保留已达上限的 keys，若用单一 `dimSinceStart` 权威则重启后落入同一 bucket 的新流量会绕过 cap 把该 bucket 撑爆（实测探针 401，已修，commit `f3469cd`）。代价是一个 capped key 可能在 sinceStart 窗口为真名、在 7d 窗口为 `"other"`（两窗口回答不同查询、cap 是有损边界，可接受）。`normalizeClient` 先把 UA 折叠到产品 token 降基数；只有 `endpoint`（4 值路由 enum）/`agentKind`（main/subagent）是真 bounded、免 cap（review H1 + CRITICAL-1）。

## 4. `/api/stats` 端点

`GET /api/stats?dimension=<name>&window=<sinceStart|7d>&limit=<N>`（management OpenAPIHono router，精确 zod schema，自动进 `/openapi.json`）。`getDimensionBreakdown` 泛型投影任意注册维度：**server-side top-N**（按 requestCount → 总 tokens 排序，余下并入 `"other"`，与基数 cap 的 `"other"` 合并不重复）；`7d` window 带 per-key series（review H3：generic 形状含 series 以免后续 API bump），`sinceStart` 无 series。未知维度 400 + 合法维度清单。

**不塞 `/api/status`**（review H3）：health-poll status 只保留 `model` 维度摘要（back-compat，前端 `useModelTelemetry` 仍读它），其余维度走 `/api/stats`——加维度永不膨胀频繁轮询的 status payload。

## 5. 前端 dashboard

`useOperationalStats` 并行轮询 endpoint/client/agentKind/tool 各 breakdown（10s，window=7d + top-N）。`DashboardBreakdownPanel`（泛型 per-key 条 + req/tok/cost subline）。`VDashboardPage` 新增 breakdown 区：main-vs-subagent token 占比 / per-endpoint / per-client / per-tool。类型从 `~backend/lib/request-telemetry` re-export。`model` 维度保留专属 `useModelTelemetry` 面板（喂 `/api/status`）。

## 6. `/metrics` Prometheus 桥（已落地）

`GET /metrics`（**常开**——它暴露的 token/cost/请求计数与已公开的 `/api/stats` 完全同源，无新增暴露面；空闲端点零成本，故不设 config 开关，与 `/api/stats`·`/openapi.json` 一致）。registry 落地使其成为纯机械投影：遍历 `TELEMETRY_DIMENSION_NAMES` × keys × `TELEMETRY_MEASURE_NAMES`，复用 `getDimensionBreakdown(dim, "sinceStart")` 输出 Prometheus 文本（v0.0.4，零依赖、不引 OTel SDK）。`src/lib/metrics-exposition.ts`（纯函数 `renderPrometheusMetrics` + live 包装 `buildMetricsExposition`）+ `src/routes/metrics/route.ts`（plain Hono，text/plain）。

设计要点：
- **数据源 = `dimSinceStart`（进程生命周期累积）**——Prometheus counter 须单调累积；5min×7d rolling 窗口会 prune、非单调，故不用。进程重启 = counter reset，正是 `rate()` 已处理的语义。
- **命名** `copilot_api_<measure_snake>_total{dimension,key}`（counter 后缀 `_total`、label 不编码进名）+ 全局 `copilot_api_accepted_requests_total`；measure 名经 camelCase→snake_case。
- **跨维度语义**：一个 settled 请求计入每个维度，故同一总数在每维度各出现一次——**平行视图、非加性**，消费者按 `dimension` label 过滤、绝不跨维度求和（输出顶部有注释 + 镜像 `/api/stats`）。
- **基数**：capped 维度（model/client/tool）已 ≤201 keys/维度（cap），故 series 数有界，`ALL_KEYS_LIMIT` 全量导出仍安全；label value 转义 `\ " \n` + strip `\r`，非有限值映射 `+Inf`/`-Inf`/`NaN`。

## 7. 暂缓项（registry 已铺 seam，未来一行接）

- **~~latency 百分位（p50/p95）~~（已落地）**——见 [telemetry-histograms.md](telemetry-histograms.md)。每 `(dim,key)` 挂 `{buckets,sum}` 自track直方图（duration_ms/queue_wait_ms/input_tokens/output_tokens），存进开放 bag 的 `__histograms` sibling（零版本 bump、旧 V3 无损升级），breakdown 投影 p50/p90/p95/p99，`/metrics` 出标准 Prometheus histogram。验证了 §3 histogram slot 的"开放 bag 不 foreclose"判断。
- **tool restored-name 投影进 entry**——见 §3.4，默认 sanitize off 时无差异，暂缓。

## 7. 删除明细（lineage + sessions）

- **lineage**：删 `lib/history/lineage/*`(6) + `scripts/backfill-lineage.ts` + 测试；`entries.ts`/`write.ts` 去 digest 写入；`handler.ts`/`route.ts`/`openapi-compat.ts` 去 `/lineage`·`/conversations`；schema 删 CREATE，`connection.ts` 启动期 `DROP TABLE IF EXISTS entry_lineage; entry_produced_tool_ids`。
- **sessions 物化表**：删 `sessions` CREATE + `recomputeSession`/`UPSERT_SESSION_SQL` + `listSessions`/`getSessionById` + session 浏览 REST；`exportHistory` 的 sessions 字段改 **derived**（`GROUP BY session_id`）；`computeStats` 的 `SELECT FROM sessions` 改 derived `COUNT(DISTINCT session_id)`（**隐藏消费者**，全套件才暴露）；`connection.ts` `DROP TABLE IF EXISTS sessions`。
- **entries-derived 保留**：`getSessionEntries`（conversation-rebuild 活消费者）、`queryEntries({sessionId})`、`entries_v2.session_id` 列、`deleteSession`（rebase existence check 到 queryEntries）、`response_sessions` + codex `previous_response_id` 链——全保留。

## 8. agentId plumbing（含 `entries_v2.agent_id` 列）

镜像 sessionId 全链：header `getAgentIdFromHeaders`（`x-claude-code-agent-id`）→ 6 codec/handler 提取点 → `RequestContext`（types/request/manager）→ `HistoryEntry.agentId` + `entries_v2.agent_id` 列（serialize/write/read + migration + `idx_entries_v2_session_agent`）+ `QueryOptions.agentId`。richest-data-flow：加列 cheap、future-proof（per-agent 查询 / telemetry agentKind backfill），不加则永久 foreclose。

## 9. commit 序列（每个中间 commit 编译 + 测试绿）

1. `eacae48` 删 lineage write/compute path
2. `3128b9b` 删 lineage REST + OpenAPI
3. `cd54f21` 删 lineage 模块 + drop dead tables
4. `bf093c7` 删 sessions 物化表 + stats entries-derived
5. `6dee399` agentId 端到端 + entries_v2.agent_id 列
6. `2a9cc4a` telemetry registry 框架 + 泛型 V3 持久（golden 字节等价锁）
7. dims（endpoint/client/agentKind/tool）+ per-token cost + cardinality cap
8. `/api/stats` 端点 + operational stats dashboard
9. 本 RFC + 文档同步 + memory 维护

## 10. 验证

- **golden**：commit 6 在旧码先锁 model telemetry snapshot 逐字节 golden（`tests/pipeline/request-telemetry.unit.test.ts` `.toEqual`），commit 7-9 任何改动后仍逐字节过——成本 measure 不进 model snapshot 投影，故 golden 不变。
- **unit**：各维度累加（含 multi-key tool 去重）、normalizeClient、extractToolNames（两种形态）、per-token cost（×multiplier、undefined→省略）、基数 cap `"other"` 溢出、null skip、`getDimensionBreakdown`（sinceStart 无 series / cap+top-N `"other"` 合并 / 未知维空）+ V1/V2→V3 迁移 + 未知维度 forward-compat round-trip。
- **.http**：`/api/stats?dimension=*` 各维度 + top-N/`"other"` + 未知维 400；`/api/status` 只含 model 摘要（不膨胀）。
- **vitest**：mount `DashboardBreakdownPanel`。

## 11. review 方法论

2 轮对抗 full review（subagent 全量工具、显式裁判轴：长远正确 + 完整，反 ROI/YAGNI；实现在主线、subagent 作核验层；绝对断言对照代码/实测复核）。Review A（扩展性/弱化 YAGNI）：维度=registered extractor、measure=开放 counters bag、generic 持久、`(entry,ctx)` extractor、per-token cost、`/api/stats` 不塞 status、agentId 列加上、histogram slot 延迟但别写字段枚举复制器。Review B（registry 数据结构）：C1 提取下沉 sink、L2 泛型复制器、C2 sinceStart 加载后空、H1 两层归一化、H2 `null`=skip、H3 generic breakdown 含 series、M1 单一 MEASURE_NAMES + golden 兜底 typo、M2 复用精确比较器、M3 按 startedAt 分桶、L1 loader 泛型迭代。

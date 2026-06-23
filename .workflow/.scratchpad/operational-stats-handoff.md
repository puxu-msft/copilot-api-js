# 交接文档：运营 stats + lineage/sessions 移除（commit 7-9 待续）

> 分支 `feat/openapi-and-dep-upgrade`。本特性已完成 6/9 个 commit（删除阶段 + agentId + telemetry registry 框架），剩 commit 7-9（注册 4 维度+成本+基数 cap / `/api/stats`+dashboard / RFC+文档）。
> 完整设计计划见 `~/.claude/plans/reflective-swimming-knuth.md`（权威设计源）。本文是**执行态交接** + 每 commit 的 self-contained kick-off 提示词。

## 0. 一句话上下文（why）

用户发现 anthropic 请求带 `x-claude-code-session-id`/`x-claude-code-agent-id`，需求从"按 session 聚合"逐步收敛为：**删 lineage（死）+ 删 sessions 物化表（drift）+ 把运营 stats 做成可长远扩展的持久 telemetry**（弱化 YAGNI、长远灵活）。不用 OTel（Bun 自动 instrumentation 损坏 + 自包含场景不匹配）。

## 1. 已完成并提交（全部全绿、独立编译、commit-invariant 守住）

| commit | 内容 | 关键点 |
|---|---|---|
| `eacae48` | 删 lineage write/compute path | entries.ts/write.ts 去 digest；删依赖 lineage 写入的 write-path/query/conversations 测试（实测修正了 plan 的 commit 切分） |
| `3128b9b` | 删 lineage REST + OpenAPI | handler/route/openapi-compat 去 `/lineage`·`/conversations` |
| `cd54f21` | 删 lineage 模块 + drop dead tables | 删 `lineage/*`(6)+backfill 脚本+测试；schema 删 CREATE + connection `DROP TABLE IF EXISTS entry_lineage/entry_produced_tool_ids`；DESIGN.md 删死路径（L1 守卫） |
| `bf093c7` | 删 sessions 物化表 + stats entries-derived | 23 文件 census；**抓到隐藏消费者 `computeStats` 的 `SELECT FROM sessions`**（改 derived `COUNT(DISTINCT session_id)`）；`getSessionEntries`/`deleteSession`/`response_sessions` 保留 rebase；UI 删 fetchSessions/sessions ref |
| `6dee399` | agentId 端到端 + entries_v2.agent_id 列 | 24 文件镜像 sessionId；列 + `idx_entries_v2_session_agent` + migration；`QueryOptions.agentId`+`mainAgentOnly`；**故意跳过 events.ts 的 ctx-snapshot agentId**（telemetry 读 finalized entry.agentId，非 snapshot；且 events.ts 有并发未提交工作） |
| `2a9cc4a` | **telemetry registry 框架** + 泛型 V3 持久化 | 见 §3；经对抗 review（C1+L2）+ golden 字节等价锁 |

## 2. 并发上下文（**交接者必读**）

- **同分支上有另一个 agent 会话活跃提交**（header 捕获 RFC / Phase 3 per-attempt 头持久化 / pre-response abort / keepalive 重整）。它的 commit 与我的交错（如 `08b2124`/`5239328`/`8a10f06` 夹在我的中间），但我的 6 个 commit 均完整。
- **HEAD 会在脚下移动**：提交一律用 `git commit -m "..." -- <精确路径>`（pathspec），提交前 `git diff --cached --name-only | grep -cvE "^(src|tests|...)/"` 确认 0 污染。
- **它当前未提交的工作文件**（`git status --short` 的 `M`）：`src/lib/config/config.ts`、`src/lib/config/schema.ts`、**`src/lib/observability/events.ts`**、`src/lib/state.ts`、`tests/config/config-hot-reload.it.test.ts`。**绝不编辑这些文件**（碰它们会裹入它的在飞工作，见 [[sed-touched-files-bundle-inflight-work]]）。**type-only import** 从 events.ts 取类型（如 `RequestContextSnapshot`）是安全的（不编辑）。
- commit 7 若需 ctx.multiplier（成本），sink 读 `event.ctx.multiplier`——**只读、不编辑 events.ts**。

## 3. 架构现状（telemetry 框架——commit 7-9 在其上扩展）

**`src/lib/request-telemetry.ts`（type-light 聚合叶子，只 import `UsageData`）**：
- 存储：`dimSinceStart: Map<dimName, Map<key, StatAccumulator>>`（进程生命周期、**不持久**）+ `dimBuckets: Map<ts, Map<dimName, Map<key, StatAccumulator>>>`（5min×7d、**持久**）+ `bucketCounts`/`acceptedSinceStart`（全局 accepted，未动）。
- `StatAccumulator { counters: Record<string, number> }`——**开放 counters bag**。
- `MEASURE_NAMES`（9 个：requestCount/successCount/failureCount/totalDurationMs/inputTokens/outputTokens/cacheReadInputTokens/cacheCreationInputTokens/reasoningTokens）= **单一真相源**；`createAccumulator()` 初始化全 9 为 0；`applySettledMeasures(acc, opts)` 累加。
- **API**：`recordSettledRequest(keys: Record<string, string | null>, opts: SettledTelemetryInput)`——**key-driven**（`null`=skip 该维度；非 null 经 `normalizeKey`=`trim()||"unknown"`；按 `opts.startedAt` 分桶）。`SettledTelemetryInput = { startedAt, endedAt, success, usage? }`。
- snapshot：`getRequestTelemetrySnapshot()` 投影 `model` 维度 → `modelsSinceStart`/`modelsLast7d`（back-compat 精确形状，复用 `compareModelSnapshots` 4-key 比较器 + `toModelSnapshot`/`toUsageTotals`）。
- 持久 V3：`{version:3, buckets:{ts:count}, dimensions:{name:{buckets:{ts:{key:{counters}}}}}}`；**泛型 counters 复制器**（`{...acc.counters}`，未来加 measure/`hist?` 零版本 bump）；loader V3 泛型迭代所有 dim（forward-compat：未知维度 round-trip）/ V2 `modelBuckets`→`model` 维度迁移 / V1 buckets-only；**`dimSinceStart` 加载后保持空**（进程生命周期，C2 不变量）。

**`src/lib/observability/telemetry-dimensions.ts`（sink 层维度 registry，entry/ctx 在此 in-scope）**：
- `StatDimension { name; extract: (entry: HistoryEntryData, ctx: RequestContextSnapshot) => string | null }`。
- `TELEMETRY_DIMENSIONS: ReadonlyArray<StatDimension>` = 当前只 `[model]`。
- `extractTelemetryKeys(entry, ctx): Record<string, string | null>`——sink 调它算 keys。

**`src/lib/observability/sinks/telemetry.ts`**：`handle` 调 `recordSettledRequest(extractTelemetryKeys(entry, event.ctx), {...})`；aborted 仍排除（只订阅 completed/failed）。

**golden 测试**：`tests/pipeline/request-telemetry.unit.test.ts`——`.toEqual` 锁死 modelsSinceStart/modelsLast7d 逐字节 + V2→V3 迁移 + 未知维度 forward-compat。**commit 7-9 任何改动后这些必须仍逐字节通过**。

## 4. 踩坑（交接者避雷）

1. **隐藏消费者**：删/改 schema 后**跑完整 `bun run test:backend`**（非仅 history 域）——`computeStats` 的 `SELECT FROM sessions` 只在全套件暴露（179 测试连环挂），不在 history 子域。同理 commit 7 改 telemetry 后跑全套件。
2. **lint `no-unnecessary-condition`**：项目 tsconfig **无 `noUncheckedIndexedAccess`**，故 `Record<string, number>` 索引访问类型是 `number`（非 `|undefined`），`counters[name] ?? 0` 被判死代码。**别加 `?? 0`**——靠 `createAccumulator` 结构性保证全 measure 存在 + golden 测试兜底 read typo。`Map.get()` 返 `|undefined` 则可正常 `if(!x)` 窄化（持久循环用 Map 构建即因此）。
3. **lint-staged 失败回滚**：lint 错误时 lint-staged stash-then-revert 工作区再中止 commit（[[lint-staged-rollback-behavior]]）。提交前先 `bun run eslint --fix <files>` 预修。
4. **Edit "File has not been read"**：很多文件我只 grep 没 Read 工具读过，Edit 前需 Read；并发会话改过的文件会"modified since read"需重读。
5. **bun 命令**：`bun run test:backend`/`typecheck`/`test:ui`/`typecheck:ui`，**不是 `npm`**。

## 5. 验证命令

```bash
bun run typecheck                 # 后端 tsc（+ e2e-ui tsconfig）；exit 1 可能是 wrapper 噪声，分别 npx tsc --noEmit 看
bun run test:backend              # 全后端 offline（~3000 测试，~28s）——改 .ts/schema 后必跑
bun test tests/pipeline/request-telemetry.unit.test.ts   # golden 字节等价（改 telemetry 后必跑）
bun run typecheck:ui && bun run test:ui                  # UI（commit 8 dashboard 后）
# live 验证（用户跑着 4141 后端，有 ce6fd04e + 3 subagent 真实流量）：
curl -s localhost:4141/api/status | jq '.requestTelemetry'   # 看维度 breakdown
```

---

## 6. Commit 7 提示词（注册 4 维度 + per-token 成本 + 基数 cap）

> 框架已就位（§3）。本 commit 是**框架扩展 + 注册**。读 `~/.claude/plans/reflective-swimming-knuth.md` §一·五 + 本文 §3 + §4 踩坑。golden 测试改后必须仍逐字节过。

**任务**：
1. **注册 4 个维度**（`telemetry-dimensions.ts` 的 `TELEMETRY_DIMENSIONS` push）：
   - `endpoint`：`extract: (entry) => entry.endpoint`（EndpointType，恒存在）。
   - `client`：`extract: (entry) => normalizeClient(entry.httpHeaders?.inboundRequest)` —— 从 `user-agent`/`x-app` header 归一（如 `claude-cli`），缺失→`null` 或 `"unknown"`。**注**：`HistoryEntryData` 是否带 `httpHeaders`？核实（可能要从别处取，或 agentKind 同源）；若 entry 无 header 则该维度此 commit 暂缓或从 ctx 取。
   - `agentKind`：`extract: (entry) => entry.agentId ? "subagent" : "main"`（恒非 null）。
   - `tool`：**multi-key**——一个 entry 调多个工具 → 多个 key。从 `entry.outboundResponse` 的 tool_use blocks 提 name。**框架扩展**：`StatDimension.extract` 返回类型扩为 `string | string[] | null`；`extractTelemetryKeys` 返回 `Record<string, string | string[] | null>`；`recordSettledRequest` 对数组逐 key 累加。**注**：tool 名是 **wire 名**（mapper 在 ctx 非 entry/snapshot，见 plan §四 C4 caveat）——记 wire 名 + RFC 文档化；`sanitizeToolNames` 默认 false 时 wire==client。
2. **per-token 成本**（measure 扩展）：`SettledTelemetryInput` 加 `multiplier?: number`；sink 传 `event.ctx.multiplier`（events.ts:81 `RequestContextSnapshot.multiplier`，**只读不编辑 events.ts**）。`applySettledMeasures` 加成本 counter——**设计决策（需定/问用户）**：单 `estCost`（= billable tokens × multiplier 累加）vs **per-token-type**（`estCostInput`/`estCostOutput`/`estCostCacheRead`/... 各 `tokens_type × multiplier` 累加，review HIGH-2 倾向，因 multiplier per-request 变化、聚合后无法重算，per-type 保留未来差异化定价的拆分）。加进 `MEASURE_NAMES`。`multiplier` undefined（token-based 账户）→ cost 段省略/0。
3. **基数 cap**（client/tool 高基数 → 无界内存/JSON 防护，review H1）：`StatDimension` 加 `cardinality?: "bounded" | "capped"`（model/endpoint/agentKind=bounded 免 cap；client/tool=capped）。`recordSettledRequest` 对 capped 维度：新 key 且该 dim 当前 key 数 ≥ CAP（如 200）时并入 `"other"`（sinceStart + 每 bucket 双写一致）。
4. **测试**：unit——各维度累加（含 multi-key tool）、normalizeClient、estCost(×multiplier、undefined→省略)、基数 cap "other" 溢出、`null`=skip。`.it`——settled 事件经 sink → snapshot 各维度（但 snapshot 目前只暴露 model；generic breakdown 是 commit 8，故 commit 7 可加内部 `_getDimensionBreakdownForTests` 或等 commit 8）。**golden 仍逐字节过**。

**Inv**：全维度持久记录、高基数有界、model golden 不变。**改后跑 `bun run test:backend`**。

---

## 7. Commit 8 提示词（`/api/stats` 端点 + 运营 stats dashboard）

> 框架已存全维度数据（commit 7）。本 commit 暴露 + 可视化。

**任务**：
1. **generic breakdown 投影**（`request-telemetry.ts`）：`getDimensionBreakdown(dimName, window: "sinceStart"|"7d", limit?)`——从 `dimSinceStart`/`dimBuckets` 投影任意维度的 `{key, counters, series?}`，**server-side top-N**（按 requestCount/tokens 排序取前 N + `"other"` 聚合余下，review H3：generic 形状含 per-key series 以免 commit 后 API bump）。`key ''`/sentinel 无（agent 维度不用 sentinel，直接 main/subagent 字符串）。
2. **`GET /api/stats?dimension=<name>&window=<sinceStart|7d>&limit=<N>`**（review H3：**不塞 `/api/status`**——health-poll 保持小；status 只留 totals 摘要）。装在 management router；OpenAPI 经 `openapi-compat.ts` registerPath。
3. **前端 dashboard**（greenfield，复用 `ui/src/pages/vuetify/VDashboardPage.vue` + `useModelTelemetry`/`useDashboardStatus`/`CompactTimelineBarChart`）：per-endpoint/client、**main-vs-subagent token 占比**（堆叠条/饼）、per-tool 频次、per-model 成本（per-token-type）、趋势图。类型从 `~backend` re-export。遵守 `ui/CLAUDE.md`（rounded:0、暖琥珀、`.state-shell`、图表入设计系统）。
4. **测试**：`.http`——`/api/stats?dimension=*` 各维度 + top-N/"other"；`/api/status` 不膨胀。vitest mount dashboard。

**Inv**：仪表盘展示全维度；health-poll status 不膨胀。**改后 `bun run test:backend` + `test:ui` + `typecheck:ui`**。

---

## 8. Commit 9 提示词（RFC + 文档同步 + memory）

**任务**：
1. 落 `docs/rfc/operational-stats-and-lineage-removal.md`：registry 框架设计（dimension/measure registry、generic V3 持久、extraction-in-sink C1、generic copier L2）+ OTel 决策（Bun 自动 instrumentation 损坏 + 自包含不匹配）+ tool wire-name caveat + `/metrics` Prometheus 桥**暂缓**形状（registry 使其后续一行接，零依赖手写）+ latency 百分位**暂缓**（histogram slot 已留路、未填）。
2. **标记废弃** 6 处 lineage 文档：`docs/rfc/request-lineage.md`、`request-lineage-v2.md`、`docs/DESIGN.md`（已删模块图行）、`docs/v4/02-current-state.md`（lineage schema/REST 行）、`docs/memory/MEMORY.md` + `lineage-canonicalization-rules.md`。
3. **回填 DESIGN.md**「活的架构现状」+「运行时选项」+「核心模块」：sessions 物化表退役（stats entries-derived）、entries_v2.agent_id 列、telemetry registry 框架 + `/api/stats`。
4. **memory 维护**：删过时 lineage memory（`lineage-canonicalization-rules` 等若纯陈旧）；新增可复用教训（如"隐藏消费者须跑全套件"、"registry 框架的 extraction-in-sink 分层"、本次 golden-pre-capture 实践）。
5. **`docs/v4/02-current-state.md`** 等若提 sessions/lineage REST 同步。

**Inv**：`grep -rn lineage src/` 干净（已是）；文档与代码一致；L1 守卫 `design-doc-tree.unit` 绿（DESIGN.md 引用的路径都存在）。

---

## 9. 参考

- **设计计划**（权威）：`~/.claude/plans/reflective-swimming-knuth.md`
- **2 轮对抗 review 结论**（已吸收）：
  - Review A（扩展性/弱化 YAGNI）：维度=registered extractor、measure=开放 counters bag、generic 持久、`(entry,ctx)` extractor、per-token cost、`/api/stats` 不塞 status、agentId 列加上、histogram slot 延迟但别写字段枚举复制器。
  - Review B（registry 数据结构，commit 6 前）：**C1** 提取下沉 sink 层（telemetry 保 type-light、收 key-bag）；**L2** 泛型 counters 复制器（非字段枚举）；**C2** V2→V3 迁移后 sinceStart 须空；**H1** `trim()||"unknown"` 两层归一化复现；**H2** `null`=skip、model 永不 null；**H3** generic breakdown 含 per-key series；**M1** 单一 MEASURE_NAMES + golden 兜底 typo；**M2** 复用精确比较器、golden 先在现码捕获；**M3** 按 startedAt 分桶；**L1** loader 泛型迭代 dimensions。
- **review 方法论**：subagent 全量工具、显式裁判轴（长远正确+完整，反 ROI/YAGNI）、实现在主线/subagent 作核验层、绝对断言对照代码复核。

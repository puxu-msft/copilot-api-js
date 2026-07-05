# ui-v4 设计规格（spec）

> copilot-api 请求历史查看器前端的 React 全面重构。本文是 brainstorm 阶段定稿的**权威设计规格**。chronological 决策草稿见同目录 [decisions.md](decisions.md)（已被本文 supersede，仅留档）。
>
> 状态：设计定稿、**已过 3-subagent 对抗 review + 主会话逐条核验 + 3 项用户拍板**、待用户复审 → 转 implementation plan。日期：2026-06-23。review 修订追溯见 §12。

## 1. 目标与定位

把现有 `ui/`（Vue 3 + Vuetify 4，113 文件 / ~15.5k 行，功能 oracle）**重新构想信息架构**，用 React 重写到 `./ui-v4`。核心理念：从"请求历史浏览器"升级为"**实时 LLM 流量检视台**"（DevTools/Network-inspector 范式）。

- **范围**：IA / 布局 / 交互可重新设计；后端契约与"双格式内容渲染"领域核心必须忠实保留。
- **共存**：与 `ui/` 并行，挂新路径；达对等后再替换、退役旧 UI。

### 非目标

- 不重造完整 metrics dashboard（深度时间序列/维度分析交 Grafana，消费已有 `/metrics`）。
- 不投入精细移动端打磨（desktop-first，窄屏仅"能用不崩"）。
- 不引入第三套搜索 UI（只有全局 + 请求内两级）。

## 2. 技术栈

| 关注点 | 选型 |
|---|---|
| 框架 | React + TypeScript（strict） |
| UI 组件 | **shadcn/ui**（Radix Primitives headless + Tailwind，组件 copy-paste 进仓库） |
| 构建 | Vite + Tailwind；bun-first（全栈 Bun 原生、无 node-gyp） |
| server-state | **TanStack Query**（缓存/SWR/失效），WS 事件喂 Query cache |
| client-state | **Zustand**（UI 偏好/过滤/tail 状态等） |
| 实时 | 移植现有类式 **WSClient**（auto-reconnect 指数退避 + topic 订阅） |
| JSON 查看器 | **可控渲染器**（CodeMirror 6 JSON + 可控 search/fold，或自建虚拟化树）——见下方修订说明，**不用** @uiw/react-json-view |
| diff | **jsdiff**（叶子文本/词 diff）+ 自建按 role/帧类型领域对齐（逐字移植 `block-diff.ts`） |
| 消息文本 | **纯文本 + 搜索高亮**默认，**逐块「原文 ↔ markdown 预览」可切换**（markdown 用 react-markdown + rehype，按需加载） |
| 样式 | **Tailwind v4**（oxide/lightningcss 预编译 `.node`——按 `docs/DESIGN.md` 审计判据**显式认定为「构建工具预编译产物，仅构建期、不进 dist 运行时」豁免**，同 @rollup/@oxc 那批） |
| 测试 | 镜像现有双系统 + e2e：`bun test`（纯逻辑：normalize/类型守卫/block-diff/utils）+ Vitest + React Testing Library（组件，jsdom）+ Playwright（e2e-ui）。**bun vs Vitest 选择规则**：无 DOM 纯逻辑→bun test；需挂载/交互→Vitest（镜像 `ui/CLAUDE.md` 的双系统判据，避免两边漂移） |

> **JSON 查看器修订**：早先选 `@uiw/react-json-view`，但请求内搜索（§6）要在折叠/未渲染 JSON 子树里计数+高亮+跳转定位，该库**无法被外部搜索驱动**展开/定位。故 JSON 段改用**可控渲染器**（CodeMirror 6 JSON + 可控 search/fold，或自建虚拟化树），全段走统一数据模型搜索。`@uiw/react-json-view` 不采用。

> **UI 组件层现状勘误 + 迁移决策（2026-07-05）**：上表的 "shadcn/ui" 在实现中初期**未落地**（交互原语 Modal/Tabs/Menu/resize 全手写、零 Radix），导致 a11y 反复手补踩坑（P4 详情面板实证）。已**采用 `radix-ui` 统一包（headless）增量迁移并落地 P0–P3**："shadcn/ui" 精化为 "Radix Primitives"（弃成品样式、保留 Terminal Amber）。已迁：Modal→`Dialog`、两 tab 轨→`Tabs`、ColumnMenu→`DropdownMenu`、splitter 键盘可操作（保留手写 + APG）。留原生：`ModelsFilterBar` 的 `<select>`（a11y 已合格，视觉-only 可选项暂缓）。→ ADR [decisions/2026-07-05-adopt-radix-primitives.md](decisions/2026-07-05-adopt-radix-primitives.md) + plan [plans/2026-07-05-radix-migration.md](plans/2026-07-05-radix-migration.md)（含 Radix 测试 gotchas [radix-styling.md](radix-styling.md)）。

### Workspace / 构建集成

- ui-v4 = 新 bun workspace 成员（根 `workspaces:["ui","ui-v4"]`，单一根 `bun.lock`）。
- 自有 `package.json`，**FE 库（jsdiff、react-markdown、CodeMirror 等）声明进 `ui-v4/package.json`**（不放根——现有 `diff` 错放在根 package.json 是既有不一致，不照搬；是否迁回 ui workspace 属 ui/ 范围、需另行授权）。
- 别名三条（**`~/*` 不可漏**，因后端源码内部用 `~/*` 自引用，ui-v4 跨引用后端源码时必须能解析）：`@/*`→`ui-v4/src/*`、`~backend/*`→`../src/*`、`~/*`→`../src/*`。vite.config + tsconfig 都要配。
- 后端**新增 `/ui-v4` 静态路由**挂 `ui-v4/dist`（与 `/ui` 并存，可部署并行构建）；开发期 `--external-ui-url` 指向 vite dev。
- **WSClient React 生命周期**：类式 WSClient 提为**React 树外的模块单例 + 引用计数 connect/disconnect**，而非每个 hook 实例一个连接——规避 StrictMode 开发期 effect 双挂载（connect→disconnect→connect 竞态）与 HMR 连接泄漏。

### 后端契约

HTTP `/history/api/*` + 根 `/api/*`，WS，类型经 `~backend/*` re-export（single-source-of-truth）。**新增只读端点**见 §7。

## 3. 信息架构

左 rail 导航：**Overview / Requests / Sessions / Models / Config**。顶栏全局 chrome：全局搜索 + ⌘K 命令面板 + WS 连接状态 + 主题切换（light/dark/system）。rail 底部常驻 upstream 健康 + pid + 版本。

- "Overview" 取代旧 Dashboard，"Requests" 取代旧 Activity。
- 全局元素全做：命令面板、全局搜索、WS+upstream 状态、主题切换。

## 4. Requests 工作台（核心）

> **落地态修订（Plan 08，用户定 2026-06-24）**：本节原设计的"主从一体（列表与详情同屏、不再是两个路由）"**已反转为两路由全屏分离**——`/requests` = 列表全屏、`/requests/:id` = 详情全屏（返回钮），点行/深链导航；`RequestsWorkbench` 已退役。深链（§4.1）、列表稳定性三件套（§4.2）、详情 C 布局分段（§4.3）均保留，只是列表与详情各占一整屏而非同屏。另：Convo/Stages 段加了左侧 TOC 树导航（消息→块 / leg→消息→块，点击滚动跳转 + 高亮）。详见 [README 现状](../README.md) 与 [plans/2026-06-23 ... 08-detail-page-split-toc-tree.md](plans/2026-06-24-08-detail-page-split-toc-tree.md)。下文为原始设计稿，保留作设计意图参考。

主从一体（DevTools/Network 范式）：左侧实时列表 + 右侧就地详情，**列表与详情不再是两个路由**。

### 4.1 深链

- 选中请求 ID 编码进 URL：`/requests/:id` = 唯一深链（复制 / 新标签页 / 书签），与旧 `/activity/:id` 等价。
- 过滤/搜索序列化进 query（`?model=opus&q=...`）。
- **详情按 ID 独立 `fetchEntry(id)`**，不依赖该行是否在当前已加载列表窗口 → 被实时流滚出也能完整深链显示。
  - 实证 `src/lib/history/queries.ts:64` `getEntry = getInFlight(id) ?? getEntryById(id)`：**在飞请求 GET `/entries/:id` 返回 in-flight 全量数据（非 404）**，已持久化条目走 SQLite。边界：reaper 已淘汰/已删的 id → 404，前端需处理"条目已不存在"态。

### 4.2 列表稳定性（解决「新请求涌入致选不中 / 深分页新条目丢失 / 终态抖动」）

**修正起点**（review 核实）：现有 `ui/src/pages/vuetify/VActivityPage.vue:116-128` **已有独立 In-flight section**（`inflightRows`，来自 dashboard WS active 流，按 `historyIds` 去重）——所以"在飞与已完成混在一个列表"**不是真实债**。真实未解决债（**均已在 ui-v4 落地**，见各条「已修」）：

- ~~`useHistoryWS.ts` 仅在 `prevCursor===null`（列表在顶部）时 prepend 新条目 → 用户向下翻页时新完成条目**静默丢失**。~~ **已修**：ui-v4 用 `useHistoryInfinite` + list-store 的 tail/buffer 三件套——向下滚动即 `scroll-up`→`tailOn=false`，paused 期间新终态条目记入 `bufferedIds`、出「N 条新」横幅，绝不静默丢失。**关键修复**：终态条目在**完成时**经 WS `entry_updated`（非 `entry_added`，后者在创建态已发）到达，而旧 `onEntryUpdated` 仅在 tailOn 时 invalidate、paused 时什么都不做 → paused 用户漏掉新完成条目。现 `entry_added`/`entry_updated` 统一经 `onEntrySettled` 按 `isTerminalSummary` 门控（`lib/activity-row.ts`，镜像后端 `isInFlightSummary`），终态才 dispatch `incoming`（tailOn→invalidate / paused→buffer）。
- ~~active→completed 瞬间，active 流与 history WS 两路各自更新 → **去重抖动**。~~ **已修**：`terminalOnly=true` 让 History 永不含在飞（消除重复显示），且 `onEntrySettled` 在创建/进行态（active）忽略、只在终态合入——一个请求要么在 Live 泳道要么在 History，不再两路同显。
- ~~失败终态（`failed`/`aborted`/`interrupted`，见 `src/lib/history/types.ts:31` 七态）如何离开 Live 泳道**未定义**。~~ **已修**：后端 `sinks/ws.ts` 对 `request.completed`/`failed`/`aborted` 都发 `action`=对应后缀；live-store `applyActiveEvent` 现对三者都移除（旧版漏 `aborted` → 被中止请求永久卡泳道）。`interrupted` 是 reaper 启动时对崩溃条目的 reclassify、不走 live WS 流，故不进 Live 泳道。
- 注：后端 `/entries` 游标 API 本身经 `getHistorySummaries`（`queries.ts`）**默认 merge 在飞 + 持久化并按 id 去重**（v3 合并 activity 视图所需）。**已落地**（修「Live 与 History 混在一起」）：handler 暴露 `?terminalOnly=true` 二分过滤，按 state 剔除 active 在飞行（pending/executing/streaming），`HistoryList`（经 `useHistoryInfinite`）显式带此参数 → Live 泳道只放在飞、History 永不含在飞。过滤作用于 merge 后结果故 `total`/游标分页保持正确。早先 ui-v4 复用此端点却漏传该参数，是 streaming 请求同时出现在两处的根因。

三件套（client-state，归 **Zustand**，不塞 Query cache）：

1. **Live 泳道**：独立、常驻、固定高度、内部独立滚动；只放在飞请求（WS `active_request_changed` 流）；始终显示（空时空态）、不可折叠、不因空消失；**七态终结后离开本泳道**——`completed` 进 History 并正常着色，`failed`/`aborted`/`interrupted` 也离场并标红（带 terminal reason）；**永不参与游标分页**。
2. **缓冲 + "N 条新"横幅**：新完成条目先缓冲，交互时列表冻结不跳；点横幅/滚到顶才合入（同时修上面的 prepend-gap 与去重抖动）。
3. **选中按 ID 粘滞**：选中是 ID 不是位置；列表重排/涌入都不偷走目标。
4. **tail**：默认 tail-on；选中某行**或**向上滚动 → 自动切 paused（列表冻结）；一键 ▶ 恢复。

### 4.3 详情面板（C · 混合 sticky sub-rail 分段）

- **诊断摘要条常驻**：status / model / ↑bytes / 时长 / attempts / tokens（含 cache token）/ cost / **terminal reason**（client disconnected / process N died——一眼看失败原因，源 `DiagnosticSummary.vue:18-22`）。
- 左侧 sticky 迷你 rail 跳转分段，各段懒加载 + 独立滚动（解决「DetailPanel 过大」债）。**分段需完整覆盖现有 7 腿 + 横切诊断**（review 核实现有 `ui/src/components/detail/` 全量能力，逐一归位，不得丢失）：

  | 分段 | 内容（覆盖现有腿/组件） |
  |---|---|
  | **Convo** | 渲染后对话（请求侧消息）；含 **inbound↔effective 消息级 rewrite diff**——`MessageBlock` 的 modified/rewritten badge + `↔ effective` 跳转 + 「diff」开富 modal（`MessageBlock.vue:119,202-221`、`MessageDiffView.vue`） |
  | **Request stages** | Inbound│Effective│Wire **请求侧三腿单屏并排对比**（per-attempt wire）+ 每腿顶部 headers（见 Headers 段） |
  | **Response** | Upstream（上游原始响应：headers + 解析块 + upstream SSE）与 Forwarded（客户端实收）；含 **`SseFrameDiff`：forwarded vs upstream 帧按类型对齐 diff**（same/modified/dropped/added，`SseFrameDiff.vue`)——现有最核心的流式诊断，**必须保留** |
  | **Headers** | 四腿对比（inboundRequest / outboundRequest / outboundResponse / inboundResponse），request 两腿做 **Client→Proxy vs Proxy→Upstream 并排 diff 高亮**（`HeadersComparisonSection.vue:45-52`）。**注**：现有 headers 是内嵌在每个 stage 顶部；本段集中呈现四腿对比表，stage 内保留指向本段的锚 |
  | **Attempts** | per-attempt 时间线 + per-attempt wire payload 消息级 diff（`AttemptsTimeline.vue`、`AttemptDiff.vue`） |
  | **Meta** | queueWaitMs / transport / currentStrategy / stop_reason / warningMessages / pipelineInfo（truncation/preprocessing/sanitization 计数）/ repetition 诊断 / truncation divider（`MetaInfo.vue:238-340`、`TruncationDivider.vue`） |

- **7 腿映射**：请求侧 Inbound/Effective/Wire→Request stages 段；响应侧 Upstream/Forwarded→Response 段（含帧 diff）；横切 Meta→Meta 段、Attempts→Attempts 段。**SSE 是两套数据**（`entry.sseEvents` 上游原始 + `entry.inboundResponse.sseEvents` 客户端实收）+ 二者 diff，归 Response 段。
- 窄屏退化成横向标签式（见 §8）。
- 待定子项：Request stages 段间 diff 默认并排 vs 按需开（取决于 diff 高频程度）。

## 5. Sessions + Agent

数据模型（实证 `src/lib/history/sessions.ts`）：

- `sessionId` ← header `x-claude-code-session-id`（每会话稳定 UUID）。
- `agentId` ← header `x-claude-code-agent-id`（每 subagent 一个**不透明 id**；main agent 不发此 header，undefined = main）。
- **header 不含 subagent 种类名**；语义名仅能从 payload（Task `subagent_type`）尽力推断 → 后续增强、非 v1 承诺。
- `/entries` 底层 `read.ts` **支持** `?sessionId=` 与 `?agentId=`/`mainAgentOnly` 过滤，**但 HTTP `handler.ts:23-36` 当前只接线 `sessionId`、未读 `agentId`**（review 核实）→ 「按 agent 查看 requests」需**补 handler 接线**（非"已就绪"）。

设计：

- 新增顶级 **Sessions** 页：session 列表，每行聚合 client / #req / #agents / tokens / cost / 时长 / 状态分布 sparkline。
- **Session 详情**：agent 树 + 请求时间线（行=agent[main + subagents]，块=请求，颜色=结果，点块→打开 C 详情）。可按 agent 折叠/筛选；整 session 一键删除（已有 `deleteSession` + `DELETE /api/sessions/:id`）。
- **按 agent 查看 requests**：Requests 工作台加「Group by: None / Session / Agent」开关 + agentId 过滤（**需补 HTTP handler 接线**，见 §7）。是否再升格独立 Agents 顶级页 = 视实现时需要（默认以分组/过滤满足）。

## 6. 两级搜索

- **全局搜索**（顶栏，⌘K 或点击）：跨历史**定位**请求，后端 trigram FTS5 子串搜索。
- **请求内搜索**（详情内，聚焦详情时 Ctrl/Cmd-F，Esc 关）：限定当前请求。**⚠ 这是全新高难度工程、非"移植"**——现有内搜索仅一个 ref 字符串 + DOM/v-html 高亮、只覆盖 3 个 stage、无虚拟化/regex/badge（review 核实 `formatters.ts:39-45`、`DetailPanel.vue:104-118`）。作为**高风险新功能单列 plan 阶段**。
  - **作用于底层数据模型**（全段源数据），非已渲染 DOM。
  - 折叠/未懒加载段的匹配照常计数；sub-rail 每段显示命中数 badge；跳转（n/N、↑↓）时自动展开/加载该段并滚动定位，当前匹配高亮加深。
  - **全功能**：regex / 大小写(Aa) / 整词 + 匹配总数 + 上/下一处导航。
  - **JSON 段（已决）**：用**可控渲染器**（CodeMirror 6 / 自建虚拟化树）渲染 wire/forwarded/tool-input JSON，使搜索能在折叠/未渲染子树里计数+高亮+展开定位（`@uiw/react-json-view` 因无法被外部驱动而不采用，见 §2）。
  - **已知难点**（plan 须显式处理）：虚拟化列表 + scrollToIndex 与匹配索引映射、懒加载段先加载再等布局稳定再滚的异步编排、SSE/diff 段内匹配定位。
- 只做单请求内搜索；session 级用「全局搜索 + sessionId 过滤」覆盖。

## 7. 其他页面

### Overview（精简）

- **留**（实时/运维可执行/依赖代理自身状态）：In-flight 数 + 实时活动、Rate limiter 状态 + queue、Quota/token source/过期、Upstream/WS 健康、近期 outcomes 一瞥、Memory pressure。
- **→ Grafana**（消费 `/metrics`）：历史请求量/token/cost 趋势、跨窗口深度维度 breakdown。Overview 放"打开 Grafana ↗"入口。
- **成本口径**（已决持久化 multiplier）：per-session/per-entry cost 用**请求时定价**（entries_v2 持久 multiplier × token 列）；聚合窗口 cost（sinceStart/7d）仍可经 `/api/stats` telemetry registry。两者口径一致、不再有"单条无成本源"缺口。

### Models

**全面增强已落地**（P1–P4，2026-07-05；规划见 [docs/plans/2026-07-05-06b-models-page-enhancement.md](plans/2026-07-05-06b-models-page-enhancement.md)、设计 WHAT/WHY 见 [docs/spec/2026-07-05-ui-v4-models-enhancement.md](../../docs/spec/2026-07-05-ui-v4-models-enhancement.md)）。

- **密集目录表**：id/name/vendor/version/ctx/out/effort/能力矩阵(vision/tools/parallel/structured/streaming/thinking)/$×/req(7d)；表头点击排序；列显隐由齿轮菜单控制并 localStorage 持久化。能力矩阵同源后端 `deriveCapabilities`（`~backend`，前端不重实现）。
- **过滤栏**：search(id/name) / vendor / type / capability(多选 AND) / premium / restricted-to plan(多选) / policy state / has-telemetry。纯谓词在 `lib/model-filters.ts`（bun 测）。
- **运行遥测 join**：`/api/status.requestTelemetry` 经 `lib/model-telemetry.ts` 按 `normalizeModelId` 归一 join（成功腿=规范名 / 失败腿=客户端别名双侧归一），无轮询、重访即刷新（`useModelTelemetry` 独立 queryKey）。归一后仍无 catalog 匹配的遥测收进**「未关联遥测」小节**（表下方）显式呈现，不静默丢弃（richest-data-flow）。
- **详情面板**：选中态由 URL 承载（`?model=<id>`，URL-as-truth、可深链），渲染为右侧可调宽 split 面板（`useResizableWidth` invert）。6 竖 tab（WAI-ARIA tabs：roving tabindex + 方向键 + tab↔panel 关联）：Overview（身份 + picker 标志 + 端点含 `(inferred)` 标注）/ Capabilities（派生矩阵 + **完整 raw supports map**）/ Limits+Vision（Vision 条件块）/ Billing+Policy / Telemetry（双窗口 + 全 6 token + 失败计数诚实标注）/ Raw JSON（完整对象含 `request_headers`）。Esc 关闭（isTyping 守卫）、开面板移焦、关闭还焦。
- **Export CSV**：当前过滤/排序视图扁平导出（`lib/models-csv.ts`，RFC-4180）；遥测列同 join。
- **后端**：`/api/models` 移除 `stripInternalFields` 对 `request_headers` 的剥离（ADR internal-tool-security-posture）；`src/lib/models/normalize-id.ts` 纯模块供前端 join 复用。

### Config

**默认进 raw YAML 页**（整体编辑），**可切回结构化分组表单**（与现有相反）。结构化表单：左侧 section 导航 + 字段控件 + 校验高亮；保存走 `PUT /api/config/yaml`。

### 新增/改动后端

> **本轮焦点 = UI 基础设施 + 全面可用。成本相关的持久化暂缓**（用户定，2026-06-23）：下列 ① 的 `multiplier`/`client` 列与成本口径**本轮不做、不阻塞 UI**；Sessions/详情的 cost 列先留位（显示 `—` 或读时近似），待后续单独成轮。本轮后端只做让 UI 可用的最小项（② sessions 聚合除 cost 外、③ agentId 接线）。

1. **（暂缓，非本轮）entries_v2 新增持久化列** `multiplier`/`client` + 写路径（serialize/write）——成本历史保真用；本轮 cost 列留位。
2. **`GET /history/api/sessions`**（新增只读聚合，本轮做）：session 摘要——`#req` / `#agents`(COUNT DISTINCT agent_id) / tokens(SUM) / 时间跨度 / 状态分布 / client（本轮 client 可读单条 entry blob 近似，免新列）。**cost 字段本轮留空/省略**。entries-derived（参 `stats.ts`）。
3. **`/entries` HTTP handler 补 `agentId`/`mainAgentOnly` 接线**（本轮做，`handler.ts:23-36` 当前缺）+ 视需要 active/非active 二分过滤（支撑 Live 泳道与 History 切分）。
4. **（可选）`GET /history/api/agents`**：跨 session agent 聚合，仅当做独立 Agents 顶级页才需要。
5. **类型 single-source**：新增 `SessionSummary` 等类型在后端 `src/lib/history/` 定义、经 `store.ts` barrel 导出，前端 `~backend/*` re-export。

## 8. 视觉方向 —— 工业风（A · Terminal Amber）

- **调性**：延续现有暖色 amber 主色（dark `#d4a04a` / light `#a07020`）。
- **工业骨架**（全局贯彻）：左对齐一切 + eyebrow 大写小字标签 + hairline 网格线分隔（非浮动卡片堆 + 阴影）+ `rounded:0` 锐角 + 高信息密度 + IBM Plex Mono 承载数据 + green/red/amber 状态信号色。**拒绝居中标题 / 居中 hero**（砍掉旧版居中 hero）。
- 全套色彩/间距/字号/层级用 CSS-var 主题 token（Tailwind theme + CSS vars 单一来源）。
- 字体：正文/标签用中性 grotesque sans（具体字族待定），数据/代码 IBM Plex Mono。

### 响应式

- desktop-first，优雅退化、不崩。
- **≥1200px Wide**：三区全展开（rail + 列表 + C 详情竖 sub-rail + Stages 并排）。
- **768–1200px Medium**：rail 塌图标；列表+详情仍并排但更窄；Stages 视宽度并排↔单列。
- **<768px Narrow**：列表/详情不再并排——列表全宽，选中→全屏详情(‹返回)；C 竖 sub-rail 退横向标签；rail→底部 tab bar；深链直达详情全屏。

## 9. 内容渲染管线（移植）

```
DetailPanel → 段(Convo / Response) → MessageBlock → ContentRenderer
  → TextBlock / ThinkingBlock / RedactedThinkingBlock / ToolUseBlock / ToolResultBlock / ImageBlock / DiffView / GenericBlock
SystemMessage（独立支路，不走 ContentRenderer）→ system-reminder 标签解析 + original↔rewritten 切换 + SideBySideView
```

- 纯逻辑层（`normalizeToContentBlocks()` 统一 Anthropic + OpenAI 双格式、类型守卫、`block-diff.ts` via jsdiff）**逐字移植成 TS**。
- Vue SFC 块组件 → React 组件，包在 React **ErrorBoundary**；ContentRenderer 按 `content.type` 纯分发。
- **8 种块类型**（review 核实 `ContentRenderer.vue:71-100`，含 `redacted_thinking`——勿漏，否则加密 thinking 掉进 GenericBlock 降级）。
- **system prompt 走独立 `SystemMessage` 组件**（不经 ContentRenderer）：保留 system-reminder/ide_opened_file 等标签解析过滤 + original↔rewritten diff 切换。
- 不仅 Convo 段，**Response 段的 upstream 解析响应块**也复用同一 MessageBlock/ContentRenderer 管线。
- OpenAI `tool_calls` → 虚拟 `tool_use` 块（与现有一致）。

## 10. 已知债顺带修复

- HTTP 客户端错误处理统一（TanStack Query 统一失败/重试语义）。
- DetailPanel 过大 → C 布局分段懒加载天然拆分。
- 列表实时更新真实债（§4.2）：`useHistoryWS` prepend-gap（仅 `prevCursor===null`）+ active→completed 去重抖动 + 失败终态离场。
- **勘误**：现有 WSClient（`ui/src/api/ws.ts:186-196`）**已是**指数退避 1s→30s + ±25% jitter——`ui/CLAUDE.md:180` 列的「固定延迟需改」是**假债**（与源码及自身 :157 行矛盾）。移植时**不需要**"改退避"，仅需正确处理 React 生命周期（§2）。同步纠正 `ui/CLAUDE.md` 此条。

## 11. 待定子项（实现期定夺，不阻塞）

- 详情 Request stages 段间 diff：默认并排 vs 按需开。
- brand 区是否放实时全局指标（倾向极简，指标放 Overview）。
- 是否升格独立 Agents 顶级页（默认以分组/过滤满足）。
- grotesque sans 具体字族。
- JSON 段可控渲染器具体选型（CodeMirror 6 JSON vs 自建虚拟化树）——实现期评测搜索集成成本后定。
- **成本持久化（multiplier/client 列 + 写路径 + cost 口径）整体暂缓**——非本轮焦点（用户定 2026-06-23），本轮 UI cost 列留位，待后续单独成轮。

## 12. Review 核实与修订追溯

3 个 general-purpose subagent 按本项目裁判轴（长远正确 + 完整，非 ROI/YAGNI）并行审：后端契约保真 / 领域保真 / React 栈可行。主会话逐条读引用 `file:line` 核验，结论：

**已核实属实并修订进 spec：**
- §5/§7 `agentId` HTTP 过滤"已就绪"为假——`handler.ts:23-36` 未接线，改为"需补接线"。
- §4.2 根因表述错——现有 `VActivityPage.vue:116-128` 已分离 in-flight 泳道；改为真实债（prepend-gap + 去重抖动 + 失败终态离场）。
- §4.3 把 7 腿降成"请求 3 腿并排"——补齐响应侧 Upstream/Forwarded、`SseFrameDiff`（forwarded vs upstream 帧 diff）、`HeadersComparisonSection` 四腿对比、消息级 inbound↔effective rewrite diff、terminal reason 的分段归位。
- §9 漏 `redacted_thinking`（实为 8 类）+ SystemMessage 独立支路——补全。
- §6 请求内搜索系全新工程非"移植"+ JSON viewer 无法外部驱动——重标为高风险新功能、JSON 段改可控渲染器。
- §10 "WSClient 改退避"系假债（源码 `ws.ts:186-196` 已退避+jitter）——删除、改为 React 生命周期处理 + 同步纠正 `ui/CLAUDE.md`。
- §2 补 `~/*` 传递别名、WSClient 模块单例+引用计数、Live 泳道归 Zustand（不塞 Query cache）、FE 依赖声明进 ui-v4/package.json。

**主会话纠正 reviewer 夸大：**
- reviewer 称"per-session cost 不可重算"——核验后 cost = Σ(token 列 × multiplier(model))，model 已存、multiplier 是 per-model，**可重算**。仅"当前定价 vs 历史定价"取舍。用户已决**写时持久化 multiplier**（历史保真）。

**用户拍板 3 决策：** ① cost = 写时持久化 multiplier；② JSON 段用可控渲染器；③ Tailwind v4（native 二进制按审计判据豁免）。

**bun-first 实测：** subagent `find node_modules -name binding.gyp` 为空，选型全过；唯一需显式认定的是 Tailwind v4 的 oxide/lightningcss 预编译 `.node`（同 @rollup/@oxc 构建工具豁免，§2 已记）。

**范围影响：** 本轮焦点 = **UI 基础设施 + 全面可用**（用户定 2026-06-23）。后端只做让 UI 可用的最小项（sessions 聚合〔除 cost〕+ agentId 接线）；**成本持久化（multiplier/client 列 + 写路径）整体暂缓、不阻塞本轮**，cost 列先留位。

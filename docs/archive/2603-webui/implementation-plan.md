# 实施路线图

分四个阶段递进实施。**所有四个阶段均已完成。**

## Phase 1：现有页面增强 — 已完成

利用 HistoryEntry 中已有但未展示的字段，增强请求详情面板和统计显示。

### 1.1 分页模型迁移（page/limit → 游标） — 已完成

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| 后端 entries 游标分页 | `src/lib/history/store.ts` | 已实现 |
| 后端 session entries 游标分页 | `src/lib/history/store.ts` | 已实现 |
| History API handler 适配 | `src/routes/history/handler.ts` | 已实现 |
| 前端 store 适配 | `composables/useHistoryStore.ts` → `history-store/useHistoryData.ts` | 已实现 |
| 前端 API 客户端适配 | `api/http.ts` | 已实现 |
| 前端分页组件 | `components/list/ListPagination.vue` | 已实现 |

### 1.2 请求详情增强 — 已完成

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| Request/Response Headers 展示 | `components/detail/HeadersSection.vue` | 已实现 |
| 重试时间线 | `components/detail/AttemptsTimeline.vue` | 已实现 |
| SSE 事件时间线 | `components/detail/SseEventsSection.vue` | 已实现 |
| 截断分隔线 | `components/detail/TruncationDivider.vue` | 已实现 |
| Pipeline 信息 composable | `composables/usePipelineInfo.ts` | 已实现 |
| 请求/响应区域拆分 | `components/detail/DetailRequestSection.vue`、`DetailResponseSection.vue` | 已实现 |

### 1.3 统计图表 — 已完成

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| 活动柱状图 | `components/charts/BarChart.vue` | 已实现 |
| 模型/端点分布条形图 | `components/charts/HorizontalBar.vue` | 已实现 |
| 图表区域容器 | `components/charts/StatsCharts.vue` | 已实现 |

---

## Phase 2：后端 API + Dashboard + WebSocket — 已完成

### 2.1 后端 API — 已完成

| API | 实现文件 | 状态 |
|-----|----------|------|
| `GET /api/status` | `src/routes/status/route.ts` | 已实现 |
| `GET /api/config` | `src/routes/config/route.ts` | 已实现 |
| `GET /api/tokens` | `src/routes/token/route.ts` | 已实现 |
| `GET /api/logs` | `src/routes/logs/route.ts` | 已实现 |
| `GET /models?detail=true` | `src/routes/models/route.ts` | 已实现 |
| 路由注册集中化 | `src/routes/index.ts` — `registerHttpRoutes()` / `registerWsRoutes()` | 已实现 |

### 2.2 WebSocket 架构 — 已完成

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| WS 广播模块 | `src/lib/ws/broadcast.ts` | 已实现 — 主题订阅 + broadcast + notify |
| WS 运行时适配 | `src/lib/ws/adapter.ts` | 已实现 — Node.js / Bun 适配 |
| Barrel re-export | `src/lib/ws/index.ts` | 已实现 |
| connectedDataFactory | `src/lib/ws/broadcast.ts` — `setConnectedDataFactory()` | 已实现 — connected 事件含 activeRequests 快照 |
| history notify | `notifyEntryAdded` / `notifyEntryUpdated` / `notifyStatsUpdated` / `notifyHistoryCleared` / `notifySessionDeleted` | 已实现 |
| active_request_changed | `src/lib/context/manager.ts` | 已实现 |
| rate_limiter_changed | `src/lib/adaptive-rate-limiter.ts` | 已实现 |
| shutdown_phase_changed | `src/lib/shutdown.ts` | 已实现 |

### 2.3 Legacy Dashboard + Logs — 已完成

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| Dashboard 页面 | `pages/DashboardPage.vue` | 已实现 |
| Logs 页面 | `pages/LogsPage.vue` | 已实现 |
| 导航栏 | `components/layout/NavBar.vue` | 已实现 |
| 路由系统 | `router.ts` + `main.ts` + `App.vue` | 已实现 |
| 通用卡片容器 | `components/ui/DataCard.vue` | 已实现 |
| 进度条 | `components/ui/ProgressBar.vue` | 已实现 |
| 轮询 composable | `composables/usePolling.ts` | 已实现 |
| Logs composable | `composables/useLogs.ts` | 已实现 |

---

## Phase 3：Models Explorer + Usage Dashboard — 已完成

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| Models 页面 | `pages/ModelsPage.vue` | 已实现 |
| Usage 页面 | `pages/UsagePage.vue` | 已实现 |

---

## Phase 4：Vuetify 3 集成 — 已完成

### 4.1 Vuetify 基础设施 — 已完成

| 任务 | 涉及文件 | 状态 |
|------|----------|------|
| Vuetify 插件配置 | `plugins/vuetify.ts` | 已实现 — dark/light 双主题，GitHub 风格配色 |
| Vite 插件 | `vite.config.ts` — `vite-plugin-vuetify` | 已实现 — autoImport |
| App.vue 双布局 | `App.vue` — v-app / div.app | 已实现 — 按路由切换 |
| 路由变体工具 | `utils/route-variants.ts` — `isVuetifyPath()` / `getVariantSwitchPath()` | 已实现 |
| NavBar 变体切换 | `components/layout/NavBar.vue` — Legacy/Vuetify 按钮 | 已实现 |

### 4.2 Vuetify 页面 — 已完成

| 页面 | 文件 | 状态 |
|------|------|------|
| VDashboardPage | `pages/vuetify/VDashboardPage.vue` | 已实现 — 4 个 Dashboard 子组件 |
| VHistoryPage | `pages/vuetify/VHistoryPage.vue` | 已实现 |
| VLogsPage | `pages/vuetify/VLogsPage.vue` | 已实现 |
| VModelsPage | `pages/vuetify/VModelsPage.vue` | 已实现 |
| VUsagePage | `pages/vuetify/VUsagePage.vue` | 已实现 |

### 4.3 Dashboard 子组件 — 已完成

| 组件 | 文件 | 状态 |
|------|------|------|
| DashboardStatusBar | `components/dashboard/DashboardStatusBar.vue` | 已实现 |
| DashboardOverviewPanel | `components/dashboard/DashboardOverviewPanel.vue` | 已实现 |
| DashboardConfigPanel | `components/dashboard/DashboardConfigPanel.vue` | 已实现 |
| DashboardActiveRequestsTable | `components/dashboard/DashboardActiveRequestsTable.vue` | 已实现 |

### 4.4 Models 子组件 — 已完成

| 组件 | 文件 | 状态 |
|------|------|------|
| ModelsToolbar | `components/models/ModelsToolbar.vue` | 已实现 |
| ModelsFilterBar | `components/models/ModelsFilterBar.vue` | 已实现 |
| ModelsGrid | `components/models/ModelsGrid.vue` | 已实现 |
| ModelCard | `components/models/ModelCard.vue` | 已实现 |
| ModelsRawView | `components/models/ModelsRawView.vue` | 已实现 |

### 4.5 新 Composables — 已完成

| Composable | 文件 | 状态 |
|------------|------|------|
| useDashboardStatus | `composables/useDashboardStatus.ts` | 已实现 — WS + HTTP 混合数据源 |
| useModelsCatalog | `composables/useModelsCatalog.ts` | 已实现 — 多维过滤 |
| useInjectedHistoryStore | `composables/useInjectedHistoryStore.ts` | 已实现 — 类型安全 inject |
| useFormatters | `composables/useFormatters.ts` | 已实现 — 格式化工具集 |

### 4.6 UI 基础组件 — 已完成

| 组件 | 文件 | 状态 |
|------|------|------|
| BaseBadge | `components/ui/BaseBadge.vue` | 已实现 |
| BaseButton | `components/ui/BaseButton.vue` | 已实现 |
| BaseCheckbox | `components/ui/BaseCheckbox.vue` | 已实现 |
| BaseInput | `components/ui/BaseInput.vue` | 已实现 |
| BaseModal | `components/ui/BaseModal.vue` | 已实现 |
| BaseSelect | `components/ui/BaseSelect.vue` | 已实现 |

---

## Phase 4.7：Playwright E2E 测试 — 已完成

| 任务 | 文件 | 状态 |
|------|------|------|
| Playwright 配置 | `playwright.config.ts` | 已实现 — testMatch: `*.pw.ts`，testDir: `tests/e2e-ui/` |
| 导航测试 | `tests/e2e-ui/navigation.pw.ts` | 已实现 |
| API 端点测试 | `tests/e2e-ui/api-endpoints.pw.ts` | 已实现 |
| Legacy 页面测试 | `tests/e2e-ui/legacy-pages.pw.ts` | 已实现 |
| Vuetify Dashboard | `tests/e2e-ui/vuetify-dashboard.pw.ts` | 已实现 |
| Vuetify History | `tests/e2e-ui/vuetify-history.pw.ts` | 已实现 |
| Vuetify Logs | `tests/e2e-ui/vuetify-logs.pw.ts` | 已实现 |
| Vuetify Models | `tests/e2e-ui/vuetify-models.pw.ts` | 已实现 |
| Vuetify Usage | `tests/e2e-ui/vuetify-usage.pw.ts` | 已实现 |

---

## 技术决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| UI 框架 | Vuetify 3 | 成熟的 Material Design 组件库，dark/light 主题开箱即用 |
| 路由方案 | vue-router hash 模式（base: `/ui/`） | 无需后端路由改动，静态文件服务兼容 |
| Legacy 保留 | `@deprecated` 标记但不删除 | 平滑迁移过渡，用户可自行选择 |
| 图表库 | 纯 CSS/SVG | 保持轻量，当前数据量不需要 D3/Chart.js |
| 状态管理 | composable + provide/inject（无 Pinia） | 当前规模不需要全局状态管理库 |
| Dashboard 数据 | WS 实时 + HTTP 轮询混合 | WS 提供高频事件（active requests、rate limiter），HTTP 提供低频聚合数据 |
| WS 模块拆分 | `broadcast.ts` + `adapter.ts` | 关注点分离：广播逻辑 vs 运行时适配 |
| connected 快照 | `setConnectedDataFactory()` 依赖注入 | WS 模块不直接依赖 context manager |
| 游标分页 | entries/sessions 全部使用游标 | 实时追加的时间序列数据，page/limit 会导致翻页跳变 |
| 前端 fetchLogs | 使用 `/history/api/entries` | 复用已有 entries API，useLogs 的 loadInitial 调用 fetchEntries |
| Playwright 测试 | `*.pw.ts` 后缀 + `tests/e2e-ui/` 目录 | 与 Bun 单元测试（`*.test.ts`）区分 |
| Vite base | 生产构建 `/ui/`，开发 `/` | 匹配后端静态文件挂载路径 |

# UI 页面与组件

本文档列出 Web UI 的所有页面、组件和 composables 的实际实现状态。

## 1. 页面

### Legacy 页面（@deprecated）

标记为 `@deprecated`，仅维护。路由定义在 `ui/history-v3/src/router.ts`。

| 页面 | 路由 | 文件 |
|------|------|------|
| HistoryPage | `/history` | `pages/HistoryPage.vue` |
| LogsPage | `/logs` | `pages/LogsPage.vue` |
| DashboardPage | `/dashboard` | `pages/DashboardPage.vue` |
| ModelsPage | `/models` | `pages/ModelsPage.vue` |
| UsagePage | `/usage` | `pages/UsagePage.vue` |

### Vuetify 页面（正式版）

路由前缀 `/v/`，使用 Vuetify 3 组件库。

| 页面 | 路由 | 文件 |
|------|------|------|
| VHistoryPage | `/v/history` | `pages/vuetify/VHistoryPage.vue` |
| VLogsPage | `/v/logs` | `pages/vuetify/VLogsPage.vue` |
| VDashboardPage | `/v/dashboard` | `pages/vuetify/VDashboardPage.vue` |
| VModelsPage | `/v/models` | `pages/vuetify/VModelsPage.vue` |
| VUsagePage | `/v/usage` | `pages/vuetify/VUsagePage.vue` |

### VDashboardPage 子组件

`VDashboardPage` 拆分为 4 个 Dashboard 子组件：

| 子组件 | 文件 | 职责 |
|--------|------|------|
| DashboardStatusBar | `components/dashboard/DashboardStatusBar.vue` | 顶部状态栏（健康、版本、uptime、活跃请求数、关闭阶段） |
| DashboardOverviewPanel | `components/dashboard/DashboardOverviewPanel.vue` | 概览面板（认证、配额、速率限制、内存） |
| DashboardConfigPanel | `components/dashboard/DashboardConfigPanel.vue` | 运行时配置展示 |
| DashboardActiveRequestsTable | `components/dashboard/DashboardActiveRequestsTable.vue` | 活跃请求实时表格（WS 驱动） |

### VModelsPage 子组件

`VModelsPage` 拆分为独立的 Models 子组件：

| 子组件 | 文件 | 职责 |
|--------|------|------|
| ModelsToolbar | `components/models/ModelsToolbar.vue` | 工具栏（搜索、视图切换） |
| ModelsFilterBar | `components/models/ModelsFilterBar.vue` | 过滤栏（vendor、endpoint、feature 过滤） |
| ModelsGrid | `components/models/ModelsGrid.vue` | 卡片网格容器 |
| ModelCard | `components/models/ModelCard.vue` | 单个模型卡片 |
| ModelsRawView | `components/models/ModelsRawView.vue` | Raw API 响应视图 |

---

## 2. 导航与布局

### NavBar

**文件：** `components/layout/NavBar.vue`

NavBar 根据当前路由自动切换导航链接集（Vuetify `/v/*` 或 Legacy `/*`）。

特性：
- 左侧：`copilot-api` 品牌名
- 中间：5 个导航链接（History、Logs、Dashboard、Models、Usage）
- 右侧：**Legacy/Vuetify 切换按钮** + WebSocket 状态指示灯（StatusDot + Live/Offline）
- 响应式：窄屏时导航链接换行

切换按钮使用 `getVariantSwitchPath()` 在 Legacy 和 Vuetify 路由之间互跳（`utils/route-variants.ts`）。

### App.vue 双布局

`App.vue` 根据 `isVuetifyPath(route.path)` 判断使用哪种布局：
- Vuetify 路由（`/v/*`）：`<v-app>` + `<v-main>` 包裹
- Legacy 路由：`<div class="app">` 包裹 + `<BaseToast />`

---

## 3. 组件库

### 通用 UI 组件

| 组件 | 目录 | 用途 |
|------|------|------|
| BaseBadge | `components/ui/` | 徽章（标签显示） |
| BaseButton | `components/ui/` | 按钮 |
| BaseCheckbox | `components/ui/` | 复选框 |
| BaseInput | `components/ui/` | 文本输入框 |
| BaseModal | `components/ui/` | 模态对话框 |
| BaseSelect | `components/ui/` | 下拉选择框 |
| BaseToast | `components/ui/` | Toast 通知（Legacy 布局使用） |
| DataCard | `components/ui/` | 仪表板卡片容器（标题 + slot） |
| ErrorBoundary | `components/ui/` | 错误边界 |
| IconSvg | `components/ui/` | SVG 图标 |
| LineNumberPre | `components/ui/` | 带行号的代码块 |
| ProgressBar | `components/ui/` | 进度条 |
| RawJsonModal | `components/ui/` | Raw JSON 查看模态框 |
| StatusDot | `components/ui/` | 状态指示点（success/error 颜色） |

### 图表组件

| 组件 | 目录 | 用途 |
|------|------|------|
| BarChart | `components/charts/` | 纯 CSS 柱状图（活动趋势） |
| HorizontalBar | `components/charts/` | 水平分布条形图（模型/端点分布） |
| StatsCharts | `components/charts/` | 统计图表区域容器（可折叠） |

### 布局组件

| 组件 | 目录 | 用途 |
|------|------|------|
| NavBar | `components/layout/` | 顶部导航栏 |
| AppHeader | `components/layout/` | History 页面头部（Session 选择器、导出、清空） |
| StatsBar | `components/layout/` | 统计栏（请求数/成功/失败/Token） |
| SplitPane | `components/layout/` | 左右分栏容器 |

### 列表组件

| 组件 | 目录 | 用途 |
|------|------|------|
| RequestList | `components/list/` | 请求列表（搜索、过滤、分页） |
| RequestItem | `components/list/` | 单条请求项 |
| ListPagination | `components/list/` | 游标分页控件 |

### 详情组件

| 组件 | 目录 | 用途 |
|------|------|------|
| DetailPanel | `components/detail/` | 请求详情面板 |
| DetailToolbar | `components/detail/` | 详情工具栏（搜索/过滤/视图模式切换） |
| DetailRequestSection | `components/detail/` | 请求消息区域 |
| DetailResponseSection | `components/detail/` | 响应消息区域 |
| HeadersSection | `components/detail/` | HTTP Headers 折叠列表 |
| AttemptsTimeline | `components/detail/` | 重试时间线可视化 |
| SectionBlock | `components/detail/` | 通用区块容器 |
| SseEventsSection | `components/detail/` | SSE 事件时间线 |
| TruncationDivider | `components/detail/` | 截断分隔线 |
| MetaInfo | `components/detail/` | 元信息面板 |

### 消息渲染组件

| 组件 | 目录 | 用途 |
|------|------|------|
| ContentRenderer | `components/message/` | 内容分发器（根据 type 选择组件） |
| ContentBlockWrapper | `components/message/` | 内容块包裹器 |
| MessageBlock | `components/message/` | 单条消息块 |
| TextBlock | `components/message/` | 文本内容 |
| ThinkingBlock | `components/message/` | Thinking 内容 |
| ToolUseBlock | `components/message/` | Tool Use 内容 |
| ToolResultBlock | `components/message/` | Tool Result 内容 |
| ImageBlock | `components/message/` | 图片内容 |
| SystemMessage | `components/message/` | 系统消息 |
| GenericBlock | `components/message/` | 通用内容块（fallback） |
| DiffView | `components/message/` | Diff 对比视图 |

---

## 4. Composables

| Composable | 文件 | 用途 |
|------------|------|------|
| `useHistoryStore` | `composables/useHistoryStore.ts` | 核心状态管理（entries、selection、WS、分页、搜索） |
| `useHistoryData` | `composables/history-store/useHistoryData.ts` | 数据加载子模块（fetch、分页、过滤） |
| `useHistoryWS` | `composables/history-store/useHistoryWS.ts` | WS 实时更新子模块 |
| `useInjectedHistoryStore` | `composables/useInjectedHistoryStore.ts` | 从 provide/inject 获取 historyStore（类型安全） |
| `useDashboardStatus` | `composables/useDashboardStatus.ts` | Dashboard 数据：HTTP 轮询 + WS 实时（active requests、rate limiter、shutdown） |
| `useModelsCatalog` | `composables/useModelsCatalog.ts` | Models 页面数据：模型列表、搜索、多维过滤（vendor/endpoint/feature） |
| `usePolling` | `composables/usePolling.ts` | 通用轮询工具 — 返回 `{ data, loading, error, refresh }` |
| `useLogs` | `composables/useLogs.ts` | Logs 页面数据 — 初始加载（fetchEntries）+ WS 实时更新 |
| `usePipelineInfo` | `composables/usePipelineInfo.ts` | Pipeline 信息计算 — 截断点、重写映射、统计 |
| `useFormatters` | `composables/useFormatters.ts` | 格式化工具 — 时间、日期、数字、持续时间、HTML 转义、搜索高亮 |
| `useHighlightHtml` | `composables/useHighlightHtml.ts` | 搜索高亮 HTML 计算属性 |
| `useTheme` | `composables/useTheme.ts` | 系统主题跟随（prefers-color-scheme） |
| `useToast` | `composables/useToast.ts` | Toast 通知管理 |
| `useKeyboard` | `composables/useKeyboard.ts` | 键盘快捷键（导航、搜索、ESC） |
| `useCopyToClipboard` | `composables/useCopyToClipboard.ts` | 剪贴板复制 |
| `useRawModal` | `composables/useRawModal.ts` | Raw JSON 模态框（单实例 provide/inject） |
| `useContentContext` | `composables/useContentContext.ts` | 内容渲染上下文（搜索、过滤、tool 映射） |
| `useSharedResizeObserver` | `composables/useSharedResizeObserver.ts` | 共享 ResizeObserver 实例 |

---

## 5. Vuetify 插件配置

**文件：** `plugins/vuetify.ts`

使用 `createVuetify()` 配置 dark/light 双主题，GitHub 风格配色。

主题色：
- **Dark**：`background: #0d1117`、`surface: #161b22`、`primary: #58a6ff`
- **Light**：`background: #ffffff`、`surface: #f6f8fa`、`primary: #0969da`

组件默认值：
- `VCard`：outlined + comfortable
- `VChip`：small + tonal
- `VTextField / VSelect`：outlined + compact + hideDetails
- `VBtn`：text + small

---

## 6. 各页面数据源

| 页面 | WS 事件 | HTTP 轮询 | 一次性加载 |
|------|---------|-----------|-----------|
| VHistoryPage | `entry_added`、`entry_updated`、`stats_updated`（via historyStore） | 无（首次 fetch 后纯 WS） | - |
| VLogsPage | `entry_added`、`entry_updated`、`history_cleared`（via useLogs） | 无（首次 fetch 后纯 WS） | `fetchEntries({ limit: 100 })` |
| VDashboardPage | `active_request_changed`、`rate_limiter_changed`、`shutdown_phase_changed`（via useDashboardStatus） | `fetchStatus()` 5s、`fetchConfig()` 30s | - |
| VModelsPage | 无 | 无 | `fetchModels(true)` via useModelsCatalog |
| VUsagePage | 间接（通过 historyStore.stats） | `fetchStatus()` 10s | - |

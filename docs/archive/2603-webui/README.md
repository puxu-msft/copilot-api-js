# Web UI 系统设计

## 概述

Web UI 是 copilot-api 的内置服务控制台，提供请求历史查看、实时日志、服务状态监控、模型目录浏览和配额管理。

UI 同时维护两套页面体系：

| 体系 | 路由前缀 | 框架 | 状态 |
|------|----------|------|------|
| Vuetify 页面 | `/v/*` | Vue 3 + Vuetify 3 | 正式版（默认） |
| Legacy 页面 | `/*` | Vue 3 + 自定义 CSS | 已弃用（维护模式） |

默认路由 `/` 重定向到 `/v/dashboard`。

## 架构

### 数据流

```
客户端请求 → Hono 路由 → Pipeline 处理 → 上游 API
                ↓                              ↓
         RequestContext ──(事件)──→ HistoryStore
                ↓                        ↓
         Manager/Shutdown/        WebSocket /ws 推送 → Web UI
         RateLimiter ──(事件)──→       ↓
                              REST API ←──── Web UI
```

### 路由结构

10 个路由（5 个 Legacy + 5 个 Vuetify），默认重定向到 `/v/dashboard`。

Legacy 路由标记为 `@deprecated`，仅维护。

```
/ui#/                        → 重定向到 /v/dashboard

── Legacy（@deprecated）──
/ui#/history                 → HistoryPage
/ui#/logs                    → LogsPage
/ui#/dashboard               → DashboardPage
/ui#/models                  → ModelsPage
/ui#/usage                   → UsagePage

── Vuetify（正式）──
/ui#/v/history               → VHistoryPage
/ui#/v/logs                  → VLogsPage
/ui#/v/dashboard             → VDashboardPage（默认页面）
/ui#/v/models                → VModelsPage
/ui#/v/usage                 → VUsagePage
```

### 前端组件树

```
App (provide historyStore)
├── v-app (Vuetify 路由) / div.app (Legacy 路由)
│   └── NavBar ────── 导航链接 + Legacy/Vuetify 切换按钮 + WebSocket 状态指示灯
│       └── <router-view>
│
│   ── Legacy 页面 ──
│   ├── HistoryPage ──────────────────── /history
│   │   ├── AppHeader ─── Session 选择、导出、清空
│   │   ├── StatsBar ──── 请求/成功/失败/Token 统计
│   │   │   └── StatsCharts ── 活动柱状图 + 模型/端点分布
│   │   │       ├── BarChart
│   │   │       └── HorizontalBar
│   │   └── SplitPane
│   │       ├── [left]  RequestList ─── 搜索、过滤、分页
│   │       │           ├── RequestItem (×N)
│   │       │           └── ListPagination
│   │       └── [right] DetailPanel ─── 消息内容、元信息
│   │                   ├── DetailToolbar ── 消息搜索/过滤/视图模式
│   │                   ├── DetailRequestSection
│   │                   ├── DetailResponseSection
│   │                   ├── HeadersSection ── Request/Response Headers
│   │                   ├── AttemptsTimeline ── 重试时间线
│   │                   ├── SseEventsSection ── SSE 事件时间线
│   │                   └── MetaInfo ── 元信息面板
│   ├── LogsPage ─────────────────────── /logs
│   ├── DashboardPage ────────────────── /dashboard
│   ├── ModelsPage ───────────────────── /models
│   └── UsagePage ────────────────────── /usage
│
│   ── Vuetify 页面 ──
│   ├── VHistoryPage ─────────────────── /v/history
│   ├── VLogsPage ────────────────────── /v/logs
│   ├── VDashboardPage ───────────────── /v/dashboard
│   │   ├── DashboardStatusBar
│   │   ├── DashboardOverviewPanel
│   │   ├── DashboardConfigPanel
│   │   └── DashboardActiveRequestsTable
│   ├── VModelsPage ──────────────────── /v/models
│   │   ├── ModelsToolbar
│   │   ├── ModelsFilterBar
│   │   ├── ModelsGrid
│   │   │   └── ModelCard (×N)
│   │   └── ModelsRawView
│   └── VUsagePage ───────────────────── /v/usage
```

### 技术栈

- **前端**：Vue 3 + TypeScript + Vite
- **UI 框架**：Vuetify 3（dark/light 主题，GitHub 风格配色）
- **路由**：vue-router（hash 模式，base: `/ui/`）
- **状态管理**：`useHistoryStore` composable（provide/inject，无 Pinia）
- **实时通信**：WebSocket `/ws`（主题订阅、自动重连、指数退避）
- **API 客户端**：基于 fetch 的 REST 客户端（`api/http.ts`）
- **轮询**：`usePolling` composable（Dashboard 5s、Config 30s、Usage 10s）
- **样式**：Vuetify 路由使用 Vuetify 主题系统；Legacy 路由使用 CSS 变量主题

### Vite 构建配置

- **base**：开发模式 `/`，生产构建 `/ui/`
- **别名**：`@` → `src/`，`~backend` → `../../src/`
- **Vuetify 插件**：`vite-plugin-vuetify`（autoImport）
- **开发代理**：`/history/api`、`/ws`、`/api`、`/models` 代理到后端

### Playwright E2E 测试

- **配置**：`playwright.config.ts`
- **测试目录**：`tests/e2e-ui/`
- **文件模式**：`*.pw.ts`
- **已有测试**：`navigation.pw.ts`、`api-endpoints.pw.ts`、`legacy-pages.pw.ts`、`vuetify-dashboard.pw.ts`、`vuetify-history.pw.ts`、`vuetify-logs.pw.ts`、`vuetify-models.pw.ts`、`vuetify-usage.pw.ts`

## 文档导航

| 文档 | 说明 |
|------|------|
| [api-reference.md](api-reference.md) | API 完整参考：HTTP 端点 + WebSocket 事件，包含请求/响应 schema |
| [ui-enhancement.md](ui-enhancement.md) | UI 页面、组件、composables 清单 |
| [websocket-protocol.md](websocket-protocol.md) | WebSocket 实现：后端广播系统、前端 WSClient、各页面使用方式 |
| [implementation-plan.md](implementation-plan.md) | 分阶段实施路线图及完成状态 |

## 与其他文档的关系

- [DESIGN.md](../DESIGN.md) — 后端架构总览、路由表、模块说明
- [history.md](../history.md) — History 系统详细设计（存储、WebSocket、Memory Pressure）
- [streaming.md](../streaming.md) — 流式处理、WebSocket Transport
- [request-pipeline.md](../request-pipeline.md) — 请求重试管道、策略模式

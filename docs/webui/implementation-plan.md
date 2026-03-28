# 实施路线图

分三个阶段递进实施，每个阶段独立可交付。

## Phase 1：现有页面增强（无需新 API）

利用 HistoryEntry 中已有但未展示的字段，增强请求详情面板和统计显示。

### 1.1 分页模型迁移（page/limit → 游标）

History 列表 API 从 page/limit 分页迁移到游标分页。

| 任务 | 涉及文件 | 说明 |
|------|----------|------|
| 后端 entries 游标分页 | `src/lib/history/store.ts` | `getHistorySummaries()` 改为接受 `cursor`/`direction`/`limit`，返回 `nextCursor`/`prevCursor` |
| 后端 session entries 游标分页 | `src/lib/history/store.ts` | `getSessionEntries()` 同上 |
| History API handler 适配 | `src/routes/history/api.ts` | 解析新的查询参数 |
| 前端 store 适配 | `ui/history-v3/src/composables/useHistoryStore.ts` | `page`/`totalPages` → `cursor`/`hasMore`，`setPage()` → `loadMore()` |
| 前端 API 客户端适配 | `ui/history-v3/src/api/http.ts` | `fetchEntries()` 接受游标参数 |
| 前端分页组件替换 | `ui/history-v3/src/components/list/ListPagination.vue` | 页码导航 → "加载更多" 按钮 |

**游标实现方案：** 使用 entry `id` 作为游标值。后端通过 `id` 查找对应条目的 `timestamp`，然后从该时间点向前或向后取 `limit` 条。`id` 比 `timestamp` 更精确，避免同一时间戳多条记录的歧义。

### 1.2 请求详情增强

| 任务 | 涉及文件 | 数据源 | 说明 |
|------|----------|--------|------|
| 显示 HTTP 状态码 | `MetaInfo.vue` | `entry.response?.status` | 在 response 区域添加 Status 行 |
| Request Headers | 新建 `HeadersSection.vue`，修改 `DetailPanel.vue` | `entry.wireRequest?.headers` | 折叠式 key-value 列表 |
| Response Headers | 同上 | `entry.response?.headers` | 同上 |
| 原始响应体 | 修改 `MetaInfo.vue` 或新建组件 | `entry.response?.rawBody` | 错误时显示，可折叠 + 复制 |
| 重试时间线 | 新建 `AttemptsTimeline.vue`，修改 `DetailPanel.vue` | `entry.attempts` | 多次重试的可视化时间线 |
| Wire Request 视图 | 修改 `DetailToolbar.vue` view mode 选项 | `entry.wireRequest` | 新增 "wire" 视图模式 |

**前置条件：** 无。所有数据已在 HistoryEntry 中可用。

### 1.3 统计栏增强

| 任务 | 涉及文件 | 说明 |
|------|----------|------|
| 显示平均延迟 | `StatsBar.vue` | `stats.averageDurationMs`（已有未显示） |
| 显示 Cache Hit Rate | `StatsBar.vue` | 需从 stats 中计算 |

### 1.4 统计图表

| 任务 | 涉及文件 | 说明 |
|------|----------|------|
| 活动柱状图 | 新建 `BarChart.vue`、`StatsCharts.vue` | 纯 CSS 实现，数据来自 `stats.recentActivity` |
| 模型分布条形图 | 新建 `HorizontalBar.vue` | 数据来自 `stats.modelDistribution` |
| 端点分布条形图 | 复用 `HorizontalBar.vue` | 数据来自 `stats.endpointDistribution` |
| 图表区域折叠 | `StatsCharts.vue` | 默认折叠，点击展开 |

### 1.5 交付物

```
ui/history-v3/src/
├── components/
│   ├── detail/
│   │   ├── HeadersSection.vue      (新)
│   │   └── AttemptsTimeline.vue     (新)
│   └── charts/
│       ├── StatsCharts.vue          (新)
│       ├── BarChart.vue             (新)
│       └── HorizontalBar.vue        (新)
├── components/detail/MetaInfo.vue   (改) — 增加 status、rawBody
├── components/detail/DetailPanel.vue (改) — 集成 headers、attempts、wire view
├── components/detail/DetailToolbar.vue (改) — 增加 wire view mode
└── components/layout/StatsBar.vue   (改) — 增加 avg duration、cache rate
```

---

## Phase 2：新增后端 API + Server Dashboard

### 2.1 后端 API 实现

| API | 实现文件 | 数据源 | 注册位置 |
|-----|----------|--------|----------|
| `GET /api/status` | 新建 `src/routes/status/route.ts` | state + manager + rate limiter + memory + shutdown + copilot quota | `src/routes/index.ts` |
| 移除 `GET /usage` | 删除 `src/routes/usage/route.ts` | 配额数据已整合到 `/api/status` | `src/routes/index.ts` 中移除注册 |
| `GET /api/config` | `src/routes/config/route.ts`（已实现） | state | `src/routes/index.ts`（已注册） |
| `GET /api/active-requests` | 新建 `src/routes/active-requests/route.ts` | RequestContextManager | `src/routes/index.ts` |
| `GET /api/memory` | 新建 `src/routes/memory/route.ts` | getMemoryPressureStats() | `src/routes/index.ts` |
| `GET /api/tokens` | `src/routes/token/route.ts`（已实现） | state.tokenInfo + copilotTokenInfo | `src/routes/index.ts`（已注册） |
| `GET /models?detail=true` | 修改 `src/routes/models/route.ts` | state.models | 现有路由增强 |

**关键依赖：**

- `src/lib/adaptive-rate-limiter.ts` 需要导出 `getAdaptiveRateLimiter()` 获取单例实例的 `getStatus()` 方法（或新增 `getRateLimiterStatus()` 模块级函数）
- `src/lib/history/memory-pressure.ts` 需要导出 `getMemoryPressureStats()` 函数
- `src/lib/shutdown.ts` 需要导出当前 `shutdownPhase` 的访问器
- 需要记录服务启动时间以计算 uptime

### 2.2 WebSocket 扩展

| 事件 | 触发位置 | 实现方式 |
|------|----------|----------|
| `active_request_changed` | `context/manager.ts` | manager 事件监听 → `notifyActiveRequestChanged()` |
| `rate_limiter_changed` | `adaptive-rate-limiter.ts` | 模式转换回调 → `notifyRateLimiterChanged()` |
| `shutdown_phase_changed` | `shutdown.ts` | 阶段变更时 → `notifyShutdownPhaseChanged()` |

**修改文件：** `src/lib/history/ws.ts`（新增 3 个 notify 函数）

### 2.3 Server Dashboard 页面

| 任务 | 涉及文件 |
|------|----------|
| 路由系统引入 | 新建 `router.ts`，修改 `main.ts`、`App.vue` |
| 导航栏 | 新建 `NavBar.vue`，替代现有 `AppHeader.vue` 的导航部分 |
| Dashboard 页面 | 新建 `pages/DashboardPage.vue` |
| 状态卡片 | 新建 `StatusCard.vue`、`AuthCard.vue` |
| 速率限制器卡片 | 新建 `RateLimiterCard.vue` |
| 内存卡片 | 新建 `MemoryCard.vue` |
| 活跃请求卡片 | 新建 `ActiveRequestsCard.vue` |
| 配置卡片 | 新建 `ConfigCard.vue` |
| 通用卡片容器 | 新建 `DataCard.vue` |
| 进度条组件 | 新建 `ProgressBar.vue` |
| 轮询 composable | 新建 `usePolling.ts`、`useServerStatus.ts`、`useActiveRequests.ts` |
| WSClient 扩展 | 修改 `api/ws.ts` — 新增回调 |
| WS 类型扩展 | 修改 `types/ws.ts` — 新增事件类型 |

### 2.4 交付物

```
# 后端
src/routes/
├── status/route.ts              (新) — 聚合状态 + 配额 + 速率限制器（替代原 /usage 和 /api/rate-limiter）
├── config/route.ts              (已实现)
├── active-requests/route.ts     (新)
├── memory/route.ts              (新)
├── models/route.ts              (改) — detail 参数
├── token/route.ts               (已改) — 返回 github + copilot 双 token，路径改为 /api/tokens
├── usage/route.ts               (删) — 配额数据已整合到 /api/status
└── index.ts                     (改) — 注册新路由，移除 /usage 和 /token

src/lib/history/ws.ts            (改) — 新增 3 个 notify 函数

# 前端
ui/history-v3/src/
├── router.ts                    (新)
├── main.ts                      (改) — 引入 router
├── App.vue                      (改) — router-view
├── api/ws.ts                    (改) — 新增回调
├── types/ws.ts                  (改) — 新增事件类型
├── pages/
│   ├── HistoryPage.vue          (新) — 从 App.vue 提取
│   └── DashboardPage.vue        (新)
├── composables/
│   ├── usePolling.ts            (新)
│   ├── useServerStatus.ts       (新)
│   └── useActiveRequests.ts     (新)
├── components/
│   ├── layout/
│   │   └── NavBar.vue           (新)
│   └── dashboard/
│       ├── StatusCard.vue       (新)
│       ├── AuthCard.vue         (新)
│       ├── RateLimiterCard.vue  (新)
│       ├── MemoryCard.vue       (新)
│       ├── ActiveRequestsCard.vue (新)
│       ├── ConfigCard.vue       (新)
│       └── DataCard.vue         (新)
└── components/ui/
    └── ProgressBar.vue          (新)
```

---

## Phase 3：Models Explorer + Usage Dashboard

### 3.1 Models Explorer

| 任务 | 涉及文件 |
|------|----------|
| Models 页面 | 新建 `pages/ModelsPage.vue` |
| 模型卡片 | 新建 `ModelCard.vue` |
| 模型表格 | 新建 `ModelTable.vue` |
| 模型工具栏 | 新建 `ModelsToolbar.vue` |
| 模型详情面板 | 新建 `ModelDetail.vue` |
| 数据 composable | 新建 `useModels.ts` |

**API 依赖：** Phase 2 中实现的 `GET /models?detail=true`。

### 3.2 Usage Dashboard

| 任务 | 涉及文件 |
|------|----------|
| Usage 页面 | 新建 `pages/UsagePage.vue` |
| 配额进度条 | 新建 `QuotaBar.vue`、`QuotaCard.vue` |
| 会话用量 | 新建 `SessionUsage.vue` |
| 模型分解 | 新建 `ModelBreakdown.vue` |
| 数据 composable | 新建 `useUsage.ts` |

**API 依赖：** Phase 2 中实现的 `GET /api/status` → `quota` 字段（配额数据）+ `GET /history/api/stats`。

### 3.3 交付物

```
ui/history-v3/src/
├── pages/
│   ├── ModelsPage.vue           (新)
│   └── UsagePage.vue            (新)
├── composables/
│   ├── useModels.ts             (新)
│   └── useUsage.ts              (新)
├── components/
│   ├── models/
│   │   ├── ModelsToolbar.vue    (新)
│   │   ├── ModelCard.vue        (新)
│   │   ├── ModelTable.vue       (新)
│   │   └── ModelDetail.vue      (新)
│   └── usage/
│       ├── QuotaCard.vue        (新)
│       ├── QuotaBar.vue         (新)
│       ├── SessionUsage.vue     (新)
│       └── ModelBreakdown.vue   (新)
└── router.ts                    (改) — 新增 models、usage 路由
```

---

## 依赖关系

```
Phase 1（无外部依赖）
  ↓
Phase 2（依赖 Phase 1 的图表组件和 CSS 变量）
  ↓
Phase 3（依赖 Phase 2 的路由系统和 /models?detail=true API）
```

## 技术决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 路由方案 | vue-router hash 模式 | 无需后端改动，静态文件服务兼容 |
| 图表库 | 纯 CSS/SVG | 保持轻量，当前数据量不需要 D3/Chart.js |
| 状态轮询 vs WebSocket | 混合：WebSocket 推送事件 + 轮询兜底 | WS 实时性好但需要后端改动，轮询作为渐进增强的过渡方案 |
| 新增 API 路径前缀 | `/api/` | 与 `/history/api/` 区分：`/api/` 是全局服务 API，`/history/api/` 是 History 子系统 API |
| 不引入 Pinia | 继续使用 composable + provide/inject | 当前规模不需要，新页面各自有独立的 composable |
| CSS 变量扩展 | 新增语义变量层 | 解决 CLAUDE.md 中提到的"缺少语义层"问题 |
| 游标分页替代 page/limit | entries/sessions 列表全部使用游标 | 历史条目是实时追加的时间序列数据，page/limit 在新条目插入时会导致翻页跳变 |
| 移除 `/usage` 独立端点 | 配额数据整合到 `/api/status` 的 `quota` 字段 | 减少独立端点数量，status 聚合端点一次请求获取所有服务状态 |

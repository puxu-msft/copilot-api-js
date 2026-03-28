# UI 增强设计

本文档描述 Web UI 的全面增强方案，包括新增页面和现有页面改进。

## 目录

- [1. 导航与页面结构](#1-导航与页面结构)
- [2. 现有页面增强](#2-现有页面增强)
- [3. 新增页面：Server Dashboard](#3-新增页面server-dashboard)
- [4. 新增页面：Models Explorer](#4-新增页面models-explorer)
- [5. 新增页面：Usage Dashboard](#5-新增页面usage-dashboard)
- [6. 组件库扩展](#6-组件库扩展)

---

## 1. 导航与页面结构

### 路由方案

当前 UI 是单页面应用，无路由。增强后引入 `vue-router`（hash 模式，无需后端改动）：

```
/history/v3/#/                     → History（当前页面，默认）
/history/v3/#/dashboard            → Server Dashboard
/history/v3/#/models               → Models Explorer
/history/v3/#/usage                → Usage Dashboard
```

### 导航布局

```
┌─────────────────────────────────────────────────────────────┐
│  copilot-api        History  Dashboard  Models  Usage   ●  │ ← 导航栏
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                      页面内容区域                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

导航栏替代现有 AppHeader：
- 左侧：项目名 + 导航链接（高亮当前页）
- 右侧：WebSocket 状态指示灯 + 服务状态摘要（从 `/api/status` 获取）

### AppHeader 改造

```
现有：[History V3]  [Session ▼]  ● Live  [Refresh] [Export ▼] [Clear]
改为：[copilot-api]  History | Dashboard | Models | Usage    ● Live  速率: Normal  内存: 45%
```

- Session 选择器移入 History 页面内部（只在该页面需要）
- Refresh/Export/Clear 移入 History 页面的工具栏
- 导航栏保持全局，高度不变（48px）

---

## 2. 现有页面增强

### 2.1 请求详情面板增强

当前 `DetailPanel` / `MetaInfo` 未展示 HistoryEntry 中的以下已有字段。增强方案：

#### HTTP Headers 展示

在 MetaInfo 中新增 **Request Headers** 和 **Response Headers** 折叠区域：

```
┌─ Request Headers ──────────────────────────────┐
│  copilot-integration-id:  vscode-chat          │
│  editor-version:          vscode/1.96.4        │
│  openai-intent:           conversation-panel   │
│  x-request-id:            abc123               │
│  ... (展开/折叠)                                 │
└────────────────────────────────────────────────┘

┌─ Response Headers ─────────────────────────────┐
│  x-ratelimit-limit:      100                   │
│  x-ratelimit-remaining:  95                    │
│  x-ratelimit-reset:      1711000000            │
│  x-request-id:           def456               │
│  ... (展开/折叠)                                 │
└────────────────────────────────────────────────┘
```

**数据源：** `entry.wireRequest?.headers`、`entry.response?.headers`

**组件：** 新建 `HeadersSection.vue`，接收 `headers: Record<string, string>`，渲染 key-value 列表，默认折叠。

#### HTTP 状态码

在 MetaInfo 的 response 区域显示上游 HTTP 状态码：

```
Status      200 OK        ← 成功时绿色
Status      429 Too Many  ← 错误时红色
```

**数据源：** `entry.response?.status`

#### 原始响应体（错误调试）

当 `entry.response?.rawBody` 存在且响应失败时，在 MetaInfo 底部显示可折叠的原始响应体：

```
┌─ Raw Response Body ────────────────────────────┐
│  {"type":"error","error":{"type":"overloaded"   │
│  ,"message":"Overloaded"}}                      │
│                                                 │
│  [Copy] [展开全部]                                │
└────────────────────────────────────────────────┘
```

**组件：** 复用 `LineNumberPre.vue`，增加 copy-to-clipboard。

#### 重试时间线

当 `entry.attempts` 存在且长度 > 1 时，在 SseEventsSection 之后展示重试时间线：

```
┌─ Retry Timeline (3 attempts) ──────────────────┐
│                                                 │
│  #0  ── 直接请求 ─── 2.3s ─── 429 overloaded   │
│  #1  ── auto-truncate ─ 1.8s ─── 429 rate_limit│
│  #2  ── token-refresh ── 3.1s ─── 200 OK       │
│                                                 │
│  总耗时: 7.2s  (含队列等待 0.5s)                   │
│                                                 │
│  ▼ Attempt #0 详情                               │
│    策略: (无)                                     │
│    耗时: 2,300ms                                 │
│    错误: Overloaded                              │
│    有效消息数: 45                                  │
│                                                 │
│  ▼ Attempt #1 详情                               │
│    策略: auto-truncate                           │
│    截断: 45 → 32 消息, 128K → 95K tokens         │
│    耗时: 1,800ms                                 │
│    错误: Rate limited                            │
│                                                 │
│  ▼ Attempt #2 详情                               │
│    策略: token-refresh                           │
│    耗时: 3,100ms                                 │
│    结果: 成功                                     │
└────────────────────────────────────────────────┘
```

**组件：** 新建 `AttemptsTimeline.vue`

**接口：**

```typescript
defineProps<{
  attempts: Array<AttemptInfo>
  totalDurationMs?: number
}>()
```

#### 三栏请求对比

当前 DetailPanel 已支持 Original / Rewritten / Diff 视图模式。增强为支持三栏对比：

```
Original Request → Effective Request → Wire Request
（客户端原始请求）  （pipeline 处理后）    （实际出站请求）
```

在 DetailToolbar 的 view mode 选择器中增加选项：
- `original` — 显示 `entry.request`（现有）
- `rewritten` — 显示 `entry.effectiveRequest`（现有，但可改为显示 effectiveRequest 而非 pipelineInfo 中的重写消息）
- `wire` — 显示 `entry.wireRequest`（新增）
- `diff` — 并排对比（现有）

### 2.2 统计栏增强

当前 StatsBar 只显示 5 个数字。增强方案：

```
现有：[1,234 Requests] [1,100 Success] [134 Failed] [2.5M In Tokens] [890K Out Tokens]

增强：[1,234 Requests] [1,100 Success] [134 Failed] [2.5M In] [890K Out] [45% Cache] [1.2s Avg] [3 Active]
```

新增字段：
- **Cache Hit Rate**：`cache_read_input_tokens / input_tokens * 100`（来自 stats）
- **Avg Duration**：`averageDurationMs`（来自 stats，已有但未显示）
- **Active Requests**：从 `/api/status` 获取的活跃请求数

### 2.3 统计图表

在 History 页面的 StatsBar 下方，增加可折叠的图表区域：

```
┌─ Activity ─────────────────────────────────────────────────┐
│  ▓                                                         │
│  ▓ ▓                    ▓                                  │
│  ▓ ▓ ▓              ▓ ▓ ▓                          ▓      │
│  ▓ ▓ ▓ ▓    ▓    ▓ ▓ ▓ ▓ ▓    ▓                ▓ ▓      │
│  ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓  ▓  ▓  ▓  ▓ ▓ ▓ ▓ ▓ │
│  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 │
│                     Requests per Hour                      │
├─ Models ──────────────────┬─ Endpoints ────────────────────┤
│  claude-opus-4.6     ████ │  anthropic-messages   █████    │
│  claude-sonnet-4.6  ██   │  openai-chat          ██      │
│  gpt-5.1            █    │  openai-responses     █       │
└──────────────────────────┴─────────────────────────────────┘
```

**数据源：** `HistoryStats.recentActivity`、`modelDistribution`、`endpointDistribution`（全部已有）

**实现方案：** 纯 CSS/SVG 图表，不引入第三方图表库（保持轻量）：
- **活动柱状图**：CSS flexbox + 百分比高度的 `<div>` 条
- **分布横向条**：CSS 百分比宽度的进度条

**组件：**
- `StatsCharts.vue` — 图表区域容器，可折叠
- `BarChart.vue` — 通用柱状图组件
- `HorizontalBar.vue` — 通用水平条形图组件

---

## 3. 新增页面：Server Dashboard

服务器运行状态的全面仪表板。

### 布局

```
┌─────────────────────────────────────────────────────────────┐
│  Server Dashboard                                [Refresh]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ Status ──────────┐  ┌─ Auth ──────────────────────────┐│
│  │  ● Healthy        │  │  Account: Business              ││
│  │  Uptime: 2h 34m   │  │  Token: device-auth             ││
│  │  Phase: idle       │  │  Expires: 2026-03-26 11:30:00   ││
│  └───────────────────┘  └─────────────────────────────────┘│
│                                                             │
│  ┌─ Rate Limiter ────────────────────────────────────────┐ │
│  │  Mode: [Normal]  Queue: 0  Successes: 15              │ │
│  │                                                       │ │
│  │  Config:                                              │ │
│  │    Base retry interval:  10s                          │ │
│  │    Max retry interval:   120s                         │ │
│  │    Recovery timeout:     10min                        │ │
│  │    Recovery successes:   5                            │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Memory ──────────────────────────────────────────────┐ │
│  │  Heap: 156 MB / 4096 MB (3.8%)                        │ │
│  │  [████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 3.8%    │ │
│  │                                                       │ │
│  │  History: 142 / 200 entries (71%)                     │ │
│  │  [████████████████████████████░░░░░░░░░░░░░░] 71%    │ │
│  │  Evicted: 58 total                                    │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Active Requests ─────────────────────────────────────┐ │
│  │  ID          Endpoint              Model     State    │ │
│  │  abc123      anthropic-messages    opus-4.6  streaming│ │
│  │  def456      openai-chat           gpt-5.1   executing│ │
│  │                                                       │ │
│  │  Total: 2 active requests                             │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Configuration ───────────────────────────────────────┐ │
│  │  auto_truncate:           true                        │ │
│  │  dedup_tool_calls:        false                       │ │
│  │  context_editing:         off                         │ │
│  │  strip_server_tools:      false                       │ │
│  │  fetch_timeout:           300s                        │ │
│  │  stream_idle_timeout:     300s                        │ │
│  │  model_overrides:                                     │ │
│  │    opus  → claude-opus-4.6                            │ │
│  │    sonnet → claude-sonnet-4.6                         │ │
│  │    haiku  → claude-haiku-4.5                          │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 数据源

| 区域 | API | 轮询间隔 |
|------|-----|----------|
| Status / Auth / Rate Limiter / Memory | `GET /api/status` | 5s |
| Active Requests | `GET /api/active-requests` | 2s |
| Configuration | `GET /api/config` | 30s（配置很少变化） |

### 组件结构

```
DashboardPage.vue
├── StatusCard.vue         ── 健康状态 + Uptime + 关闭阶段
├── AuthCard.vue           ── 账户类型 + Token 来源 + 过期时间
├── RateLimiterCard.vue    ── 模式指示灯 + 队列 + 配置详情
├── MemoryCard.vue         ── 堆使用进度条 + History 条目进度条 + 淘汰计数
├── ActiveRequestsCard.vue ── 活跃请求表格（实时刷新）
└── ConfigCard.vue         ── 运行时配置 key-value 列表
```

### 交互

- **自动刷新**：各区域按不同间隔轮询（状态 5s、活跃请求 2s、配置 30s）
- **速率限制器模式指示灯**：Normal=绿色、Rate-limited=红色、Recovering=黄色
- **内存进度条**：
  - 绿色 < 75%
  - 黄色 75-90%
  - 红色 > 90%
- **活跃请求状态**：带状态点颜色编码（pending=灰、executing=蓝、streaming=绿）

---

## 4. 新增页面：Models Explorer

浏览所有可用模型的目录页面。

### 布局

```
┌─────────────────────────────────────────────────────────────┐
│  Models Explorer                                            │
│  [Search ________________]  [Vendor ▼]  [Type ▼]  [Grid|List]│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─ claude-opus-4.6 ─────────┐ ┌─ claude-sonnet-4.6 ─────┐│
│  │  Anthropic  ● Premium     │ │  Anthropic               ││
│  │                           │ │                           ││
│  │  Family: claude-opus      │ │  Family: claude-sonnet    ││
│  │  Context: 200K tokens     │ │  Context: 200K tokens     ││
│  │  Max Output: 32K tokens   │ │  Max Output: 16K tokens   ││
│  │  Billing: 3x              │ │  Billing: 1x              ││
│  │                           │ │                           ││
│  │  ✓ Streaming              │ │  ✓ Streaming              ││
│  │  ✓ Tool Calls             │ │  ✓ Tool Calls             ││
│  │  ✓ Vision                 │ │  ✓ Vision                 ││
│  │  ✓ Thinking               │ │  ✓ Thinking               ││
│  │                           │ │                           ││
│  │  Endpoints:               │ │  Endpoints:               ││
│  │  messages | chat | resp   │ │  messages | chat | resp   ││
│  └───────────────────────────┘ └───────────────────────────┘│
│                                                             │
│  ┌─ gpt-5.1 ────────────────┐ ┌─ gemini-2.5-pro ─────────┐│
│  │  OpenAI                   │ │  Google                   ││
│  │  ...                      │ │  ...                      ││
│  └───────────────────────────┘ └───────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 模型卡片详细设计

每个模型卡片展示：

| 区域 | 内容 | 数据源 |
|------|------|--------|
| 标题行 | 模型 ID + Vendor 徽章 + Premium 标记 | `id`, `vendor`, `billing.is_premium` |
| 基础信息 | Family、Category、Tokenizer | `capabilities.family`, `model_picker_category`, `capabilities.tokenizer` |
| 限制参数 | Context window、Max output、Max prompt | `capabilities.limits.*` |
| 计费信息 | Multiplier、Premium、限制计划 | `billing.*` |
| 能力标签 | Streaming、Tool calls、Vision、Thinking 等 | `capabilities.supports.*` |
| 端点支持 | 支持的 API 端点列表 | `supported_endpoints` |

### 过滤与搜索

- **搜索框**：按模型 ID、名称、vendor 模糊搜索
- **Vendor 过滤**：Anthropic / OpenAI / Google / Azure OpenAI
- **Type 过滤**：chat / embeddings / completion
- **视图切换**：Grid（卡片网格）/ List（紧凑表格）

### 列表视图

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Model              Vendor     Family        Context   Output  Billing    │
│  claude-opus-4.6    Anthropic  claude-opus   200K      32K     3x ●Prem  │
│  claude-sonnet-4.6  Anthropic  claude-sonnet 200K      16K     1x        │
│  gpt-5.1            OpenAI     gpt-5         128K      32K     1x        │
│  gemini-2.5-pro     Google     gemini-2.5    1M        65K     1x        │
└────────────────────────────────────────────────────────────────────────────┘
```

**点击行/卡片** → 展开详情面板或弹出模态框。

### 组件结构

```
ModelsPage.vue
├── ModelsToolbar.vue      ── 搜索 + 过滤 + 视图切换
├── ModelGrid.vue          ── 卡片网格视图
│   └── ModelCard.vue (×N) ── 单个模型卡片
├── ModelTable.vue         ── 表格列表视图
└── ModelDetail.vue        ── 详情面板/模态框
```

### 数据源

`GET /models?detail=true`（单次加载，不需要轮询——模型列表启动后不变）。

---

## 5. 新增页面：Usage Dashboard

Copilot 账户用量和配额监控。

### 布局

```
┌─────────────────────────────────────────────────────────────┐
│  Usage Dashboard                                 [Refresh]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Account: Business    Plan: copilot-business                │
│  Quota Reset: 2026-04-01                                    │
│                                                             │
│  ┌─ Premium Interactions ────────────────────────────────┐ │
│  │                                                       │ │
│  │  [████████████████████████░░░░░░░░░░] 65% remaining   │ │
│  │  650 / 1000  (overage: 0)                             │ │
│  │                                                       │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Chat ─────────────────────┐ ┌─ Completions ──────────┐ │
│  │  [███████████████░░░░░] 72%│ │  [████████████████░] 85%│ │
│  │  720 / 1000                │ │  850 / 1000             │ │
│  │  Unlimited: No             │ │  Unlimited: No          │ │
│  └────────────────────────────┘ └─────────────────────────┘ │
│                                                             │
│  ┌─ Session Token Usage ─────────────────────────────────┐ │
│  │                                                       │ │
│  │  本次会话:                                              │ │
│  │    Input:  245,000 tokens                             │ │
│  │    Output:  89,000 tokens                             │ │
│  │    Cache Hits: 78,000 tokens (32% of input)           │ │
│  │                                                       │ │
│  │  ┌─ Per-Model Breakdown ──────────────────────────┐   │ │
│  │  │  claude-opus-4.6     180K in / 65K out  (3x)   │   │ │
│  │  │  claude-sonnet-4.6    45K in / 18K out  (1x)   │   │ │
│  │  │  gpt-5.1              20K in /  6K out  (1x)   │   │ │
│  │  └────────────────────────────────────────────────┘   │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─ Activity Trend ──────────────────────────────────────┐ │
│  │  (复用 StatsCharts 中的活动柱状图)                       │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 数据源

| 区域 | API | 说明 |
|------|-----|------|
| 账户信息 + 配额 | `GET /api/status` → `quota` 字段 | 已整合到 status 端点 |
| Session Token Usage | `GET /history/api/stats` | History 聚合统计 |
| Per-Model Breakdown | `GET /history/api/stats` → `modelDistribution` + 会话 token 数据 | 已有数据 |
| Activity Trend | `GET /history/api/stats` → `recentActivity` | 已有数据 |

### 配额进度条设计

```typescript
interface QuotaBarProps {
  label: string          // "Premium Interactions"
  used: number           // entitlement - remaining
  total: number          // entitlement
  remaining: number
  percentRemaining: number
  unlimited: boolean
  overage: number
  overagePermitted: boolean
}
```

颜色编码：
- 绿色：剩余 > 50%
- 黄色：剩余 20-50%
- 红色：剩余 < 20%
- 灰色条：unlimited = true

### 组件结构

```
UsagePage.vue
├── AccountInfo.vue        ── 账户信息行
├── QuotaCard.vue          ── 配额进度条 (×3: premium, chat, completions)
│   └── QuotaBar.vue       ── 单个进度条组件
├── SessionUsage.vue       ── 本次会话 token 统计
│   └── ModelBreakdown.vue ── 按模型的 token 分解
└── StatsCharts.vue        ── 复用活动图表组件
```

---

## 6. 组件库扩展

### 新增通用组件

| 组件 | 用途 | 接口 |
|------|------|------|
| `ProgressBar.vue` | 带百分比和颜色编码的进度条 | `value: number, max: number, color?: string` |
| `BarChart.vue` | 纯 CSS 柱状图 | `data: Array<{label, value}>, maxBars?: number` |
| `HorizontalBar.vue` | 水平分布条形图 | `data: Record<string, number>` |
| `KeyValueList.vue` | Key-Value 列表（折叠） | `items: Record<string, string>, collapsed?: boolean` |
| `StatusIndicator.vue` | 模式指示灯（圆点 + 文字） | `status: string, color: string` |
| `DataCard.vue` | 仪表板卡片容器 | `title: string, slot: default` |
| `NavBar.vue` | 顶部导航栏 | `currentRoute: string` |
| `HeadersSection.vue` | HTTP Headers 折叠列表 | `headers: Record<string, string>, title: string` |
| `AttemptsTimeline.vue` | 重试时间线可视化 | `attempts: Array<AttemptInfo>` |

### 新增 Composables

| Composable | 用途 | 返回 |
|------------|------|------|
| `useServerStatus()` | 轮询 `/api/status`，5s 间隔 | `{ status, loading, error }` |
| `useModels()` | 加载 `/models?detail=true`，一次性 | `{ models, loading, error, search, filter }` |
| `useUsage()` | 从 `/api/status` 的 `quota` 提取配额数据，手动刷新 | `{ quota, loading, error, refresh }` |
| `useActiveRequests()` | 轮询 `/api/active-requests`，2s 间隔 | `{ requests, count, loading }` |
| `usePolling(fn, interval)` | 通用轮询工具 | `{ data, loading, error, pause, resume }` |

### CSS 变量扩展

```css
/* 语义色彩变量 */
--color-success: var(--success);
--color-warning: var(--warning);
--color-error: var(--error);
--color-info: var(--primary);

/* 进度条 */
--progress-bg: var(--bg-tertiary);
--progress-height: 8px;
--progress-border-radius: 4px;

/* 卡片 */
--card-bg: var(--bg-secondary);
--card-border: var(--border);
--card-padding: var(--spacing-lg);
--card-gap: var(--spacing-md);

/* 导航 */
--nav-height: 48px;
--nav-bg: var(--bg-secondary);
--nav-active-color: var(--primary);
--nav-hover-bg: var(--bg-hover);
```

# Web UI 系统设计

## 概述

Web UI 从单一的请求历史查看器演进为 **全面的服务控制台**，提供以下能力：

| 能力 | 当前状态 | 目标状态 |
|------|----------|----------|
| 请求历史查看 | 已实现 | 增强（headers、重试时间线、三栏对比） |
| 实时统计 | 基础数字 | 图表可视化（活动趋势、模型分布） |
| 模型目录浏览 | 无 UI | Models Explorer（能力、限制、计费） |
| Copilot 用量配额 | 无 UI | Usage Dashboard（配额进度、趋势） |
| 服务状态监控 | 仅 `/health` | Server Dashboard（配置、速率限制、内存） |
| 活跃请求追踪 | 无 | 实时活跃请求面板 |

## 架构

### 当前数据流

```
客户端请求 → Hono 路由 → Pipeline 处理 → 上游 API
                ↓                              ↓
         RequestContext ──(事件)──→ HistoryStore
                                       ↓
                              WebSocket 推送 → Web UI
                                       ↓
                              REST API ←──── Web UI
```

### 前端组件树

```
App (provide historyStore)
├── AppHeader ─── Session 选择、导出、清空
├── StatsBar ──── 请求/成功/失败/Token 统计
└── SplitPane
    ├── [left]  RequestList ─── 搜索、过滤、分页
    │           └── RequestItem (×N)
    └── [right] DetailPanel ─── 消息内容、元信息
                ├── DetailToolbar ── 消息搜索/过滤/视图模式
                ├── SectionBlock [Request] ── 请求消息
                │   └── MessageBlock → ContentRenderer
                │       → TextBlock / ThinkingBlock / ToolUseBlock / ...
                ├── SectionBlock [Response] ── 响应消息
                ├── SseEventsSection ── SSE 事件时间线
                └── MetaInfo ── 元信息面板
```

### 技术栈

- **前端**：Vue 3 + TypeScript + Vite
- **状态管理**：`useHistoryStore` composable（provide/inject，无 Pinia）
- **实时通信**：WebSocket（自动重连、指数退避）
- **API 客户端**：基于 fetch 的 REST 客户端
- **样式**：CSS 变量主题系统，深色/浅色跟随系统

## 文档导航

| 文档 | 说明 |
|------|------|
| [api-reference.md](api-reference.md) | API 完整参考：现有端点 + 新增端点，包含请求/响应 schema |
| [ui-enhancement.md](ui-enhancement.md) | UI 增强设计：新页面（Dashboard、Models、Usage）+ 现有页面改进 |
| [websocket-protocol.md](websocket-protocol.md) | WebSocket 协议参考：事件类型、消息格式、扩展事件 |
| [implementation-plan.md](implementation-plan.md) | 分阶段实施路线图，含优先级和依赖关系 |

## 与其他文档的关系

- [DESIGN.md](../DESIGN.md) — 后端架构总览、路由表、模块说明
- [history.md](../history.md) — History 系统详细设计（存储、WebSocket、Memory Pressure）
- [streaming.md](../streaming.md) — 流式处理、WebSocket Transport
- [request-pipeline.md](../request-pipeline.md) — 请求重试管道、策略模式

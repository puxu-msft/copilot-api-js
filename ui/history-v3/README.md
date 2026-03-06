# History V3

Copilot API 请求历史查看器的 Vue 3 实现，用于查看、分析和调试 API 请求/响应。

## 技术栈

- **Vue 3** + Composition API（`<script setup>`）
- **TypeScript**（严格模式）
- **Vite**（构建工具，base: `/history/v3/`）
- **diff2html**（diff 渲染）
- **highlight.js**（代码高亮）

## 目录结构

```
src/
├── api/                    # 后端通信
│   ├── http.ts             # REST API 客户端（fetch 封装）
│   └── ws.ts               # WebSocket 客户端（自动重连）
├── composables/            # Vue 组合函数
│   ├── useHistoryStore.ts  # 核心状态管理（请求列表、选中、分页、WS 连接）
│   ├── useTheme.ts         # 主题切换（light/dark，持久化到 localStorage）
│   ├── useFormatters.ts    # 数据格式化（时间、大小、token 数、HTTP 状态码）
│   ├── useHighlightHtml.ts # 代码高亮 HTML 生成
│   ├── useContentContext.ts # 消息内容的上下文信息（模型、角色）
│   ├── useRewriteInfo.ts   # 请求重写信息提取
│   ├── useCopyToClipboard.ts # 复制到剪贴板
│   ├── useKeyboard.ts      # 键盘快捷键（↑↓ 导航、Escape 关闭）
│   └── useToast.ts         # Toast 通知
├── components/
│   ├── layout/             # 布局组件
│   │   ├── AppHeader.vue   # 顶栏（状态指示器、搜索、主题切换）
│   │   ├── SplitPane.vue   # 左右分栏（可拖拽调整宽度）
│   │   └── StatsBar.vue    # 底部统计栏
│   ├── list/               # 请求列表
│   │   ├── RequestList.vue # 请求列表容器
│   │   ├── RequestItem.vue # 单个请求行
│   │   └── ListPagination.vue # 分页控制
│   ├── detail/             # 请求详情
│   │   ├── DetailPanel.vue # 详情面板主容器
│   │   ├── DetailToolbar.vue # 工具栏（复制、查看原始 JSON）
│   │   ├── MetaInfo.vue    # 元信息展示（模型、耗时、token）
│   │   ├── SectionBlock.vue # 可折叠区域
│   │   └── TruncationDivider.vue # 截断分隔线
│   ├── message/            # 消息内容渲染
│   │   ├── ContentRenderer.vue  # 内容块分发器
│   │   ├── ContentBlockWrapper.vue # 内容块包装器
│   │   ├── MessageBlock.vue     # 单条消息
│   │   ├── SystemMessage.vue    # 系统消息
│   │   ├── TextBlock.vue        # 文本内容
│   │   ├── ThinkingBlock.vue    # 思考过程
│   │   ├── ToolUseBlock.vue     # 工具调用
│   │   ├── ToolResultBlock.vue  # 工具结果
│   │   ├── ImageBlock.vue       # 图片
│   │   ├── DiffView.vue         # Diff 渲染
│   │   └── GenericBlock.vue     # 未知类型兜底
│   └── ui/                 # 基础 UI 组件
│       ├── BaseBadge.vue
│       ├── BaseButton.vue
│       ├── BaseCheckbox.vue
│       ├── BaseInput.vue
│       ├── BaseModal.vue
│       ├── BaseSelect.vue
│       ├── BaseToast.vue
│       ├── IconSvg.vue
│       ├── LineNumberPre.vue
│       ├── RawJsonModal.vue
│       └── StatusDot.vue
├── styles/                 # 全局样式
│   ├── variables.css       # CSS 变量（颜色、间距、字体）
│   ├── base.css            # 基础样式
│   ├── reset.css           # CSS reset
│   ├── scrollbar.css       # 滚动条样式
│   ├── transitions.css     # 动画过渡
│   └── diff2html-overrides.css # diff2html 样式覆盖
├── types/
│   ├── index.ts            # 核心类型定义（HistoryEntry、消息类型）
│   └── ws.ts               # WebSocket 消息类型
├── utils/
│   └── typeGuards.ts       # 类型守卫（内容块类型判断）
├── App.vue                 # 根组件
└── main.ts                 # 入口

dist/                       # 构建产物（提交到仓库，由后端 serveStatic 提供）
```

## 开发

```bash
cd ui/history-v3
bun install
bun run dev       # 启动 Vite 开发服务器（自动代理 /history/api → 后端）
bun run build     # 构建到 dist/
bun run preview   # 预览构建产物
```

## 数据流

```
后端 API                    前端
─────────                  ─────────
GET /history/api/entries → useHistoryStore.loadEntries()
                           ↓
WS  /history/ws          → WSClient → onEntryAdded / onEntryUpdated
                           ↓
                         entries (ref) → RequestList → RequestItem
                           ↓
                         selectedEntry (ref) → DetailPanel → MessageBlock → ContentRenderer
```

## WebSocket 协议

连接到 `ws://<host>/history/ws`，服务端推送：

| 事件 | 说明 |
|------|------|
| `connected` | 连接确认 |
| `entry:added` | 新请求记录 |
| `entry:updated` | 请求记录更新（如流式完成后的 usage） |

客户端通过 `onStatusChange(connected: boolean)` 回调更新 UI 状态指示器。

## 构建部署

构建产物在 `dist/` 目录，提交到仓库。后端通过 `serveStatic` 在 `/history/v3/` 路径下提供静态文件。Vite 的 `base: '/history/v3/'` 确保所有资源引用使用正确的路径前缀。

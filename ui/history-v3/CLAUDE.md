# CLAUDE.md — History V3

## 项目上下文

这是 copilot-api 的内置请求历史查看器前端，Vue 3 + TypeScript + Vite 项目。
**独立于后端 tsconfig**——后端 `tsconfig.json` 通过 `exclude` 排除本目录，本目录有自己的 `tsconfig.json`。

## 代码风格

- Vue 3 `<script setup lang="ts">` 单文件组件
- 组合函数（composables）命名 `useXxx`，返回响应式状态和方法
- CSS 变量定义在 `src/styles/variables.css`，组件内使用 `var(--xxx)`
- 组件内样式使用 `<style scoped>`，全局样式在 `src/styles/`
- 不使用分号（与后端保持一致）

## 架构要点

### 状态管理

没有使用 Pinia，状态集中在 `useHistoryStore` composable 中：
- `entries`：请求列表（分页加载）
- `selectedEntry`：当前选中的请求
- `wsConnected`：WebSocket 连接状态
- `init()` 初始化时创建 WSClient 并加载首页数据

### API 层

- `api/http.ts`：基于 fetch 的 REST 客户端，所有端点返回 `Promise<T>`
- `api/ws.ts`：WebSocket 客户端类，自动重连（指数退避），通过回调通知消费者

### 内容渲染

消息内容通过组件链渲染：
```
DetailPanel → SectionBlock（请求/响应区域）
  → MessageBlock（单条 user/assistant 消息）
    → ContentRenderer（分发到具体内容块）
      → TextBlock / ThinkingBlock / ToolUseBlock / ToolResultBlock / ImageBlock / DiffView / GenericBlock
```

`ContentRenderer` 是纯分发器，根据 `content.type` 选择组件。

### 类型体系

- `types/index.ts`：核心类型（`HistoryEntry`、`ContentBlock`、消息类型）
- `types/ws.ts`：WebSocket 消息类型（`WSMessage`、事件类型联合）
- `utils/typeGuards.ts`：类型守卫函数（`isTextBlock`、`isToolUseBlock` 等）

## 已知设计问题

### 需要改进

1. **useHistoryStore 职责过重**：集合了数据加载、分页、选中、WS 连接、搜索、实时更新等所有状态。应拆分为独立的 composables（分页逻辑、WS 连接状态、选中状态）。

2. **HTTP 客户端错误处理不一致**：`http.ts` 中部分函数 try-catch 后静默返回空数组，部分直接抛出。应统一策略。

3. **WSClient 重连逻辑**：固定的延迟值（`RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]`），应改为指数退避 + jitter。

4. **DetailPanel 过大**：~200 行模板，承担了详情渲染的所有逻辑。应将请求/响应区域提取为子组件。

5. **样式变量缺少语义层**：`variables.css` 直接定义具体颜色值，缺少语义变量（如 `--color-success`、`--color-error`），导致多处硬编码颜色。

### 不要改动

- **不要引入 Pinia**：当前规模不需要，`useHistoryStore` 的问题是职责拆分不够，不是缺少状态管理库。
- **不要改变组件目录结构**：`layout/`、`list/`、`detail/`、`message/`、`ui/` 的分层是合理的。
- **不要移除 diff2html**：虽然引入了较大的依赖，但 diff 渲染是核心功能。

## 构建

```bash
npm run build:ui      # 构建到 dist/，产物提交到仓库
npm run dev:ui        # 开发模式，Vite 代理 API 请求到后端
npm run preview:ui    # 预览构建产物
npm run typecheck:ui  # 前端类型检查
npm run test:ui       # 前端测试
```

前端依赖和脚本由仓库根 `package.json` 统一管理，不再在 `ui/history-v3/` 下单独安装依赖。

## 与后端的关系

- 后端 `src/routes/ui/route.ts` 提供 `dist/` 中的静态文件，挂载到 `/ui`
- WebSocket 路由通过 `registerWsRoutes()` 注册到根 app 的 `/ws`
- API 路由在 `src/routes/history/route.ts` 中，挂载在 `/history/api/`

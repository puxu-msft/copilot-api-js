# CLAUDE.md — Web UI

## 项目上下文

这是 copilot-api 内置的请求历史查看器前端。Vue 3 + Vuetify 4 + Vite 7。
本目录是**独立的 bun workspace 成员**：有自己的 [package.json](package.json)（FE 依赖与脚本）与 [tsconfig.json](tsconfig.json)（后端 tsconfig 经 `exclude` 排除本目录）。根 `package.json` 声明 `workspaces:["ui"]`，**单一根 `bun.lock`**（hoist）。
后端 `src/routes/ui/route.ts` 默认在 `/ui` 提供 `ui/dist/` 静态文件，可使用 `--external-ui-url` 改为其他 URL（如 vite dev server）。

## 构建与工具链

- **依赖管理用 bun**（lockfile 为根 `bun.lock`）。FE 依赖装到本 workspace：在 `ui/` 下 `bun add <pkg>`，或根目录 `bun add --filter copilot-api-ui <pkg>`；不要用 `npm install`（npm 会因 peer deps 冲突失败）。仓库级 dev 工具（typescript/eslint/tsdown/playwright/lint-staged）在根 `package.json`，经 hoist 对本 workspace 可见。
- 路径别名：`@/*` → `<root>/ui/src/*`，`~backend/*` → `<root>/src/*`（跨项目类型导入）。
- Base URL \(`base`\) 开发时为 `/`，生产构建为 `/ui/`（后端静态文件挂载路径）。
- dev proxy 转发 API 到后端（默认 `localhost:4141`，可通过 `COPILOT_API_HOST`/`COPILOT_API_PORT` 覆盖）。

Vite 配置的自动导入（自动注册组件）：

- Vuetify 通过 `vite-plugin-vuetify` 的 `autoImport: true` 自动注册组件，无需手动导入。
- `unplugin-auto-import` 自动导入 Vue、VueUse、Pinia、vue-router API，生成 [auto-imports.d.ts](types/auto-imports.d.ts)。
- `unplugin-vue-components` 自动导入 `src/components/` 下的项目组件，生成 [components.d.ts`](types/components.d.ts)。

脚本定义在本目录 [package.json](package.json)；根目录 [package.json](../package.json) 提供同名委派入口（`bun run --filter copilot-api-ui …`），故两处均可运行：

```bash
# 在 ui/ 下直接跑(本 workspace 脚本)         # 或在根目录跑(委派)
bun run build      # 构建到 ui/dist/          bun run build:ui
bun run dev        # 开发模式，Vite 代理后端    bun run dev:ui
bun run typecheck  # vue-tsc 类型检查          bun run typecheck:ui
bun run test       # 先跑 bun test，再跑 vitest  bun run test:ui
```

## 两套测试系统

| | Bun 测试 | Vitest 测试 |
|---|---|---|
| 路径 | `ui/tests/*.test.ts` | `ui/vitest/*.test.ts` |
| 运行 | `npm run test:ui:bun` | `npm run test:ui:vitest` |
| 环境 | 无 DOM | jsdom + `@vue/test-utils` |
| 用途 | composable 和工具函数的纯逻辑测试 | 需要 DOM 的组件挂载测试 |
| Mock | `mock.module()`（Bun 专用，import 须在 mock 之后） | `vi.mock()` / `vi.fn()` |
| Vuetify | 不涉及 | `vitest/helpers/mount.ts` 提供 `mountWithVuetifyStubs()` |

**选择规则**：测试 composable、工具函数、类型守卫 → bun test。测试组件渲染、用户交互 → vitest。

## 代码风格

- `<script setup lang="ts">` 单文件组件，偏好使用 Composition API 而非 Options API
- 不使用行末分号（与后端一致）
- 优先使用 VueUse（`@vueuse/core`）而非手写生命周期管理

### script setup 内部排序

1. Vue 核心导入（`ref`、`computed`、`watch`、`onMounted`）
2. Vue Router 导入
3. `import type` 类型导入
4. 组件导入
5. composable 调用（`useXxx()`）
6. `ref()` / `reactive()` 声明
7. `computed()` 声明
8. 函数定义
9. 生命周期钩子

### Props 和 Emits

Props 用 `defineProps<{ ... }>()` 泛型形式，接口内联。Emits 用 `defineEmits<{ event: [payload] }>()` 泛型形式。
v-model 模式：`modelValue` prop + `update:modelValue` emit + 本地 `computed` 桥接。

### composable 约定

命名 `useXxx`，放在 `src/composables/`。非平凡的 composable 必须导出返回类型接口（如 `HistoryStore`、`AppThemeController`、`UsePollingReturn<T>`）。

## 视觉风格

### Vuetify 配置

- 蓝图：Material Design 3（`md3`）
- **全局 `rounded: 0`**——所有 Vuetify 组件无圆角，这是刻意的设计选择
- 色调：暖色 amber/gold 主色（dark `#d4a04a` / light `#a07020`），暖灰背景
- 主题三态：`light`、`dark`、`system`，持久化到 localStorage `copilot-api-theme`
- 默认 density：表单控件 `compact`，VCard `outlined`，VChip `small` + `tonal`
- 图标：MDI（`@mdi/font`）

### CSS 架构

加载顺序（`main.ts`）：Vuetify 样式 → `vuetify-overrides.css` → `reset.css`（scoped to `.app-legacy`）→ `variables.css` → `base.css` → `scrollbar.css` → `transitions.css` → `diff2html-overrides.css` → `json-viewer.css`

**颜色变量来源于 Vuetify theme**（`vuetify.ts` 是唯一真实来源）：
- `.v-application` 上映射 `--v-theme-*` → 简写变量（`--bg`、`--text`、`--primary`、`--success`、`--error`）
- `.v-theme--dark` / `.v-theme--light` 定义无 Vuetify 等价物的自定义变量（`--bg-hover`、`--border`、`--purple`、`--cyan`）
- `:root` 定义主题无关 token：spacing（`--spacing-xs` ~ `--spacing-xl`）、字体大小（`--font-size-xs` ~ `--font-size-lg`）、布局

**字体**：DM Sans（正文，variable weight），IBM Plex Mono（代码），通过 `index.html` Google Fonts 加载。

### 页面布局约定

所有页面根元素使用 `class="xxx-page v-page-root"`，可滚动区域使用 `class="v-page-scroll"`。
这两个 class 定义在 `vuetify-overrides.css`，提供填满 v-main 的 flex 布局。

## 路由

Hash 路由（`createWebHashHistory`），所有路由懒加载：

| 路径 | 页面 |
|------|------|
| `/dashboard` | VDashboardPage — 运维看板 |
| `/activity` | VActivityPage — 请求历史列表 |
| `/activity/:id` | VDetailPage — 请求详情 |
| `/search` | VSearchPage — 内容寻址全文搜索（5 源单选切换，消费 `/history/api/search` + `/search/contains`；与 `/activity` 列表的轻量 preview 快筛分离） |
| `/config` | VConfigPage — config.yaml 编辑器 |

所有遗留路径（`/v/*`、`/history`、`/logs`、`/usage`）已重定向到新路径。

> **模型视图已退役**（2026-07-10）：`/models` 页（VModelsPage + `components/models/` + `useModelsCatalog`/`useModelDetail`/`useModelColumns` 等）已删除，模型目录 UI 由 React `ui-v4/`（`/ui-v4`）承担并已超越旧版。`useModelTelemetry` 保留（Dashboard 共享）。

## 状态管理

使用 Pinia（setup store 语法）管理全局状态：
- `useHistoryStore`：请求历史数据、分页、WebSocket 实时更新（facade，内部组合 `useHistoryData` + `useHistoryWS`）
- `useDetailViewState`：详情面板的搜索、过滤、显示模式

Pinia store 直接调用即可（`useHistoryStore()`），无需 provide/inject。

**仍使用 provide/inject 的**：
- `useAppTheme` — 依赖 Vuetify `useTheme()`（需要组件上下文），不适合 Pinia
- `provideContentContext` — 组件树层级的内容渲染上下文（Symbol key）
- `provideRawModal` — 单实例 JSON 查看 modal
- `provideSharedResizeObserver` — 单实例 ResizeObserver + rAF 合并

**Toast**：`useToast()` 是模块级单例（模块作用域 `ref`），任何位置调用共享同一消息队列。

## 类型体系

**单一真实来源**：核心类型从后端 re-export（`types/index.ts` 通过 `~backend/lib/history/store` 导入 `HistoryEntry`、`ContentBlock` 等）。

**前端专有类型**：
- `types/ws.ts` — WebSocket 消息的判别联合类型
- `types/config.ts` — 配置编辑器的 `EditableConfig`、`ConfigValidationError`

**类型守卫**（`utils/typeGuards.ts`）：`isTextBlock`、`isToolUseBlock`、`isToolResultBlock` 等。`normalizeToContentBlocks()` 将 Anthropic 和 OpenAI 两种消息格式统一转换为 `ContentBlock[]`。

## 内容渲染管线

```
DetailPanel → SectionBlock → MessageBlock → ContentRenderer
  → TextBlock / ThinkingBlock / ToolUseBlock / ToolResultBlock / ImageBlock / DiffView / GenericBlock
```

`ContentRenderer` 是纯分发器（根据 `content.type` 选择组件），块组件包裹在 `ErrorBoundary` 中。
支持 Anthropic 和 OpenAI 两种消息格式——OpenAI `tool_calls` 转换为虚拟 `tool_use` 块。

## API 层

`api/http.ts` 导出单例 `api` 对象。两个 base path：
- `/history/api` — 历史相关端点（entries、sessions、stats）
- 根路径 — 管理端点（`/api/status`、`/api/config`、`/api/models`）

错误通过 `ApiError` 类（携带 `status`、`bodyText`）。Entries 使用游标分页（`cursor` + `direction`）。

`api/ws.ts` 是类式 WebSocket 客户端（`WSClient`），提供自动重连（指数退避 1s→30s）、topic 订阅、回调分发。消费方依赖此类接口，不用 VueUse 的 `useWebSocket` 替换。

## VueUse 使用现状

以下 composable 已使用 VueUse 替换手写生命周期管理：

- `usePolling` → `useIntervalFn`（轮询 interval 自动清理）
- `useCopyToClipboard` → `useClipboard`（剪贴板 + `isSupported` 检测）
- `useKeyboard` → `useEventListener`（document keydown 自动清理）
- `useAppTheme` → `useLocalStorage`（主题持久化）
- `RequestList.vue` → `watchDebounced`（搜索 300ms 防抖）
- `VDetailPage.vue` → `onKeyStroke`（j/k/Esc；用 `utils/keyboard.ts` 的 `isTyping` 守卫）

**刻意保留手写实现的**：
- `useSharedResizeObserver` — 共享单实例 + rAF 合并，VueUse 每次创建新实例
- `WSClient` — 消费方依赖类式接口和 topic 订阅

## 已知设计问题

### 需要改进

1. **HTTP 客户端错误处理不一致**：`http.ts` 部分函数 try-catch 后静默返回空数组，部分直接抛出。应统一策略。
2. **~~WSClient 重连逻辑~~**（勘误：非真实债）：`api/ws.ts` 的 `scheduleReconnect` 实际**已是**指数退避（1s→30s）+ ±25% jitter；本条原述"固定延迟值"与源码及上文 §157 矛盾，作废。
3. **DetailPanel 过大**：~200 行模板，应将请求/响应区域提取为子组件。

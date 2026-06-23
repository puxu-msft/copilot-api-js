# copilot-api ui-v4

React + Tailwind v4 重写的请求检视台（inspector）。设计见 [docs/DESIGN.md](docs/DESIGN.md)，实现计划见 [docs/plans/](docs/plans/)。与现有 Vue 版 `ui/` 并行共存（后端 `/ui-v4` 路由），达对等后再替换。

## 开发

- `bun run dev:ui-v4`（仓库根）或在本目录 `bun run dev` 启动 vite，代理后端（默认 `localhost:4141`，可经 `COPILOT_API_HOST`/`COPILOT_API_PORT` 覆盖）。
- 后端需另行启动（`bun run dev`）。访问 vite 打印的本地 URL。
- 生产构建 `bun run build:ui-v4` → `ui-v4/dist`，后端 `/ui-v4` 静态路由服务。

## 测试

双系统 + e2e（按后缀隔离，互斥）：

| | 命令 | 后缀 | 环境 |
|---|---|---|---|
| 纯逻辑 | `bun run --filter copilot-api-ui-v4 test:bun` | `*.bun.test.ts` | 无 DOM |
| 组件 | `bun run --filter copilot-api-ui-v4 test:vitest` | `*.vitest.test.tsx` | jsdom + RTL |
| 全部 | `bun run --filter copilot-api-ui-v4 test` | 两者 | — |
| 类型 | `bun run --filter copilot-api-ui-v4 typecheck` | — | — |

**选择规则**：无 DOM 纯逻辑（归一化/工具/类型守卫）→ `bun test`；需挂载/交互 → vitest（jsdom）。两 runner 按文件后缀互斥，勿混用。

## 别名

`@/*`→`ui-v4/src/*`，`~backend/*` 与 `~/*`→`../src/*`（后端源码，类型 single-source、`~/*` 供后端源码内部自引用解析）。

## 技术栈

React 18 · TypeScript strict · Vite 7 · **Tailwind v4**（`@tailwindcss/vite`，CSS-first `@theme`）· React Router 6（hash 路由）· **TanStack Query**（server-state）· **Zustand**（client-state）· 移植的类式 WSClient（模块单例 + 引用计数，规避 StrictMode churn）。

## 视觉

工业风 **Terminal Amber**：暖近黑 + amber 主色、全局锐角 `rounded:0`、左对齐（拒绝居中标题）、hairline 网格、IBM Plex Mono 承载数据、green/red/amber 状态信号。主题 token 在 `src/styles/theme.css`（CSS vars 单一来源）。

## 现状（Plan 03 详情 C 布局）

- **Plan 01 地基**：应用壳层（NavRail + TopBar）+ WS 状态指示 + 主题切换 + 路由 errorElement/catch-all 占位。
- **Plan 02 Requests 工作台**：主从一体——左侧 **Live 泳道**（常驻固定高度、WS `active_request_changed` 驱动）+ **History 游标列表**（缓冲横幅 + tail 暂停/恢复 + 选中粘滞，spec §4.2）；右侧按 URL `:id` 独立 fetch 详情（深链 `/requests/:id`，spec §4.1）。
- **Plan 03 详情 C 布局 + 双格式内容渲染管线**：详情从 raw JSON 升级为 **C 布局**——常驻 DiagnosticBar（state/endpoint/时长/attempts/tokens）+ sticky sub-rail（Convo/Stages/Headers/Meta，懒加载仅挂当前段）。**内容渲染管线**：`normalizeToContentBlocks` 双格式归一化（Anthropic ContentBlock[] / OpenAI text+tool_calls / tool 响应）→ 块组件（Text/Thinking/RedactedThinking/ToolUse/ToolResult/Image/Generic，各包 ErrorBoundary）→ ContentRenderer 分发。Stages 段展示 7 腿（Inbound/Effective/Wire/Upstream/Forwarded），Headers 段 4 腿，Meta 段诊断。
- **仅 `/requests`/`/requests/:id` 已接线**；Overview/Sessions/Models/Config 显示"即将推出"占位。
- 详情 diff（SSE 帧/消息级/stages 并排）→ Plan 03b；请求内搜索 + 可控 JSON 渲染器 → Plan 04；Sessions+Agent + 后端聚合 → Plan 05。见 `docs/plans/`。

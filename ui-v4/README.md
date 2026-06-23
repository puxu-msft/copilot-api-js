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

## 现状（Plan 01 地基）

已打通端到端骨架：应用壳层（NavRail + TopBar）+ 真实拉取 `/history/api/entries` 的最小 Requests 列表 + WS 状态指示 + 主题切换。**仅 `/requests` 路由已接线**，Overview/Sessions/Models/Config 为后续 Plan（导航为预期占位）。工作台主从布局 / Live 泳道 / 详情 C 布局 / 请求内搜索 / Sessions+Agent 见 `docs/plans/` 后续子计划。

# copilot-api ui-v4

copilot-api 请求历史查看器的 React 全面重写——从「请求历史浏览器」升级为「**实时 LLM 流量检视台**」（DevTools / Network-inspector 范式）。与旧 Vue 版 `ui/` 并行共存（后端 `/ui-v4` 静态路由），达功能对等后替换。

- **架构现状**（栈/入口/数据层/渲染管线/目录职责）→ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **设计规格 WHAT/WHY** → [docs/DESIGN.md](docs/DESIGN.md)
- **逐 Plan 演进史** → [docs/evolution.md](docs/evolution.md)
- **退役 `ui/` 的功能对等 gating 清单** → [docs/TODO.md](docs/TODO.md)
- **全部文档索引** → [docs/README.md](docs/README.md)

## 功能

- **Requests**：Live 泳道（在飞请求实时流）+ History 游标列表（tail 暂停/恢复 + 「N 条新」缓冲 + 选中粘滞）；点行/深链 `#/requests/:id` 打开全屏详情。
- **详情检视**：诊断摘要条 + sub-rail 分段（Convo / System / Stages / Response / SSE / Headers / Meta），双格式（Anthropic + OpenAI）内容渲染、消息级改写 diff、SSE 帧对齐 diff、JSON 语法高亮 + 行号、TOC 树导航。
- **Sessions**：按 `x-claude-code-session-id` 聚合的会话列表 + agent 泳道时间线（main + subagent）。
- **Models**：密集能力矩阵目录表 + 运行遥测 join + 可配置列 + 过滤 + CSV 导出 + 右侧详情面板。
- **Overview**：精简运维健康（in-flight / rate limiter / quota / upstream / WS）+ Grafana 入口。
- **Config**：raw YAML 编辑（`PUT /api/config/yaml`），结构化分组表单规划中。
- 全局：主题切换（light/dark/system）、WS 连接状态、hash 路由（可深链/书签）。

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

React 19 · TypeScript strict · Vite 7 · **Tailwind v4**（`@tailwindcss/vite`，CSS-first `@theme`）· React Router 7（hash 路由 `createHashRouter`）· **TanStack Query**（server-state）· **Zustand**（client-state）· radix-ui headless · shiki 语法高亮 · 移植的类式 WSClient（模块单例 + 引用计数，规避 StrictMode churn）。完整版本清单见 [docs/ARCHITECTURE.md §1](docs/ARCHITECTURE.md)。

## 视觉

工业风 **Terminal Amber**：暖近黑 + amber 主色、全局锐角 `rounded:0`、左对齐（拒绝居中标题）、hairline 网格、IBM Plex Mono 承载数据、green/red/amber 状态信号。主题 token 在 `src/styles/theme.css`（CSS vars 单一来源）。

## 现状

当前架构现状见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（活文档）；逐 Plan/逐轮反馈的演进史见 [docs/evolution.md](docs/evolution.md)。

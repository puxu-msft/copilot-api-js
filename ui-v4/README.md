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

## 现状（Plan 08 详情页两路由分离 + Convo/Stages TOC 树导航）

- **Plan 01 地基**：应用壳层（NavRail + TopBar）+ WS 状态指示 + 主题切换 + 路由 errorElement/catch-all 占位。
- **Plan 02 Requests 列表**：**Live 泳道**（WS `active_request_changed` 驱动）+ **History 游标列表**（缓冲横幅 + tail 暂停/恢复 + 选中粘滞）；按 ID 独立 fetch 详情、深链 §4.1/§4.2。**注**：原主从一体已被 **Plan 08** 反转为两路由全屏分离。
- **Plan 03 详情 C 布局 + 双格式内容渲染管线**：DiagnosticBar + sticky sub-rail（Convo/Stages/Headers/Meta 懒加载）；`normalizeToContentBlocks` 双格式归一化 → 块组件（各包 ErrorBoundary）→ ContentRenderer 分发；Stages 7 腿 / Headers 4 腿 / Meta 诊断。
- **Plan 06 Overview/Models/Config**：**Overview** 精简健康 + Grafana 入口；**Models** 目录表 + raw JSON 切换；**Config** 结构化 JSON 编辑器 + 保存。
- **Plan 05 Sessions+Agent**：**后端新增**（只读）`GET /history/api/sessions`（entries_v2 GROUP BY session_id 聚合）+ `/entries?agentId=&mainAgentOnly=` 过滤接线；前端 **Sessions** 列表（聚合行：#req/#agents/tokens/时长/状态）+ **Session 详情**（agent 泳道时间线：main + subagent 按 agentId 分泳道，请求块深链 `/requests/:id`；subagent 标签为不透明 agentId，header 无种类名）。
- **Plan 03b 详情 diff**：详情段加 **diff**（DESIGN §4.3 最具诊断价值部分）。移植 `ui/src/utils/block-diff.ts` 算法核（jsdiff 词/行 diff + 按 role/帧类型领域 aligner，纯逻辑 + bun 测试）→ 渲染原语 `InlineParts`/`DiffRow`（kind→色钉死）。**新增 Response 段**（sub-rail 五项 Convo/Stages/Response/Headers/Meta）承载 **`SseFrameDiff`**（upstream vs forwarded 帧按类型对齐,oversized/MAX_ROWS cap）+ upstream/forwarded 响应展示；**`MessageDiffView`**（inbound↔effective 消息级改写 diff，Stages 顶部切换）；**Stages 请求三腿容器查询并排**（`@container`,窄→单列/宽→三列）；**`SystemMessage` 独立支路**（original↔rewritten↔diff 三态，`UnifiedLineDiff` 首个消费 `diffLinesRich`，React 自动转义无 HTML 注入）；**tool_result 内嵌 content-block 数组递归**走 ContentRenderer。**零后端改动**。
- **Plan 08 详情页分离 + TOC 树导航**（**零后端改动**）：**① 两路由全屏分离**——`/requests` = 列表全屏（Live 泳道 + History，点行/深链导航）、`/requests/:id` = 详情全屏（返回钮）；LiveLane 行补导航、HistoryList 粘滞高亮改读 list-store `selectedId`；退役 `RequestsWorkbench`（反转 DESIGN §4 主从一体，用户定 2026-06-24）。**② Convo/Stages 左侧 TOC 树**——`buildMessageTocNodes` 纯 builder 产消息→块树（锚点契约 `${prefix}-msg-${i}/-blk-${j}`，blocks 源 `normalizeToContentBlocks` 与渲染对齐）+ `DetailTocTree`（可折叠递归、块默认折叠、activeAnchor 高亮）；`anchorPrefix` 贯穿 ConversationView→MessageBlock→ContentRenderer 渲染锚点（未锚定调用方 DOM 不变）；`useAnchorScroll`（scrollIntoView + 瞬时 `.toc-flash` 高亮 + timeout 清理）；Convo `[TOC sticky 左 | 内容右]`、Stages `leg→message→block` 树（leg 包裹 `id=stage-${key}`，`[TOC | @container 三腿并排]`）。
- **nav 5 项全是真页**：Overview / Requests / Sessions / Models / Config。catch-all 仅兜真未知路径。
- 后续：请求内搜索 → Plan 04；视觉打磨+响应式 → Plan 07；Config 结构化分组表单 → Plan 06b；Session client/cost 列 + 工作台 group-by + subagent 种类名 → Plan 05b；TOC scroll-spy / Response·Headers·Meta 段 TOC → 待后续。见 `docs/plans/`。

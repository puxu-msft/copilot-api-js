# copilot-api ui-v4

React + Tailwind v4 重写的请求检视台（inspector）。设计见 [docs/DESIGN.md](docs/DESIGN.md)，实现计划见 [docs/plans/](docs/plans/)。与现有 Vue 版 `ui/` 并行共存（后端 `/ui-v4` 路由），达对等后再替换——**退役 `ui/` 的功能对等补齐清单见 [docs/TODO.md](docs/TODO.md)**（逐页缺口 + 严重度 + plan 关联）。

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

## 现状（Plan 09 详情/列表打磨 —— 行统计 + 行号 + 语法高亮 + TOC 美化 + 后端字节/成本）

- **Plan 01 地基**：应用壳层（NavRail + TopBar）+ WS 状态指示 + 主题切换 + 路由 errorElement/catch-all 占位。
- **Plan 02 Requests 列表**：**Live 泳道**（WS `active_request_changed` 驱动）+ **History 游标列表**（缓冲横幅 + tail 暂停/恢复 + 选中粘滞）；按 ID 独立 fetch 详情、深链 §4.1/§4.2。**注**：原主从一体已被 **Plan 08** 反转为两路由全屏分离。
- **Plan 03 详情 C 布局 + 双格式内容渲染管线**：DiagnosticBar + sticky sub-rail（Convo/Stages/Headers/Meta 懒加载）；`normalizeToContentBlocks` 双格式归一化 → 块组件（各包 ErrorBoundary）→ ContentRenderer 分发；Stages 7 腿 / Headers 4 腿 / Meta 诊断。
- **Plan 06 Overview/Models/Config**：**Overview** 精简健康 + Grafana 入口；**Models** 目录表 + raw JSON 切换；**Config** 结构化 JSON 编辑器 + 保存。
- **Plan 05 Sessions+Agent**：**后端新增**（只读）`GET /history/api/sessions`（entries_v2 GROUP BY session_id 聚合）+ `/entries?agentId=&mainAgentOnly=` 过滤接线；前端 **Sessions** 列表（聚合行：#req/#agents/tokens/时长/状态）+ **Session 详情**（agent 泳道时间线：main + subagent 按 agentId 分泳道，请求块深链 `/requests/:id`；subagent 标签为不透明 agentId，header 无种类名）。
- **Plan 03b 详情 diff**：详情段加 **diff**（DESIGN §4.3 最具诊断价值部分）。移植 `ui/src/utils/block-diff.ts` 算法核（jsdiff 词/行 diff + 按 role/帧类型领域 aligner，纯逻辑 + bun 测试）→ 渲染原语 `InlineParts`/`DiffRow`（kind→色钉死）。**新增 Response 段**（sub-rail 五项 Convo/Stages/Response/Headers/Meta）承载 **`SseFrameDiff`**（upstream vs forwarded 帧按类型对齐,oversized/MAX_ROWS cap）+ upstream/forwarded 响应展示；**`MessageDiffView`**（inbound↔effective 消息级改写 diff，Stages 顶部切换）；**Stages 请求三腿容器查询并排**（`@container`,窄→单列/宽→三列）；**`SystemMessage` 独立支路**（original↔rewritten↔diff 三态，`UnifiedLineDiff` 首个消费 `diffLinesRich`，React 自动转义无 HTML 注入）；**tool_result 内嵌 content-block 数组递归**走 ContentRenderer。**零后端改动**。
- **Plan 08 详情页分离 + TOC 树导航**（**零后端改动**）：**① 两路由全屏分离**——`/requests` = 列表全屏（Live 泳道 + History，点行/深链导航）、`/requests/:id` = 详情全屏（返回钮）；LiveLane 行补导航、HistoryList 粘滞高亮改读 list-store `selectedId`；退役 `RequestsWorkbench`（反转 DESIGN §4 主从一体，用户定 2026-06-24）。**② Convo/Stages 左侧 TOC 树**——`buildMessageTocNodes` 纯 builder 产消息→块树（锚点契约 `${prefix}-msg-${i}/-blk-${j}`，blocks 源 `normalizeToContentBlocks` 与渲染对齐）+ `DetailTocTree`（可折叠递归、块默认折叠、activeAnchor 高亮）；`anchorPrefix` 贯穿 ConversationView→MessageBlock→ContentRenderer 渲染锚点（未锚定调用方 DOM 不变）；`useAnchorScroll`（scrollIntoView + 瞬时 `.toc-flash` 高亮 + timeout 清理）；Convo `[TOC sticky 左 | 内容右]`、Stages `leg→message→block` 树（leg 包裹 `id=stage-${key}`，`[TOC | @container 三腿并排]`）。
- **nav 5 项全是真页**：Overview / Requests / Sessions / Models / Config。catch-all 仅兜真未知路径。
- **Plan 09 详情/列表打磨**：**① 列表行丰富统计**——RequestRow（discriminated union `entry`/`live`）显 time/endpoint/model/(Nx)·↑in↓out/cacheRead·↑req↓resp 字节/×attempt/dur/preview，非完成行 failureSummary（红），慢/缓存未命中琥珀异常高亮；移植 `activity-row` 领域助手。**② 文本块行号 gutter**（`LineNumberedText`+可复用 `LineGutter`，>500 行截断，React 自动转义）。**③ JSON/代码块语法高亮**——**`shiki`**（VS Code TextMate 语法+主题、25 语言、异步单例 + JS 正则引擎 bun 原生零 node-gyp）`codeToHast`→hast→扁平 token→按行拆→`LineGutter`（行号+高亮一体，**无 dangerouslySetInnerHTML**），自写 `terminal-amber` 主题，应用 ToolUse/Generic/ToolResult JSON。**④ TOC 树美化**——树引导线/kind 色/hover/左 accent 条；**用户反馈精修**：`+/-` 折叠、层级序号、精简标签（role:句/text:句/类型领衔）、title 悬浮、**`TocSidebar` 可拖拽调宽**（deferred-apply 预览线，拖拽期零 content 重排消除大数据卡顿；localStorage 持久；StrictMode-safe）。**⑤ 后端字节/成本**——entries_v2 持久化 `request_bytes`/`response_bytes`/`multiplier`（migrate ALTER + CREATE，写时 multiplier 经 ctx billing、字节 serialize 派生），EntrySummary 投影（解锁 Overview/Sessions cost 留位）。
- **详情视图用户反馈迭代**（**零后端改动**）：① **system prompt 文本块加行号**（`SystemBlocksBody` 走 `LineNumberedText`，diff 模式不变）；② **Convo 看原始客户端请求 body**——`Rendered`/`Raw` 切换，Raw 显 `entry.inboundRequest` 全量 JSON（CodeBlock shiki+行号，含 tools/params），raw 时隐 TOC+渲染；③ **Stages 改 TOC 驱动单腿显示**（取代 Plan 08 的 `@container 三腿并排`）——TOC leg 点击选腿、message 点击选腿+延迟滚动；每腿 `Rendered`/`Raw` 切换（Inbound raw=客户端请求 body）；**重写区分** `deriveRewriteMarks`（走 inbound→effective `diffMessageList` 标 modified/added/removed，经 `ConversationView.marks`→`MessageBlock.mark` 渲徽+左 accent，Convo 不传 marks 不受影响；纯逻辑抽 `lib/diff/rewrite-marks.ts` + bun 单测）。
- **列表行用户反馈精修**：**RequestRow**——① `(Nx)` 倍率徽仅在 `multiplier` 定义且 `≠1` 时显示（标准倍率是噪声）；② 耗时改 `formatElapsed` `+123.4s`（恒秒、不转 `2m3.4s` 分钟形），移到 `HH:MM:SS` 时间紧后，删行尾旧耗时列（`formatDuration` 不变，LiveRow 仍用）；③ 字节 `↑req↓resp` 移到 token 前，token 合并为单格 `↑in+Nc ↓out`（cached 并入 up 方向、无 cache read 时略 `+Nc`），删独立 cacheRead 列。新列序：state·time·+dur·model·(Nx≠1)·endpoint·bytes·tokens·×attempt·preview。**SessionRow**——加状态块（`failed===0` 绿/`>0` 红）+ 末条消息摘要 `s.preview`（flex-1 truncate、空显 `—`）。**后端配套**（`src/lib/history/`）：`extractPreviewText` 改忠实摘要**最后一条消息**（`role:tool`→`[tool_result:id]` 优先于裸 string content、string→text、array→text>tool_use>tool_result、assistant tool_calls→`[tool_call:names]`，末条空才向前扫描），取代旧的向后搜寻最后一条 user 消息；`SessionSummary` 加 `preview` 字段（每 session 最新终态 entry 的 `preview_text`，`querySessionLastPreview` 子查询）。
- **列表行二轮精修 + agent 泳道重设计**：① **截断单元格 native tooltip**——RequestRow（model/endpoint/bytes/tokens/preview·failure）+ SessionRow（sessionId/preview）加 `title=完整未截断值`（preview title 用完整 `entry.previewText` 而非 120 字 `truncPreview`），无列头时悬浮看全文；② **session 详情 agent 泳道去连续绿块**——`AgentLane` 原把每 entry 渲成 `h-3.5 w-6` 连续色块，改为**每 agent 一个表头**（name + `N req · ↑in↓out · failed` 聚合）紧跟其**请求列表**（复用 `RequestRow` 密集行，onClick 深链 `/requests/:id`），读起来像按 agent 分段的请求列表；③ **后端 preview_text 一次性 backfill**——`extractPreviewText` 逻辑变更后已存 entry 的 denormalized `preview_text` 列陈旧（读路径不重算），`backfillPreviewInBackground`（`sqlite/preview-backfill.ts`，`PRAGMA user_version` 守卫一次性重算所有行、仅变更时 UPDATE 触发 FTS 重同步），重启即把历史条目的旧式预览刷新为「忠实末条消息」。**注**：初版同步跑在 `openDatabase` 里、且用 `assembleFullEntry` 解压整条生命周期（含最大的 sse_events），在 4.2G 库上把启动卡了 3m53s——已改为**非阻塞后台**（监听后 fire-and-forget、50/批 `await sleep(0)` 让出 event loop）+ **inbound-only**（只解压 `inbound_request`/`request_group` 容器帧，等价性测试钉死 ≡ 全路径）。
- 后续：请求内搜索 → Plan 04；视觉打磨+响应式 → Plan 07；Config 结构化分组表单 → Plan 06b；Session client/cost 列 + 工作台 group-by + subagent 种类名 → Plan 05b；TOC scroll-spy / Response·Headers·Meta 段 TOC → 待后续。见 `docs/plans/`。

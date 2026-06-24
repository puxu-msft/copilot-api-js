# ui-v4 重构交接提示词（贴给新会话）

> 把下面整段贴给新的 Claude 会话即可接力 ui-v4 重构。本文是权威交接，随进展更新。

---

我在继续 `copilot-api`（一个 LLM 代理）内置请求检视台的 **React 全面重写**，代号 **ui-v4**，位于 `/home/xp/src/copilot-api-js/ui-v4/`（与旧的 Vue 版 `ui/` 并行共存，后端 `/ui-v4` 路由服务）。

## 先读这些（按序）

1. **设计规格（权威）**：`ui-v4/docs/DESIGN.md` —— IA、详情 C 布局、内容管线、Sessions/Agent、两级搜索、视觉方向、§12 review 追溯。
2. **现状**：`ui-v4/README.md` —— 已落地态 + 后续路线图。
3. **实现计划**：`ui-v4/docs/plans/`（已全部执行完）：`01-foundation` / `02-workbench` / `03-detail-content` / `05-sessions-agent` / `06-overview-models-config`。
4. **项目原则**：根 `CLAUDE.md` + `docs/DESIGN.md`（后端架构、bun-first、测试组织）。
5. **设计草稿/决策**：`ui-v4/docs/decisions.md`（已被 DESIGN.md supersede）。

## 已完成（Plan 01/02/03/03b/05/06/08/09，nav 5 项全是真页 + 详情 diff + 两路由分离 + TOC 树 + 行统计/行号/高亮/字节·成本）

- **栈**：React 18 + TS strict + Vite 7 + **Tailwind v4**（`@tailwindcss/vite`，CSS-first `@theme`，主题 token 在 `src/styles/theme.css`）+ **TanStack Query**（server-state）+ **Zustand**（client-state）+ React Router 6 **hash 路由** + 移植的类式 **WSClient**（模块单例 + 引用计数 + latest-ref，规避 StrictMode churn）。视觉 **工业风 Terminal Amber**（暖近黑 + amber、锐角 rounded:0、左对齐拒绝居中、hairline、IBM Plex Mono、green/red/amber 信号色）。
- **Plan 01**：应用壳层（NavRail/TopBar/AppShell）+ WS 状态 + 主题切换 + 路由 errorElement/catch-all。
- **Plan 02**：Requests **主从工作台**——Live 泳道（WS `active_request_changed`）+ History 游标列表（缓冲横幅 + tail 暂停/恢复 + 选中粘滞）+ 深链 `/requests/:id` 按 ID 独立 fetch。
- **Plan 03**：详情 **C 布局**（DiagnosticBar + sticky sub-rail 懒加载段）+ **双格式内容渲染管线**（`normalizeToContentBlocks` 归一化 Anthropic/OpenAI → 块组件各包 ErrorBoundary → ContentRenderer 分发）+ Convo/Stages(7 腿)/Headers(4 腿)/Meta 段（**展示，无 diff**）。
- **Plan 06**：Overview（精简健康 + Grafana 入口）/ Models（表 + raw 切换）/ Config（结构化 JSON 编辑器 + 保存）。**无后端改动**。
- **Plan 05**：Sessions+Agent —— **后端新增**只读 `GET /history/api/sessions`（GROUP BY session_id 聚合）+ `/entries?agentId=&mainAgentOnly=` 接线；前端 Sessions 列表 + Session 详情（agent 泳道时间线，按 agentId 分 main/subagent，块深链）。
- **Plan 03b**：详情 **diff**（**无后端改动**）——移植 `block-diff.ts` 算法核（jsdiff 词/行 diff + role/帧类型领域 aligner）→ `InlineParts`/`DiffRow` 渲染原语；**新增 Response 段**（sub-rail 五项）承载 `SseFrameDiff`（upstream↔forwarded 帧对齐，cap 守卫）+ 响应展示；`MessageDiffView`（inbound↔effective 消息 diff，Stages 顶部切换）；Stages 请求三腿 **容器查询并排**（`@container` 窄→单列/宽→三列）；`SystemMessage` 独立支路（original↔rewritten↔diff，`UnifiedLineDiff` 首消费 `diffLinesRich`，自动转义）；tool_result 内嵌块递归走 ContentRenderer。**注**：DESIGN §9 提及的 "formatters.ts 标签过滤" 经实证不存在（详情应展示完整 system prompt），故未做。
- **Plan 08**：详情页 **两路由全屏分离**（**无后端改动**）——`/requests` 列表全屏 + `/requests/:id` 详情全屏（返回钮）、点行/深链导航、退役 `RequestsWorkbench`（反转 DESIGN §4 主从一体，用户定 2026-06-24）；**Convo/Stages 左侧 TOC 树**——`buildMessageTocNodes` builder（锚点契约 `${prefix}-msg-${i}/-blk-${j}`，blocks 源 normalizeToContentBlocks）+ `DetailTocTree`（可折叠递归、默认折叠块、activeAnchor 高亮）+ `anchorPrefix` 贯穿渲染锚点（未锚定调用方 DOM 不变）+ `useAnchorScroll`（scrollIntoView + `.toc-flash` 瞬时高亮）；Convo `[TOC|内容]`、Stages `leg→message→block` 树 `[TOC|@container 三腿]`。
- **Plan 09**：详情/列表**打磨**——① 列表行丰富统计（RequestRow `entry`/`live` union：time/endpoint/model/(Nx)·↑in↓out·cacheRead·↑req↓resp·×attempt·dur·preview/failureSummary·异常高亮，移植 `activity-row` 助手）；② 文本块行号 gutter（`LineNumberedText`+`LineGutter`，>500 截断）；③ JSON/代码块语法高亮——**`shiki`**（VS Code TextMate 语法+主题、25 语言、异步单例 + JS 引擎 bun 原生；`codeToHast`→hast→React `<span style>`，**无 dangerouslySetInnerHTML**，自写 `terminal-amber` 主题；早先 lowlight/highlight.js 已被换掉，用户要"更强大不倒退"）；④ TOC 树美化（树线/kind 色/hover/左 accent 条）+ **用户反馈精修**（`+/-` 折叠、层级序号、精简标签、title 悬浮、`TocSidebar` 可拖拽调宽—deferred-apply 预览线消除大数据卡顿、StrictMode-safe）；⑤ **后端**字节/成本（entries_v2 加 `request_bytes`/`response_bytes`/`multiplier`，写时 multiplier 经 ctx billing、字节 serialize 派生，EntrySummary 投影，解锁 cost 留位）。⚠ 本任务执行期 implementer 误跑 `git stash` 卷走并发会话工作→已完整恢复（diff 验证、零丢失），后续 subagent prompt 加「绝对禁 git」红线。
- **详情视图用户反馈迭代**（零后端）：① system prompt 文本块加行号（`LineNumberedText`，diff 模式不变）；② Convo `Rendered`/`Raw` 切换看原始客户端请求 body（`entry.inboundRequest` 全量 JSON，CodeBlock，raw 时隐 TOC+渲染）；③ Stages 改 **TOC 驱动单腿显示**（取代 Plan 08 的 `@container 三腿`）——leg 点击选腿、message 点击选腿+延迟滚动；每腿 `Rendered`/`Raw`（Inbound raw=客户端 body）；**重写区分** `deriveRewriteMarks`（inbound→effective `diffMessageList` → modified/added/removed marks → `ConversationView.marks`→`MessageBlock.mark` 徽+左 accent，Convo 不传 marks 不受影响；抽 `lib/diff/rewrite-marks.ts`+bun 单测）。
- 全局**字号上调一档**（8→11/9→12/10→13/11→14，基准 13→15）+ 配套加宽固定容器消除溢出。
- **列表行用户反馈精修**（前端 `RequestRow`/`SessionRow`/`format` + 后端 `src/lib/history/`）：**RequestRow** ① `(Nx)` 倍率徽仅 `multiplier` 定义且 `≠1` 显示；② 耗时 `formatElapsed` `+123.4s`（恒秒不转分钟），移到时间紧后、删行尾旧列（`formatDuration` 不变）；③ 字节移到 token 前、token 合并单格 `↑in+Nc ↓out`（cached 并入 up、无 cache 略 `+Nc`）、删独立 cacheRead 列。**SessionRow** 加状态块（绿/红 by failed）+ 末条消息摘要 `s.preview`。**后端**：`extractPreviewText` 改忠实摘要**最后一条消息**（`role:tool` 优先、text>tool_use>tool_result、空才向前扫）取代向后搜 user；`SessionSummary` 加 `preview`（`querySessionLastPreview` 取每 session 最新终态 entry preview_text）。
- **列表行二轮精修 + agent 泳道重设计**（前端 `RequestRow`/`SessionRow`/`AgentLane`/`SessionDetailPage` + 后端 `sqlite/preview-backfill.ts`/`connection.ts`）：① 截断单元格 native `title` tooltip（RequestRow model/endpoint/bytes/tokens/preview·failure + SessionRow sessionId/preview，用完整未截断值），无列头时悬浮看全文；② session 详情 **agent 泳道去连续绿块**——`AgentLane` 改每 agent 一个表头（name + `N req·↑in↓out·failed`）紧跟其请求列表（复用 `RequestRow` 深链 `/requests/:id`）；③ **后端 `preview_text` 一次性 backfill**——`maybeBackfillPreview`（`PRAGMA user_version` 守卫、200-id 分批 `assembleFullEntry`+重算、仅变更 UPDATE 触发 FTS 重同步、整体+逐 entry try/catch 绝不阻断 startup），重启即把已存历史条目的旧式预览刷新为「忠实末条消息」（denormalized `preview_text` 列原本读路径不重算 → 陈旧）。

## 下一步（增强，挑一个；非缺页）—— **plan 文档已写好，直接执行**

- **Plan 04**（`plans/2026-06-23-04-in-request-search.md`）：**请求内搜索** —— 搜底层数据模型、跨段命中计数、n/N、regex/大小写/整词 + **可控 JSON 渲染器**（CodeMirror/自建树）。⚠ 全新高风险工程，含技术尖刺。
- **Plan 07**（`plans/2026-06-23-07-polish-responsive.md`）：**视觉打磨 + 响应式**（三断点）+ 命令面板(⌘K) + 全局搜索实装 + shadcn 基底 + 补 react-hooks eslint。
- **Plan 06b**（`plans/2026-06-23-06b-config-form.md`）：Config **结构化分组表单**（section 导航 + 字段控件 + 校验，移植旧 UI config 组件）。
- **Plan 05b**（`plans/2026-06-23-05b-session-enrich.md`）：Session **client/cost 列**（依赖成本轮：entries_v2 加 multiplier/client 列）+ 工作台 **group-by** + subagent **种类名**推断。
- **tooling 待办**：本仓库 eslint 无 `eslint-plugin-react-hooks` → ui-v4 hooks 拿不到 rules-of-hooks/exhaustive-deps 校验（已并入 Plan 07 Task 6）。

> 这些 plan 文档是**计划级**（goal/architecture/数据契约 deep-read 指针/文件结构/任务分解 + 锚点/验收/暂缓）。执行时若某任务需要，先 deep-read 后端真实类型把该任务展开成 bite-sized（带真实代码），再派 subagent——参照已执行的 01/02/03/05/06 的 bite-sized 详细度。

## 工作方法（务必遵守）

**用 `superpowers:subagent-driven-development`**：写计划 → 每任务派 implementer subagent（贴**完整任务文本** + 上下文，别让它读计划文件）→ spec 合规 review → 代码质量 review → 标完成 → 全部完成后整体 review。implementer/reviewer 一律用 **general-purpose**（全量工具）。**每个 subagent prompt 必须显式写明裁判轴**：长远正确 + 范围内完整，**不是** ROI/YAGNI/工期/改动量（subagent 默认价值观与本项目冲突）。大计划先写 `ui-v4/docs/plans/NN-xxx.md`（bite-sized TDD，真实代码/命令/期望）。

## 项目硬性约定（最容易踩）

- **bun-first**：所有命令走 `bun`（**不是 npm**）。验证：`bun run --filter copilot-api-ui-v4 {typecheck,test,test:bun,test:vitest,build}`；后端 `bun run test:backend` / `bun run typecheck`。审计 `find ui-v4/node_modules node_modules -name binding.gyp` 应空（零 node-gyp；Tailwind v4 的 oxide/lightningcss `.node` 是构建工具豁免）。
- **代码风格**：**不用分号**；三元运算符放行首；严格 TS **避免 any**；`eslint --fix` 格式化（不是 prettier --write）。
- **Git 细粒度暂存**：**只** `git add -- <精确路径>`，**绝不** `-A`/`.`/`-am`；提交前 `git diff --cached --stat` 复核仅本次改动。Conventional commits，**不加任何 Claude/AI 署名**。
- **⚠ 并发会话**：另有 agent 在改 `src/lib/request-telemetry.ts` + `src/lib/metrics-exposition.ts`（未提交、typecheck 不过、约 4 个后端测试失败）。**这些不是你的**——区分清楚，**绝不**把它们裹进你的提交。前端 typecheck 隔离、不受影响。
- **deep-read 后端真实类型再写前端**（曾多次踩坑）：`EntrySummary` 用 `state`（非 status）/`responseModel`/`requestModel`（非 model）/`durationMs`；`HistoryEntry` **无顶层 usage**（在 `outboundResponse.usage`），endpoint 是 `EndpointType` 枚举；legs = inboundRequest/effectiveRequest(RequestLegData)/outboundRequest/outboundResponse(OutboundResponseData)/inboundResponse(ForwardedResponse)，httpHeaders 四腿 `Record<string,string>`；ContentBlock 变体是 Anthropic SDK param 别名；`/api/status` memory **无 heap**；`/api/config/yaml` 返**结构化 JSON 非 raw YAML**；`/api/models` 扩展字段在嵌套 capabilities。
- **类型 single-source**：后端定义、前端经 `~backend/lib/history/store` re-export，**不在前端重定义**。
- **测试隔离**：`.it`/`.http` 用 `useIsolatedRuntime()`（history `:memory:`），**绝不碰真实 $HOME/DB**。两 runner 按后缀互斥：`*.bun.test.ts`（bun，纯逻辑）/ `*.vitest.test.tsx`（vitest+jsdom，组件）；`test:bun` = `bun test .bun.test`。
- **不自动起服务器**：绝不 `bun run dev`/`start`；服务器验证交用户。用户验证：终端 1 `bun run dev`（后端）+ 终端 2 `bun run dev:ui-v4`（前端 vite，HMR），开 vite 打印的 URL；报错让用户 `bun run dev:ui-v4 2>&1 | tee /tmp/ui-v4-dev.log` 抓全日志、你 Read `/tmp/ui-v4-dev.log`。

## 别名

`@/*`→`ui-v4/src/*`；`~backend/*` 与 `~/*`→`../src/*`（后端源码，`~/*` 供后端源码内部自引用）。

## 起手式

先读 DESIGN.md + README.md + 你要做的那个 plan（若已存在）；没有就先 brainstorm/写 plan。确认要做哪个增强后，按 subagent-driven 执行。每个 subagent prompt 带上「项目硬性约定」里相关条目 + 显式裁判轴。

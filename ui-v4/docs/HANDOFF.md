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

## 已完成（Plan 01/02/03/05/06，nav 5 项全是真页）

- **栈**：React 18 + TS strict + Vite 7 + **Tailwind v4**（`@tailwindcss/vite`，CSS-first `@theme`，主题 token 在 `src/styles/theme.css`）+ **TanStack Query**（server-state）+ **Zustand**（client-state）+ React Router 6 **hash 路由** + 移植的类式 **WSClient**（模块单例 + 引用计数 + latest-ref，规避 StrictMode churn）。视觉 **工业风 Terminal Amber**（暖近黑 + amber、锐角 rounded:0、左对齐拒绝居中、hairline、IBM Plex Mono、green/red/amber 信号色）。
- **Plan 01**：应用壳层（NavRail/TopBar/AppShell）+ WS 状态 + 主题切换 + 路由 errorElement/catch-all。
- **Plan 02**：Requests **主从工作台**——Live 泳道（WS `active_request_changed`）+ History 游标列表（缓冲横幅 + tail 暂停/恢复 + 选中粘滞）+ 深链 `/requests/:id` 按 ID 独立 fetch。
- **Plan 03**：详情 **C 布局**（DiagnosticBar + sticky sub-rail 懒加载段）+ **双格式内容渲染管线**（`normalizeToContentBlocks` 归一化 Anthropic/OpenAI → 块组件各包 ErrorBoundary → ContentRenderer 分发）+ Convo/Stages(7 腿)/Headers(4 腿)/Meta 段（**展示，无 diff**）。
- **Plan 06**：Overview（精简健康 + Grafana 入口）/ Models（表 + raw 切换）/ Config（结构化 JSON 编辑器 + 保存）。**无后端改动**。
- **Plan 05**：Sessions+Agent —— **后端新增**只读 `GET /history/api/sessions`（GROUP BY session_id 聚合）+ `/entries?agentId=&mainAgentOnly=` 接线；前端 Sessions 列表 + Session 详情（agent 泳道时间线，按 agentId 分 main/subagent，块深链）。
- 全局**字号上调一档**（8→11/9→12/10→13/11→14，基准 13→15）+ 配套加宽固定容器消除溢出。

## 下一步（增强，挑一个；非缺页）

- **Plan 03b**：详情 **diff** —— SSE 帧 diff（forwarded vs upstream）、消息级 inbound↔effective rewrite diff、stages 并排对比。**用 jsdiff**（移植旧 `ui/src/utils/block-diff.ts`：jsdiff 做叶子词/行 diff + 自建按 role/帧类型领域对齐）；SystemMessage 独立支路 + tool_result 内嵌块递归也归这里。
- **Plan 04**：**请求内搜索** —— 搜底层数据模型（非 DOM）、跨段命中计数 badge、n/N 导航、regex/大小写/整词；**JSON 段需可控渲染器**（CodeMirror 6 或自建虚拟化树，因 @uiw/react-json-view 无法被外部驱动）。详情见 DESIGN.md §6。
- **Plan 07**：视觉打磨 + **响应式退化**（spec §8：≥1200 三栏 / 768-1200 图标 rail / <768 列表-详情全屏切换 + sub-rail 转横向标签）+ 命令面板(⌘K) + 全局搜索实装（后端有 trigram FTS5）。
- **Plan 06b**：Config 结构化分组表单（左 section 导航 + 字段控件 + 校验，spec §7）。
- **Plan 05b**：Session client/cost 列（需后端 entries_v2 加 multiplier/client 列 + 写路径，成本持久化 spec 已定暂缓）+ 工作台 Group-by(None/Session/Agent) + subagent 种类名（从 Task payload `subagent_type` 推断）。
- **tooling 待办**：本仓库 eslint 无 `eslint-plugin-react-hooks` → ui-v4 hooks 拿不到 rules-of-hooks/exhaustive-deps 校验，建议补。

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

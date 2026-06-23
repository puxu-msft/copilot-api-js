# ui-v4 设计规格（spec）

> copilot-api 请求历史查看器前端的 React 全面重构。本文是 brainstorm 阶段定稿的**权威设计规格**。chronological 决策草稿见同目录 [decisions.md](decisions.md)（已被本文 supersede，仅留档）。
>
> 状态：设计定稿、待用户复审 → 转 implementation plan。日期：2026-06-23。

## 1. 目标与定位

把现有 `ui/`（Vue 3 + Vuetify 4，113 文件 / ~15.5k 行，功能 oracle）**重新构想信息架构**，用 React 重写到 `./ui-v4`。核心理念：从"请求历史浏览器"升级为"**实时 LLM 流量检视台**"（DevTools/Network-inspector 范式）。

- **范围**：IA / 布局 / 交互可重新设计；后端契约与"双格式内容渲染"领域核心必须忠实保留。
- **共存**：与 `ui/` 并行，挂新路径；达对等后再替换、退役旧 UI。

### 非目标

- 不重造完整 metrics dashboard（深度时间序列/维度分析交 Grafana，消费已有 `/metrics`）。
- 不投入精细移动端打磨（desktop-first，窄屏仅"能用不崩"）。
- 不引入第三套搜索 UI（只有全局 + 请求内两级）。

## 2. 技术栈

| 关注点 | 选型 |
|---|---|
| 框架 | React + TypeScript（strict） |
| UI 组件 | **shadcn/ui**（Radix Primitives headless + Tailwind，组件 copy-paste 进仓库） |
| 构建 | Vite + Tailwind；bun-first（全栈 Bun 原生、无 node-gyp） |
| server-state | **TanStack Query**（缓存/SWR/失效），WS 事件喂 Query cache |
| client-state | **Zustand**（UI 偏好/过滤/tail 状态等） |
| 实时 | 移植现有类式 **WSClient**（auto-reconnect 指数退避 + topic 订阅） |
| JSON 查看器 | **@uiw/react-json-view**（主题化成 amber 工业调） |
| diff | **jsdiff**（叶子文本/词 diff）+ 自建按 role/帧类型领域对齐（逐字移植 `block-diff.ts`） |
| 消息文本 | **纯文本 + 搜索高亮**默认，**逐块「原文 ↔ markdown 预览」可切换**（markdown 用 react-markdown + rehype，按需加载） |
| 测试 | 镜像现有双系统：`bun test`（纯逻辑）+ Vitest + React Testing Library（组件，jsdom）+ Playwright（e2e-ui） |

### Workspace / 构建集成

- ui-v4 = 新 bun workspace 成员（根 `workspaces:["ui","ui-v4"]`，单一根 `bun.lock`）。
- 自有 `package.json`（FE 依赖与脚本）；别名 `@/*`→`ui-v4/src/*`、`~backend/*`→`../src/*`。
- 后端**新增 `/ui-v4` 静态路由**挂 `ui-v4/dist`（与现有 `/ui` 并存，可部署并行构建）；开发期用 `--external-ui-url` 指向 vite dev。

### 后端契约

HTTP `/history/api/*` + 根 `/api/*`，WS，类型经 `~backend/*` re-export（single-source-of-truth）。**新增只读端点**见 §7。

## 3. 信息架构

左 rail 导航：**Overview / Requests / Sessions / Models / Config**。顶栏全局 chrome：全局搜索 + ⌘K 命令面板 + WS 连接状态 + 主题切换（light/dark/system）。rail 底部常驻 upstream 健康 + pid + 版本。

- "Overview" 取代旧 Dashboard，"Requests" 取代旧 Activity。
- 全局元素全做：命令面板、全局搜索、WS+upstream 状态、主题切换。

## 4. Requests 工作台（核心）

主从一体（DevTools/Network 范式）：左侧实时列表 + 右侧就地详情，**列表与详情不再是两个路由**。

### 4.1 深链

- 选中请求 ID 编码进 URL：`/requests/:id` = 唯一深链（复制 / 新标签页 / 书签），与旧 `/activity/:id` 等价。
- 过滤/搜索序列化进 query（`?model=opus&q=...`）。
- **详情按 ID 独立 `fetchEntry(id)`**，不依赖该行是否在当前已加载列表窗口 → 被实时流滚出也能完整深链显示。

### 4.2 列表稳定性（解决「在飞破坏分页 / 新请求涌入致选不中」）

根因：旧版把「在飞请求（WS active 事件、内存、无游标锚点）」与「已完成条目（SQLite 游标分页）」混进一个列表。修复 = 尊重后端已有的数据分离，前端分两条数据源。

1. **Live 泳道**：独立、常驻、固定高度、内部独立滚动；只放在飞请求；始终显示（空时空态）、不可折叠、不因空消失；完成后离开本泳道进 History；**永不参与游标分页**。
2. **缓冲 + "N 条新"横幅**：新完成条目先缓冲，交互时列表冻结不跳；点横幅/滚到顶才合入。
3. **选中按 ID 粘滞**：选中是 ID 不是位置；列表重排/涌入都不偷走目标。
4. **tail**：默认 tail-on；选中某行**或**向上滚动 → 自动切 paused（列表冻结）；一键 ▶ 恢复。

### 4.3 详情面板（C · 混合 sticky sub-rail 分段）

- 顶部诊断摘要条常驻（status / model / ↑bytes / 时长 / attempts / tokens / cost）。
- 左侧 sticky 迷你 rail 跳转分段：**Convo / Stages / Headers / SSE / Attempts / Meta**，各段懒加载 + 独立滚动（解决「DetailPanel 过大」债）。
- **Stages 段单屏并排** Inbound│Effective│Wire 直接对比（免来回切标签）——保留 v4 的 7 阶段「腿」模型：Inbound / Effective / Wire(per-attempt) / Upstream(raw sse) / Forwarded / Meta / Attempts。
- 窄屏退化成横向标签式（见 §8）。
- 待定子项：阶段间 diff 默认并排 vs 按需开（取决于 diff 高频程度）。

## 5. Sessions + Agent

数据模型（实证 `src/lib/history/sessions.ts`）：

- `sessionId` ← header `x-claude-code-session-id`（每会话稳定 UUID）。
- `agentId` ← header `x-claude-code-agent-id`（每 subagent 一个**不透明 id**；main agent 不发此 header，undefined = main）。
- **header 不含 subagent 种类名**；语义名仅能从 payload（Task `subagent_type`）尽力推断 → 后续增强、非 v1 承诺。
- `/entries` **已支持** `?sessionId=` 与 `?agentId=` 过滤。

设计：

- 新增顶级 **Sessions** 页：session 列表，每行聚合 client / #req / #agents / tokens / cost / 时长 / 状态分布 sparkline。
- **Session 详情**：agent 树 + 请求时间线（行=agent[main + subagents]，块=请求，颜色=结果，点块→打开 C 详情）。可按 agent 折叠/筛选；整 session 一键删除（已有 `deleteSession` + `DELETE /api/sessions/:id`）。
- **按 agent 查看 requests**：Requests 工作台加「Group by: None / Session / Agent」开关 + agentId 过滤（后端过滤已就绪）。是否再升格独立 Agents 顶级页 = 视实现时需要（默认以分组/过滤满足）。

## 6. 两级搜索

- **全局搜索**（顶栏，⌘K 或点击）：跨历史**定位**请求，后端 trigram FTS5 子串搜索。
- **请求内搜索**（详情内，聚焦详情时 Ctrl/Cmd-F，Esc 关）：限定当前请求。
  - **作用于底层数据模型**（全段源数据），非已渲染 DOM。
  - 折叠/未懒加载段的匹配照常计数；sub-rail 每段显示命中数 badge；跳转（n/N、↑↓）时自动展开/加载该段并定位，当前匹配高亮加深。
  - **全功能**：regex / 大小写(Aa) / 整词 + 匹配总数 + 上/下一处导航。
- 只做单请求内搜索；session 级用「全局搜索 + sessionId 过滤」覆盖。

## 7. 其他页面

### Overview（精简）

- **留**（实时/运维可执行/依赖代理自身状态）：In-flight 数 + 实时活动、Rate limiter 状态 + queue、Quota/token source/过期、Upstream/WS 健康、近期 outcomes 一瞥、Memory pressure。
- **→ Grafana**（消费 `/metrics`）：历史请求量/token/cost 趋势、跨窗口深度维度 breakdown。Overview 放"打开 Grafana ↗"入口。

### Models

目录表：基线 + 扩展字段（vendor / ctx / vision / tools / reasoning / family）；工具栏过滤(vendor/能力) + 搜索 + raw JSON 切换。

### Config

**默认进 raw YAML 页**（整体编辑），**可切回结构化分组表单**（与现有相反）。结构化表单：左侧 section 导航 + 字段控件 + 校验高亮；保存走 `PUT /api/config/yaml`。

### 新增后端 HTTP API（已同意，只读、改动小）

- `GET /history/api/sessions` —— **新增**：session 摘要聚合列表（client / req 数 / agent 数 / token / cost / 时间跨度 / 状态分布），支持分页/排序。
- （可选）`GET /history/api/agents` —— 跨 session agent 运行聚合，仅当决定做独立 Agents 顶级页才需要。
- 既有 `/entries?sessionId=&agentId=` 过滤复用。

## 8. 视觉方向 —— 工业风（A · Terminal Amber）

- **调性**：延续现有暖色 amber 主色（dark `#d4a04a` / light `#a07020`）。
- **工业骨架**（全局贯彻）：左对齐一切 + eyebrow 大写小字标签 + hairline 网格线分隔（非浮动卡片堆 + 阴影）+ `rounded:0` 锐角 + 高信息密度 + IBM Plex Mono 承载数据 + green/red/amber 状态信号色。**拒绝居中标题 / 居中 hero**（砍掉旧版居中 hero）。
- 全套色彩/间距/字号/层级用 CSS-var 主题 token（Tailwind theme + CSS vars 单一来源）。
- 字体：正文/标签用中性 grotesque sans（具体字族待定），数据/代码 IBM Plex Mono。

### 响应式

- desktop-first，优雅退化、不崩。
- **≥1200px Wide**：三区全展开（rail + 列表 + C 详情竖 sub-rail + Stages 并排）。
- **768–1200px Medium**：rail 塌图标；列表+详情仍并排但更窄；Stages 视宽度并排↔单列。
- **<768px Narrow**：列表/详情不再并排——列表全宽，选中→全屏详情(‹返回)；C 竖 sub-rail 退横向标签；rail→底部 tab bar；深链直达详情全屏。

## 9. 内容渲染管线（移植）

```
DetailPanel → 段(Convo) → MessageBlock → ContentRenderer
  → TextBlock / ThinkingBlock / ToolUseBlock / ToolResultBlock / ImageBlock / DiffView / GenericBlock
```

- 纯逻辑层（`normalizeToContentBlocks()` 统一 Anthropic + OpenAI 双格式、类型守卫、`block-diff.ts` via jsdiff）**逐字移植成 TS**。
- Vue SFC 块组件 → React 组件，包在 React **ErrorBoundary**；ContentRenderer 按 `content.type` 纯分发。
- OpenAI `tool_calls` → 虚拟 `tool_use` 块（与现有一致）。

## 10. 已知债顺带修复

- HTTP 客户端错误处理统一（TanStack Query 统一失败/重试语义）。
- WSClient 重连改指数退避 + jitter（移植时落实）。
- DetailPanel 过大 → C 布局分段懒加载天然拆分。

## 11. 待定子项（实现期定夺，不阻塞）

- 详情 Stages 段间 diff：默认并排 vs 按需开。
- brand 区是否放实时全局指标（倾向极简，指标放 Overview）。
- 是否升格独立 Agents 顶级页（默认以分组/过滤满足）。
- grotesque sans 具体字族。

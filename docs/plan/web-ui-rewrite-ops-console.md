# Web UI 重写：Activity + Detail + Models（高密度运维控制台）

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：`ui/src/utils/status-meta.ts`（单一状态表）+ ui/src/components/{activity,detail}/；后端 history/types.ts
> **备注**：§0-§4 全落地；LifecycleStrip.vue 以 StageTabs.vue + stages/ 子组件实现，能力等价

## Context（为什么 / 目标）

后端近期获得丰富可观测数据——per-attempt 真实 wire body（Bug3）、`aborted`/`interrupted` 终态、stats 分列、process(pid/version)、24 字段 EntrySummary、`/api/models` raw 全能力——但前端**完全没展示**。同时现有 UI 有结构病：状态显示 bug（aborted/interrupted 退化成 pending）、丢失搜索框、`outboundRequest` 真实 wire body 无视图、多腿无对比、Models 宽松卡片、死代码堆积、预存类型错误。

**目标**：Vue 3 + Vuetify 内，以**信息架构/UX 重构 + 高密度运维控制台**重写 **Activity（独立页密集化）/ Detail（生命周期导航）/ Models（密集能力表）**。视觉基线 = 现有 `VDashboardPage.vue`（metric-tile/panel/quota-row/telemetry-row、uppercase eyebrow + `font-mono` tabular、`rounded:0`、surface-variant 发丝边框）。

**用户核心诉求：不怕改动大，怕不够好/不够长远/不够高效。** 故经两轮对抗评审，把"防漂移结构"与"高频循环效率"升为一等目标（见 §0 与 §1）。

## 已确认决策
- Activity：独立页密集化（点行 `/activity/:id`）。**list↔detail↔next 无摩擦循环升为核心**。
- Detail：生命周期导航 = **顶部水平 stage 条 + 保留左侧 TocTree 内容大纲**（分工不抢位）。
- Models：密集能力表。
- 纳入 4 个高价值增项：**后端 `state` 跨页筛选、Session 串联视图、SSE 逐帧对齐 diff、诊断增强（列表失败归因 chip + attempt 间消息 diff）**。

---

## §0 共享基础（防漂移结构 —— 长远性的核心）

> 当前 aborted/interrupted 漏跟的根因不是"忘改一处"，而是"加一态要改三处"。本节根治结构，否则下一轮新增态/能力/筛选维度会再漏。

1. **状态系统收敛为单一 `STATUS_META` 表**（新 `ui/src/utils/status-meta.ts`）：
   - `Record<RequestLifecycleState, { color, icon, label }>`，`RequestLifecycleState` 从 `~backend/lib/history/types` re-export（后端类型为全集权威）。
   - `statusColor`/`statusIcon`/`statusLabel`/pill-class 全部从此表派生；`activity-helpers.ts` 改为薄封装。删除 `StatusDot.vue` 第二套映射。
   - **穷尽性测试**（bun）：遍历 `RequestLifecycleState` 全集断言每个 key 在 STATUS_META 有条目 + TS exhaustiveness（`satisfies Record<RequestLifecycleState,…>`）。后端加第 8 态、前端漏配则测试立红。
2. **新增 `aborted`/`interrupted` 为一等 Vuetify theme 颜色**（`ui/src/plugins/vuetify.ts`），完整注册清单（防变体/简写漂移）：(a) `themes.{dark,light}.colors` 各加两色（aborted=紫系、interrupted=玫瑰/灰系，dark+light 两份）；(b) `variations.colors` 数组登记；(c) `variables.css` 简写变量映射 `--aborted`/`--interrupted`（+ muted）。图标：aborted=`mdi-link-off`、interrupted=`mdi-alert-octagon`。同步把 Dashboard "Request Outcomes" 面板的 warning/secondary 对齐到新 token（一致性）。
3. **filter 状态收敛**（`useHistoryData`）：N 个手写 setter → 单一 `filters` reactive 对象 + 泛型 `setFilter<K>(key,value)`。新增筛选维度 = 加一个字段，而非 state+setter+http+UI 四处。
4. **死代码删除须逐一实测 grep**（不信声称；warning auto-import 间接引用陷阱）：候选 `components/list/{RequestList,RequestItem,ListPagination}.vue`、`ui/StatusDot.vue`、`composables/useKeyboard.ts`、`charts/{StatsCharts,BarChart,HorizontalBar}.vue`、`ui/{ProgressBar,DataCard}.vue`、`dashboard/{DashboardActiveRequestsTable,DashboardStatusBar,DashboardOverviewPanel}.vue`、`message/DiffView.vue` + `diff2html` 依赖 + `diff2html-overrides.css`。每个删前 `grep -rn` 确认（含 components.d.ts）。
5. **修预存类型错误**：`MetaInfo.vue:56` `'orange'`→合法色；`useModelsCatalog.ts:31` `ref<[number,number]>`；调查 `ui/tsconfig.json` 补 `~/*`→`../src/*` 让 vue-tsc 解析 `~backend` 链路的后端内部 import。

---

## §1 Activity（独立页密集化 + 无摩擦循环）

### 1a. list↔detail↔next 无摩擦循环（核心，非增强）
- **`<keep-alive>`** 包 `/activity` 路由视图（`/activity/:id` 不缓存）：返回零重建、保住列表 DOM 与**内层 `.v-page-scroll` 滚动位置**（hash 路由 scrollBehavior 管不到内层容器，必须靠 keep-alive + `activated`）。
- **筛选 + cursor + 选中 id 进 URL query**（`/activity?status=failed&model=opus&cursor=…`）：刷新/分享/返回一致。store filters ↔ `route.query` 双向绑定。
- **详情页内 prev/next**（头部 ◀/▶ + `[12/337]`，接既有 `selectAdjacentEntry`，到页边界自动 `loadNext` 续接）+ **键盘 j/k/Enter/Esc**（复用孤儿 `useKeyboard` 或新轻量实现）。
- **详情默认滚到顶**（request/error 优先）；当前 `DetailPanel` 的 auto-scroll-to-bottom 改为显式"跳到响应"锚点。
- 修 `fetchEntries` 翻页副作用：列表翻页**不触发** `selectEntry`（当前每翻页白打一次 `fetchEntry`）。

### 1b. 密集列表
- 抽**单一 `ActivityRow.vue`**，消除 in-flight 表/history 表 ~80 行重复。两态差异用**声明式列定义**（列对象带 `showWhen?:(e)=>boolean`），不在组件内散 `v-if`。
- **搜索框**（防抖→`setFilter('search')`）+ 完整筛选栏：search/endpoint/**status(7 态)**/model/时间范围/session/**pid**。
- 列扩充（24 字段，当前仅 9）：status(7 态) · time · model · endpoint · stream · messages · duration · tokens(in/out **+ cache_read/creation**) · preview。
- **列表层失败归因 chip**：非 completed 行的 preview 列渲染结构化归因（`status` + 终态语义 + `attemptCount`/`currentStrategy`，如 `429·auto-truncate×3` / `aborted@stream` / `interrupted(pid 1234)`），让诊断 80% 在列表完成、少跳页。
- token/耗时**异常高亮**（duration 异常高、input 接近 limit、`cache_read=0` 缓存未命中）。
- 已激活筛选汇总条（可清除 chip）+ 骨架加载态 + 含"清空筛选"的空态。

### 1c. Session 串联视图
- Activity 支持**按 session 分组/折叠**或 session chip 钻入该会话请求序列（后端 `Session` 聚合 + `sessionId` 筛选已就绪）。诊断"这轮对话第 N 个请求开始崩"。

---

## §2 Detail（生命周期导航）

### 2a. 导航
- **顶部水平 stage 条**（新 `components/detail/LifecycleStrip.vue`）：inbound→effective→outbound(wire)→upstream resp→forwarded，每段标注是否有差异/被重写，点击聚焦/滚动。**保留左侧 TocTree** 作内容大纲（两者分工）。
- **硬约束**：LifecycleStrip **只做导航/锚点**，内容渲染**强制全部走** `SectionBlock→MessageBlock→ContentRenderer`。每个 stage = 一个 `SectionBlock` 实例，绝不自渲染（否则又造第三套并行管线——重蹈 VActivityPage 内联表覆辙）。
- **顶部固定"诊断摘要带"**（一屏可见、不需点）：状态徽章 + 终态语义（aborted/interrupted 原因）+ stop_reason + token(in/out/cache) + 耗时 + attempt 数 + pid/version。运维第一眼所需，不再藏在底部 Meta。

### 2b. 补齐缺口视图（后端有、前端零覆盖）
- `outboundRequest.payload` 真实上游 wire body（新 stage）。
- **per-attempt 下钻 = attempt 切换 tab**（不是层层点开）：`#1 #2 #3(final)`，默认显示**最终/失败那次**的 wire/response/effective（Bug3 数据）。去掉"仅 attempts>1 才显示"门槛（单次失败也有诊断价值）。

### 2b-diff. 分层 block-diff：外部库管叶子、自建管领域对齐（三轴共用核心）
> 删 `diff2html`（行级 diff + 整套 HTML/CSS 渲染器——渲染我们用主题组件自做，不需要）。**保留/装回 `diff`(jsdiff)** 作 L3 叶子引擎（成熟的行级 + 行内词/字级 diff，处理"行为单位 + 行内词级显著性"，手搓 LCS 劣化）。三个 diff 轴——改写轴(inbound→effective/outbound)、重试轴(attempt#1 vs #2)、转发轴(上游 sseEvents vs 转发帧)——共用一套核心，避免"三套 diff 漂移"。新 `ui/src/utils/block-diff.ts`（纯函数）+ 渲染组件。
- **L1 结构对齐器（自建）**：对齐 message 数组（index + role +（有则）id）→ added/removed/modified/unchanged。
- **L2 块对齐器（自建）**：modified message 内对齐 content blocks（type + 序号）→ 块级增删改。
- **L3 叶子 differ（用 jsdiff）**：变化的 text/json 块内，`diffLines` 取行级、对改动行组用 `diffWordsWithSpace` 取行内词级显著高亮；tool_use/JSON 用 `diffJson`/结构化 key diff。我们只消费 jsdiff 的 change 数组，**不引入 diff2html 的渲染/样式**。
- **L4 帧对齐器（自建）**（SSE）：按 `offsetMs` + 事件类型/序号对齐 → same/rewritten/dropped/added，高亮变化字段（如 signature）。帧内文本变化可下沉 L3。
- **渲染**：每侧复用 `ContentRenderer` + `ContentBlockWrapper`；行/词高亮走主题 token（`--success-muted` 加 / `--error-muted` 删）。把既有 `SideBySideView`（现仅"并排+判等"）升级为"对齐+高亮"。
- 单元测试（bun）：L1/L2/L4 对齐纯逻辑、L3 对 jsdiff 输出→主题 span 的映射、L4 帧对齐（offsetMs + 改写帧识别）。

### 2b-cont.
- **attempt 间消息 diff** 用 L1/L2（#1 vs #2 少发/多发哪些 message），直击 auto-truncate 调试。
- **SSE 上游 vs 客户端逐帧对齐 diff**（`components/detail/SseFrameDiff.vue` 用 L4），直击 shim/转发 bug。**不是**两个 JSON 数组左右铺。
- `entry.process`(pid/version) + `state` 的 aborted/interrupted 语义着色（MetaInfo，复用 §0 STATUS_META）。
- 默认折叠策略：诊断摘要带 + inbound 常开；wire/upstream/forwarded 默认折叠但**有差异时自动展开并打 diff 标记**。

### 2c. 复用与重构
- 复用：`ContentRenderer`/`ContentBlockWrapper`/`RawJsonModal`(左右分栏)/`SideBySideView`（**已被 MessageBlock/SystemMessage 用于"重写 diff"轴——复用其装配，不是启用闲置组件**）/`typeGuards`。
- 拆 `DetailPanel`(258 行) + 把 `MessageBlock`(431 行)的 diff 分支抽 `MessageDiffBlock`，避免继续膨胀。
- 切 entry 重置全局 detail filter（当前 Pinia 单例残留）。

---

## §3 Models（密集能力表）

- **替换卡片网格为密集可排序表**（telemetry-row 密度）。核心列常驻：id · vendor · context · max output · billing 倍率；能力（thinking/vision/tool_calls/parallel/structured）折成**一个紧凑能力图标矩阵单元格**（✓/✗/—，hover 详情），省 5 列、防窄屏挤爆。次要列可隐/横向滚动。
- **能力筛选改多选 AND + 值筛选**（effort/budget），非当前单选 feature——否则"找满足 N 个能力的模型"这个密集表核心用途做不到。
- **能力派生不在前端重写第三套**：提取共享纯函数 `deriveCapabilities(model: Model)`（后端 `src/lib/models/`，无 SDK 依赖，前后端共用；若 `capabilities-mapper.ts` 耦合 SDK 则抽纯逻辑出来）。前端只消费，不重派生（防与后端映射漂移）。修当前 `getCapabilities` 丢数值(thinking budget)/数组(reasoning_effort)的 bug 由此自然解决。
- **`ModelData = Record<string,any>` → 收敛为 `~backend/lib/models/client` re-export 的 `Model`**（原则9）。
- 补字段：version/is_chat_default/fallback/policy/billing.restricted_to/reasoning_effort/thinking budgets。
- **行展开 = raw JSON**（`JsonViewerSurface` 行内嵌，可多行同时展开对比），modal 留给"复制全文"。**倾向删 `ModelCard`**（密集表 + raw 行展开够用，避免表/卡双套视觉）。

---

## §4 后端小改（已确认纳入）
- `QueryOptions` 加 `state?: RequestLifecycleState`（`src/lib/history/types.ts`）+ `read.ts applyWhere` 加 `state` WHERE（已有 `status` 列，代价极小）+ `api/http.ts` 透传 `state`/`pid`。让 7 态筛选与游标分页同源、跨页正确。
- 配套：config 热重载完整性守卫、history 既有测试不回退。

---

## 实施顺序（增量，每阶段 typecheck:ui + test:ui + build:ui + subagent review）
1. **§0 共享基础**：STATUS_META + theme 色完整注册 + filters 收敛 + 死代码实测删除 + 类型错误修复 + 穷尽性测试。
2. **§4 后端 state 筛选**（小改，先于依赖它的 Activity 筛选）。
3. **§1 Activity**：keep-alive/URL/prev-next/键盘核心循环 + ActivityRow 声明式列 + 搜索/筛选 + 归因 chip + Session 串联。
4. **§2 Detail**：LifecycleStrip(纯导航) + 诊断摘要带 + outbound wire/per-attempt tab/attempt diff/SSE 帧 diff + DetailPanel/MessageBlock 拆分 + MetaInfo 修复。
5. **§3 Models**：共享 deriveCapabilities + Model 类型收敛 + 密集表 + 多选能力筛选 + 行展开 raw。
6. **回归**：全量 test（含后端 history）+ typecheck + build 全绿。

## 复用清单
视觉：Dashboard metric-tile/panel/telemetry-row/`CompactTimelineBarChart`、`variables.css` token、IBM Plex Mono。组件：ContentRenderer 管线/ContentBlockWrapper/RawJsonModal(分栏)/SideBySideView/JsonViewerSurface/BaseBadge/ErrorBoundary/typeGuards。数据层：useHistoryStore(游标+WS 完备)、Session 聚合、/api/models raw。

## 验证
1. `npm run typecheck:ui`（消除本次 + 预存 orange/tuple；后端别名据 tsconfig 结果处理）。
2. `npm run test:ui`（vitest 组件 + bun composable）全绿；新增：STATUS_META 穷尽性、ActivityRow 列定义/归因 chip、deriveCapabilities 契约、Models 表行、LifecycleStrip 纯导航、SSE 帧 diff 对齐、store `setFilter`→QueryOptions(含 pid/state)透传。
3. `npm run build:ui` 成功。
4. 视觉验证由用户启动 `npm run dev:ui`（不自动起服务器，原则3）。
5. 每阶段 subagent review。

## 防"重蹈技术债"硬约束（评审点名，须守住）
- stage 子组件**禁止自渲染**，内容必走 SectionBlock→ContentRenderer。
- Models 能力**禁止前端重派生**，用共享 deriveCapabilities。
- 新增筛选维度走泛型 setFilter，不再逐个手写。
- theme 新增色须完成 colors+variations+简写变量+dark/light 全套注册。
- 死组件删除逐一 grep 实测，不信声称。
- ModelCard 行展开用 raw JSON，不复活卡片视觉。

## 暂缓 / 风险
- 改动量大：6 个独立可编译阶段 + 每阶段 review 降险。
- 虚拟滚动：游标分页够用，暂不引入（列表可调大每页条数）。
- 后端别名 vue-tsc 报错若 tsconfig 修复牵涉过广，记为独立暂缓项（文件实存，仅类型解析）。

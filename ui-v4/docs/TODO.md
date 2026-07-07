# ui-v4 → ui/ 功能对等补齐清单（退役 gating）

> 本文是 **ui-v4 替换旧 Vue 版 `ui/` 的前置条件清单**。目标是逐页达到与 `ui/` 的功能对等，对等后才能退役 `ui/`（参见 README "达对等后再替换"）。
>
> **来源与可信度**：本清单由 3 个并行 subagent 对 `ui/`↔`ui-v4` 做逐功能对账 + 主线亲手核验关键断言（grep 全 `ui-v4/src` + 读 `ui/` 真实组件）得出。已核验的证据路径标 `[已验]`；个别次要项的 `ui/` 侧组件名/路径待复核，标 `[路径待核]`，但其**功能缺口本身**已确认。
>
> **裁判轴**：功能对等的完整性。"某功能可能没人用/不重要/以后再说"不构成跳过理由——任何 `ui/` 有而 ui-v4 没有的功能都如实列为缺口。

## 总览

后端 5 个 nav 页（Overview/Requests/Sessions/Models/Config）+ 2 个详情路由在 ui-v4 都有"真页"，但**功能对等意义上**仍有显著缺口。Sessions 是 ui-v4 净新增（无 `ui/` 对应），不在对等清单内。

| `ui/` 页面 | ui-v4 对应 | 对等状态 | 阻断退役 |
|---|---|---|---|
| Activity（请求列表） | Requests | ✅ **对等达成且超越**（2026-07 筛选层 + URL 深链 + 虚拟化 + 键盘 + scoped delete） | 否（已解除） |
| Detail（请求详情） | RequestDetail | ⚠️ 交互增强 + 丢核心诊断 | 是（attempts/meta） |
| Models | Models | ✅ **对等达成且超越**（2026-07 P1–P4） | 否（已解除） |
| Config | Config | ❌ **占位实现**（raw JSON textarea） | 是（结构化表单） |
| Dashboard | Overview | ⚠️ 故意精简（分析外包 Grafana） | 取决于设计决策 |
| Search（全局全文搜索） | 无 | ❌ 完全缺失 | 是（零替代品） |

ui-v4 **确有的真增强**（不因下列缺口抹杀）：Live 泳道（WS）+ tail 暂停/缓冲横幅、详情两路由全屏分离、TOC 树 + 锚点滚动、block-diff 内核 + SSE 帧 diff（coalesceDeltas）、shiki 25 语言高亮、4 腿 headers（`ui/` 仅 3 腿）、tool_result 真递归渲染、可拖拽分栏延迟提交、富列表行（字节/倍率/attempt 列 + tooltip）。

---

## Activity — ✅ 对等达成且超越（2026-07，本节保留作历史缺口记录）

> **现状勘误（2026-07，plans [plans/requests-list-enhancement/](plans/requests-list-enhancement/) Phase 0–4）**：下列缺口已全部闭合——URL-as-SSOT 七维筛选层 + 活动 chips + Clear all（🔴）、URL↔筛选深链同步（🔴）、错误态 UI + paused 行内更新（🟡）、空态文案 + 键盘导航 + 清空历史入口（🟢）均落地；「双向游标退化」为**有意不补**（tail + 缓冲横幅提供另一条回最新路径，见 DESIGN §4.2 + spec）。Activity 至此**对等达成且超越** `ui/`，退役阻断已解除。以下逐条保留原缺口记录 + 达成标注。

（原缺口记录）ui-v4 的 Live 泳道/tail/缓冲/富行是真增强，但当时整个**筛选系统**未迁移——**现已全部闭合**（见上方勘误 + 下方逐条 ✅ 标注）。

### 🔴 阻断级（✅ 已达成）

- **✅ 筛选系统已达成**（原缺口：search / model / endpoint / state / pid / sessionId 六维 + 时间范围 + 活动筛选 chips + 单个清除 + Clear all）。`ui/` 经 `setFilter` 统一路径做 server-side 过滤（`ui/src/composables/history-store/useHistoryData.ts` 的 `setFilter`/`setSessionFilter` `[已验]`）；ui-v4 现以 `lib/request-filters.ts`（纯 codec + `matchesGating` + `hasAnyFilter` + chips）+ `hooks/useRequestFilters.ts`（读写 URL）+ `RequestsFilterBar`/`RequestFilterChips` 落地七维筛选，筛选进 `useHistoryInfinite` 的 queryKey → server-side refetch（search 维走后端 FTS）。**→ 已落地**（DESIGN §4 落地态增强）。
- **✅ URL ↔ 筛选同步 / 深链已达成**。`ui/` 有 onMounted hydrate + watch→`router.replace` + onActivated resync（`ui/src/pages/vuetify/VActivityPage.vue`）；ui-v4 现以 `useRequestFilters` 直接把 URL query 作为筛选唯一真值源（URL-as-SSOT，无本地镜像 state），刷新 / 复制链接 / 前进后退都还原。**→ 已落地**。

### 🟡 重要

- **⏸ 双向游标退化为单向无限滚动（有意不补）**：`ui/` 有 prev+next 双游标 + Newer/Older 双按钮（`useHistoryData.ts`）；ui-v4 只 `direction=older`（`useHistoryInfinite.ts`）。**有意不补**——v4 用 tail + 缓冲横幅提供了另一条回最新路径，反向翻页能力由此替代（见 DESIGN §4.2 三件套 + spec），非遗漏。
- **✅ 错误态 UI 已达成**：`ui/` 在 `store.error` 渲染错误图标 + toast；ui-v4 `useHistoryInfinite` 现暴露 `isError`/`error`/`refetch`，`HistoryList` 渲染错误消息 + 「重试」按钮（Task 4.1）。**→ 已落地**。
- **✅ WS entry_updated 行内更新已达成**：`ui/` 无条件原地替换行 + 选中则刷新详情；ui-v4 现在门控顺序里**优先原地更新已加载行**（`gateIncoming` → `inplace` 先于终态 / buffer 门控，顺序互斥），paused 浏览下进行中请求的状态变化如实反映、且不误入缓冲横幅（Phase 1 Task 1.3；端到端渲染层已锁 `tests/useHistoryInfinite.vitest.test.tsx`）。**→ 已落地**。

### 🟢 轻微（✅ 已达成）

- **✅ 空状态文案已达成**（`ui/` "No matching requests" + Clear filters；ui-v4 现渲染「无匹配请求」+ 有筛选时「清除筛选」按钮，Task 4.1）。
- **✅ 清空历史入口已达成**（`api.ts` 有 `delete`；ui-v4 现于列表 header 加「清空」入口 + 筛选感知确认 Modal，走后端 scoped delete / clear-all，Task 4.3）。
- **✅ 列表层键盘上下选中相邻行已达成**（↑/↓/Enter/Esc roving 焦点导航，Task 4.2）。

**关联 plan**：[plans/requests-list-enhancement/](plans/requests-list-enhancement/)（Phase 0–4，已执行）。

---

## Detail — 交互增强与诊断退化并存（违反 richest-data-flow）

ui-v4 在 diff/TOC/shiki/headers 上增强，但丢失三类核心**诊断**能力。后端按 richest-data-flow 完整存了数据，前端却不展示。

### 🔴 阻断级

- **attempts 重试三件套全缺**。`ui/` 有 Retry Timeline（每次重试的 strategy/duration/error/truncation/effectiveMessageCount/截断前帧数，`ui/src/components/detail/AttemptsTimeline.vue` `[已验]`）+ per-attempt wire payload diff（`ui/src/components/detail/AttemptDiff.vue` `[已验]`）+ per-attempt sse_events + stage 入口（`ui/src/components/detail/stages/StageAttempts.vue` `[已验]`）。ui-v4 完全不消费 `entry.attempts[]`——grep `attempts` 全 `ui-v4/src` 仅 `segments/MetaSegment.tsx` 一个计数 `[已验]`。**影响**：重试请求（429/learning probe/截断重试）的逐次诊断在 v4 完全不可见，这是代理排障最核心的数据。后端完整存了 `attempts[].{wireRequest,response,sseEvents,truncation,strategy}`，前端整组丢弃。
- **meta 大网格退化为 6 行**。`ui/` `MetaInfo.vue` 渲染 ~30 字段含 process(pid/version/gitSha)、cache_read/cache_creation tokens、truncation、preprocessing(strippedReadTags/dedupedToolCalls)、**sanitization 逐 attempt 明细**（blocksRemoved/orphaned tool_use/empty text/corrupt thinking）、HTTP status（`ui/src/components/detail/MetaInfo.vue` `[已验]` 存在；字段清单来自 subagent 报告）。ui-v4 `MetaSegment.tsx` 只有 strategy/transport/attempts/queueWait/stop_reason/in+out tokens/warnings。**影响**：sanitization/preprocessing/truncation（请求改写的可观测性）+ cache token + process 身份全部不可见。
- **rewrite 导航 + only-rewritten 过滤丢失**。`ui/` `DetailToolbar.vue` 有改写消息计数徽章 + "Only Rewritten" 过滤 + prev/next 跳转（`ui/src/components/detail/DetailToolbar.vue` `[已验]`）。ui-v4 只有 per-message marks 着色（看得见但无法过滤/逐条定位）。

### 🟡 重要

- **detail 内搜索 + role/type 过滤 + aggregate tools 开关**全缺（`ui/src/components/detail/DetailToolbar.vue`）。ui-v4 无任何 detail 级搜索/过滤。
- **页面级导航全缺**：prev/next 兄弟请求（键盘 j/k，跨分页）、position label（`3/142`）、Escape 返回、Session 钻取、标题栏（model·time·duration·tokens）。ui-v4 只有一个"返回列表"按钮。
- **复制部分补齐**：`ui/` 多处 copy 按钮。ui-v4 现有 `lib/clipboard.ts`（`copyText`，Clipboard API + `execCommand` 兜底）+ per-block JSON modal 的 Copy 按钮（见下条 modal）。**仍缺**：请求头/单字段/整段等其它 copy 入口，可复用 `copyText`。（**export 已补齐**：ui-v4 详情页 DiagnosticBar 有 `ExportButton`，走后端 `GET /history/api/entries/:id/export` 下载单条全量 `.json.zst`——服务端 zstd 压缩 `getEntry` 规范全量形式，比 `ui/` 旧的前端 `JSON.stringify` 明文导出更权威。见 `ui-v4/src/components/detail/ExportButton.tsx` + `lib/export-entry.ts`。）
- **message-level JSON modal 已补齐**：每条 message 的 role 行 hover `{ }` → 居中 Modal 看整条 `{ role, content }` 对象（Source 高亮 / Tree 折叠切换 + Copy），标题取 role（`user JSON` 等）。请求侧（ConversationView）+ 响应侧（ResponseSegment）每条 message 都有。新增 `components/shared/Modal.tsx` + `components/detail/JsonModalButton.tsx` 可复用原语。**内容块级 `{ }` 按用户反馈移除**（message JSON 已含 content 数组）。见 `ui-v4/docs/plans/2026-07-05-per-block-json-modal-design.md`。
- **original-vs-rewritten split 比对 modal**：`ui/` 任何 section 可弹 Raw JSON modal 并 split 对比 original/rewritten `[路径待核]`（subagent 引用的 `RawJsonModal.vue` 名不符，功能存在性确认、`ui/` 侧确切载体待核）。ui-v4 仅 inline Rendered/Raw 切换。
- **tool_use 三项**：parse-error 横幅、display-decode（stringified JSON 字段解回结构化）、tool_use↔tool_result 聚合配对 + jump-to-call/result `[路径待核]`。**影响**：AskUserQuestion 等被 decode 的字段在 v4 看到的是 stringified JSON。
- **tool_result error 徽章**（`is_error`）缺失，失败工具结果无视觉区分。

### 🟢 轻微（diff 视图增强项 / 边界标记）

- git-hunk 折叠未变行 + 统一⇄并排切换 + SideBySideView 语义并排：`ui/` DiffModal 三者皆有（`ui/src/components/detail/DiffModal.vue`、`ui/src/components/message/SideBySideView.vue` `[已验]`），ui-v4 只有统一行级 diff + 硬截断。
- DiagnosticBar 失败原因文案：`ui/` `DiagnosticSummary.vue` 显示 "client disconnected"/"process N died"/error/stop_reason；ui-v4 DiagnosticBar 无 reason 行、无 pid、无 cache token。
- TruncationDivider 语义截断标记（`ui/src/components/detail/TruncationDivider.vue` `[已验]`）：ui-v4 仅靠 rewrite marks 标 removed。

**关联 plan**：detail 内搜索 → Plan 04（in-request-search，未执行）；attempts/meta 移植 + rewrite 导航 + 页面级导航 + 复制 → **需新立项**（export 已单独补齐，见上）。

---

## Models — ✅ 对等达成且超越（2026-07 P1–P4，本节保留作历史缺口记录）

> **现状勘误（2026-07-05）**：下方"占位实现"描述已过时。Models 页经 P1–P4 全面增强（富表格 + 过滤 + 遥测 join + 详情面板 6 tab + CSV + 未关联遥测 + Radix 化），**已达对等且超越 `ui/`**。规划见 [plans/2026-07-05-06b-models-page-enhancement.md](plans/2026-07-05-06b-models-page-enhancement.md)、现状见 [DESIGN.md §7](DESIGN.md)。以下为原始缺口记录。

ui-v4 `ModelsPage.tsx` 全 50 行、只有 4 列（id/name/vendor/version）`[已验，亲读全文]`。`ui/` 的 `ModelsTable.vue`/`ModelsFilterBar.vue` 富表全在 `[已验存在]`。

### 🔴 阻断级（核心数据展示缺失）

- **全部 capability/limit 列缺失**：context_window、max_output、reasoning_effort、vision、tool_calls、parallel_tool_calls、structured_outputs、streaming、thinking（含 budget/adaptive tooltip）。后端 `src/lib/models/capabilities.ts` 的 `deriveCapabilities` 派生的字段 ui-v4 一个都没用。
- **billing.multiplier 列缺失**。
- **is_chat_default / preview 标记 chip 缺失**。

### 🟡 重要（交互能力整体缺失）

- 搜索（id/name）。
- 5 个过滤维度：vendor / endpoint / capabilities(多选 AND) / type / billing range slider + 活跃过滤计数。
- 列排序（5 个可排序列，数值列默认降序）。
- 行点击展开看单模型 raw JSON。

### 🟢 中等

- 错误态未处理（`useModels` 返回 error 但 `ModelsPage.tsx` 丢弃，上游 500/网络失败永远停在空表）。
- 全量 raw JSON 退化：ui-v4 用纯 `<pre>`（无折叠/高亮/Copy），且只 dump `models` 数组、丢 API response 外层；`ui/` 用结构化 `JsonViewerSurface` + Copy JSON。
- 计数信息退化：ui-v4 只显示总数 N，丢了 visible/total、vendors、endpoints 统计。

**实现要点**：复用后端 `~backend/lib/models/capabilities` 的 `deriveCapabilities` 与 `ui/` 的 `getEffectiveEndpoints` 派生逻辑，避免能力推导漂移。

**关联 plan**：无 → **需新立项**。

---

## Config — 占位实现，需结构化表单

ui-v4 `ConfigPage.tsx` 是一个 raw JSON `<textarea>`（58 行）`[已验]`。`ui/` `VConfigPage.vue` 是分组结构化表单（General / Anthropic Pipeline / System Prompt 分区 + 逐字段 label 控件 + 校验，`[已验]` grep 出 section/label/title）。

### 🔴 阻断级

- 结构化逐字段编辑体验完全缺失（ui-v4 只能编辑裸 JSON，丢字段说明/分组/控件类型/校验）。

**关联 plan**：Plan 06b（config 结构化分组表单，未执行）。

---

## Dashboard — 取决于设计决策（非缺陷）

ui-v4 Overview 是**故意**精简成 6 张健康卡片 + "深度分析见 Grafana" 横幅（`ui-v4/src/components/overview/OverviewPage.tsx` `[已验]`）；`ui/` `VDashboardPage.vue`（908 行）是完整 in-app 分析（`CompactTimelineBarChart`/`DashboardBreakdownPanel`/`DashboardRateLimiterPanel`，`[已验]` grep）。HANDOFF.md 明确这是有意外包给 Grafana / `/metrics`，不是漏做。

**判断题**：若接受"趋势/breakdown 看 Grafana"的设计，Dashboard 可随 `ui/` 一并退役；否则它是唯一带 in-app analytics 的页面，退役会丢失。**留待用户决策。**

---

## Search — 全局全文搜索，零替代品（硬阻塞）

`ui/` `VSearchPage.vue`（503 行）是横跨全部 history 的内容寻址全文搜索（5 facets：inbound/rewrites-req/rewrites-resp/req-headers/resp-headers，对应后端 `search_index`）。ui-v4 grep `search` 全 src 零命中 `[已验]`。

> **注意区分**：Plan 04（`plans/2026-06-23-04-in-request-search.md`）是**请求内搜索**（Ctrl-F 式，在已打开的详情里找文本），与此**全局搜索**是两码事。全局搜索实装在 Plan 07，未执行。

**关联 plan**：Plan 07（polish-responsive，含"全局搜索实装"，未执行）。

---

## 退役 gating 汇总

退役 `ui/` 的完整前置条件（按"是否已有 plan"分类）：

**已有 plan、待执行**：
- Config 结构化表单 → Plan 06b
- Detail 内搜索 → Plan 04
- 全局 Search 实装 → Plan 07

**需新立项（plan 尚未覆盖）**：
- **Activity 筛选层 + URL 深链同步**（七维筛选 + chips + 深链 + 键盘 + scoped delete）✅ **已完成**（2026-07 plans/requests-list-enhancement Phase 0–4）
- **Detail attempts 诊断移植**（timeline + per-attempt wire diff + per-attempt sse_events）—— richest-data-flow 红线
- **Detail meta 大网格移植**（sanitization/preprocessing/truncation/cache token/process）
- **Detail rewrite 导航 + 页面级导航 + 复制**（export 已补齐）
- **Models 页基本重写** ✅ **已完成**（2026-07 P1–P4：capability 列 + billing + 标记 + 搜索/过滤/排序 + 详情面板 + CSV + 遥测）

**留待用户决策**：
- Dashboard 是否接受外包 Grafana 而随 `ui/` 退役

> **退役路径建议**：因 `ui/` 各页共享 router 壳层与基建（charts/formatters/useHistoryStore 等），单独删 Activity/Detail/Models 的 ROI 不高（省不下共享基建）。更干净的边界是**补齐上述全部缺口后整套 `ui/` 一次性退役**，而非逐页删除。

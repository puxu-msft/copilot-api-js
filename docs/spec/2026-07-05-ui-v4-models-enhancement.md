# ui-v4 Models 页面全面增强 — 设计规格

> 日期：2026-07-05
> 范围：`ui/src/pages/vuetify/VModelsPage.vue` 及其组件/composable 子树
> 类型：前端特性（不改后端）
> 状态：设计已定稿，待拆实施计划

本规格覆盖 Models 页面的四维度增强：**数据完整性 · 交互与 UX · 运行遥测整合 · 视觉与呈现**。核心动作是把当前"密集表格 + 行内原始 JSON 展开"升级为"密集表格 + 右侧详情抽屉 + 运行遥测 join"。

设计经两轮并行对抗 subagent review（架构可行性 / Vue-UX-测试）修订，最高风险点"遥测 join key 分裂"已亲手核验属实并纳入设计。

---

## 1. 目标与非目标

### 目标

- 把 `Model` 上游 payload 里当前**未在 UI 暴露的全部字段**忠实呈现（richest-data-flow：后端已完整透传 `/api/models`，前端不再裁剪）。
- 每个模型 join 其**运行时遥测**（请求数/成功失败/token 分解/时延），让"目录"与"实际用量"关联。
- 交互增强：右侧详情抽屉、列可配置、更多过滤维度、Export CSV。
- 视觉：信息密度高、对齐项目既有 amber/rounded:0/DM Sans 视觉体系。

### 非目标

- **后端仅一处小改**：models route 现状即忠实透传（完整内部 payload），遥测复用现有 `/api/status`、`/api/stats` 端点。唯一后端改动是移除 `stripInternalFields` 对 `request_headers` 的剥离（§13，按 ADR `internal-tool-security-posture`）。
- **不引 WebSocket**：Models 目录是准静态数据 + 遥测快照轮询足够。
- **首版遥测不接 `/api/stats` 直方图**：仅用 `/api/status` 的聚合数值（p50/p90/p99 直方图作为后续增强，见 §10）。
- **不新增 Pinia store**：抽屉/选中态不跨路由，页面作用域 composable 足够（见 §5）。

---

## 2. 现状基线（改动锚点）

| 文件 | 现状 |
|---|---|
| `VModelsPage.vue` | 编排：Toolbar + FilterBar + 结果列（loading/error/empty/table 四态）+ 页面级 Raw JSON `v-dialog`（`isRawJsonOpen`） |
| `components/models/ModelsToolbar.vue` | 标题 + 计数 + Raw JSON 按钮 |
| `components/models/ModelsFilterBar.vue` | 搜索 / vendor / endpoint / capabilities(多选 AND) / type / billing 区间滑块 |
| `components/models/ModelsTable.vue` | 手写 `v-table` + 排序 + **行内展开 → `JsonViewerSurface`**（`expanded` ref） |
| `composables/useModelsCatalog.ts` | 数据加载（`onMounted` fetch）+ `caps()`（WeakMap 缓存 `deriveCapabilities`）+ 过滤 + options |
| `composables/useModelTelemetry.ts` | **Dashboard 专用**：入参 `Ref<RequestTelemetrySnapshot>`，输出聚合排序视图，非 join 结构 |
| `composables/useDashboardStatus.ts` | `requestTelemetry` computed（:209-280）内联 parse `/api/status` 原始遥测 → `RequestTelemetrySnapshot`；`onMounted` 建 WSClient |
| `utils/model-endpoints.ts` | `getEffectiveEndpoints`（legacy 模型按 `capabilities.type` 推断端点） |

关键既有约束：

- `useModelsCatalog()` **非单例**——`VModelsPage` 调一次持有全部状态。子组件**绝不**各自再调（会重复 fetch + `caps()` WeakMap 缓存割裂）。
- `caps()` 的 WeakMap 以 **Model 对象引用**为 key（`useModelsCatalog.ts:56`）。选中态**绝不复制 model 对象**，否则缓存 miss + caps 不一致。
- Raw JSON 现用页面级 `v-dialog`（**不是** `provideRawModal`——后者是 DetailPanel 树内单实例 modal）。
- `mountWithVuetifyStubs`（`vitest/helpers/mount.ts`）的 stub 集**不含** `VNavigationDrawer`/`VTabs`/`VTab`/`VWindow`。

---

## 3. 数据完整性：字段 → 分区映射

`Model` 类型（`src/lib/models/client.ts:102-126`）的全部字段按分区呈现。**取数路径已核验**（`family`/`tokenizer` 在 `capabilities.*`，非顶层）。所有可选字段一律 `?.` + 缺失显示 `—`（`fetchModels` 是 `as unknown as Model`，运行时无校验）。

| 分区(tab) | 字段 · 来源 |
|---|---|
| **Overview** | `id` · `name` · `vendor` · `version`(顶层，必填) · `capabilities.family` · `capabilities.tokenizer` · `capabilities.type` · `capabilities.object` · `model_picker_category` · `model_picker_enabled` · `is_chat_default` · `is_chat_fallback` · `preview` |
| **Capabilities** | 派生布尔矩阵（`deriveCapabilities`：vision/toolCalls/parallel/structured/streaming/thinking）**＋完整 raw `capabilities.supports` 开放 map**（含 `min/max_thinking_budget`、`reasoning_effort` 数组及任意未来 flag——**不裁剪到派生子集**，richest-data-flow）；`adaptive_thinking` |
| **Limits + Vision** | limits：`max_context_window_tokens` · `max_prompt_tokens` · `max_output_tokens` · `max_non_streaming_output_tokens` · `max_inputs`。Vision **条件区块**（仅 `capabilities.limits.vision` 存在时显示）：`max_prompt_images` · `max_prompt_image_size` · `supported_media_types`（这些**不在** `DerivedCapabilities`，直接读 raw `model.capabilities?.limits?.vision`） |
| **Billing + Policy** | billing：`multiplier` · `is_premium` · `restricted_to`（plan chips）。policy：`state` · `terms` |
| **Endpoints** | `supported_endpoints`（含 `getEffectiveEndpoints` 前端推断；推断项打 `(inferred)` 标记区分上游明确声明 vs 推断） |
| **Telemetry** | 见 §4 |
| **Raw JSON** | 内嵌 `JsonViewerSurface`（展示前端实收的完整 model 对象，**含 `request_headers`**——见 §13：按 ADR `internal-tool-security-posture` 移除 `stripInternalFields` 的剥离，`/api/models` 完整透传） |

> 注：分区上方列为 6 tab 划分下的归并结果（§6）。Endpoints 与 Telemetry 可各自独立成 tab，也可折叠——见 §6 决策。

---

## 4. 运行遥测整合（核心难点）

### 4.1 数据源与解耦（消除 WS 耦合）

**问题**：原设想"复用 `useModelTelemetry`"会引入 WS——它依赖 `useDashboardStatus` 生产的 snapshot，而后者在 `onMounted` 建立 WSClient，与"不引 WS"矛盾；且其输出是 dashboard 聚合视图，非 join 结构。

**方案**：把 `useDashboardStatus.ts:209-280` 的 parse 逻辑**抽成独立纯函数** `parseRequestTelemetry(raw: unknown): RequestTelemetrySnapshot | null`（连同内部 `parseUsage`/`parseModelStats`/`parseModels`/`parseModelSeries`），放共享位置（如 `ui/src/composables/telemetry-parse.ts`）。

- `useDashboardStatus` 改为调用该纯函数（行为逐字节等价，回归靠现有 Dashboard 测试兜底）。
- Models 页新建遥测源：`usePolling(() => api.fetchStatus(), 15000)`（15s 快照轮询，模型目录准静态、无需更密）+ `parseRequestTelemetry(data.value?.requestTelemetry)` → 拿到 snapshot，**零 WS**。

### 4.2 join key 归一化（已核验的失配 → 显式处理）

**已核验事实**（`telemetry-dimensions.ts:110`）：遥测 `model` 维度 key = `entry.outboundResponse?.model ?? entry.inboundRequest.model ?? "unknown"`：

- **成功腿** key = `outboundResponse.model` = `normalizeModelId(上游返回名)`（对齐 `/models` id；Claude 规范名可 join）。
- **失败腿**（无 outboundResponse） key = `inboundRequest.model` = **客户端逐字别名**（`opus`、date 后缀、override 名）。
- `normalizeModelId`（`resolver.ts:126-133`）**仅**归一化 Claude 版本号（`claude-opus-4-6`→`claude-opus-4.6`），**非 Claude / 无法识别 pattern 原样返回**。

**后果**：同一逻辑模型的成功/失败腿产生**不同 key**；别名/override 客户端的遥测也可能对不上 `model.id`。"按模型名直接 join"会**静默丢失失败腿计数**（failure 偏低）与别名遥测。

**join 层设计**（`useModelDetail` 内或独立 `useModelTelemetryJoin`）：

1. 建 `Map<normalizedKey, 聚合遥测行>`：把 snapshot 的每条遥测行的 model key **过 `normalizeModelId`**（复用后端 `~backend`，与 catalog 同源），归一到同一 key 的多行（成功腿 canonical + 失败腿别名恰好归一到同值时）**聚合合并**（requestCount/success/failure/usage/duration 累加）。
2. 每个 catalog model：以 `normalizeModelId(model.id)`（`model.id` 本就是规范名，归一幂等）查 Map。命中 → 该模型遥测；未命中 → "no traffic"。
3. **unmatched 遥测可见性**（richest-data-flow：join 不上的遥测**不静默丢弃**）：归一化后仍无任何 `model.id` 匹配的遥测行（如纯别名 `opus` 从未有成功腿回填规范名、或目录中已下线的模型），收集为 `unmatchedTelemetry` 列表，在**页面表格下方一个"未关联遥测"小节**展示（model key + req/fail 计数），让运维看到"有流量但目录无此 id"的真相。

> **诚实标注**：因失败腿别名可能无法归一到规范 id，抽屉 Telemetry tab 的 failure 计数在这类客户端下可能偏低——UI 对遥测区块加一句说明（"failure 计数按上游规范名聚合，纯别名失败请求见页面底部未关联遥测"）。

### 4.3 遥测呈现

- **表格可选列**：`req(7d)` 数值 + 迷你占比条（复用 `useModelTelemetry` 的 `relativeWidth` 思路或轻量重算；不引 Dashboard 的 WS 实例）。默认隐藏或显示由列配置控制（§7）。
- **抽屉 Telemetry tab**：`requestCount` / `successCount` / `failureCount` / `averageDurationMs` / **全 6 项 token 分解**（`inputTokens`/`outputTokens`/`totalTokens`/`cacheReadInputTokens`/`cacheCreationInputTokens`/`reasoningTokens`）。数据取 `modelsLast7d`（7d 窗口）为主，可并列 `modelsSinceStart`（自启动累积）。

---

## 5. 组件与状态归属

```
VModelsPage (编排, 单一 useModelsCatalog + useModelDetail 实例)
├── ModelsToolbar        计数 + 列配置齿轮菜单 + Export CSV + Raw JSON(全量)
├── ModelsFilterBar      现有过滤 + 新增(premium / restricted-to plan / policy state / has-telemetry)
├── ModelsTable          密集可排序表 + 可配置列 + 遥测列 + 行点击选中(高亮)
├── ModelDetailDrawer    ★ v-navigation-drawer(location=right, temporary)
│   └── DetailSection(共享原语) × N + 特化子组件(Capabilities 矩阵 / Telemetry / Raw JSON)
└── UnmatchedTelemetrySection  ★ "未关联遥测"小节(§4.2)

composables:
├── useModelsCatalog     扩展: 新过滤谓词 + options
├── useModelColumns      ★ 列可配置 + useLocalStorage 持久化
├── useModelDetail       ★ 选中 model.id + 抽屉开关 + 遥测 join Map(导出返回类型接口)
└── telemetry-parse.ts   ★ parseRequestTelemetry 纯函数(从 useDashboardStatus 抽出)

utils:
└── models-csv.ts        ★ CSV 序列化纯函数
```

### 状态归属（三分，不上 Pinia）

- **抽屉开关 + 选中 `model.id`**：页面级 UI 态，与 Models 页强绑定、不跨路由 → 页面作用域 `useModelDetail`（在 `VModelsPage` 调一次，经 props/provide 下传）。参照既有 `isRawJsonOpen` 本地 ref 做法。
- **选中态存 `model.id` 字符串**（**绝不复制 model 对象**）；抽屉取 model 时以 id 反查 `models.value`，`caps()` 复用页面同一实例（WeakMap 命中）；遥测在 computed 里**叠加**（正交维度，不卷入 caps 重算）。
- **列配置**：跨会话持久化 → `useLocalStorage`（key `copilot-api-models-columns`），封装在 `useModelColumns`。
- **不新增 Pinia store**：现有 Pinia store 皆跨组件/跨路由共享；Models 抽屉态不跨路由，上 Pinia 是过度设计。

### 组件边界

- **子组件走 props，绝不各自 `useModelsCatalog()`**（避免重复 fetch + 缓存割裂）。
- presentational 子组件统一契约 `defineProps<{ model: Model; caps: DerivedCapabilities }>()`（Telemetry tab 额外 `telemetry`），对齐 `ModelsTable.vue:13-18` 的 getter-prop 风格。
- 抽 **共享 `DetailSection` / `DetailKeyValueList` 原语**（统一 key-value 行 + chip 行渲染）；tab 子组件只负责"选字段 + 标签文案"。**组件数按"是否有独立渲染逻辑"推导**——只有真正有独立逻辑的（Capabilities 矩阵、Telemetry、Raw JSON）单独成组件，其余 tab 用共享原语。

---

## 6. Tab 划分（6 tab）

采纳折叠到 6 tab：

1. **Overview** — §3 Overview 字段
2. **Capabilities** — 派生矩阵 + **完整 raw supports map** + adaptive_thinking
3. **Limits + Vision** — limits 5 项 + Vision 条件区块
4. **Billing + Policy** — billing 3 项 + policy 2 项
5. **Telemetry** — §4.3
6. **Raw JSON** — 内嵌 `JsonViewerSurface`

> Endpoints 归入 Overview 底部（数据量小、`(inferred)` 标注区块），不独立成第 7 tab。

抽屉内 Raw JSON 作为一个 tab **内嵌 `JsonViewerSurface`**（复用行内展开现有做法），**不用 `provideRawModal`**（避免 modal 叠 drawer 的坏体验）。

---

## 7. 交互与 UX

- **抽屉替换行内展开**（**非叠加**）：点击表格行 → 选中 + 打开右侧抽屉 + 行高亮。移除 `ModelsTable` 的 `expanded` 行内展开逻辑，避免"既展开又开抽屉"双重交互。
- **列可配置**：Toolbar 齿轮菜单勾选显隐列（Model/Vendor 恒显；Ctx/Out/Effort/各 cap/$×/req(7d) 可切），`useLocalStorage` 持久化。
- **新增过滤**（ModelsFilterBar + useModelsCatalog 谓词）：Premium(是/否) · Restricted-to plan(多选) · Policy state · Has-telemetry(有无 join 到遥测)。
- **Export CSV**：当前过滤结果扁平化导出（id/vendor/limits/caps/billing/telemetry 各列）。序列化为 `utils/models-csv.ts` **纯函数**（bun 测）；下载动作复用 `utils/export-entry.ts` 的 `downloadEntryAsZst` 的 Blob + anchor 模式（改 `text/csv`）。CSV 遥测列与表格 req 列**同源同 join 策略**（继承 §4.2）。
- **关闭抽屉**：优先 Vuetify `v-navigation-drawer` `temporary` **原生 scrim 点击关闭**（battle-tested > hand-rolled，先确认原生行为再决定是否补 `onClickOutside`，避免双绑）；Esc 关闭复用 `onKeyStroke("Escape")` + `isTyping()` 守卫（参照 `VDetailPage.vue:172-181`）。

### 复用 primitive（禁止手搓）

| 需求 | primitive | 出处 |
|---|---|---|
| 列配置持久化 | `useLocalStorage`(VueUse) | 范例 `useAppTheme.ts:17` |
| Esc/键盘 | `onKeyStroke` + `isTyping()` | 范例 `VDetailPage.vue:172-181` |
| 剪贴板 | `useCopyToClipboard` | `useCopyToClipboard.ts` |
| 遥测轮询 | `usePolling<T>` | `usePolling.ts` |
| CSV 下载 | Blob + anchor（参照 `downloadEntryAsZst`） | `utils/export-entry.ts` |
| caps 派生 | `deriveCapabilities` / 页面 `caps()` | `capabilities.ts:52` / `useModelsCatalog.ts:56` |
| 端点推断 | `getEffectiveEndpoints` | `utils/model-endpoints.ts` |
| JSON 展示 | `JsonViewerSurface` | `ModelsTable.vue:230` |

---

## 8. 视觉与可访问性

- 沿用全局 `rounded:0` + amber 主色 + DM Sans/IBM Plex Mono + 既有 `--v-theme-*` token。
- capability 矩阵保留 ✓/·；thinking 带 budget tooltip；plan/policy 用 `tonal` chip；limits 用 `tabular-nums` 对齐。
- 抽屉宽 ~420px，桌面右侧覆盖、窄屏全宽。
- **a11y（新引入模式，无既有范例，必须在实现时落实）**：抽屉打开时焦点移入、关闭后归还触发行；`role`/`aria-label`（抽屉）；表格行 `aria-expanded`/`aria-selected`；键盘可达。

---

## 9. 测试（TDD）

### bun（纯逻辑，`ui/tests/`）

- `parseRequestTelemetry` 纯函数（抽出后逐字节等价 + 边界：缺字段/非数组）。
- 遥测 join：`model.id → 聚合遥测` Map；**失配路径**（成功/失败分裂 key、别名/date 后缀/override）；**unmatched 收集**（归一化仍无匹配 → 进 unmatched 列表，不丢弃）。
- 新过滤谓词（premium/restricted-to/policy/has-telemetry）。
- `models-csv.ts` 序列化（含缺失字段、遥测列失配为空）。
- `useModelColumns` 默认值/合并/持久化逻辑。
- `useModelDetail` 纯状态迁移（选中/清除，选中态是 id 非对象）。

### vitest（DOM/交互，`ui/vitest/`）

- 抽屉挂载 + 6 tab 切换渲染各分区字段；缺失字段显示 `—`。
- **Vision 条件区块在非 vision 模型下不渲染**（空态）。
- **完整 supports map 渲染**（非仅派生子集）。
- 行点击 → 选中 + 开抽屉 + 高亮；Esc 关闭；scrim/点外关闭。
- 遥测列渲染 + "未关联遥测"小节渲染。
- 列配置菜单交互；CSV 按钮点击。

### 测试基建

- **新增 Vuetify stub**：`mountWithVuetifyStubs` 补 `VNavigationDrawer`/`VTabs`/`VTab`/`VWindow`/`VWindowItem`（参照 `models-table.test.ts` 现场补 `VTableStub` 的做法），否则挂载全红。
- 选择规则：纯逻辑/序列化/join → bun；DOM/交互/渲染 → vitest（`ui/CLAUDE.md:43`）。

---

## 10. 后续增强（本次不做，备忘）

- `/api/stats?dimension=model` 直方图（p50/p90/p99）接入 Telemetry tab。
- 遥测迷你时间线（`modelsLast7d[].buckets`，复用 `useModelTelemetry.compressTimeline`）。
- 模型对比（多选行并排）。

---

## 11. 文档卫生（收尾任务）

- **归档** `docs/2604-ui-models/`（引用已不存在的 `ModelCard.vue`）→ `docs/archive/2604-ui-models/`（`git mv`，git 追踪可恢复）。本 spec 不引用其 ModelCard 细节，仅其"未来增强"清单作字段备忘。
- `ui/CLAUDE.md` 陈旧点（`SplitPane.vue`/`AppHeader.vue` 已删、`onClickOutside` 零现存用法）——记入收尾 doc-sync。
- 落地后回填 `docs/DESIGN.md` / `ui/CLAUDE.md` 的 Models 页架构描述。

---

## 12. 实施阶段划分（供 writing-plans 细化）

1. **Phase 1 — 遥测解耦地基**：抽 `parseRequestTelemetry` 纯函数 + `useDashboardStatus` 改调它（回归中立）；建遥测 join 层 + unmatched 收集（bun 测先行）。
2. **Phase 2 — 详情抽屉骨架**：`useModelDetail`（选中/开关/join）+ `ModelDetailDrawer` + `DetailSection` 原语 + 6 tab（数据完整性全字段）；抽屉替换行内展开；补 stub + vitest。
3. **Phase 3 — 表格/过滤/列配置增强**：遥测列 + 新过滤谓词 + `useModelColumns` + 齿轮菜单；"未关联遥测"小节。
4. **Phase 4 — Export CSV + a11y + 视觉打磨**：`models-csv.ts` + 下载 + 焦点/aria + 文档卫生（归档 2604、回填 DESIGN）。

每 phase 一 commit（conventional），阶段自洽、typecheck/test 绿。

---

## 13. 后端字段暴露核验（已实测）

`api.fetchModels()` → `/api/models`（`src/routes/models/internal.ts:72-81`）。该路由对每个 model 调 `stripInternalFields`（`:15-18`）：

- **`...rest` 展开**——除被剥字段外，所有 `Model` 字段（含 `policy`/`billing.restricted_to`/`version`/`capabilities.family`/`tokenizer`/`model_picker_*`/完整 `supports` 开放 map/`limits.vision`）**及未 typed 的上游多余键**都完整透传。`getModels`（`client.ts`）本身也是 `response.json() as ModelsResponse` 纯透传、不重构字段。→ **数据完整性设计（§3）成立，后端暴露充分。**
- **原剥离字段 `request_headers`**（`Omit<Model, "request_headers">`）——现按 ADR 移除剥离（见下）。

### 决策：暴露 `request_headers`（已定，按 ADR）

`request_headers` 是 CAPI 下发的**模型专属请求头**（转发上游用，`client.ts:118`）。`stripInternalFields` 原为"不暴露给外部消费者"而剥离它。

按 ADR [internal-tool-security-posture](../decisions/2026-07-05-internal-tool-security-posture.md)：**本项目是内部个人工具、无需防范的外部消费者，该剥离是不适合本项目定位的多余安全处理**。故：

- **移除 `stripInternalFields` 对 `request_headers` 的剥离**（`src/routes/models/internal.ts:15-18`）——`/api/models`（list + single）完整透传，Models 页 Raw JSON tab 展示该字段（richest-data-flow）。
- 这是本 spec 唯一的后端改动（一处小改），列入 **Phase 2**（随 Raw JSON tab 落地），不新开 Phase 0。`stripInternalFields` 若剥离后无其他字段可剥，整个 helper 一并删除（避免留空壳）。

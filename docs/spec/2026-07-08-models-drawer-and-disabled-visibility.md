# Spec: 模型详情模态抽屉 + 禁用模型可见性

**Status:** Draft v2（已纳入 2 轮对抗 subagent 审查 → 待用户审查 → writing-plans）
**Date:** 2026-07-08
**Scope:** ui-v4 Models 页面（前端）+ `/api/models` 内部端点（后端）
**Owner:** 本会话

---

## Changelog

**Review round A（2026-07-08，2 个并行对抗 subagent：后端红线正确性 / 前端完整性，裁判轴 = 长远正确 + 完整）—— 已纳入：**

- **[HIGH-1，已改 R1]** R1 旧断言「禁用模型在**所有**请求路径不可用」**证伪**：实测只有 Anthropic `/v1/messages` 拦截（`supportsDirectAnthropicApi` → `modelIndex.get` undefined → 400）；OpenAI CC/Gemini/Responses 因 `isEndpointSupported(undefined)` 返 `true` 走 passthrough → 禁用 id **直发上游可用**。根因 = `disabled_models` 自述职责是「从列表隐藏」非可用性拦截（[state.ts:461-468](../../src/lib/state.ts) 注释）。→ R1 改写为诚实表述；存量缺口记入 [deferred-backlog.md](../todo/deferred-backlog.md)（供用户决定是否统一为真拦截）。本 spec 不再拿「禁用即不可用」自证安全——**暴露禁用模型本就符合 internal-tool-security-posture ADR（全量暴露），无需安全背书**。
- **[C1，已改 §5.4]** 抽屉 Escape 测试影响被低估：现 Escape 监听挂 **window**（[ModelDetail.tsx:77](../../ui-v4/src/components/models/ModelDetail.tsx#L77)），测试往 window 派发；Radix `Dialog` 的 `useEscapeKeydown` 挂 **document（capture 相）**，window 派发到不了 → 三条 Escape 断言破/假绿。→ §5.4 明列「Escape 测试派发目标 window→document」，删除误标的「保持不变: Escape-closes」。
- **[H1/H2，已扩 §4.2-4.5]** status 数据流接线系统性缺失 → 补全 `statusFor` 统一闭包 + 全部三处消费者（table/filter/csv）签名与调用点 + `configDisabledSet` 的 `useMemo` 稳定性 + `augmentRows` **两个**调用点。
- **[H3，已改 §4.1/R3]** SSOT 响应类型是待建非既有（`useModels` 现内联 `{data}`、后端 schema 是开放 `z.record`）→ 明列「后端新建 `InternalModelsResponse` + Zod 加 `disabled` 字段 + `useModels` 改 import」三件套。
- **[H4，已改 §5.1]** Radix `Dialog.Content` 无 `Dialog.Title` 会走 a11y 警告 → 补 `Dialog.Title` + `aria-describedby={undefined}`（对齐 [Modal.tsx:38-45](../../ui-v4/src/components/shared/Modal.tsx#L38-L45)）。
- **[MEDIUM-1，已改 §3.1]** envelope 加字段须同步 openapi `ModelListSchema`（`disabled: z.array(z.string())`）否则 typecheck 红。
- **[M1，已改 §4.3]** 行暗化用 `tr` opacity 会洗淡 selected 琥珀底 → 改用**前景色 muting（text token）**，不用 opacity。
- **[M2，设计决策·已改 §4.3]** 实测 37 模型中 **19 个（51%）是 picker-disabled**（embeddings/legacy），默认暗化过半目录使暗化信号失效、首屏像半坏。→ **决策：行暗化只施于 config-disabled；picker-disabled 只给 status chip、不暗化**。三态 chip 区分照旧（满足「区分两种禁用」），但视觉降噪只针对真正「原本不可见」的 config-disabled。**此决策改变可见 UX，请用户在审查时确认。**
- **[M3，已入 §8]** 若 status 列可排序，须补 `SortableColumnId` 联合 + `ACCESSORS`（喂 table + CSV 两条排序路径）。

**Review round A 经核实成立（无需改，plan 可复用）**：rebuildModelIndex 从**过滤集**构建（R1(b) 成立，禁用不进 index）；vendor 端点/`/status`/setup 读过滤集、本次改动不波及；§3.1 `disabled` 数组归一化判据与 `applyDisabledFilter` 一致、边界正确（undefined 回退空、不存在于目录的 config 字符串不进数组）；§3.2 无消费者依赖其 404；三态穷尽无第四种被吞、优先级只影响标签不隐藏行；前端 `.has(model.id)` 精确匹配正确（归一化只在后端做一次）；深链到禁用模型成立；include 标志默认 true → 默认全显成立；除 Escape 三条外的 portal 测试（resize separator/六 tab/tabpanel/预览线）不受影响；测试环境已 stub ResizeObserver + pointer capture，抽屉转 Dialog 无需新 stub。

---

## 1. 背景与目标

两个独立但同页的诉求：

1. **模型详情从「共平面 split」改为「模态抽屉」。** 当前 [ModelDetail](../../ui-v4/src/components/models/ModelDetail.tsx) 是右侧停靠面板，但与表格在同一 flex 行内瓜分横向空间（[ModelsPage.tsx:194-227](../../ui-v4/src/components/models/ModelsPage.tsx#L194-L227)），一展开就把列表压窄。目标：详情浮在列表之上（模态遮罩），列表保持全宽。

2. **配置禁用的模型当前在 UI 里完全不可见，要让它们可见并可辨识。** `config.disabled_models` 经 [setModels/applyDisabledFilter](../../src/lib/state.ts#L996-L1010) 把禁用模型从 `state.models` 滤除；`/api/models`（[internal.ts:65-74](../../src/routes/models/internal.ts#L65-L74)）返回的是过滤后的 `state.models.data`，故 ui-v4 看不到它们。目标：内部管理视图 `/api/models` 暴露**全量**目录并标注禁用状态，前端标记 + 可筛选。

### 非目标（本 spec 不做）

- **移动端/窄屏响应式**：暂缓，记入 [deferred-backlog.md](../todo/deferred-backlog.md)（用户明确「未来要求了再做」）。
- **把 `disabled_models` 变成真正的全局可用性拦截**：HIGH-1 揭示的存量缺口（CC/Gemini/Responses 放行禁用 id）超出「可见性」范围，记入 [deferred-backlog.md](../todo/deferred-backlog.md) 供用户决定。本 spec 只改「可见性」。

---

## 2. 承重红线（不变量）

**R1 — 本次改动不新增任何「暴露禁用模型为可用」的路径（隔离性）。** 本 spec **只改内部 `/api/models`（internal.ts）读全量 + 新增 envelope 字段**，绝不改 `state.modelIndex`、`state.models` 的过滤，也不改任何 vendor-facing 端点（OpenAI `/v1/models`、Anthropic 模型列表 [anthropic.ts:35](../../src/routes/models/anthropic.ts#L35)、`/status` 计数 [status/route.ts:213](../../src/routes/status/route.ts#L213)、启动可用列表）。`rebuildModelIndex` 继续从**过滤后**的 `state.models` 构建（[state.ts:1240](../../src/lib/state.ts#L1240)），禁用模型不进 index。

> **诚实注记（不是本 spec 要修的）**：`disabled_models` 的现有语义是「从列表隐藏」，**非全局可用性拦截**——只有 Anthropic 路径实际拒绝禁用模型，CC/Gemini/Responses 因 permissive passthrough 仍放行（详见 [deferred-backlog.md](../todo/deferred-backlog.md) HIGH-1）。故本 spec 让禁用模型在 UI 可见，**不是**把「本不可用」的东西变可用——它们经 3/4 路径本就可用。暴露它们符合 internal-tool-security-posture ADR（全量暴露、运维价值 > 假想泄露）。

**R2 — 合成标记可辨识（richest-data-flow ADR）。** 后端给 UI 全量目录 + 禁用标注；「禁用」是本项目附加的合成信息，**不污染上游 Model 形状**——放在响应 envelope 顶层（`disabled: string[]`），前端按成员关系判定。→ ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)。

**R3 — SSOT 类型（待建，非既有）。** 现状**无**可复用的 `/api/models` 响应 TS 类型：`useModels` 内联 `api.get<{ data: Array<Model> }>`（[useModels.ts:11](../../ui-v4/src/hooks/useModels.ts#L11)，还丢了 `object` 字段），后端 [internal.ts:22-29](../../src/routes/models/internal.ts#L22-L29) 是运行时 `z.record` 开放 schema（`z.infer` 出 `Record<string,unknown>[]`、与前端结构化 `Model` 对不齐），`ModelsResponse`（[client.ts:65](../../src/lib/models/client.ts#L65)）是**上游 catalog** 类型、加 `disabled` 会污染其语义。→ **必须新建**一个后端导出的内部响应类型 `InternalModelsResponse { object: string; data: Model[]; disabled: string[] }`（独立于上游 `ModelsResponse`），前端 `useModels` **停止内联、改从 `~backend/*` re-export 该类型 import**。一处定义、消费端 re-export。→ [DESIGN.md 类型架构](../DESIGN.md)。

---

## 3. 后端改动：`/api/models` 暴露全量 + 禁用标注

### 3.1 列表端点 `GET /api/models`（[internal.ts](../../src/routes/models/internal.ts)）

- **数据源换全量**：用 [`getRawModels()`](../../src/lib/state.ts#L1013)（未过滤上游目录）而非 `state.models`。`getRawModels()` 为 `undefined`（尚未拉取）时回退空 `{ data: [], disabled: [] }`。
- **envelope 增字段 `disabled: string[]`**：值 = 对全量 `data` 逐个 `normalizeForMatching(m.id)`（[model-name.ts:16](../../src/lib/models/model-name.ts#L16)），命中 `new Set(state.disabledModels.map(normalizeForMatching))` 的模型的**原始 `m.id`** 收集而成——与 [`applyDisabledFilter`](../../src/lib/state.ts#L996) 完全同一双侧归一化判据。回吐**实际命中目录的 id**（非 config 原字符串），前端 `.has(model.id)` 精确比对（归一化只在后端做一次）。
- **同步 openapi schema**（MEDIUM-1）：`ModelListSchema`（[internal.ts:24-29](../../src/routes/models/internal.ts#L24-L29)）加 `disabled: z.array(z.string())`，否则 `OpenAPIHono.openapi()` handler 返回多出 `disabled` 键会 typecheck 失败、且 OpenAPI 文档漏声明。
- **新建导出类型**（R3）：在后端定义并导出 `InternalModelsResponse`（见 §2 R3），供前端 re-export。
- 响应形如 `{ object, data: <全量>, disabled: [<实际被禁用的 id>] }`。

`model_picker_enabled: false`（picker-disabled）**不进** `disabled` 数组——它本在 `data` 里、前端从每个 model 的 `model_picker_enabled` 字段自判（§4.2）。`disabled` 数组专指 config-disabled。

### 3.2 详情端点 `GET /api/models/{model}`

- 解析改为对**全量目录**（`getRawModels()?.data` 建临时 index 或 `find`），否则禁用模型详情 404、与列表能显示矛盾（已核实无消费者依赖其 404）。命中返回该 model（形状不变，禁用与否由前端从列表 envelope 已知，不在单模型响应重复标注）。
- **对抽屉深链非必要**：ui-v4 抽屉 selectedModel 从已拉取列表 `models.find` 取（[ModelsPage.tsx:88](../../ui-v4/src/components/models/ModelsPage.tsx#L88)），不走此端点。§3.2 是为「直接打详情端点」的一致性。

### 3.3 后端测试

- `/api/models` 有 `disabledModels` 时返回全量 `data`（含被禁用项）+ 正确 `disabled` 数组；为空时 `disabled: []` 且 `data` == 全量。
- 归一化匹配：config 写 `claude-opus-4-8`、上游 id `claude-opus-4.8` → `disabled` 含 `claude-opus-4.8`；config 含不存在于目录的 id → 不进 `disabled`。
- **回归**：vendor 端点（Anthropic 列表）+ `/status` 计数仍只反映过滤后集合（禁用模型不出现）。
- `/api/models/{id}` 对被禁用 id 返回 200。

---

## 4. 前端改动：标记 + 筛选（三态 status）

### 4.1 `useModels` 消费新 envelope（R3）

[useModels.ts](../../ui-v4/src/hooks/useModels.ts) **停止内联**，改从 `~backend/*` import `InternalModelsResponse`（含 `object`/`data`/`disabled`）。ModelsPage 从 `data.disabled` 构造 `configDisabledSet: Set<string>`，**必须 `useMemo`（依赖 `data`）** 以保证 Set 身份稳定（否则连锁重建列/行模型，见 §4.3 H1）。

### 4.2 三态判定（单一 primitive + statusFor 闭包）

新增纯函数 `ui-v4/src/lib/model-status.ts`：

```
type ModelStatus = "enabled" | "config-disabled" | "picker-disabled"

modelStatus(model, configDisabledSet): ModelStatus
  1. configDisabledSet.has(model.id) → "config-disabled"   // 优先级最高
  2. model.model_picker_enabled === false → "picker-disabled"
  3. → "enabled"
```

优先级 config-disabled > picker-disabled 只影响「双态模型显示哪个标签」、**不隐藏任何行**（已核实）。ModelsPage 建一个 `statusFor = useMemo(() => (m: Model) => modelStatus(m, configDisabledSet), [configDisabledSet])` 闭包，**table / filter / csv 三个消费者共用**（避免 status 被算多遍破坏 SSOT）。注意：picker-disabled 判据自足于 `model.model_picker_enabled`（后端必填 boolean，[client.ts:111](../../src/lib/models/client.ts#L111)），**只有 config-disabled 需外部 Set 注入**。

### 4.3 status 列 + 行前景 muting（H1 + M1 + M2）

- **新列** `status`（`ModelColumnKey` 加一项，[model-columns.ts](../../ui-v4/src/lib/model-columns.ts) 注册；默认可见）。
- **数据流接线**（H1，全部列出）：
  - `ModelRow`（[model-table-columns.tsx:38](../../ui-v4/src/components/models/model-table-columns.tsx#L38)）加 `status: ModelStatus`（或 cell 内联算，但入 row 更省重复）。
  - `augmentRows` 加 `statusFor` 参 → **两个调用点齐改**：`ModelsTable` 内（[ModelsTable.tsx:53](../../ui-v4/src/components/models/ModelsTable.tsx#L53)）+ `ModelsPage.exportCsv`（[ModelsPage.tsx:137](../../ui-v4/src/components/models/ModelsPage.tsx#L137)）。
  - `ModelsTable` 加 `statusFor`（或 `configDisabledSet`）prop（[ModelsTable.tsx:28-39](../../ui-v4/src/components/models/ModelsTable.tsx#L28)）；`buildModelColumns` 若需 status 入 `BuildColumnsOptions` 则**必须进 `columns` 的 useMemo 依赖**（[ModelsTable.tsx:54](../../ui-v4/src/components/models/ModelsTable.tsx#L54)），且 `statusFor`/`configDisabledSet` 身份稳定（§4.1 已 useMemo）。
- **单元格 chip**：`enabled`（正常/muted 极简或不显）/ `config-off`（警示 token）/ `picker-off`（muted token）。配色用 Terminal Amber tokens。
- **行视觉 muting（M1 + M2 决策）**：**只对 config-disabled 行**施加**前景色 muting（改 text color / 降 muted，不用 `tr` opacity）**——opacity 作用整棵子树会洗淡 selected 琥珀底（`bg-[#3a2f1a]` [ModelsTable.tsx:105](../../ui-v4/src/components/models/ModelsTable.tsx#L105)）与 primary 文字。**picker-disabled 行不 muting**（占 51%、暗化过半无区分度），仅靠 chip 区分。muting 与 selected 高亮的叠加：前景色 muting 不影响 selected 底色/左边框，二者正交。
- 该列默认**不可排序**（与 caps 列一致）；可排序留作 §8 开放问题（若选，见 M3 接线）。

### 4.4 筛选（默认包含两种禁用，H2）

- [model-filters.ts](../../ui-v4/src/lib/model-filters.ts) `ModelFilters` 加 `includeConfigDisabled: boolean`、`includePickerDisabled: boolean`，`EMPTY_FILTERS` 两者默认 `true`（包含）。语义为「是否包含」而非「只看禁用」，保证默认全显。
- `filterModels` **加第四参 `statusFor: (m: Model) => ModelStatus`**（照 `hasTelemetry` 闭包形态，[model-filters.ts:94](../../ui-v4/src/lib/model-filters.ts#L94)）：status=config-disabled 且 `!includeConfigDisabled` → 排除；picker-disabled 且 `!includePickerDisabled` → 排除。调用点 [ModelsPage.tsx:126](../../ui-v4/src/components/models/ModelsPage.tsx#L126) + `visible` 的 useMemo 依赖同步加 `statusFor`。
- `countActiveFilters`：`includeX === false` 各记一个 active（偏离默认 = 有筛选）。
- [ModelsFilterBar.tsx](../../ui-v4/src/components/models/ModelsFilterBar.tsx) 加两个 tri/toggle 控件（沿用现有 `triToValue`/toggle 视觉），或一个「Status」多选按钮组（plan 定，§8）。

### 4.5 CSV 导出（H2）

[models-csv.ts](../../ui-v4/src/lib/models-csv.ts) `HEADERS` 加 `status` 列；`modelsToCsv` **加 `statusFor` 参**（[models-csv.ts:36](../../ui-v4/src/lib/models-csv.ts#L36)），调用点 [ModelsPage.tsx:138](../../ui-v4/src/components/models/ModelsPage.tsx#L138) 同步。导出当前筛选/排序视图。三消费者共用同一 §4.2 `statusFor`。

### 4.6 状态栏计数

[ModelsPage.tsx:157-159](../../ui-v4/src/components/models/ModelsPage.tsx#L157) 的 `visible/models` 计数自然涵盖全量（含禁用）；可选加「N disabled」提示（§8）。

### 4.7 前端测试

- `modelStatus` 三态 + 优先级（config > picker）+ 穷尽性。
- status 列渲染三种 chip；**config-disabled 行带前景 muting class、picker-disabled 行不带**。
- 筛选：默认全显；关 includeConfigDisabled 隐藏 config-disabled 行、picker 同理；`countActiveFilters` 正确。
- CSV 含 status 列、值取 statusFor。

---

## 5. 抽屉改造：模态 + 60vw 可拖拽

### 5.1 ModelDetail 换 Radix Dialog（H4）

[ModelDetail.tsx](../../ui-v4/src/components/models/ModelDetail.tsx) 外层从「flex 兄弟面板」改为 Radix `Dialog`（项目已在 [Modal.tsx](../../ui-v4/src/components/shared/Modal.tsx) 用同款）：

- `Dialog.Root open onOpenChange`（open=false → `onClose`）+ `Dialog.Portal` + `Dialog.Overlay`（`fixed inset-0` 半透明遮罩、点击关闭）+ `Dialog.Content`（`fixed inset-y-0 right-0`，右侧贴边，宽度 = 现有 resizer）。
- **必带 `Dialog.Title` + `aria-describedby={undefined}`**（H4）：Radix `Dialog.Content` 无 Title 会走 a11y 警告路径。复用 model.id 头作 Title（或视觉隐藏的 Title），对齐 [Modal.tsx:38-45](../../ui-v4/src/components/shared/Modal.tsx#L38-L45)。
- **Radix 原生替换手搓逻辑**：删除现有 focus-into-panel / focus-restore / Escape 全局监听（[ModelDetail.tsx:71-82](../../ui-v4/src/components/models/ModelDetail.tsx#L71-L82)）——focus-trap / scroll-lock / focus-restore / `aria-modal` / portal / 遮罩全由 Dialog 提供。
- **isTyping 守卫保留**：抽屉内可能有文本框（Raw JSON 搜索等），`onEscapeKeyDown={e => { if (isTyping()) e.preventDefault() }}`，Esc-while-typing 不误关。

### 5.2 宽度：60vw 默认、可拖拽

调用处改视口相对（用 `window.innerWidth`，M4）：

```
useResizableWidth(MODELS_DETAIL_WIDTH_KEY, {
  min: 320,
  max: Math.round(window.innerWidth * 0.9),
  default: Math.round(window.innerWidth * 0.6),   // 3/5
  invert: true,
})
```

[useResizableWidth](../../ui-v4/src/hooks/useResizableWidth.ts) 已支持任意数值 min/max/default，**无需改 hook**；持久化仍存 px。jsdom 下 `window.innerWidth` 默认 1024 → default=614、max=922 均在界内，现有 keyboard-resize 相对断言（`before±16`）不受 default 变化影响。左缘 drag handle + 拖拽预览线（`dragEdgeX` fixed 定位）在模态右侧照常。

### 5.3 ModelsPage 布局简化

[ModelsPage.tsx:194-227](../../ui-v4/src/components/models/ModelsPage.tsx#L194-L227)：外层不再是「表格 flex-1 + 详情兄弟」split。表格容器恒 `flex-1` 全宽；ModelDetail 改为 portal 浮层（selectedModel 存在时挂载）。`?model=<id>` 选择、深链解析、`select`/`clearSelection` **完全不动**（URL 不变，§6）。

### 5.4 抽屉测试调整（C1）

现有 [ModelDetail.vitest.test.tsx](../../ui-v4/tests/ModelDetail.vitest.test.tsx) 需改：

- **Escape 三条断言的派发目标 `window` → `document`**（C1，关键）：现测试 `fireEvent.keyDown(globalThis.window, …)`（[:254](../../ui-v4/tests/ModelDetail.vitest.test.tsx#L254)/[:270](../../ui-v4/tests/ModelDetail.vitest.test.tsx#L270)/[:274](../../ui-v4/tests/ModelDetail.vitest.test.tsx#L274)）；Radix `useEscapeKeydown` 挂 document(capture)，window 派发到不了。改为往 `document` 派发（或 `await user.keyboard("{Escape}")` 且焦点在 dialog 内）。
  - `"closes on Escape"`：派发目标改 document 后应 close。
  - `"does NOT close on Escape while typing"`：input 移进抽屉内 + 派发 document + isTyping 守卫（`onEscapeKeyDown` preventDefault）→ 不关；焦点移出后再派发 → 关。**§5.4 不再声称「Escape-closes 保持不变」**（旧 spec 误标）。
- **"moves focus into the panel"**：Radix 自动聚焦 → 断言改「焦点落在抽屉内」（`onOpenAutoFocus` 可定向到 region/Title）。
- **保持不变**（已核实）：resize separator 键盘缩放（[:349](../../ui-v4/tests/ModelDetail.vitest.test.tsx#L349)）、六 tab 切换/键盘导航、各 tab 内容断言、`getAllByRole("tabpanel")`、`dragEdgeX` 预览线——经 Radix Portal 仍被 `screen` 命中。测试环境已 stub ResizeObserver + pointer capture，无需新 stub。

---

## 6. URL（不变）

模型选择继续用查询参数 `#/models?model=<id>`（[ModelsPage.tsx:84-88](../../ui-v4/src/components/models/ModelsPage.tsx#L84)，URL-as-truth，可分享/深链）。不改为 `/models/:id` 独立路由（会卸载列表、与抽屉语义冲突，改动大）。**深链到禁用模型**：§3.1 列表返全量后，`models.find(selectedId)` 能解析禁用模型 → `#/models?model=<config-disabled-id>` 可直接打开其详情抽屉。

---

## 7. 验收标准

**后端**
- [ ] `/api/models` 返回全量目录（含 config-disabled）+ 正确 `disabled` 数组（归一化匹配）；openapi schema 同步含 `disabled`。
- [ ] 新建并导出 `InternalModelsResponse`，前端从 `~backend/*` re-export 消费（不再内联）。
- [ ] vendor 端点、`/status` 计数、`state.modelIndex` 不受影响（回归）。
- [ ] `/api/models/{id}` 对禁用 id 返回 200。

**前端**
- [ ] 列表显示 config-disabled 模型，status 列三态；**config-disabled 行前景 muting、picker-disabled 行不 muting**。
- [ ] 两个筛选开关默认包含全部；关掉后对应禁用行隐藏；`countActiveFilters` 正确。
- [ ] CSV 含 status 列。
- [ ] 模型详情为**模态抽屉**（遮罩、点遮罩/Esc 关、focus-trap、Dialog.Title），列表保持全宽不被压窄；默认 60vw、可拖拽 320–90vw。
- [ ] URL 仍为 `?model=<id>`，深链可打开禁用模型详情。
- [ ] `bun run typecheck` + `bun run lint:all` + 前端 `build:ui`（rollup，非仅 vitest）全绿；相关测试通过（含 Escape 派发目标已改 document）。

---

## 8. 开放问题（plan 阶段定）

- **[M2 决策待用户确认]** 行 muting 只施 config-disabled、picker-disabled 只给 chip——是否认可？（理由：picker-disabled 占 51%，暗化过半失效。）
- status 列是否可排序？若可排序，须补 `SortableColumnId` 联合 + `ACCESSORS`（[model-table-columns.tsx:67-81](../../ui-v4/src/components/models/model-table-columns.tsx#L67)），否则 CSV 与表格排序不一致（M3）。
- 筛选控件形态：两个 tri-state Select，还是一个「Status」多选按钮组？
- 状态栏是否加「N disabled」提示？
- config-disabled chip 用何 token（复用 `--color-fail` 还是新增警示 token）？

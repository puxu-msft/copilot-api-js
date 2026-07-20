# Vue `ui/` 退役路线图（增量迁移到 React `ui-v4/`）

- 创建：2026-07-10
- 归属：前端子项目退役跟踪。**这是「哪些 Vue 页面还能删、怎么删」的单一事实源。**
- 现状锚点：`ui-v4/` 是**当前活的** React History UI（`/ui-v4`）；`ui/` 是**旧 Vue** UI（`/ui`），正被逐页退役。两者并行挂载见 [DESIGN.md](DESIGN.md)「活的架构现状」+ `src/routes/index.ts`（`/ui` + `/ui-v4` 双 mount）。
- 相关：[ui/CLAUDE.md](../ui/CLAUDE.md)、models 退役 spec [spec/2026-07-08-ui-v4-models-list-parity.md](spec/2026-07-08-ui-v4-models-list-parity.md) + [spec/2026-07-08-ui-v4-raw-json-dual-view.md](spec/2026-07-08-ui-v4-raw-json-dual-view.md)。

## 1. 逐页退役状态

Vue `ui/` 剩余页面 → ui-v4 对应面 → 状态。**「parity 未审」= 只做了存在性映射，退役前必须先做深度对比审计**（见 §2 方法论），别凭「看起来有对应页」就删。

| Vue 页面（`ui/src/pages/vuetify/`） | 路由 | ui-v4 对应 | 状态 | 门控 / 备注 |
|---|---|---|---|---|
| VModelsPage + `components/models/` | ~~`/models`~~ | `ModelsPage`（`/models`） | ✅ **已退役**（2026-07-10） | 见 §4。深度 parity 审计 + 补齐 8 项缺口 + Raw JSON 双视图后退役 |
| VDashboardPage | `/dashboard` | `OverviewPage`（`/overview`） | ⬜ **parity 未审** | 退役前对比：运维看板的每块 stat/图表/遥测维度 ui-v4 是否覆盖。**注意共享件** `useModelTelemetry`（§3） |
| VActivityPage（请求列表） | `/activity` | `RequestsListPage`（`/requests`） | ⬜ **parity 未审** | 对比：列/筛选/分页/实时 WS/preview 快筛。ui-v4 有 `useRequestFilters` + filter chips |
| VDetailPage（请求详情） | `/activity/:id` | `RequestDetailPage`（`/requests/:id`） | ⬜ **parity 未审** | 对比：请求/响应分段渲染、SSE events、attempts timeline、diff、raw JSON（ui-v4 raw JSON 已双视图）、j/k/Esc 导航 |
| VConfigPage | `/config` | `ConfigPage`（`/config`） | ⬜ **parity 未审** | 二者都是 config 编辑器。对比：校验、错误提示、保存回写、字段覆盖 |
| VSearchPage | `/search` | **无对应** | 🚫 **门控：ui-v4 缺此功能** | ui-v4 **没有**内容寻址 5 源全文搜索页（只有 Requests 的轻量 filter chips，非 `/history/api/search` + `/search/contains` 的 5 facet 搜索）。**必须先在 ui-v4 建出对应，才能退役 Vue `/search`** |

ui-v4 独有、Vue 无对应的页（不涉及退役）：`/sessions`·`/sessions/:id`（SessionsPage）、`/learned`（LearnedPage，反应式学习记录生命周期）、`/tools/json`（JsonToolsPage）。

## 2. 退役方法论（可复用三步）

每退役一个 Vue 页面，走与 models 相同的流水线：

1. **深度 parity 审计**（先做，别跳）：派 subagent 逐特性对比 Vue 页 vs ui-v4 对应面，明确裁判轴 = **面向用户的功能完备度 + 信息覆盖**（不是代码风格/ROI）。产出：等价项 / ui-v4 已超越项 / **ui-v4 缺失或退化项**（每条带 Vue `file:line` 证据）。models 的范例见对话 + spec 附录 A。
2. **补齐缺口**（若审计发现 ui-v4 有回退）：写 parity spec（`docs/spec/<date>-ui-v4-<page>-parity.md`，含验收 oracle 附录）→ subagent-driven 执行补齐 → 直到 ui-v4 达到并超越 Vue。models 走了这步（补 8 项 + Raw JSON 双视图）。
3. **退役 Vue 页**（parity 确认后）：按 §3 检查清单删除，隔离 worktree + 独立分支，subagent 审查删除完整性，合回 master。

**门控页（如 `/search`）**：ui-v4 根本没有对应功能时，退役第 3 步被第 2 步阻塞——须先在 ui-v4 **建出**该页（新特性开发，非补缺口），才能退役 Vue 版。

## 3. 退役检查清单（删一个 Vue 页时逐项核对）

以 models 退役（commits `3fc6b78c`）为范本：

- [ ] **删页面 + 组件**：`pages/vuetify/V<Page>.vue` + 该页专属 `components/<page>/`。
- [ ] **删专属 composable / util / 类型**：先 grep 确认**只被该页引用**（`grep -rl <name> ui/src | grep -v <page>`）——被其它页共享的**绝不删**（见 §3 共享件教训）。
- [ ] **删该页测试**：`ui/tests/*<page>*` + `ui/vitest/*<page>*`。**注意文件名不含页名但引用该页组件的测试**（models 踩坑：`detail-primitives.test.ts` / `unmatched-telemetry-section.test.ts` / `navbar-config.test.ts` / `router.test.ts` 都引用了模型件却不含 "model" 名）——用 `grep -rn '<deleted-component>' ui/tests ui/vitest` 兜底。
- [ ] **删接线**：`ui/src/router.ts` 的路由 + `/v/<page>` 遗留重定向；`ui/src/components/layout/NavBar.vue` 的 nav 链接；对应更新 `navbar-config.test.ts`（nav labels 断言）+ `router.test.ts`（重定向断言）。
- [ ] **dangling-ref 全清**：`grep -rniE '<Page>|components/<page>/|use<Page>...' ui/src ui/tests ui/vitest` 必须空。
- [ ] **孤儿扫描**：删页后，原本**只被该页用**的通用组件/util 会成孤儿（models 踩出 `JsonViewerSurface.vue`——通用 JSON 组件、只被模型页用）。孤儿**保守保留 + 记 `docs/todo/deferred-backlog.md`**（no-destructive「绝不以无消费者为名擅自删」），或经用户确认后删（删时连带清 eslint 揪出的 unused imports）。
- [ ] **`components.d.ts` 自动重生**：`ui/types/components.d.ts` 是 gitignore 生成物，`build:ui` 会重生、无需手改/提交。
- [ ] **验证三绿**：`bun run build:ui`（vite，删除结构正确性的真门禁）+ `bun run typecheck:ui`（vue-tsc）+ `bun run test:ui`（bun + vitest）。
- [ ] **doc-sync**：更新 [ui/CLAUDE.md](../ui/CLAUDE.md) 路由表 + VueUse 小节（删该页的 composable 提及）；更新本文档 §1 状态。

### 共享件教训（退役 models 实测）

删页时**必须先验证依赖方向**，被非本页共享的件绝不连带删：
- `ui/src/composables/useModelTelemetry.ts` — 虽名带 "model"，却被 `useOperationalStats.ts` + `VDashboardPage.vue`（Dashboard）共享 → **保留**。**当 Dashboard 退役时，此件才随之可删**（届时先复核无其它消费者）。
- `ui/src/components/ui/JsonViewerSurface.vue` — 通用 JSON 查看组件，但实测只被模型页用 → models 退役后成孤儿，经用户确认已删（commit `ee838f63`）。

## 4. 已完成退役日志

- **models（2026-07-10）**：删整个 `/models` 特性（VModelsPage + 16 组件 + 4 composable + 2 util + 13 测试 + router/nav 接线）。保留共享 `useModelTelemetry`。ui-v4 `ModelsPage` 经 parity 审计 + 补 8 项缺口（endpoint 筛选/billing 滑块/错误态/thinking 单元格/active-filter 计数/空态引导/vendor chip/头部计数，spec [models-list-parity](spec/2026-07-08-ui-v4-models-list-parity.md)）+ Raw JSON 双视图（spec [raw-json-dual-view](spec/2026-07-08-ui-v4-raw-json-dual-view.md)）后达到并超越 Vue。commits：`3fc6b78c`（退役）+ `ee838f63`/`62d14d7d`（孤儿清理）。同时移除两个前端的 **CSV 导出**功能（用户决策，commit `1e0fdc13`）。

## 5. 附带：并发会话预存问题（非退役引入）

- ui-v4 侧 history/requests 测试 fixture 有 `EntrySummary.responsePreviewText` 类型漂移（另一会话给类型加了必填字段但没更新部分 fixture），`typecheck:ui-v4` 因此红。**非本退役工作引入**，属 `response_preview_text` 特性会话的收尾债。Vue 侧同类漂移已在 models 退役时顺手修（commit `7654a223`）。退役后续页时若再遇，同样修 fixture（`responsePreviewText: ""` 镜像 `previewText: ""`）。

# 06 — 前端清理（P2）— 已完成

## 完成状态

| 项目 | 状态 | 结果 |
|------|------|------|
| Legacy 页面维护态标记 | ✓ 已完成 | 路由与 5 个 legacy 页面均已标注 `@deprecated`，明确只做维护不做功能增长 |
| `VDashboardPage.vue` 拆分 | ✓ 已完成 | 页面收敛为容器，认证/配额/系统信息拆到 `components/dashboard/` + `useDashboardStatus.ts` |
| `VModelsPage.vue` 拆分 | ✓ 已完成 | 页面收敛为容器，模型卡片/原始视图/工具栏拆到 `components/models/` + `useModelsCatalog.ts` |
| `useHistoryStore.ts` 拆分 | ✓ 已完成 | 数据加载/分页与 WS 同步拆到 `history-store/useHistoryData.ts`、`history-store/useHistoryWS.ts` |
| `DetailPanel.vue` 拆分 | ✓ 已完成 | 请求区、响应区拆为独立 section 组件 |

## 问题 1：双轨页面

5 legacy + 5 Vuetify 页面并存，默认 `/` → `/v/dashboard`。

当前真实行数（legacy 反而更大）：

| Legacy 页面 | 行数 | Vuetify 页面 | 行数 |
|-------------|------|-------------|------|
| `ModelsPage.vue` | **713** | `VModelsPage.vue` | 499 |
| `DashboardPage.vue` | **561** | `VDashboardPage.vue` | 668 |
| `UsagePage.vue` | 292 | `VUsagePage.vue` | 278 |
| `LogsPage.vue` | 242 | `VLogsPage.vue` | 216 |
| `HistoryPage.vue` | 55 | `VHistoryPage.vue` | 285 |

### 已执行：标记维护态（保留，不删除）

- 路由中加 `@deprecated` 注释
- 每个 legacy 页面加 `/** @deprecated Use VXxxPage.vue (/v/xxx) instead */`
- 明确 legacy 页面只做维护，不再接受功能增长

---

## 问题 2：Vuetify 页面职责混合

### `VDashboardPage.vue`（原 668 行）

已拆分认证状态展示、配额信息、系统配置等多个独立 section。

**实际结果**：布局容器 + `components/dashboard/*` + `useDashboardStatus.ts`

### `VModelsPage.vue`（原 499 行）

卡片视图、Raw JSON 视图、过滤逻辑已拆分。

**实际结果**：布局容器 + `components/models/*` + `useModelsCatalog.ts`

### `useHistoryStore.ts`（原 444 行）

原先混合数据加载、分页、WS 连接、搜索/过滤、选择与清空等 UI 动作。

**实际结果**：保留 facade，拆为 `useHistoryData.ts`（加载/分页/搜索）+ `useHistoryWS.ts`（WS 连接/实时更新）

### `DetailPanel.vue`（原 475 行）

请求区域和响应区域已各自提取为子组件。

---

## 验证

- [x] Legacy 路由注释不影响功能
- [x] 拆分后 `typecheck:ui` + `test:ui` 通过

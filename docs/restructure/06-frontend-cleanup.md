# 06 — 前端清理（P2）

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

### 方案：标记废弃

- 路由中加 `@deprecated` 注释
- 每个 legacy 页面加 `/** @deprecated Use VXxxPage.vue (/v/xxx) instead */`
- 明确 legacy 页面只做维护，不再接受功能增长

---

## 问题 2：Vuetify 页面职责混合

### `VDashboardPage.vue`（668 行）

混合了认证状态展示、配额信息、系统配置等多个独立 section。

**建议拆分为**：布局容器 + `DashboardAuth.vue` + `DashboardQuota.vue`

### `VModelsPage.vue`（499 行）

卡片视图 + Raw JSON 视图 + 过滤逻辑。

**建议拆分为**：布局容器 + `ModelsCardView.vue` + `ModelsRawView.vue`

### `useHistoryStore.ts`（444 行）

当前混合了数据加载、分页、WS 连接、搜索/过滤、选择与清空等 UI 动作。

**建议拆分为**：`useHistoryData.ts`（加载/分页/搜索）+ `useHistoryWS.ts`（WS 连接/实时更新）

### `DetailPanel.vue`（475 行）

可将请求区域和响应区域各自提取为子组件。

---

## 验证

- [ ] Legacy 路由注释不影响功能
- [ ] 拆分后 `typecheck:ui` + `test:ui` 通过

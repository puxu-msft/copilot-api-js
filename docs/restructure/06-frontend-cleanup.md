# 06 — 前端清理（P2）

## 问题 1：双套页面系统

### 现状

两套完整的页面并存：

| Legacy 页面 (`pages/`) | Vuetify 页面 (`pages/vuetify/`) | 路由 |
|------------------------|--------------------------------|------|
| `DashboardPage.vue` (358行) | `VDashboardPage.vue` (530行) | `#/dashboard` / `#/v/dashboard` |
| `HistoryPage.vue` | `VHistoryPage.vue` (241行) | `#/history` / `#/v/history` |
| `LogsPage.vue` (228行) | `VLogsPage.vue` (174行) | `#/logs` / `#/v/logs` |
| `ModelsPage.vue` (494行) | `VModelsPage.vue` (389行) | `#/models` / `#/v/models` |
| `UsagePage.vue` (241行) | `VUsagePage.vue` (246行) | `#/usage` / `#/v/usage` |

默认 `/` redirect 到 `/v/dashboard`。Legacy 页面可访问但不再是主路径。

### 方案：标记废弃

1. 在 `router.ts` 的 legacy 路由上加 `@deprecated` 注释：
   ```ts
   // Legacy routes — @deprecated, use /v/* Vuetify routes
   ```

2. 在每个 legacy 页面组件的 `<script>` 顶部加注释：
   ```ts
   /** @deprecated Use VDashboardPage.vue (/v/dashboard) instead */
   ```

3. 不删除代码——用户可能需要参考 legacy 实现中的逻辑

---

## 问题 2：Vuetify 页面超限

### 现状

| 组件 | 行数 | 问题 |
|------|------|------|
| `VDashboardPage.vue` | 530 | 多个独立 section（认证、配额、配置）可提取 |
| `useHistoryStore.ts` | 437 | CLAUDE.md 已指出职责过重 |
| `DetailPanel.vue` | 429 | 模板 ~200 行，承担全部详情渲染 |
| `VModelsPage.vue` | 389 | 卡片视图 + Raw 视图 + 过滤逻辑 |

### 拆分建议

**`VDashboardPage.vue`（530 → 3 个子组件）**：

| 目标 | 内容 | 预估行数 |
|------|------|----------|
| `VDashboardPage.vue` | 布局容器 + composable 调用 | ~150 |
| `DashboardAuth.vue` | 认证状态 section | ~150 |
| `DashboardQuota.vue` | 配额 + 配置 section | ~230 |

**`useHistoryStore.ts`（437 → 2-3 个 composable）**：

| 目标 | 内容 | 预估行数 |
|------|------|----------|
| `useHistoryStore.ts` | 入口 composable（组合调用） | ~100 |
| `useHistoryData.ts` | 数据加载、分页、搜索 | ~200 |
| `useHistoryWS.ts` | WebSocket 连接、实时更新 | ~140 |

**`DetailPanel.vue`（429 → 提取子区域）**：

可将请求区域和响应区域各自提取为子组件，减少单文件模板长度。

---

## 验证

- [ ] Legacy 路由注释不影响功能
- [ ] 拆分后 `typecheck:ui` 通过
- [ ] 拆分后 `test:ui` 通过
- [ ] 浏览器验证 Vuetify 页面渲染正常

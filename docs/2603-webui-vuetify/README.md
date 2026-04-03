# Web UI Vuetify 全面重写设计文档

## 概述

对 History UI v3 的 Vuetify 页面（`/v/*`）进行全面视觉重写。统一使用 Vuetify 4 组件系统，支持深/浅双主题切换，全局使用直角（border-radius: 0）。

## 目标

1. **Material Design 原生风格 + 直角**：所有 UI 元素使用 Vuetify 组件，全局 `border-radius: 0`
2. **深/浅双主题**：用户可手动切换（light / dark / system），持久化到 localStorage
3. **Vuetify 页面壳层风格统一**：Vuetify 页面（`/v/*`）及其直属组件消除自定义 CSS，改用 Vuetify 原生组件和 utility class
4. **仅重写 Vuetify 页面壳层**：legacy 页面（`/history`、`/logs` 等）保持不变

## 非目标

- 不修改 legacy 页面（`pages/HistoryPage.vue`、`LogsPage.vue` 等）
- 不修改 legacy 专用组件（`components/list/*`、`components/message/*`）
- 不删除 `styles/variables.css`（legacy 页面仍在使用）
- 不修改后端 API 或数据结构
- 不修改 composable 的业务逻辑（只改视觉层）
- 不修改 `components/charts/*`（仅被 legacy `UsagePage` 使用，不在 `/v/*` 范围内）

## 范围边界澄清

### Vuetify 页面对 legacy 组件的依赖

以下 legacy 组件被 Vuetify 页面间接使用，但**本次不重写其内部样式**：

| 组件 | 被谁使用 | 处理方式 |
|------|---------|---------|
| `components/detail/DetailPanel.vue` | `VHistoryPage.vue` | 保持不动——它同时服务 legacy `HistoryPage`，内部样式重写会影响 legacy |
| `components/detail/*.vue`（其他） | `DetailPanel` 内部 | 保持不动（同上） |
| `components/ui/ErrorBoundary.vue` | `VHistoryPage.vue` | 保持不动——仅做错误边界，视觉影响极小 |
| `components/ui/BaseToast.vue` | `App.vue`（全局） | 保持不动——全局 toast 组件，同时服务两套页面 |

**验收标准收紧为**：Vuetify 页面壳层（`VXxxPage.vue` + 其直属子组件）不直接引用 legacy CSS 变量。被间接引入的 `detail/*` 和 `ui/*` 组件允许暂时保留 legacy 风格，后续迁移时单独处理。

### Charts 组件不在范围内

`components/charts/BarChart.vue`、`HorizontalBar.vue`、`StatsCharts.vue` **仅被 legacy `UsagePage.vue` 使用**（见 `pages/UsagePage.vue:6`），`VUsagePage.vue` 已自行实现 Vuetify 风格横条（`v-progress-linear`）。这些 charts 组件是纯 DOM 结构（非 canvas），本次不修改。

## 当前问题诊断

### 1. 主题系统断裂

- `vuetify.ts` 硬编码 `defaultTheme: "dark"`，light 主题定义了但从未激活
- `useTheme.ts` composable 监听 `prefers-color-scheme` 但**从未被任何组件引用**
- `App.vue` 不调用 Vuetify 的 theme API，无法切换主题
- 结果：用户只能看到深色模式

### 2. 双套 CSS 变量共存

| 变量系统 | 来源 | 用途 |
|---------|------|------|
| Legacy CSS（`--bg`、`--text`、`--border`） | `styles/variables.css` | legacy 页面 + NavBar（27 处引用） |
| Vuetify theme token（`rgb(var(--v-theme-*))`) | Vuetify 主题 | 部分 Vuetify 页面 |
| Vuetify utility class（`text-primary`、`bg-surface`） | Vuetify | 部分 Vuetify 组件 |

NavBar 是共享组件，完全使用 legacy CSS 变量，与 Vuetify 页面的主题系统割裂。

### 3. 组件风格不一致

| 区域 | 风格 |
|------|------|
| NavBar | 完全 legacy CSS（自定义 `.navbar`、`.nav-link` 等） |
| Dashboard | 纯 Vuetify class（`v-list`、`v-chip`、`v-progress-linear`），少量 `<style scoped>` |
| Config | 较规范——Vuetify 组件 + `--v-theme-*` token |
| Logs | 自定义表格样式（`:deep(.logs-table td)` override），字体硬编码 |
| History | `v-navigation-drawer` + 大量自定义 CSS（`.request-item`、`.model-truncate`） |
| Models | Vuetify `v-card` + 自定义 `ModelCard.vue`（238 行，大量 `<style scoped>`） |
| Usage | 混合 Vuetify class + 自定义 `.bar-wrap`、`.bar-fill` 等 |

### 4. 直角缺失

当前 `variables.css` 设置了 `--border-radius: 0`，但 Vuetify 组件自带圆角（`v-card` 默认 `border-radius: 4px`），两者冲突。

## 技术基线

| 依赖 | 版本 |
|------|------|
| Vuetify | `^4.0.4` |
| Vue | 3 |
| `@mdi/font` | 已安装 |

**注意：** 仓库使用的是 **Vuetify 4**（非 Vuetify 3）。Vuetify 4 的 API 与 Vuetify 3 高度兼容，但部分 defaults 配置语法可能有变化。实施时应参照 Vuetify 4 文档确认 `rounded` prop 和 defaults 的正确写法。

## 实施方案

### Phase 1: 主题基础设施

#### 1.1 Vuetify 插件配置

**文件：** `plugins/vuetify.ts`

```typescript
import "vuetify/styles"
import "@mdi/font/css/materialdesignicons.css"
import { createVuetify } from "vuetify"

export const vuetify = createVuetify({
  theme: {
    defaultTheme: "dark", // 运行时由 useAppTheme() 覆盖
    themes: {
      dark: {
        dark: true,
        colors: {
          background: "#0d1117",
          surface: "#161b22",
          "surface-variant": "#21262d",
          primary: "#58a6ff",
          secondary: "#8b949e",
          success: "#3fb950",
          error: "#f85149",
          warning: "#d29922",
          info: "#58a6ff",
        },
      },
      light: {
        dark: false,
        colors: {
          background: "#ffffff",
          surface: "#f6f8fa",
          "surface-variant": "#eaeef2",
          primary: "#0969da",
          secondary: "#57606a",
          success: "#1a7f37",
          error: "#cf222e",
          warning: "#9a6700",
          info: "#0969da",
        },
      },
    },
  },
  defaults: {
    global: {
      rounded: 0,
    },
    VCard: { variant: "outlined", rounded: 0 },
    VBtn: { rounded: 0 },
    VTextField: { variant: "outlined", density: "compact", hideDetails: true, rounded: 0 },
    VSelect: { variant: "outlined", density: "compact", hideDetails: true, rounded: 0 },
    VChip: { size: "small", variant: "tonal", rounded: 0 },
    VAlert: { rounded: 0 },
    VProgressLinear: { rounded: false },
    VNavigationDrawer: { rounded: 0 },
    VDialog: { rounded: 0 },
    VMenu: { rounded: 0 },
    VList: { rounded: 0 },
    VListItem: { rounded: 0 },
    VBtnToggle: { rounded: 0 },
    VSheet: { rounded: 0 },
    VToolbar: { rounded: 0 },
    VAppBar: { rounded: 0 },
    VTab: { rounded: 0 },
    VTabs: { rounded: 0 },
    VTable: { rounded: 0 },
    VTooltip: { rounded: 0 },
    VTextarea: { variant: "outlined", density: "compact", hideDetails: true, rounded: 0 },
  },
})
```

**关键变更：**
- 所有组件默认 `rounded: 0`（直角）
- 保留现有 dark/light 配色（GitHub-inspired，用户未要求改配色）
- `VProgressLinear` 设为 `rounded: false`（方角进度条）

**Vuetify 4 兼容性注意：** 如果 Vuetify 4 的 defaults 语法与上述写法有差异，应参照 Vuetify 4 文档调整。核心目标是全局直角，实现手段可适配。

#### 1.2 全局直角 CSS 覆盖

**文件：** `styles/vuetify-overrides.css`（新建）

对于 Vuetify defaults 无法覆盖的组件，通过 CSS 强制直角：

```css
/* 全局直角覆盖——针对 Vuetify defaults 不支持 rounded prop 的组件 */
.v-overlay__content,
.v-snackbar__wrapper,
.v-banner,
.v-bottom-sheet {
  border-radius: 0 !important;
}
```

在 `main.ts` 中 `import "./styles/vuetify-overrides.css"` 放在 `vuetify/styles` 之后。

#### 1.3 主题切换 Composable

**文件：** `composables/useAppTheme.ts`（新建，替代 `useTheme.ts`）

```typescript
import { computed, ref, watch, onMounted, onUnmounted } from "vue"
import { useTheme } from "vuetify"

type ThemePreference = "light" | "dark" | "system"
const VALID_PREFERENCES = new Set<ThemePreference>(["light", "dark", "system"])

const STORAGE_KEY = "copilot-api-theme"

/** 从 localStorage 读取并校验主题偏好，非法值归一化为 "system" */
function loadStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY)
  return VALID_PREFERENCES.has(stored as ThemePreference) ? (stored as ThemePreference) : "system"
}

/** 全局单例：主题偏好 */
const preference = ref<ThemePreference>(loadStoredPreference())

export function useAppTheme() {
  const vuetifyTheme = useTheme()

  // 缓存同一个 MediaQueryList 实例，确保 add/remove 成对操作
  let mql: MediaQueryList | null = null
  const systemDark = ref(window.matchMedia("(prefers-color-scheme: dark)").matches)

  function onSystemChange(e: MediaQueryListEvent) {
    systemDark.value = e.matches
  }

  onMounted(() => {
    mql = window.matchMedia("(prefers-color-scheme: dark)")
    systemDark.value = mql.matches
    mql.addEventListener("change", onSystemChange)
  })

  onUnmounted(() => {
    mql?.removeEventListener("change", onSystemChange)
  })

  const resolvedTheme = computed<"light" | "dark">(() => {
    if (preference.value === "system") return systemDark.value ? "dark" : "light"
    return preference.value
  })

  // 同步到 Vuetify
  watch(resolvedTheme, (theme) => {
    vuetifyTheme.global.name.value = theme
  }, { immediate: true })

  function setPreference(pref: ThemePreference) {
    preference.value = pref
    localStorage.setItem(STORAGE_KEY, pref)
  }

  function cycle() {
    const order: ThemePreference[] = ["light", "dark", "system"]
    const idx = order.indexOf(preference.value)
    setPreference(order[(idx + 1) % order.length])
  }

  return {
    preference,
    resolvedTheme,
    isDark: computed(() => resolvedTheme.value === "dark"),
    setPreference,
    cycle,
  }
}
```

**与旧 `useTheme.ts` 的关键差异：**
- 缓存同一个 `MediaQueryList` 实例（`mql` 变量），确保 `addEventListener` 和 `removeEventListener` 操作同一对象，避免监听器泄漏
- `localStorage` 读取做白名单校验（`VALID_PREFERENCES`），非法值归一化为 `"system"`
- 全局单例 `preference` ref 放在模块级别，多组件调用 `useAppTheme()` 共享同一状态
- 组件级生命周期监听（`onMounted` / `onUnmounted`）与全局状态单例分离

#### 1.4 App.vue 集成

**文件：** `App.vue`

在 Vuetify 分支中初始化主题：

```vue
<script setup lang="ts">
import { provide, onMounted, onUnmounted, computed } from "vue"
import { useRoute } from "vue-router"

import NavBar from "@/components/layout/NavBar.vue"
import BaseToast from "@/components/ui/BaseToast.vue"
import { useAppTheme } from "@/composables/useAppTheme"
import { useHistoryStore } from "@/composables/useHistoryStore"
import { isVuetifyPath } from "@/utils/route-variants"

const store = useHistoryStore()
provide("historyStore", store)

const route = useRoute()
const isVuetifyRoute = computed(() => isVuetifyPath(route.path))

// 初始化主题——在 v-app 内部才能调用 Vuetify useTheme()
// 所以 useAppTheme 需要在组件 setup 中调用
const appTheme = useAppTheme()
provide("appTheme", appTheme)

onMounted(() => store.init())
onUnmounted(() => store.destroy())
</script>
```

**注意：** `useAppTheme()` 调用 Vuetify 的 `useTheme()`，需要在 `v-app` 的上下文中。当前 `App.vue` 的 `<script setup>` 在 `v-app` 模板渲染之前执行——需要验证 Vuetify 4 中 `useTheme()` 是否要求在 `v-app` 子组件中调用。如果是，则需要把 `useAppTheme()` 下沉到 `v-app` 内部的一个 wrapper 组件中。

### Phase 2: NavBar 重写

**文件：** `components/layout/NavBar.vue`

当前：自定义 HTML + 27 个 legacy CSS 变量引用。

重写为 Vuetify 原生组件（仅在 Vuetify 路由下）：

```
┌──────────────────────────────────────────────────────────────┐
│ copilot-api   Dashboard  Config  Models  Logs  History  Usage  │  🌙  ● Live │
└──────────────────────────────────────────────────────────────┘
```

- **容器**：`v-app-bar` flat + `density="compact"`
- **Logo**：`v-app-bar-title`
- **导航**：`v-tabs`（自动高亮当前路由）
- **主题切换**：`v-btn` icon（cycle 按钮）
- **WS 状态**：`v-chip` + `v-icon`（彩色点）
- **移除**：variant switch（已在 route-variants 中处理），所有 legacy CSS

### Legacy 模式（非 `/v/*` 路由）

保持现有 NavBar HTML/CSS 不变。NavBar 内部通过 `isVuetifyPath(route.path)` 条件渲染两套模板（`v-if` / `v-else`），保持单一组件。

### Phase 3: 逐页重写

每个页面重写的通用原则：
- **移除所有 `<style scoped>`**（或最小化为纯布局，不含颜色/字体/边框）
- **颜色只通过 Vuetify**：`color="primary"` prop、`text-primary` class、`bg-surface` class
- **字体通过 Vuetify**：`text-body-1`、`text-caption`、`font-weight-bold`，不用自定义 `.mono` class
- **间距通过 Vuetify**：`pa-4`、`ma-2`、`ga-3`
- **直角已由 defaults 处理**：不需要在每个组件上重复写 `rounded="0"`

#### 3.1 VDashboardPage

**当前状态：** 76 行，已基本使用 Vuetify 组件。子组件有些 legacy 写法。

**重写范围：**

| 组件 | 变更 |
|------|------|
| `DashboardStatusBar` | 改用 `v-toolbar` + `v-chip`，移除自定义 CSS |
| `DashboardOverviewPanel` | 移除 `.two-col` 自定义 CSS grid → 用 `v-row` + `v-col`。移除 `.mono` class → 用 Vuetify `font-family: monospace` 或 `style` |
| `DashboardActiveRequestsTable` | 保持 `v-table`，统一 density |
| 页面本身 | 无大改动 |

#### 3.2 VConfigPage

**当前状态：** 442 行，刚写的。使用 `--v-theme-*` token + `<style scoped>`。

**重写范围：**

| 区域 | 变更 |
|------|------|
| sticky toolbar/footer | 移除 `color-mix(in srgb, ...)` hack → 用 `v-toolbar` + `v-footer` |
| `ConfigSection.vue` | 移除 `border-radius: 16px` → 已由 defaults 处理 |
| `ConfigRewriteRules.vue` `.rule-card` | 移除 `border-radius: 14px`、自定义 border → 改用 `v-card` variant="outlined" |
| 其余控件 | 已较规范，微调间距 |

#### 3.3 VLogsPage

**当前状态：** 216 行，大量 `<style scoped>`（70 行 CSS）。自定义表格列宽、字体、hover 效果。

**重写方案：**
- 改用 `v-data-table` 替代手写 `v-table`（自动排序、密度、responsive）
- 移除所有 `:deep(.logs-table td)` 覆盖
- 列定义通过 `headers` prop
- 自定义单元格内容通过 `item.<column>` slot
- 状态点改用 `v-icon` 彩色点
- toolbar 改用 `v-toolbar`

#### 3.4 VHistoryPage

**当前状态：** 285 行，左右分栏布局。左侧列表用 `v-navigation-drawer` + 自定义 CSS，右侧详情面板。

**重写方案：**
- 保持 `v-navigation-drawer` + main content 布局
- 左侧列表：`v-list` + `v-list-item`，移除自定义 `.request-item` 样式
- **右侧详情：保持 `DetailPanel`（legacy 组件，本次不重写其内部——见"范围边界澄清"）**
- 移除 `.mono`、`.model-truncate`、`.preview-truncate` 自定义 class → 用 Vuetify `text-truncate` 工具 class
- 分页控件用 `v-pagination`

#### 3.5 VModelsPage

**当前状态：** 81 行页面壳 + 404 行子组件。`ModelCard.vue` 有 238 行（大量自定义样式）。

**重写方案：**
- `ModelsToolbar`：改用 `v-toolbar`
- `ModelsFilterBar`：保持 `v-text-field` + `v-select`
- `ModelsGrid`：`v-row` + `v-col` 网格
- `ModelCard`：全面重写——用 `v-card` + `v-list` 展示模型属性，移除所有自定义 CSS（当前 100+ 行样式）
- `ModelsRawView`：保持 JSON 展示

#### 3.6 VUsagePage

**当前状态：** 278 行。自定义进度条（`.bar-wrap` / `.bar-fill`）、section headers。

**重写方案：**
- 进度条改用 `v-progress-linear`（已部分使用）
- 统计卡片用 `v-card` + `v-list`
- 模型分布列表用 `v-table`
- 移除所有自定义 `.bar-wrap` / `.bar-fill` / `.model-name` 等

### Phase 4: 清理

- 删除 `composables/useTheme.ts`（被 `useAppTheme.ts` 替代）
- 确认 Vuetify 页面壳层和直属组件不再直接引用 legacy CSS 变量（允许被间接引入的 `detail/*`、`ui/ErrorBoundary`、`ui/BaseToast` 暂时保留）
- legacy 页面仍正常使用 `variables.css`
- `styles/base.css` 中 Vuetify 页面不需要的全局样式用 `:not(.v-application)` 限定

## 主题切换按钮行为

| 当前模式 | 图标 | 点击后 |
|---------|------|--------|
| Light | `mdi-brightness-5`（太阳） | → Dark |
| Dark | `mdi-brightness-2`（月亮） | → System |
| System | `mdi-brightness-auto`（自动） | → Light |

tooltip 显示当前模式名称。

## 涉及的文件清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `composables/useAppTheme.ts` | 主题切换 composable（替代 useTheme.ts） |
| `styles/vuetify-overrides.css` | 全局直角 CSS 覆盖 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `plugins/vuetify.ts` | 全局 defaults（直角 + 组件规范） |
| `App.vue` | 主题初始化、provide appTheme |
| `main.ts` | 导入 vuetify-overrides.css |
| `components/layout/NavBar.vue` | Vuetify 模式下用原生组件重写 |
| `pages/vuetify/VDashboardPage.vue` | 样式统一 |
| `pages/vuetify/VConfigPage.vue` | 移除自定义圆角和 color-mix |
| `pages/vuetify/VLogsPage.vue` | 改用 v-data-table，移除自定义 CSS |
| `pages/vuetify/VHistoryPage.vue` | 统一列表风格，DetailPanel 保持不动 |
| `pages/vuetify/VModelsPage.vue` | 统一布局 |
| `pages/vuetify/VUsagePage.vue` | 改用 Vuetify 原生进度条和表格 |
| `components/dashboard/DashboardStatusBar.vue` | 改用 v-toolbar |
| `components/dashboard/DashboardOverviewPanel.vue` | v-row/v-col 替代自定义 grid |
| `components/dashboard/DashboardActiveRequestsTable.vue` | 统一密度 |
| `components/config/ConfigSection.vue` | 移除 `border-radius: 16px` |
| `components/config/ConfigRewriteRules.vue` | 移除 `border-radius: 14px` |
| `components/models/ModelCard.vue` | 全面重写样式 |
| `components/models/ModelsToolbar.vue` | 改用 v-toolbar |
| `components/models/ModelsGrid.vue` | 统一网格布局 |

### 删除文件

| 文件 | 原因 |
|------|------|
| `composables/useTheme.ts` | 被 `useAppTheme.ts` 替代，从未被使用 |

### 不动文件

| 文件 | 原因 |
|------|------|
| `pages/HistoryPage.vue` 等 legacy 页面 | 范围外 |
| `components/list/*`、`message/*` | legacy 专用 |
| `components/detail/*`（含 `DetailPanel.vue`） | 被 `VHistoryPage` 使用但同时服务 legacy，本次不动内部样式 |
| `components/ui/ErrorBoundary.vue` | 被 `VHistoryPage` 使用但视觉影响极小，本次不动 |
| `components/ui/BaseToast.vue` | 全局 toast，同时服务两套页面，本次不动 |
| `components/ui/*`（其余） | legacy 专用 |
| `components/charts/*` | 仅被 legacy `UsagePage` 使用，不在 `/v/*` 范围内 |
| `styles/variables.css` | legacy 页面仍在用 |
| `styles/base.css`、`reset.css` 等 | legacy 需要 |
| `composables/useConfigEditor.ts` 等 | 业务逻辑不变 |

## 测试计划

### 1. useAppTheme composable 单元测试

| 用例 | 预期 |
|------|------|
| 首次加载（无 localStorage） | `preference` 为 `"system"`，`resolvedTheme` 跟随 `matchMedia` |
| localStorage 存有 `"light"` | `preference` 为 `"light"`，`resolvedTheme` 为 `"light"` |
| localStorage 存有 `"dark"` | `preference` 为 `"dark"`，`resolvedTheme` 为 `"dark"` |
| localStorage 存有 `"system"` | `preference` 为 `"system"`，`resolvedTheme` 跟随系统 |
| localStorage 存有非法值 `"blue"` | 归一化为 `"system"` |
| `cycle()` 调用 | `light → dark → system → light` |
| `setPreference("dark")` | `preference` 更新，`localStorage` 写入 `"dark"` |
| 系统偏好变化（`matchMedia` change 事件） | `systemDark` 更新，`resolvedTheme` 响应变化 |
| 组件卸载后 | `matchMedia` 监听器已移除（同一 mql 实例） |
| `resolvedTheme` 变化 | Vuetify `global.name` 同步更新 |

### 2. App.vue 集成测试

| 用例 | 预期 |
|------|------|
| Vuetify 路由加载 | `useAppTheme()` 被调用，`appTheme` 通过 provide 可用 |
| 子组件 inject `appTheme` | 能获取到 `preference`、`cycle`、`isDark` 等 |
| 主题切换后 Vuetify 组件颜色更新 | `v-card`、`v-btn` 等跟随 `vuetifyTheme.global.name` |

### 3. NavBar 测试

| 用例 | 预期 |
|------|------|
| Vuetify 路由显示 `v-app-bar` | `v-tabs` 渲染，各 tab 对应正确路由 |
| Legacy 路由显示旧 NavBar | 保持不变（`.navbar` class 存在） |
| 导航顺序 | Dashboard, Config, Models, Logs, History, Usage |
| `/v/config` 无 variant switch | 按现有逻辑隐藏 |
| 主题切换按钮可见且可交互 | 只在 Vuetify 模式显示，点击触发 `cycle()` |
| WS 状态指示器 | `v-chip` 正确显示 Live/Offline |
| 主题按钮图标正确 | light → `mdi-brightness-5`，dark → `mdi-brightness-2`，system → `mdi-brightness-auto` |

### 4. 视觉一致性测试（手动）

每个 Vuetify 页面在以下条件下验证：

- [ ] 浅色主题：文字可读、对比度足够、无白底白字
- [ ] 深色主题：文字可读、对比度足够、无黑底黑字
- [ ] 所有卡片、按钮、输入框、芯片、表格为直角
- [ ] 无残留圆角（检查 `v-progress-linear`、`v-chip`、`v-tooltip`）
- [ ] 页面壳层无 legacy CSS 变量直接引用（`--bg`、`--text`、`--border`）
- [ ] 字体统一（无自定义 `.mono` class 残留——改用 inline `font-family` 或 Vuetify class）
- [ ] 间距统一（无自定义 spacing CSS 残留）

### 5. 功能回归测试

| 页面 | 验证项 |
|------|--------|
| Dashboard | 状态栏、Quota 进度条、活跃请求表、WebSocket 实时更新 |
| Config | 所有字段编辑、Save/Discard、restart 提示、rewrite rules 折叠/展开 |
| Logs | 表格渲染、排序、状态图标、model 显示 |
| History | 列表加载、选择、详情面板（允许 DetailPanel 保持 legacy 风格）、分页 |
| Models | 网格/列表视图切换、过滤、Raw JSON 视图 |
| Usage | Quota 显示、模型分布、统计卡片 |

### 6. Legacy 页面无回归

- [ ] `/history` 正常加载和交互
- [ ] `/logs` 正常加载
- [ ] `/dashboard` 正常加载
- [ ] `/models` 正常加载
- [ ] `/usage` 正常加载

### 7. 自动化测试

- `npm run typecheck:ui` 通过
- `npm run test:ui` 通过（bun test + vitest）
- 已有的 Vitest 组件测试（config-fields、navbar-config、config-page）通过或更新
- 新增测试：
  - `useAppTheme` 单元测试（lifecycle、localStorage、matchMedia mock）
  - NavBar 测试更新（Vuetify 模式下 `v-app-bar` 渲染 + 主题按钮）
  - App.vue 集成测试（主题 provide 链路）

## 约束

- **不引入新依赖**：仅使用已有的 Vuetify 4 + `@mdi/font`
- **Composable 逻辑不变**：只改视觉层（template + style），不改数据获取/处理逻辑
- **Legacy 兼容**：legacy 页面和 `variables.css` 不受影响
- **直角全局化**：通过 Vuetify defaults 而非逐组件设置
- **`MediaQueryList` 生命周期安全**：缓存同一实例，`addEventListener` / `removeEventListener` 成对操作
- **`localStorage` 读取做白名单校验**：非法值归一化为 `"system"`

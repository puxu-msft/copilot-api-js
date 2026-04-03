# Vuetify 最佳实践审查

## 审查范围

对照 Vuetify 4 官方文档和最佳实践，全面检查项目 `ui/history-v3` 中 Vuetify 的使用情况。覆盖配置、主题、组件使用、样式管理、性能等维度。

## 发现汇总

| 严重度 | 数量 | 类别 |
|--------|------|------|
| 高 | 3 | 主题系统、Vuetify 4 特性未利用、默认主题 |
| 中 | 5 | `!important` 滥用、`:deep()` 覆盖、font-family 重复、border-radius 硬编码、inline style |
| 低 | 3 | 缺少 blueprint、缺少 variations、icon 配置方式 |

## Findings

### 1. [高] 未使用 Vuetify 4 内置 `defaultTheme: "system"` 和 `theme.toggle()` / `theme.cycle()` API

**现状：** `plugins/vuetify.ts:9` 硬编码 `defaultTheme: "dark"`。`useTheme.ts` 自行实现系统偏好监听但从未被任何组件使用。

**Vuetify 4 最佳实践：**

Vuetify 4 将 `defaultTheme` 从 `"light"` 改为 `"system"`，并新增了 `theme.toggle()`、`theme.cycle()`、`theme.change()` 内置方法：

```typescript
// Vuetify 4 推荐写法
export default createVuetify({
  theme: {
    defaultTheme: "system", // 自动跟随系统偏好
  },
})

// 组件中切换主题
const theme = useTheme()
theme.toggle()                          // light ↔ dark
theme.cycle(["light", "dark", "system"]) // 三态循环
theme.change("dark")                     // 直接指定
```

**影响：** 设计文档中自行实现的 `useAppTheme.ts`（手动管理 `matchMedia`、`localStorage`、`cycle()`）**大部分功能 Vuetify 4 已内置**。自定义实现增加了维护负担和 bug 风险（如审阅中发现的 `MediaQueryList` 泄漏问题）。

**建议：**
- 将 `defaultTheme` 改为 `"system"`
- 主题切换直接使用 Vuetify 4 的 `theme.toggle()` / `theme.cycle()` API
- 仅在 `localStorage` 持久化方面做最薄的封装——Vuetify 4 的 `"system"` 模式已自带 `matchMedia` 监听
- 如果需要 "light / dark / system" 三态（Vuetify 4 原生支持 `"system"` 值），直接用 `theme.cycle(["light", "dark", "system"])`

### 2. [高] 未使用 MD3 Blueprint

**现状：** `plugins/vuetify.ts` 没有配置 `blueprint`。所有组件使用 Vuetify 的裸默认值。

**Vuetify 4 最佳实践：**

```typescript
import { md3 } from "vuetify/blueprints"

export default createVuetify({
  blueprint: md3, // 预配置 MD3 风格的默认值
})
```

Blueprint 提供了经过设计审查的 MD3 默认值（间距、密度、圆角、排版等），无需在 `defaults` 中逐个配置。

**影响：** 当前 `defaults` 手动配置了 5 个组件的默认值，但遗漏了大量其他组件。使用 `md3` blueprint 后，所有组件获得一致的 MD3 基线，然后只需在 `defaults` 中覆盖与 blueprint 不同的部分（如直角 `rounded: 0`）。

**建议：** 引入 `md3` blueprint，在其基础上覆盖 `rounded: 0`。

### 3. [高] `defaultTheme: "dark"` 导致浅色主题永远不生效

**现状：** `plugins/vuetify.ts:9` 硬编码 `defaultTheme: "dark"`。`useTheme.ts` 存在但从未连接。Light 主题的颜色定义了但从未激活。

**影响：** 用户被锁定在深色模式，无法使用已定义好的浅色主题。

**建议：** 改为 `defaultTheme: "system"`（Vuetify 4 默认值），让主题自动跟随系统偏好。

### 4. [中] `!important` 覆盖 Vuetify 内部样式（8 处）

**位置：**
- `VLogsPage.vue:155,161-163`：覆盖 `v-table` 的背景、字体、padding、height
- `VHistoryPage.vue:265`：覆盖 `v-list-item` 的 `min-height`
- `ModelCard.vue:225,229,234`：覆盖 `v-table` 的背景和 padding

**最佳实践：** `!important` 几乎总是在对抗 Vuetify 的设计意图。正确做法是：
- 使用 Vuetify 提供的 prop（`density="compact"` 代替覆盖 padding）
- 使用 `defaults` 全局配置
- 使用 Vuetify utility class

**建议：** 逐个替换为 Vuetify 原生方案。例如 `v-table` 的 padding 应通过 `density="compact"` 控制，而非 `!important`。

### 5. [中] `:deep()` 穿透 Vuetify 组件内部结构（4 处）

**位置：**
- `VLogsPage.vue:159-160,166`：`:deep(td)`, `:deep(th)` 覆盖表格单元格
- `VHistoryPage.vue:253`：`:deep(.v-navigation-drawer__content)` 覆盖 drawer 内部

**最佳实践：** `:deep()` 选择器依赖 Vuetify 的内部 DOM 结构，当 Vuetify 升级修改内部 class 时会静默失效。

**建议：**
- `v-table` 自定义应通过 `<template #item>` slot 和 Vuetify class 实现
- `v-navigation-drawer` 内部布局应通过 `v-navigation-drawer` 的 slot（`#prepend`、`#append`、默认 slot）控制

### 6. [中] `font-family` 硬编码分散在 9 个文件中

**位置：** `VLogsPage.vue`、`VHistoryPage.vue`、`VUsagePage.vue`、`DashboardActiveRequestsTable.vue`、`DashboardStatusBar.vue`、`DashboardOverviewPanel.vue`、`ModelsRawView.vue`、`ModelCard.vue`（2 处）

每个文件都有 `.mono { font-family: "SF Mono", Monaco, "Courier New", monospace; }` 的重复定义。

**最佳实践：** 在 `vuetify-overrides.css` 或 `defaults` 中定义一次，通过 utility class 引用。Vuetify 没有内置 monospace utility，但可以：
- 在全局 CSS 中定义 `.font-mono { font-family: "SF Mono", Monaco, "Courier New", monospace; }`
- 或在 `vuetify.ts` 的 `theme.variables` 中定义 `--v-font-mono`

### 7. [中] `border-radius` 硬编码与 Vuetify defaults 冲突（4 处）

**位置：**
- `ConfigSection.vue:52`：`border-radius: 16px`
- `ConfigRewriteRules.vue:214`：`border-radius: 14px`
- `VUsagePage.vue:258,264`：`border-radius: 2px`

**最佳实践：** 圆角应通过 Vuetify 的 `rounded` prop 控制。如果全局设为 `rounded: 0`（直角），这些硬编码值会与全局设定冲突。

**建议：** 移除所有硬编码 `border-radius`，让 Vuetify defaults 统一管理。

### 8. [中] inline `style="..."` 替代 Vuetify class（10+ 处）

**位置：** 主要在 `DashboardOverviewPanel.vue`（8 处 `style="min-height: 32px"`）和 `VHistoryPage.vue`、`VUsagePage.vue`。

**最佳实践：** Vuetify 的 `v-list-item` 有 `min-height` prop（通过 `density` 控制）。反复写 `style="min-height: 32px"` 应改为设置组件的 `density` prop。

### 9. [低] 缺少 `theme.variations` 配置

**现状：** 没有配置颜色变体（`lighten` / `darken`）。

**Vuetify 4 最佳实践：**
```typescript
theme: {
  variations: {
    colors: ["primary", "secondary"],
    lighten: 2,
    darken: 2,
  },
}
```

**影响：** 无法使用 `text-primary-lighten-1` 等变体 class。当前如果需要颜色渐变只能硬编码。

### 10. [低] Icon 配置使用全量 CSS 导入

**现状：** `plugins/vuetify.ts:4` 使用 `import "@mdi/font/css/materialdesignicons.css"` 全量导入所有 MDI 图标。

**最佳实践：** 对于 tree-shaking 场景，推荐使用 SVG 方式按需导入：
```typescript
import { mdi } from "vuetify/iconsets/mdi-svg"
```
但全量 CSS 方式更简单，对于这种小应用来说性能差异可忽略。

### 11. [低] `color-mix()` CSS hack 模拟半透明背景

**位置：** `VConfigPage.vue:491` 使用 `color-mix(in srgb, rgb(var(--v-theme-surface)) 92%, transparent)` + `backdrop-filter: blur(10px)` 实现磨砂效果。

**最佳实践：** Vuetify 提供 `v-toolbar` 和 `v-footer` 组件，可以直接用 `color="surface"` + `flat` 实现。如果需要半透明效果，应在 `vuetify-overrides.css` 中统一定义，而非在组件内 hack。

## 设计文档影响

以上发现对 `docs/2603-webui-vuetify/README.md` 的具体影响：

### 1. `useAppTheme.ts` 应大幅简化

Vuetify 4 已内置 `defaultTheme: "system"` 和 `theme.toggle()` / `theme.cycle()` / `theme.change()` 方法。自定义 composable 不需要：
- 自行监听 `matchMedia`（Vuetify `"system"` 模式已内置）
- 自行实现 `cycle()` 逻辑（Vuetify 4 `theme.cycle(["light", "dark", "system"])` 已内置）
- 自行管理 `resolvedTheme` computed（Vuetify 的 `theme.global.current.value.dark` 即可判断）

`useAppTheme.ts` 只需做 **localStorage 持久化** 这一件事：

```typescript
import { useTheme } from "vuetify"
import { watch } from "vue"

const STORAGE_KEY = "copilot-api-theme"
const VALID = new Set(["light", "dark", "system"])

export function useAppTheme() {
  const theme = useTheme()

  // 启动时从 localStorage 恢复
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && VALID.has(stored)) {
    theme.global.name.value = stored
  }

  // 持久化变化
  watch(() => theme.global.name.value, (name) => {
    localStorage.setItem(STORAGE_KEY, name)
  })

  return {
    theme,
    cycle: () => theme.cycle(["light", "dark", "system"]),
    isDark: () => theme.global.current.value.dark,
  }
}
```

这完全消除了 `matchMedia` 管理、`MediaQueryList` 泄漏风险、和手动 `cycle` 实现。

### 2. 应使用 `md3` Blueprint

设计文档中的 `defaults` 配置应改为：

```typescript
import { md3 } from "vuetify/blueprints"

export const vuetify = createVuetify({
  blueprint: md3,
  theme: { defaultTheme: "system", /* ... */ },
  defaults: {
    // 只覆盖与 md3 不同的部分
    global: { rounded: 0 },
    VCard: { rounded: 0 },
    VBtn: { rounded: 0 },
    // ... 直角覆盖
  },
})
```

### 3. 应添加 `variations` 配置

使颜色变体（`primary-lighten-1` 等）可用。

## 建议更新设计文档的内容

1. **替换 `useAppTheme.ts` 完整示例**为上述精简版（利用 Vuetify 4 内置 API）
2. **在 `vuetify.ts` 配置中加入 `blueprint: md3`**
3. **在 `vuetify.ts` 配置中加入 `variations`**
4. **将 `defaultTheme` 改为 `"system"`**（Vuetify 4 默认值）
5. **在 Phase 3 通用原则中增加**：
   - 移除所有 `!important` 覆盖，改用 Vuetify prop 和 defaults
   - 移除所有 `:deep()` 穿透选择器，改用 slot 和 Vuetify class
   - 定义全局 `.font-mono` class，替代分散在 9 个文件中的重复 `font-family`
   - 移除所有 inline `style="min-height: ..."` 等，改用 Vuetify density prop
6. **主题切换按钮**直接用 `theme.cycle(["light", "dark", "system"])`

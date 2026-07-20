# Vuetify 重写实施审阅 260331-1

## 审阅范围

对照 `docs/2603-webui-vuetify/README.md` 设计文档和 `docs/2603-webui-vuetify/vuetify-best-practices-audit.md` 最佳实践审查，全面校验 Codex 实施的 Vuetify UI 重构。

## 验证结果

- `npm run typecheck:ui` — **通过**
- `npm run test:ui` — **通过**（bun 176 pass + vitest 17 pass = 193 tests）

## 设计文档要求逐项核对

### Phase 1: 主题基础设施 ✅

| 要求 | 实现 | 状态 |
|------|------|------|
| `blueprint: md3` | `vuetify.ts:9` | ✅ |
| `defaultTheme: "system"` | `vuetify.ts:11` | ✅ |
| `variations` 配置 | `vuetify.ts:12-16` | ✅ |
| 全局 `rounded: 0` defaults | `vuetify.ts:48-73`（22 个组件） | ✅ |
| `useAppTheme.ts` 用 `theme.change()` | `useAppTheme.ts:19` | ✅ |
| `useAppTheme.ts` 用 `theme.cycle()` | `useAppTheme.ts:31` | ✅ |
| localStorage 持久化 + 白名单校验 | `useAppTheme.ts:5,17-20,22-27` | ✅ |
| 无 `matchMedia` 管理 | 无 `onMounted`/`onUnmounted` | ✅ |
| `AppThemeController` 接口导出 | `useAppTheme.ts:7-12` | ✅ |
| `vuetify-overrides.css` 全局直角 | 新建文件，4 个 selector | ✅ |
| `.font-mono` 全局 class | `vuetify-overrides.css:8-10` | ✅ |
| `main.ts` 导入 overrides | `main.ts:8` | ✅ |
| `App.vue` 初始化 appTheme + provide | `App.vue:7,13-14` | ✅ |

### Phase 2: NavBar 重写 ✅

| 要求 | 实现 | 状态 |
|------|------|------|
| Vuetify 模式用 `v-app-bar` | `NavBar.vue:71-122` | ✅ |
| `v-tabs` 导航 | `NavBar.vue:81-95` | ✅ |
| 主题切换按钮 + cycle | `NavBar.vue:99-107,65-67` | ✅ |
| 主题图标正确（brightness-5/2/auto） | `NavBar.vue:47-52` | ✅ |
| WS 状态 `v-chip` | `NavBar.vue:109-121` | ✅ |
| Legacy 模式保持旧 NavBar | `NavBar.vue:124-155` | ✅ |
| 导航顺序正确 | `NavBar.vue:22-29` Dashboard > Config > Models > Logs > History > Usage | ✅ |
| inject appTheme（可选） | `NavBar.vue:17` | ✅ |

### Phase 3: 逐页重写

| 页面 | 状态 | 备注 |
|------|------|------|
| VConfigPage | ✅ | sticky 改用 `v-toolbar` + `v-footer`，新增 config 字段（context_editing_trigger 等） |
| VDashboardPage | ✅ | `font-mono` 替代 `.mono`，移除 hardcoded font-family |
| VLogsPage | ⚠️ | 仍用 `v-table`，未改用 `v-data-table`（见 Finding 2） |
| VHistoryPage | ✅ | cursor 分页保持 `v-btn`，移除 `!important` 和 `:deep()` |
| VModelsPage | ⚠️ | `ModelCard.vue` 仍有 1 处 hardcoded `font-family`（见 Finding 3） |
| VUsagePage | ✅ | 移除 hardcoded `border-radius`，用 `--v-theme-*` token |

### Phase 4: 清理

| 要求 | 实现 | 状态 |
|------|------|------|
| 删除 `useTheme.ts` | **未删除** | ❌（见 Finding 1）|
| 页面壳层无 legacy CSS 变量 | 已确认——0 处 `var(--bg)`/`var(--text)` 等 | ✅ |
| 零 `!important` | 已确认——0 处 | ✅ |
| 零 `:deep()` | 已确认——0 处 | ✅ |
| 零 hardcoded `border-radius` | 已确认——0 处 | ✅ |
| 零 `color-mix()` / `backdrop-filter` | 已确认——0 处 | ✅ |
| 零 inline `style="..."` | 已确认——0 处（Vuetify 页面和直属组件） | ✅ |

## Findings

### 1. [低] `composables/useTheme.ts` 未按设计文档删除

设计文档明确要求删除 `useTheme.ts`（"被 `useAppTheme.ts` 替代，从未被使用"）。当前文件仍存在（491 bytes，最后修改 Mar 6）。虽然没有被任何组件引用，不会造成运行时问题，但属于死代码。

### 2. [低] VLogsPage 仍用 `v-table` 而非设计文档指定的 `v-data-table`

设计文档 Phase 3.3 明确要求"改用 `v-data-table` 替代手写 `v-table`"。实际实现保留了 `v-table`（`VLogsPage.vue:85`）。

不过，当前实现已经达成了设计文档的实质目标：
- 移除了所有 `!important`（原 4 处）
- 移除了所有 `:deep()` 穿透（原 3 处）
- 移除了硬编码 font-family（改用 `font-mono`）
- 用 `--v-theme-*` token 替代了自定义颜色

`v-table` 在当前场景下可以接受——Logs 页面不需要排序/分页功能。但与设计文档不一致。

### 3. [极低] `ModelCard.vue:203` 仍有 1 处 hardcoded `font-family`

```css
.model-id {
  font-family: "SF Mono", Monaco, "Courier New", monospace;
}
```

应改为 `font-mono` class 引用。这是全部 Vuetify 页面和直属组件中唯一残留的 hardcoded font-family。

## 超出设计文档的额外实现（值得注意）

Codex 在重构时同时新增了一些与 Vuetify 重写无关的功能变更：

### 1. 新增 config 字段

Config 页面新增了设计文档中未提及的字段：

| 字段 | 类型 | 所在 section |
|------|------|-------------|
| `context_editing_trigger` | number | Anthropic Pipeline |
| `context_editing_keep_tools` | number | Anthropic Pipeline |
| `context_editing_keep_thinking` | number | Anthropic Pipeline |
| `tool_search` | boolean | Anthropic Pipeline |
| `auto_cache_control` | boolean | Anthropic Pipeline |
| `non_deferred_tools` | string[] | Anthropic Pipeline |
| `upstream_websocket` | boolean | OpenAI Responses |
| `model_refresh_interval` | number | Timeouts |

这些字段在 `config.example.yaml` 中已存在，后端 `route.ts` 也已支持校验和 merge。**不是 bug，是额外完成的工作**——但超出了 Vuetify 重写的范围定义。

### 2. 新增 `ConfigStringList.vue` 组件

用于 `non_deferred_tools`（字符串数组编辑器）。组件质量好——遵循现有 Config 组件的 v-model 模式。

### 3. `useConfigEditor.ts` 更新

新增了对新字段的 normalize 逻辑（`non_deferred_tools` 数组处理等）。

## 反模式清理成效总结

| 反模式 | 设计前 | 设计后 | 改善 |
|--------|--------|--------|------|
| `!important` 覆盖 | 8 处 | 0 处 | 100% |
| `:deep()` 穿透 | 4 处 | 0 处 | 100% |
| hardcoded `border-radius` | 4 处 | 0 处 | 100% |
| hardcoded `font-family` | 9 处 | 1 处 | 89% |
| `color-mix()` hack | 1 处 | 0 处 | 100% |
| inline `style="..."` | 10+ 处 | 0 处 | 100% |
| legacy CSS 变量 in Vuetify pages | 27 处（NavBar） | 0 处（Vuetify 模式） | 100% |

## Summary

| 优先级 | 问题 | 状态 |
|--------|------|------|
| 低 | `useTheme.ts` 未删除 | 死代码，不影响运行 |
| 低 | VLogsPage 用 `v-table` 非 `v-data-table` | 功能正确，与设计文档不一致 |
| 极低 | ModelCard 1 处 hardcoded font-family | 应改用 `.font-mono` |

**实施整体质量高。** 设计文档的核心目标全部达成：
- `md3` blueprint + `defaultTheme: "system"` + `theme.change()` / `theme.cycle()`
- 全局直角（`rounded: 0`）
- NavBar 双模板（Vuetify `v-app-bar` / legacy）
- 主题切换（light/dark/system 三态 cycle + localStorage 持久化）
- 反模式清理（`!important`、`:deep()`、hardcoded border-radius/font-family、inline style、legacy CSS vars）基本清零

额外完成了 8 个新 config 字段的前后端支持，属于正面的超额交付。

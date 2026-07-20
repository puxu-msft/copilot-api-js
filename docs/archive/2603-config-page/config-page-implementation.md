# Config Page 实施文档

## 状态

`docs/config-page-design.md` 中定义的 Config Page 方案现已实施完成。

本次实施覆盖：

- 独立 Vuetify Config 页面
- `/api/config/yaml` 读写接口
- YAML round-trip merge / 写回
- 保存后热重载与 runtime state 同步
- 字段级 UI 组件
- 导航与路由变体处理
- 后端、composable、组件、页面集成测试

## 已完成内容

### 1. 路由与导航

已完成：

- 新增 `/v/config` 路由
- 不提供 legacy `/config`
- NavBar 在 Vuetify 模式下显示 `Config`
- NavBar 在 legacy 模式下不显示 `Config`
- `/v/config` 上隐藏 variant switch
- 导航顺序调整为 `Dashboard | Config | Models | Logs | History | Usage`

对应文件：

- [ui/history-v3/src/router.ts](/home/xp/src/copilot-api-js/ui/history-v3/src/router.ts)
- [ui/history-v3/src/components/layout/NavBar.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/layout/NavBar.vue)
- [ui/history-v3/src/utils/route-variants.ts](/home/xp/src/copilot-api-js/ui/history-v3/src/utils/route-variants.ts)

### 2. Config 页面与字段组件

已完成：

- 单列长表单布局
- sticky toolbar + sticky footer
- `Save` / `Discard` 全局操作
- General / Anthropic / System Prompt / OpenAI Responses / Timeouts / Shutdown / History / Model Overrides / Rate Limiter 各 section
- `ConfigToggle` / `ConfigNumber` / `ConfigEnum` / `ConfigText` / `ConfigKeyValueList` / `ConfigRewriteRules` / `ConfigSection`
- `proxy` 与 `rate_limiter` 的 restart 标记
- `ConfigSection` 上的 `Requires restart to take effect` tooltip
- `ConfigRewriteRules` 折叠/展开交互

对应文件：

- [ui/history-v3/src/pages/vuetify/VConfigPage.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/pages/vuetify/VConfigPage.vue)
- [ui/history-v3/src/components/config/ConfigSection.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/config/ConfigSection.vue)
- [ui/history-v3/src/components/config/ConfigToggle.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/config/ConfigToggle.vue)
- [ui/history-v3/src/components/config/ConfigNumber.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/config/ConfigNumber.vue)
- [ui/history-v3/src/components/config/ConfigEnum.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/config/ConfigEnum.vue)
- [ui/history-v3/src/components/config/ConfigText.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/config/ConfigText.vue)
- [ui/history-v3/src/components/config/ConfigKeyValueList.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/config/ConfigKeyValueList.vue)
- [ui/history-v3/src/components/config/ConfigRewriteRules.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/components/config/ConfigRewriteRules.vue)

### 3. `useConfigEditor`

已完成：

- `load()` / `save()` / `discard()`
- `loading` / `saving` / `error`
- `isDirty`
- `hasRestartFields`
- 保存成功后的 restart-aware toast
- 保存失败保留编辑态
- 深拷贝时递归剥离 reactive wrapper，避免嵌套对象触发 `DataCloneError`

对应文件：

- [ui/history-v3/src/composables/useConfigEditor.ts](/home/xp/src/copilot-api-js/ui/history-v3/src/composables/useConfigEditor.ts)

### 4. 后端 API 与 YAML round-trip

已完成：

- `GET /api/config/yaml`
- `PUT /api/config/yaml`
- 不存在文件时返回 `{}` 并允许首次保存创建文件
- 非法 YAML 时返回 `500` + 结构化错误体 `{ error, details }`
- 后端字段校验
- `yaml.parseDocument()` + `setIn()` / `deleteIn()` / `toString()` round-trip 写回
- `resetConfigCache()` + `resetConfigManagedState()` + `applyConfigToState()` 保存后即时生效
- `loadRawConfigFile()` 返回保存后的结构化结果

对应文件：

- [src/routes/config/route.ts](/home/xp/src/copilot-api-js/src/routes/config/route.ts)
- [src/lib/config/config.ts](/home/xp/src/copilot-api-js/src/lib/config/config.ts)
- [src/lib/state.ts](/home/xp/src/copilot-api-js/src/lib/state.ts)

### 5. Dashboard 清理

已完成：

- Dashboard 移除旧的 config panel
- `useDashboardStatus` 移除 configGroups / fetchConfig 逻辑
- `DashboardConfigPanel.vue` 删除

对应文件：

- [ui/history-v3/src/pages/vuetify/VDashboardPage.vue](/home/xp/src/copilot-api-js/ui/history-v3/src/pages/vuetify/VDashboardPage.vue)
- [ui/history-v3/src/composables/useDashboardStatus.ts](/home/xp/src/copilot-api-js/ui/history-v3/src/composables/useDashboardStatus.ts)

## 与设计文档相比的实现说明

### 1. `rate_limiter` merge 策略做了增强

原设计文档把 `rate_limiter` 写成 collection 整段替换。

最终实现没有沿用这一点，而是改成了与其他 nested scalar section 一致的 partial merge 语义：

- 缺失字段：保留原值
- `null` / `undefined`：删除
- 具体值：覆盖

原因是整段替换会导致 partial update 时误删 sibling 字段，这与 `anthropic` 的已修复问题同源。当前实现更稳健，也更符合“未发送字段保持原样”的总体设计目标。

### 2. restart 提示采用 `chip + tooltip`

设计文档要求有 restart 提示。最终实现使用：

- 标题侧 `Requires restart` chip
- tooltip 文案：`Requires restart to take effect`

语义与设计一致，交互比纯文本标记更明确。

## 测试覆盖

### 后端

已覆盖：

- `GET /api/config/yaml` 基本读取
- `GET /api/config/yaml` 全字段读取与非法 YAML 错误响应
- 不存在文件时返回 `{}` 
- enum / number / regex / proxy / model override key 校验
- scalar / nested scalar / deleteIn / create file / comment preservation
- nested child delete、collection replacement、absent-key no-op
- `resetConfigCache()` debounce bypass
- 删除字段后 runtime 回退默认值（`fetch_timeout`、`anthropic.strip_server_tools`、`model_overrides`、`system_prompt_overrides`）
- `anthropic` sibling-preservation
- `rate_limiter` sibling-preservation

对应文件：

- [tests/http/config-yaml-routes.test.ts](/home/xp/src/copilot-api-js/tests/http/config-yaml-routes.test.ts)
- [tests/component/config-hot-reload.test.ts](/home/xp/src/copilot-api-js/tests/component/config-hot-reload.test.ts)

### 前端 composable

已覆盖：

- `load()` 成功
- `load()` 失败
- dirty tracking
- 修改后恢复原值时 `isDirty` 回到 false
- `discard()`
- `save()` 成功
- `save()` 校验失败
- `save()` 网络失败
- restart-aware toast
- reactive 嵌套对象 save 不抛异常

对应文件：

- [ui/history-v3/tests/config-editor.test.ts](/home/xp/src/copilot-api-js/ui/history-v3/tests/config-editor.test.ts)

### 前端 UI 组件与页面

已覆盖：

- NavBar Config 链接与顺序
- `/v/config` 上隐藏 variant switch
- `ConfigToggle` / `ConfigNumber` / `ConfigEnum` / `ConfigText`
- `ConfigKeyValueList`
- `ConfigRewriteRules` 模式切换、添加/删除、method 切换、折叠/展开、`showModelField`
- `ConfigSection` restart badge + tooltip
- `VConfigPage` 加载、编辑、保存、丢弃、错误提示

对应文件：

- [ui/history-v3/vitest/navbar-config.test.ts](/home/xp/src/copilot-api-js/ui/history-v3/vitest/navbar-config.test.ts)
- [ui/history-v3/vitest/config-fields.test.ts](/home/xp/src/copilot-api-js/ui/history-v3/vitest/config-fields.test.ts)
- [ui/history-v3/vitest/config-page.test.ts](/home/xp/src/copilot-api-js/ui/history-v3/vitest/config-page.test.ts)

## 验证结果

已通过：

```bash
npm run typecheck:ui
```

```bash
bun x eslint ui/history-v3/src/components/config/ConfigSection.vue \
  ui/history-v3/src/components/config/ConfigRewriteRules.vue \
  ui/history-v3/vitest/helpers/mount.ts \
  ui/history-v3/vitest/config-fields.test.ts \
  ui/history-v3/tests/config-editor.test.ts \
  src/routes/config/route.ts \
  tests/http/config-yaml-routes.test.ts
```

```bash
npm run test:ui
```

```bash
bun test tests/http/config-yaml-routes.test.ts
```

验证时结果为：

- UI 测试：`176 pass, 0 fail`
- Vitest UI：`13 pass, 0 fail`
- config yaml 路由测试：`28 pass, 0 fail`

## 最终结论

`docs/config-page-design.md` 的 Config Page 方案已完成实施。

当前状态下：

- 核心功能已齐备
- 关键交互已补齐
- 后端 merge / 热重载语义已闭环
- 主要测试链路已覆盖
- 无剩余阻塞项

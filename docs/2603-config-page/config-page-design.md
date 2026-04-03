# Config Page 设计文档

## 概述

新增独立的 Config 页面，以可视化表单方式编辑 `config.yaml`，写回时尽量保留未修改节点的格式（注释、空行、缩进）。

## 目标

1. **可视化配置编辑**：每个配置字段用最合适的 UI 控件呈现（toggle、number input、enum selector、key-value list、rewrite rules editor 等），替代手动编辑 YAML 文件
2. **YAML Round-Trip 写回**：编辑后写回 config.yaml，尽量保留未修改节点的原始格式（注释、空行、缩进、字段顺序）
3. **保存后即时生效**：大部分字段保存后即时应用到运行时 state（需要对 `applyConfigToState()` 做适配，见"热重载适配"章节）；不可热重载的字段（`proxy`、`rate_limiter`）在 UI 上明确标注 "requires restart"
4. **输入校验**：后端校验所有字段值合法性，复用运行时相同的解析逻辑（如 `compileRewriteRule()`），避免 UI 保存了运行时无法加载的配置
5. **单列长表单布局**：底部 sticky 全局 Save 按钮，Discard 按钮重置到上次保存状态

## 非目标

- 不支持从 UI 修改 CLI 参数（`--auto-truncate`、`--verbose` 等）
- 不提供单独的"新建配置文件"流程或向导，但允许首次保存时隐式创建 config.yaml
- 不支持 config.yaml 之外的配置源（环境变量、CLI 参数）的展示或编辑
- 不提供 legacy UI 变体（仅 Vuetify）
- 不提供 config.yaml 语法错误的可视化修复，用户需手动修正文件

## 导航

NavBar 顺序调整为：**Dashboard | Config | Models | Logs | History | Usage**

路由：`/v/config` → `VConfigPage.vue`

### 路由变体处理

Config 页面只提供 Vuetify 版本，不创建 legacy `/config` 路由。需要处理的兼容点：

- **router.ts**：只注册 `/v/config`，不注册 `/config`
- **NavBar.vue**：`vuetifyLinks` 数组加入 Config；`legacyLinks` 数组不加入 Config（legacy 页面看不到此入口）
- **route-variants.ts**：`getVariantSwitchPath()` 需要 special-case `/v/config` —— 在 Config 页面时**隐藏** variant switch 按钮（因为没有 legacy 对应页面，跳转无意义）
- **两套 link 数组的顺序**同步调整为：Dashboard | Config | Models | Logs | History | Usage

## 架构

### 数据流概览

```
┌─────────────┐     GET /api/config/yaml      ┌──────────────────┐     fs.readFile      ┌──────────────┐
│  VConfigPage │ ──────────────────────────►  │  config route.ts  │ ──────────────────►  │  config.yaml  │
│  (前端)      │ ◄──────────────────────────  │  (后端)           │ ◄──────────────────  │  (文件)       │
│              │     ConfigYamlResponse        │                  │     yaml.parse()     │              │
│              │                               │                  │                      │              │
│              │     PUT /api/config/yaml      │                  │     parseDocument()  │              │
│              │ ──────────────────────────►  │  校验 → merge →  │     setIn/deleteIn   │              │
│              │ ◄──────────────────────────  │  写回 → reload    │     toString()       │              │
│              │     ConfigYamlResponse        │                  │     writeFile()      │              │
└─────────────┘                               └──────────────────┘                      └──────────────┘
                                                      │
                                                      │ applyConfigToState()
                                                      ▼
                                              ┌──────────────────┐
                                              │  runtime state    │
                                              │  (lib/state.ts)   │
                                              └──────────────────┘
```

### 职责划分

| 层 | 职责 | 不做什么 |
|----|------|---------|
| **VConfigPage.vue** | 页面壳：加载数据、渲染表单 sections、Save/Discard 按钮、toast | 不做 YAML 操作、不做字段校验 |
| **useConfigEditor.ts** | fetch/save、dirty tracking、error 状态管理 | 不做 UI 渲染 |
| **ConfigXxx.vue 组件** | 单个字段的 v-model 双向绑定、UI 控件选择 | 不做数据加载、不做 save |
| **PUT /api/config/yaml 后端** | body 校验、YAML Document merge、文件写回、热重载触发 | 不做前端状态管理 |
| **GET /api/config/yaml 后端** | 读取并解析 config.yaml 为结构化 JSON | 不返回运行时 state 或默认值 |

### 与现有系统的关系

| 现有模块 | 关系 |
|---------|------|
| `GET /api/config`（现有） | 返回运行时 state（含默认值 + CLI 参数）。保留不变，Dashboard 等其他消费者继续使用 |
| `loadConfig()`（`config.ts`） | 现有的 mtime-cached yaml 加载。被 `applyConfigToState()` 调用 |
| `loadRawConfigFile()`（**新增**） | 直接 `fs.readFile` + `yaml.parse()`，不走 mtime cache。`GET /api/config/yaml` 和 `PUT` 返回值共用此函数 |
| `applyConfigToState()`（`config.ts`） | PUT 写回文件后调用它触发热重载。**需要适配**，见下方"热重载适配"章节 |
| `resetConfigCache()`（`config.ts`） | PUT 写回后必须先调用此函数清除 debounce 缓存，否则 `applyConfigToState()` 可能读到旧值 |
| `compileRewriteRule()`（`config.ts`） | PUT 校验时复用，验证 rewrite rule 的 regex 合法性 |

### 热重载适配

当前 `applyConfigToState()` 的语义是 **merge-only**：只有 config.yaml 中显式存在的字段才覆盖 runtime state，被删除的 key 保持当前 runtime 值不变（注释："deleted keys keep current runtime value"，`config.ts:273-281`）。这在普通热重载场景下是合理的（避免用户删一行配置就意外重置），但对 Config 页面的"保存后即时生效"目标是不够的——用户在 UI 清空一个字段后，期望 runtime 回退到默认值。

**解决方案：新增 `resetConfigManagedState()` 函数**

为避免默认值在 `mutableState` 初始化和 reset 函数中重复硬编码（维护两份会漂移），实现时应**从单一来源派生**：

```typescript
/**
 * Default values for config-managed scalar/runtime fields.
 * Single source of truth — used by both mutableState initialization and resetConfigManagedState().
 * Note: model overrides continue to use DEFAULT_MODEL_OVERRIDES (already a single source).
 */
const CONFIG_MANAGED_DEFAULTS = {
  stripServerTools: false,
  immutableThinkingMessages: false,
  dedupToolCalls: false as const,
  stripReadToolResultTags: false,
  contextEditingMode: "off" as const,
  rewriteSystemReminders: false as const,
  systemPromptOverrides: [] as Array<CompiledRewriteRule>,
  compressToolResultsBeforeTruncate: true,
  fetchTimeout: 300,
  streamIdleTimeout: 300,
  staleRequestMaxAge: 600,
  shutdownGracefulWait: 60,
  shutdownAbortWait: 120,
  historyLimit: 200,
  historyMinEntries: 50,
  normalizeResponsesCallIds: true,
} satisfies Partial<State>

/**
 * Reset all config-managed fields to their default values.
 * Called before applyConfigToState() when config is explicitly saved via Config page,
 * ensuring deleted keys actually revert to defaults instead of keeping stale values.
 *
 * NOT called during normal per-request hot-reload — only via PUT /api/config/yaml.
 */
export function resetConfigManagedState(): void {
  setAnthropicBehavior({
    stripServerTools: CONFIG_MANAGED_DEFAULTS.stripServerTools,
    immutableThinkingMessages: CONFIG_MANAGED_DEFAULTS.immutableThinkingMessages,
    dedupToolCalls: CONFIG_MANAGED_DEFAULTS.dedupToolCalls,
    stripReadToolResultTags: CONFIG_MANAGED_DEFAULTS.stripReadToolResultTags,
    contextEditingMode: CONFIG_MANAGED_DEFAULTS.contextEditingMode,
    rewriteSystemReminders: CONFIG_MANAGED_DEFAULTS.rewriteSystemReminders,
    systemPromptOverrides: [...CONFIG_MANAGED_DEFAULTS.systemPromptOverrides],
    compressToolResultsBeforeTruncate: CONFIG_MANAGED_DEFAULTS.compressToolResultsBeforeTruncate,
  })
  setModelOverrides({ ...DEFAULT_MODEL_OVERRIDES })
  setTimeoutConfig({
    fetchTimeout: CONFIG_MANAGED_DEFAULTS.fetchTimeout,
    streamIdleTimeout: CONFIG_MANAGED_DEFAULTS.streamIdleTimeout,
    staleRequestMaxAge: CONFIG_MANAGED_DEFAULTS.staleRequestMaxAge,
  })
  setShutdownConfig({
    shutdownGracefulWait: CONFIG_MANAGED_DEFAULTS.shutdownGracefulWait,
    shutdownAbortWait: CONFIG_MANAGED_DEFAULTS.shutdownAbortWait,
  })
  setHistoryConfig({
    historyLimit: CONFIG_MANAGED_DEFAULTS.historyLimit,
    historyMinEntries: CONFIG_MANAGED_DEFAULTS.historyMinEntries,
  })
  setHistoryMaxEntries(CONFIG_MANAGED_DEFAULTS.historyLimit)
  setResponsesConfig({
    normalizeResponsesCallIds: CONFIG_MANAGED_DEFAULTS.normalizeResponsesCallIds,
  })
}
```

`mutableState` 初始化也应从 `CONFIG_MANAGED_DEFAULTS` 派生对应字段，确保单一来源。

**PUT 写回后的完整调用链：**

```
resetConfigCache()          ← 清除 loadConfig() 的 debounce 缓存
resetConfigManagedState()   ← 重置所有 config-managed 字段到默认值
applyConfigToState()        ← 从文件重新加载并覆盖
```

这样，删除的字段会回退到默认值（因为 reset 已经把它设为默认），而文件中存在的字段会被 apply 覆盖。

**重要约束：** `resetConfigManagedState()` 只在 PUT 路由中调用，普通的 per-request 热重载仍走原来的 merge-only 语义（不调用 reset）。这保持了现有行为的向后兼容。

## 后端 API

### `GET /api/config/yaml`

返回 config.yaml 的结构化解析结果（JSON）。未设置的字段不出现在响应中（区别于 `/api/config` 返回含默认值的运行时 state）。

如果 config.yaml 不存在，返回 `{}`（空对象）。

```typescript
interface ConfigYamlResponse {
  proxy?: string
  model_overrides?: Record<string, string>
  stream_idle_timeout?: number
  fetch_timeout?: number
  stale_request_max_age?: number
  model_refresh_interval?: number
  shutdown?: { graceful_wait?: number; abort_wait?: number }
  history?: { limit?: number; min_entries?: number }
  anthropic?: {
    strip_server_tools?: boolean
    dedup_tool_calls?: boolean | "input" | "result"
    immutable_thinking_messages?: boolean
    strip_read_tool_result_tags?: boolean
    context_editing?: "off" | "clear-thinking" | "clear-tooluse" | "clear-both"
    context_editing_trigger?: number
    context_editing_keep_tools?: number
    context_editing_keep_thinking?: number
    tool_search?: boolean
    auto_cache_control?: boolean
    non_deferred_tools?: string[]
    rewrite_system_reminders?: boolean | Array<ReminderRewriteRule>
  }
  "openai-responses"?: { normalize_call_ids?: boolean }
  rate_limiter?: {
    retry_interval?: number
    request_interval?: number
    recovery_timeout?: number
    consecutive_successes?: number
  }
  compress_tool_results_before_truncate?: boolean
  system_prompt_overrides?: Array<PromptOverrideRule>
  system_prompt_prepend?: string
  system_prompt_append?: string
}

/** rewrite_system_reminders 的规则——不支持 model 字段 */
interface ReminderRewriteRule {
  from: string
  to: string
  method?: "line" | "regex"
}

/** system_prompt_overrides 的规则——支持 model 字段 */
interface PromptOverrideRule {
  from: string
  to: string
  method?: "line" | "regex"
  model?: string
}
```

### `PUT /api/config/yaml`

接收同结构 JSON body。后端执行：

1. **校验**：验证所有字段值合法性，不合法返回 400 + 具体错误信息（见校验规则表）
2. `yaml.parseDocument()` 读取当前 config.yaml 文件（保留注释/格式的 Document 对象）。如果文件不存在，创建空 Document
3. **Scalar 字段**（boolean、number、string）：
   - 有值 → `doc.setIn()` 更新
   - 值为 null/undefined 且原文件**有**此 key → `doc.deleteIn()` 删除该 key（**绝不写 `null`**，因为运行时 `applyConfigToState()` 用 `!== undefined` 判断是否应用，`null` 会穿透进 state 造成类型污染）
   - 值为 null/undefined 且原文件**无**此 key → 跳过不写入
4. **Collection 字段**（`model_overrides`、`rewrite_system_reminders` array、`system_prompt_overrides` array）：**整段替换** subtree。先 `doc.deleteIn()` 移除旧节点，再 `doc.setIn()` 写入新值。接受这些 subtree 内部的注释会丢失
5. **Nested scalar 容器**（`shutdown`、`history`、`anthropic`、`openai-responses`、`rate_limiter`）：遍历子 key，每个子 key 按 scalar 字段规则处理（有值 setIn、清空 deleteIn、未发送跳过），保留容器节点和周围注释
6. 对于 body 中缺失的顶层 key（前端未发送），保持原文件不动
7. `doc.toString()` 序列化写回文件
8. 调用 `resetConfigCache()` 清除 `loadConfig()` 的 debounce 缓存（避免读到旧值）
9. 调用 `resetConfigManagedState()` 重置所有 config-managed 字段到默认值
10. 调用 `applyConfigToState()` 从文件重新加载并覆盖 state
11. 通过 `loadRawConfigFile()` 重新读取文件，返回结构化配置（确保返回值与文件一致，不走 mtime cache）

### 字段更新策略总结

| 策略 | 字段 | 注释保留 |
|------|------|---------|
| scalar setIn/deleteIn | `proxy`, `fetch_timeout`, `stream_idle_timeout`, `stale_request_max_age`, `model_refresh_interval`, `compress_tool_results_before_truncate`, `system_prompt_prepend`, `system_prompt_append` | 保留 |
| nested scalar setIn/deleteIn | `shutdown.*`, `history.*`, `anthropic.*`（scalar 子字段）, `openai-responses.*`, `rate_limiter.*` | 保留 |
| collection 整段替换 | `model_overrides`, `anthropic.rewrite_system_reminders`（array 形式）, `system_prompt_overrides` | subtree 内部注释丢失 |

**新增键**：`doc.setIn()` 会追加到 mapping 末尾，不保证特定位置。可接受。

### 校验规则

| 字段 | 校验规则 | 错误示例 |
|------|---------|---------|
| enum 字段（`context_editing`、`dedup_tool_calls`） | 值必须在允许列表内 | `context_editing: "invalid"` → 400 |
| number 字段（所有超时值、history limit 等） | 必须为非负整数 | `fetch_timeout: -1` → 400 |
| regex 字段（rewrite rules 的 from） | 调用 `compileRewriteRule()` 验证（复用运行时逻辑，正确处理 `(?i)` 等 inline flags），失败返回 400 | `from: "(?P<invalid"` → 400 |
| key-value map 的 key（`model_overrides`） | 非空字符串（重复 key 去重由前端 `ConfigKeyValueList` 在 UI 层阻止，JSON object 序列化后后端无法检测重复） | `"": "target"` → 400 |
| proxy | 如果提供，必须是合法 URL scheme（http/https/socks5/socks5h） | `proxy: "ftp://..."` → 400 |
| `rewrite_system_reminders`（boolean 形式） | 必须是 `true` 或 `false` | `rewrite_system_reminders: "yes"` → 400 |

### 错误响应格式

```typescript
// 400 响应 body
interface ConfigValidationError {
  error: string              // 人类可读的错误摘要
  details: Array<{
    field: string            // 字段路径，如 "anthropic.context_editing"
    message: string          // 具体错误信息
    value?: unknown          // 触发错误的值（可选，便于调试）
  }>
}
```

### 路由注册

在 `src/routes/config/route.ts` 中新增端点，复用同一 Hono 路由组：

```typescript
// 现有
configRoutes.get("/", ...)          // GET /api/config（运行时 state，保留不变）

// 新增
configRoutes.get("/yaml", ...)      // GET /api/config/yaml（文件内容）
configRoutes.put("/yaml", ...)      // PUT /api/config/yaml（编辑保存）
```

## 前端

### 页面布局

单列垂直滚动表单，分段排列：

```
┌──────────────────────────────────────────┐
│ Config                            [Save] │  ← sticky header/toolbar
├──────────────────────────────────────────┤
│ ▸ General                                │
│   proxy .............. [text input] ⚠    │  ← ⚠ = "requires restart"
│   compress_tool_... .. [toggle]          │
│                                          │
│ ▸ Anthropic Pipeline                     │
│   strip_server_tools . [toggle]          │
│   dedup_tool_calls ... [false|input|res] │
│   context_editing .... [off|ct|cu|both]  │
│   immutable_thinking . [toggle]          │
│   strip_read_tool_... [toggle]           │
│   rewrite_system_rem  [rules editor]     │
│                                          │
│ ▸ System Prompt                          │
│   system_prompt_prepend [textarea]       │
│   system_prompt_append  [textarea]       │
│   system_prompt_overrides [rules editor] │
│                                          │
│ ▸ OpenAI Responses                       │
│   normalize_call_ids . [toggle]          │
│                                          │
│ ▸ Timeouts                               │
│   fetch_timeout ...... [number] s        │
│   stream_idle_timeout  [number] s        │
│   stale_request_max_.. [number] s        │
│   model_refresh_i... [number] s        │
│                                          │
│ ▸ Shutdown                               │
│   graceful_wait ...... [number] s        │
│   abort_wait ......... [number] s        │
│                                          │
│ ▸ History                                │
│   limit .............. [number]          │
│   min_entries ........ [number]          │
│                                          │
│ ▸ Model Overrides                        │
│   [key] → [value]              [×]      │
│   [key] → [value]              [×]      │
│   [+ Add override]                       │
│                                          │
│ ▸ Rate Limiter                     ⚠    │  ← ⚠ = "requires restart"
│   retry_interval ..... [number] s        │
│   request_interval ... [number] s        │
│   recovery_timeout ... [number] min      │
│   consecutive_successes [number]         │
│                                          │
├──────────────────────────────────────────┤
│ [Discard]                        [Save]  │  ← sticky footer
└──────────────────────────────────────────┘
```

### "Requires restart" 标注

`proxy` 和 `rate_limiter` 不可热重载（代码依据：`applyConfigToState()` 注释 "NOT hot-reloaded: rate_limiter"，`proxy` 在启动时一次性读取），在 UI 上：
- Section 标题或字段旁显示 ⚠ 图标 + "Requires restart to take effect" tooltip
- 保存包含这些字段变更时，toast 提示 "Some changes require a restart to take effect"

### 字段类型 → 控件映射

| 字段类型 | 控件 | Vuetify 组件 | 示例字段 |
|---------|------|-------------|---------|
| boolean | Toggle switch | `v-switch` | `strip_server_tools` |
| number | Number input + 单位 | `v-text-field type=number` + suffix | `fetch_timeout`, `model_refresh_interval` |
| enum (string) | Segmented buttons | `v-btn-toggle` | `context_editing`, `dedup_tool_calls` |
| string (optional) | Text input | `v-text-field` | `proxy` |
| multiline text | Textarea | `v-textarea` | `system_prompt_prepend` |
| key-value map | Inline list (key→value) | 自定义组件 | `model_overrides` |
| rewrite rules (no model) | 可折叠规则卡片 (from/to/method) | 自定义组件 | `rewrite_system_reminders` |
| override rules (with model) | 可折叠规则卡片 (from/to/method/model) | 自定义组件 | `system_prompt_overrides` |

### RewriteRule 类型区分

`rewrite_system_reminders` 和 `system_prompt_overrides` 虽然结构相似，但 `model` 字段只有 `system_prompt_overrides` 支持。运行时依据：`rewriteReminder()` 不读取 `modelPattern`，`config.example.yaml:118` 注释明确写了 "rewrite_system_reminders 不支持 model"。

前端使用同一个 `ConfigRewriteRules.vue` 组件，通过 prop 控制是否显示 `model` 字段：

```typescript
// ConfigRewriteRules.vue
defineProps<{
  modelValue: Array<{ from: string; to: string; method?: string; model?: string }>
  showModelField?: boolean  // 只有 system_prompt_overrides 传 true
}>()
```

### 组件结构

```
pages/vuetify/VConfigPage.vue             # 页面壳：toolbar + save + sections
components/config/
  ConfigSection.vue                        # 分段容器（标题 + 描述 + restart 标记 + slot）
  ConfigToggle.vue                         # boolean 字段（v-switch + label + description）
  ConfigNumber.vue                         # 数值字段（v-text-field + suffix）
  ConfigEnum.vue                           # 枚举字段（v-btn-toggle）
  ConfigText.vue                           # 单行/多行文本
  ConfigKeyValueList.vue                   # key→value 映射列表
  ConfigRewriteRules.vue                   # rewrite rules 可折叠编辑器（showModelField prop）
composables/
  useConfigEditor.ts                       # 数据加载、dirty tracking、save 逻辑
```

### 组件 Props 规范

所有字段组件遵循统一接口：

```typescript
// 通用字段 props（所有 ConfigXxx 组件）
interface ConfigFieldProps {
  modelValue: T              // v-model 绑定值
  label: string              // 字段显示名
  description?: string       // 字段说明文字
  disabled?: boolean         // 是否禁用
}

// ConfigNumber 额外 props
interface ConfigNumberProps extends ConfigFieldProps {
  suffix?: string            // 单位标签（"s"、"min"）
  min?: number               // 最小值
  max?: number               // 最大值
}

// ConfigEnum 额外 props
interface ConfigEnumProps extends ConfigFieldProps {
  options: Array<{ value: string; label: string }>
}

// ConfigSection props
interface ConfigSectionProps {
  title: string              // Section 标题
  description?: string       // Section 说明
  requiresRestart?: boolean  // 是否显示 ⚠ 标记
}
```

### useConfigEditor composable

```typescript
interface UseConfigEditor {
  // State
  config: Ref<ConfigYamlResponse | null>  // 当前编辑中的配置
  original: Ref<ConfigYamlResponse | null> // 上次加载/保存的快照
  loading: Ref<boolean>
  saving: Ref<boolean>
  error: Ref<string | null>
  isDirty: ComputedRef<boolean>            // deep compare config vs original
  hasRestartFields: ComputedRef<boolean>   // dirty 字段中是否包含 restart-required 字段

  // Actions
  load(): Promise<void>                    // GET /api/config/yaml
  save(): Promise<void>                    // PUT /api/config/yaml
  discard(): void                          // 重置 config 到 original（deep clone）
}
```

**dirty tracking 实现**：`isDirty` 通过 `JSON.stringify(config) !== JSON.stringify(original)` 做 deep compare。约束：所有编辑态对象在进入 state 前需做 canonicalize（移除 `undefined` 值、确保 key 顺序稳定），避免脏状态误判。当前配置结构体量有限，不会有性能问题。

**hasRestartFields 实现**：比较 `config` 和 `original` 中 `proxy` 和 `rate_limiter` 的差异。

### Save 流程

1. 用户修改字段 → v-model 更新 `config` ref → `isDirty` 变为 true → Save 按钮高亮
2. 点击 Save → **保存前**快照 `const requiresRestart = hasRestartFields.value`（在 `original` 更新前读取，避免 ComputedRef 在步骤 6 后变 false 的时序问题）
3. `PUT /api/config/yaml` 发送 `config` 值
4. 后端校验 → 校验失败返回 400 + error details → 前端显示 error toast（包含具体字段错误）
5. 后端校验通过 → 写文件 → `resetConfigCache()` → `resetConfigManagedState()` → `applyConfigToState()` → `loadRawConfigFile()` 返回新配置
6. 前端更新 `original` = deep clone(返回值)，`isDirty` 回到 false
7. 显示 success toast；如果步骤 2 快照的 `requiresRestart` 为 true，额外提示 "Some changes require a restart"

### 边界情况处理

| 场景 | 行为 |
|------|------|
| config.yaml 不存在 | GET 返回 `{}`，前端显示全空表单。首次 PUT 创建文件 |
| config.yaml 解析失败（非法 YAML） | GET 返回 500 + 结构化错误信息 `{ error, details }`，前端显示错误提示 |
| 并发编辑（用户在编辑时外部修改了文件） | PUT 基于当前文件内容 merge，不做乐观锁。用户的 UI 编辑会覆盖外部修改的相同字段 |
| Save 网络失败 | 显示 error toast，保留编辑状态，不清除 dirty |
| 空 model_overrides（用户删除所有 override） | 发送 `model_overrides: {}`，后端写入空 mapping |
| 空 rewrite rules（用户删除所有规则） | 发送 `rewrite_system_reminders: false`（规范形式，表示禁用。不发送空 array `[]`，避免序列化歧义） |

### 不可编辑字段

以下字段不在 Config 页面中出现（它们不是 config.yaml 的字段，来自 CLI 参数）：

- `autoTruncate`（`--auto-truncate` / `--no-auto-truncate`）
- `verbose`（`--verbose`）
- `showGitHubToken`（`--show-github-token`）

## Dashboard 变更

- 移除 `DashboardConfigPanel` 组件的使用
- 从 `VDashboardPage.vue` 中删除 config 相关的 import 和渲染
- `useDashboardStatus.ts` 中移除 `configGroups` 相关逻辑和 `fetchConfig` 轮询
- `DashboardConfigPanel.vue` 文件删除

## YAML Round-Trip 实现

使用项目已有的 `yaml` v2（`^2.8.3`）依赖的 Document API：

```typescript
import { parseDocument } from "yaml"

// 读取并解析（保留注释）
const content = await fs.readFile(configPath, "utf8")
const doc = parseDocument(content)

// Scalar 字段：逐个 setIn（保留周围格式）
doc.setIn(["fetch_timeout"], 600)
doc.setIn(["model_refresh_interval"], 600)

// 清空已有 optional scalar：deleteIn 删除 key（绝不写 null）
doc.deleteIn(["proxy"])

// Nested scalar：逐个 setIn 子 key
doc.setIn(["anthropic", "strip_server_tools"], true)

// Collection 字段：整段替换（subtree 内部注释会丢失）
doc.deleteIn(["model_overrides"])
doc.setIn(["model_overrides"], doc.createNode({ opus: "claude-opus-4.6-1m", haiku: "claude-sonnet-4.6" }))

// 写回
await fs.writeFile(configPath, doc.toString())
```

### 格式保留边界

- **保留**：未修改的 scalar 字段及周围注释、文档级注释、字段顺序、空行
- **可能丢失**：被整段替换的 collection 字段（`model_overrides`、rule arrays）内部的注释
- **新增键**：追加到所属 mapping 末尾，不保证特定位置

这是 `yaml` Document API 的固有限制，产品上可接受——用户通过 UI 编辑 collection 字段时，心理预期是"UI 就是真相"，不会期望 YAML 文件内联注释被保留。

## 涉及的文件变更清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `ui/history-v3/src/pages/vuetify/VConfigPage.vue` | Config 页面 |
| `ui/history-v3/src/composables/useConfigEditor.ts` | 编辑器逻辑 composable |
| `ui/history-v3/src/components/config/ConfigSection.vue` | 分段容器 |
| `ui/history-v3/src/components/config/ConfigToggle.vue` | Boolean 控件 |
| `ui/history-v3/src/components/config/ConfigNumber.vue` | Number 控件 |
| `ui/history-v3/src/components/config/ConfigEnum.vue` | Enum 控件 |
| `ui/history-v3/src/components/config/ConfigText.vue` | Text/Textarea 控件 |
| `ui/history-v3/src/components/config/ConfigKeyValueList.vue` | Key-value 列表控件 |
| `ui/history-v3/src/components/config/ConfigRewriteRules.vue` | Rewrite rules 编辑器 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/routes/config/route.ts` | 新增 `GET /yaml` 和 `PUT /yaml` 端点 |
| `src/lib/config/config.ts` | 新增 `loadRawConfigFile()` 函数；导出 `resetConfigCache()` |
| `src/lib/state.ts` | 新增 `resetConfigManagedState()` 函数 |
| `ui/history-v3/src/router.ts` | 新增 `/v/config` 路由，调整路由顺序 |
| `ui/history-v3/src/components/layout/NavBar.vue` | 更新 link 数组顺序，加入 Config |
| `ui/history-v3/src/utils/route-variants.ts` | Special-case `/v/config` |
| `ui/history-v3/src/api/http.ts` | 新增 `fetchConfigYaml()` 和 `saveConfigYaml()` |
| `ui/history-v3/src/pages/vuetify/VDashboardPage.vue` | 移除 ConfigPanel |
| `ui/history-v3/src/composables/useDashboardStatus.ts` | 移除 configGroups 和 fetchConfig |

### 删除文件

| 文件 | 原因 |
|------|------|
| `ui/history-v3/src/components/dashboard/DashboardConfigPanel.vue` | 被独立 Config 页面取代 |

## 测试计划

### 后端测试

#### 1. GET /api/config/yaml 路由测试

| 用例 | 预期 |
|------|------|
| config.yaml 存在且有效 | 返回 200 + 结构化 JSON，字段与文件内容一致 |
| config.yaml 不存在 | 返回 200 + `{}` |
| config.yaml 包含所有已知字段 | 返回完整 ConfigYamlResponse |
| config.yaml 只有部分字段 | 返回只有那些字段的 JSON，其余缺失 |

#### 2. PUT /api/config/yaml 校验测试

| 用例 | 预期 |
|------|------|
| 非法 enum 值（`context_editing: "invalid"`） | 400 + field error |
| 负数超时值（`fetch_timeout: -1`） | 400 + field error |
| 非法 regex pattern（`from: "(?P<invalid"`） | 400 + field error |
| 合法 inline flags regex（`from: "(?i)pattern"`） | 200（不被误拒） |
| 空 key 的 model_overrides（`"": "target"`） | 400 + field error |
| 非法 proxy scheme（`proxy: "ftp://..."`） | 400 + field error |
| 合法完整配置 | 200 + 返回更新后配置 |
| 空 body `{}` | 200（保持文件不变） |

#### 3. PUT /api/config/yaml YAML merge 测试

| 用例 | 预期 |
|------|------|
| 修改 scalar 字段（`fetch_timeout: 600 → 300`） | 值更新，周围注释保留 |
| 清空已有 optional scalar（`proxy: "..." → null`） | key 从文件删除（不是写 `null`） |
| 清空不存在的字段（`proxy: null`，文件无 proxy） | 文件不变 |
| 修改 nested scalar（`anthropic.strip_server_tools: false → true`） | 子 key 更新，容器和周围注释保留 |
| 清空 nested scalar（`shutdown.graceful_wait: null`） | 子 key 删除，shutdown 容器保留 |
| 整段替换 model_overrides | 旧 mapping 被新值替换，内部注释丢失 |
| 删除 model_overrides 中的一个 key | 整段替换后该 key 不存在 |
| 添加新 model_override | 整段替换后新 key 出现 |
| 整段替换 rewrite rules array | 旧 array 被新值替换 |
| 未发送的顶层 key（body 不含 `shutdown`） | 文件中 shutdown 保持原样 |
| 文件不存在时 PUT | 创建新文件 |
| 写回后 `applyConfigToState()` 被调用 | 运行时 state 更新 |

#### 4. PUT /api/config/yaml 格式保留测试

| 用例 | 预期 |
|------|------|
| 修改 scalar，文件有注释 | `toString()` 输出中未修改部分的注释保留 |
| 未做任何修改的 PUT | `toString()` 输出中未修改节点的结构、注释、顺序保持不变（不做字节级一致性断言，避免对 serializer 细节的脆弱绑定） |

#### 5. 热重载适配测试（resetConfigManagedState + debounce bypass）

| 用例 | 预期 |
|------|------|
| PUT 删除 `fetch_timeout`（文件中有 → 清空） | runtime `state.fetchTimeout` 回退到默认值 300 |
| PUT 删除 `anthropic.strip_server_tools` | runtime `state.stripServerTools` 回退到默认值 false |
| PUT 删除整个 `shutdown` section | runtime `state.shutdownGracefulWait` 和 `shutdownAbortWait` 回退到默认值 |
| PUT 删除 `model_overrides` | runtime `state.modelOverrides` 回退到 `DEFAULT_MODEL_OVERRIDES` |
| PUT 删除 `system_prompt_overrides` | runtime `state.systemPromptOverrides` 回退到空 array |
| PUT 保存修改值（`fetch_timeout: 600`） | runtime `state.fetchTimeout` 更新为 600（不是默认值） |
| PUT 在 `loadConfig()` debounce 窗口内（2s 内多次调用） | `resetConfigCache()` 清除缓存后 apply 读到新值，不命中旧缓存 |
| `resetConfigManagedState()` 不被普通 per-request 热重载调用 | 手动修改 config.yaml（不通过 PUT）后，删除的 key 保持旧 runtime 值（merge-only 语义不变） |
| `CONFIG_MANAGED_DEFAULTS` 与 `mutableState` 初始值一致 | 断言 `CONFIG_MANAGED_DEFAULTS` 中每个字段的值等于 `mutableState` 对应字段初始值，防止默认值漂移 |

### 前端测试

#### 6. 前端路由和导航测试

| 用例 | 预期 |
|------|------|
| 访问 `/v/config` | VConfigPage 渲染成功 |
| NavBar 在 Vuetify 模式下显示 Config 链接 | Config 出现在 Dashboard 后面 |
| NavBar 在 legacy 模式下不显示 Config | Config 不出现在 legacyLinks 中 |
| NavBar 链接顺序 | Dashboard, Config, Models, Logs, History, Usage |
| Variant switch 在 `/v/config` 上 | 隐藏（不显示 switch 按钮） |

#### 7. useConfigEditor composable 测试

| 用例 | 预期 |
|------|------|
| `load()` 成功 | `config` 和 `original` 设为返回值，`loading` 变为 false |
| `load()` 失败 | `error` 设置错误信息，`loading` 变为 false |
| 修改 `config` 的某个字段 | `isDirty` 变为 true |
| 修改后恢复到原值 | `isDirty` 变回 false |
| `save()` 成功 | `original` 更新为返回值，`isDirty` 变为 false |
| `save()` 400 校验失败 | `error` 设置，`config` 保留编辑状态 |
| `save()` 网络失败 | `error` 设置，`config` 保留编辑状态 |
| `discard()` | `config` deep clone 回 `original`，`isDirty` 变为 false |
| `hasRestartFields` 检测 | 修改 proxy → true；修改 fetch_timeout → false |

#### 8. 字段组件测试

| 组件 | 用例 |
|------|------|
| ConfigToggle | v-model 双向绑定、label 显示、disabled 状态 |
| ConfigNumber | v-model 双向绑定、suffix 显示、最小值约束 |
| ConfigEnum | v-model 双向绑定、选项渲染、选中高亮 |
| ConfigText | v-model 双向绑定、textarea mode（multiline prop） |
| ConfigKeyValueList | 添加/删除 entry、key 和 value 编辑、空列表显示 |
| ConfigRewriteRules | 添加/删除 rule、展开/折叠、method 切换、showModelField 控制 model 字段显示 |
| ConfigSection | 标题渲染、requiresRestart 显示 ⚠ 图标 |

#### 9. VConfigPage 集成测试

| 用例 | 预期 |
|------|------|
| 页面加载 | 显示 loading → 表单渲染 → 所有 section 可见 |
| Save 按钮初始状态 | disabled（isDirty = false） |
| 修改字段后 Save 按钮 | enabled（isDirty = true） |
| 点击 Save 成功 | toast 显示 success，Save 按钮回到 disabled |
| 点击 Save 含 restart 字段 | toast 额外提示 restart |
| 点击 Discard | 字段值回到上次保存状态 |
| Save 校验失败 | toast 显示错误信息 |

## 约束

- **前端只传结构化数据**：不直接操作 YAML 文本，round-trip 逻辑完全在后端
- **`proxy` 和 `rate_limiter` 标注 "requires restart"**：UI 上显示提示，因为它们不可热重载
- **`rewrite_system_reminders` 不暴露 `model` 字段**：运行时不支持，UI 不误导
- **Scalar 清空 = deleteIn**：绝不把 `null` 写进 YAML，避免运行时类型污染
- **Regex 校验复用运行时逻辑**：调用 `compileRewriteRule()`，不另起 `new RegExp()` 规则
- **Collection 字段整段替换**：接受 subtree 注释丢失，确保删除操作正确

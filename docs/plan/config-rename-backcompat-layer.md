# 配置项重命名 + 独立向后兼容层

## Context（背景）

当前 `config.yaml` 的配置项命名存在三类**真实缺陷**（非主观偏好）：

1. **一致性破缺**：`openai-responses` 是全配置唯一用连字符的 section（其它都 snake_case）；同 section 内 `ws`/`websocket` 缩写混用（`client_websocket_keep_open` 与 `max_client_ws_connections` 指同一个 client WS）；`efforts_overrides` 复数与 `model_overrides` 不一致。
2. **名实不符**：`thinking_block_sanitize_check` 的 `_check` 后缀暗示返回 bool，但值是策略枚举（`empty_thinking`/`empty_any`/`false`）；`rate_limiter.recovery_timeout` 单位是**分钟**而邻居 `retry_interval`/`request_interval` 是**秒**，命名零提示。
3. **层级归属错误**：三个 timeout 项（`stream_idle_timeout`/`fetch_timeout`/`stale_request_max_age`）扁平在顶层且风格分裂；`compress_tool_results_before_truncate`（顶层）与 `auto_truncate.compress_threshold`（section）是同一行为的开关+阈值却被割裂。

用户已确认**含结构性重组**的改名范围（两轮 AskUserQuestion 决策见下），并追加要求：**新增一个独立的配置向后兼容重定向层**，系统化、优雅地把旧配置名、旧值（含单位/语义变化）迁移到最新版本——而非把迁移规则散落在 `schema.ts`。

预期结果：配置命名一致、名实相符、结构合理；所有旧配置文件**零用户成本自动迁移**（旧键 → 新键 + 值换算，warn 一次）；迁移规则集中在专门模块，便于未来扩展。

---

## 一、命名映射表（8 项，已经用户拍板）

| # | 旧 key | 新 key | 类型 | 值变换 |
|---|--------|--------|------|--------|
| 1 | `openai-responses`（section） | `openai_responses` | section 改名 | — |
| 1a | `openai-responses.upstream_websocket` | `openai_responses.upstream_ws` | 内部字段改名 | — |
| 1b | `openai-responses.client_websocket_keep_open` | `openai_responses.client_ws_keep_open` | 内部字段改名 | — |
| 1c | `openai-responses.{normalize_call_ids, fix_stream_ids, max_ws_frame_bytes, max_client_ws_connections, max_upstream_ws_connections}` | 同名（仅随 section 改名） | 路径变 | — |
| 2 | `anthropic.efforts_overrides` | `anthropic.effort_overrides` | 改名（单数） | — |
| 3 | `anthropic.thinking_block_sanitize_check` | `anthropic.thinking_block_sanitize` | 改名（去误导的 `_check`） | — |
| 4 | `rate_limiter.recovery_timeout`（分钟） | `rate_limiter.recovery_interval`（秒） | 改名 + 单位统一 | **×60**（分→秒，保持行为不变） |
| 5 | `stream_idle_timeout`（顶层） | `timeouts.stream_idle` | 移入新 section | — |
| 6 | `fetch_timeout`（顶层） | `timeouts.response_header` | 移入新 section + 改名（语义=响应头超时） | — |
| 7 | `stale_request_max_age`（顶层） | `timeouts.stale_request_max_age` | 移入新 section（叶名不变） | — |
| 8 | `compress_tool_results_before_truncate`（顶层） | `auto_truncate.compress_tool_results` | 移入已有 section + 改名 | — |

**不改**（已确认）：`model_refresh_interval`（是刷新周期非 timeout，留顶层）、`thinking_signature_compat`、`coerce_adaptive_thinking`（语义与 block 策略不同，不强统一前缀）、`normalize_call_ids`/`fix_stream_ids`（动词各自清晰）。

**决策来源**：timeouts section + fetch 改名 / ws 统一缩写 / 仅统一 thinking_block 两件 / rate_limiter 统一为秒 —— 均用户选定。`recovery_timeout`→`recovery_interval` 是「统一为秒」的落地解读（同时修了 interval/timeout 混用）。

---

## 二、架构：独立向后兼容重定向层（用户新需求）

**现状**：迁移逻辑分散——`DeprecatedKey` 接口 + `DEPRECATED_KEYS` 数组定义在 `src/lib/config/schema.ts:453-496`（仅 3 条历史迁移），由 `validation.ts:57` 的 `extractAndTranslateDeprecated()` 通用消费（`deepMergeMissingOnly` 已支持嵌套 patch 深合并 —— 已验证能表达 section 改名 / 顶层→section / 跨 section 搬迁 / 值变换）。

**目标**：抽出为专门模块 `src/lib/config/compat.ts`，职责单一——schema 只管「当前合法形状」，compat 只管「旧→新重定向」。

### 2.1 新建 `src/lib/config/compat.ts`

- 迁移 `DeprecatedKey` 接口（重命名为 `ConfigMigration`，保留 `path`/`parentPath`/`key`/`message`/`translate` 字段，向后兼容旧语义）。
- 提供**声明式构造 helper**（让「优雅处理」名副其实，减少手写 `translate` 样板）：
  - `renameLeaf(oldPath, newPath, opts?: { transform?: (v) => unknown })` —— 叶子改名/移位，可选值变换。生成 `parentPath`/`key`/`translate`（translate 把 `newPath` 拆成嵌套 patch，对 value 应用 `transform`）。
  - `renameSection(oldKey, newKey, opts?: { fieldRenames?: Record<string,string> })` —— 整个 section 改名，可重映射内部字段（用于 #1，把 `upstream_websocket`→`upstream_ws` 等内部 rename 一并完成；否则旧 ws 值进入新 section 会被 `.strict()` 剥离丢失）。
- 导出 `CONFIG_MIGRATIONS: ReadonlyArray<ConfigMigration>`，含：
  - **3 条历史迁移**（从 schema.ts 原样搬来）：`anthropic.immutable_thinking_messages`、`anthropic.auto_cache_control`、`history.min_entries`。
  - **本次 8 项**（用 helper 声明）：
    ```
    renameSection("openai-responses", "openai_responses", {
      fieldRenames: { upstream_websocket: "upstream_ws", client_websocket_keep_open: "client_ws_keep_open" },
    })
    renameLeaf("anthropic.efforts_overrides", "anthropic.effort_overrides")
    renameLeaf("anthropic.thinking_block_sanitize_check", "anthropic.thinking_block_sanitize")
    renameLeaf("rate_limiter.recovery_timeout", "rate_limiter.recovery_interval", { transform: (v) => typeof v === "number" ? v * 60 : v })
    renameLeaf("stream_idle_timeout", "timeouts.stream_idle")
    renameLeaf("fetch_timeout", "timeouts.response_header")
    renameLeaf("stale_request_max_age", "timeouts.stale_request_max_age")
    renameLeaf("compress_tool_results_before_truncate", "auto_truncate.compress_tool_results")
    ```

### 2.2 接线

- `validation.ts:25` 改为从 `./compat` 导入 `CONFIG_MIGRATIONS`（替换 `DEPRECATED_KEYS`）；`extractAndTranslateDeprecated` 逻辑**不变**（已通用）。
- `schema.ts`：移除 `DeprecatedKey` 接口 + `DEPRECATED_KEYS`（迁至 compat.ts）。
- **去重保证**：`renameLeaf("fetch_timeout"...)` 与 `renameLeaf("stream_idle_timeout"...)` 等多条往同一 `timeouts` section 合并，依赖 `deepMergeMissingOnly` 的累积深合并（已验证 deepMergeMissingOnly 递归对 `timeouts` 对象逐字段累积，不互相覆盖）。
- **helper 的 path 反推算法（验证发现：是整层根基，必须精确）**：`extractAndTranslateDeprecated`（validation.ts:60-68）靠 `parentPath`/`key` 三字段 `navigate` 到父节点再 `delete` 旧键，算错则旧键残留 → 被 `.strict()` + `cleanInvalidPaths` 静默剥离（用户设置无声丢失）。helper 必须从 dotted `oldPath` 正确拆出：`key` = 最后一段、`parentPath` = 前缀（顶层键 parentPath=`""`）、`path` = 完整 oldPath（用于 warn dedup）。`translate` 反向把 dotted `newPath` 构造成嵌套 patch 对象（如 `"timeouts.response_header"` → `{timeouts:{response_header:transform(v)}}`）。新增 `tests/config/config-compat.unit.test.ts` 须显式覆盖顶层旧键（parentPath=""）与嵌套旧键（parentPath="anthropic"）两种 delete 路径。

### 2.3 PUT 路径也走兼容层（CRITICAL C3——「优雅处理旧配置名」必须覆盖 HTTP API）

`validateConfigInput`（validation.ts:213-226，PUT `/api/config/yaml` 用）当前直接 `ConfigSchema.safeParse`、**不跑** `extractAndTranslateDeprecated`，且 schema `.strict()`。重命名后，任何携旧键的 PUT body 会 `400 "Unknown config field"`，与「零成本自动迁移」承诺矛盾，且 PUT API 是外部 automation 入口。

**方案（采纳，契合用户「优雅处理旧名」意图）**：`validateConfigInput` 在 `safeParse` 前先跑 `extractAndTranslateDeprecated`（迁移=输入规范化）。旧键被迁移成新键后再校验/写回，用户文件被顺势规范化。保留 accept-or-reject + 结构化错误语义（迁移后仍非法才报错）。新增 PUT-旧键 测试：PUT `{fetch_timeout: 30}` → 期望 200 且写回 `timeouts.response_header: 30`。

---

## 三、Schema 改动（`src/lib/config/schema.ts`）

1. **新增 `TimeoutsConfigSchema`**（`.strict()`）：`stream_idle` / `response_header` / `stale_request_max_age`，均 `nullableNonnegativeInt()`。
2. **`ConfigSchema` 顶层**：删除 `stream_idle_timeout`/`fetch_timeout`/`stale_request_max_age`/`compress_tool_results_before_truncate`（schema.ts:425,437,438,439）；新增 `timeouts: nullableSection(TimeoutsConfigSchema)`。
3. **`AutoTruncateConfigSchema`**（schema.ts:288-299）：新增 `compress_tool_results: nullableBoolean()`。
4. **`ResponsesConfigSchema`**：`upstream_websocket`→`upstream_ws`（:249）、`client_websocket_keep_open`→`client_ws_keep_open`（:251）。
5. **`ConfigSchema` section key**：`"openai-responses"`→`openai_responses`（:410，去引号，合法标识符）。
6. **`AnthropicConfigSchema`**：`efforts_overrides`→`effort_overrides`（:228）、`thinking_block_sanitize_check`→`thinking_block_sanitize`（:166）。
7. **`RateLimiterConfigSchema`**：`recovery_timeout`→`recovery_interval`（:140），注释标明单位=秒。
8. **导出类型 `ResponsesConfig`/`Config` 等**自动随 `z.infer` 更新；新增 `export type TimeoutsConfig`。
9. 注释引用同步（:22, :205, :509, :528）。
10. `RECORD_MERGE_STRATEGIES`：**无需改**（`effort_overrides` 仍内联 `z.record`，默认 `replace`，与原 `efforts_overrides` 一致）。

### 已提交的生成产物 `config.schema.json`（CRITICAL C1——原计划漏了）
仓库根 `config.schema.json` 是 **committed 的 JSON Schema 生成产物**（`scripts/generate-config-json-schema.ts`，npm script `generate:config-schema`），供 YAML LSP / VS Code 自动补全。它含全部 8 个旧键字面量。重命名后若不重新生成，编辑器会继续向用户提示**已被 schema 拒绝的旧键名**。
- **执行**：改完 schema.ts 后运行 `bun run generate:config-schema`，**提交**更新后的 `config.schema.json`。这是可执行产物，非文档。

---

## 四、后端 apply / 写入

### `src/lib/config/config.ts`（apply 读取，13 处）
- thinking_block_sanitize（:401-402）、effort_overrides（:429-431，含 `normalizeModelKeyedRecord` 的 label 字符串改 `"anthropic.effort_overrides"`）。
- openai_responses：`config["openai_responses"]`（:539）、`.upstream_ws`（:541）、`.client_ws_keep_open`（:543-544）。
- **timeouts 嵌套读取**（:531/532/535）：改为 `config.timeouts?.response_header` / `config.timeouts?.stream_idle` / `config.timeouts?.stale_request_max_age`；更新注释 `// Top-level timeouts`。
- **compress 移入 auto_truncate 块**（:494-495）：移到 `if (config.auto_truncate)` 块内（:481-491），读 `a.compress_tool_results`。
- **state 字段名（`fetchTimeout`/`effortsOverrides`/`upstreamWebSocket`/`thinkingBlockSanitizeCheck` 等）保持不变**（内部运行时字段，与 config key 解耦，本次不改名 —— 降低 diff）。

### `src/routes/config/route.ts`（PUT YAML 写入，6 块）
- effort 无关；改 :208（`openai-responses`×3 → `openai_responses`）。
- **timeouts 三项**（:192-194）：从三个独立 `setScalar(doc, ["xxx"], body.xxx)` 重构为 `setNestedScalarContainer(doc, ["timeouts"], body.timeouts)`（参照现有 `["openai-responses"]`/`shutdown` 容器写法）。
- **compress**（:196-197）：新增 `auto_truncate` 容器写处理（当前 route.ts 无 auto_truncate 写逻辑），key 改 `["auto_truncate","compress_tool_results"]`。
- recovery：:198/759 等若存在 `recovery_timeout` 字符串改 `recovery_interval`（见测试清单）。

### rate_limiter 单位「秒化」必须全链路贯穿（CRITICAL，原计划严重低估）
「统一为秒」不只是 config 层换名——必须贯穿运行时字段、默认值、单位换算、日志、前端 UI，否则产生静默观测损坏 + fresh-install 默认值不一致。涉及 4 个文件**原子同改**：

- **`src/lib/adaptive-rate-limiter.ts`**：内部字段 `recoveryTimeoutMinutes` → `recoveryTimeoutSeconds`（接口 :32、`DEFAULT_CONFIG` :43 值 `10`→`600`、换算 :317 `×60×1000`→`×1000`、日志 :319 `"minutes elapsed"`→`"seconds elapsed"`、init :598、init 日志 :602-605 `recovery: ${recovery}min`→`s`）。
- **`src/start.ts`**：:284 `rlConfig?.recovery_timeout ?? 10` → `rlConfig?.recovery_interval ?? 600`；:294 传参名随字段改 `recoveryTimeoutSeconds`。
- **`ui/src/components/.../DashboardRateLimiterPanel.vue`**（:31/69/95）：`recoveryTimeoutMinutes`/`formatMinutes`/"Recovery Timeout" 标签 → 秒语义（该面板读 `RateLimiterSnapshot.config` 运行时状态，是 camelCase 运行时字段，须随内部字段改名）。
- **双默认值一致性**：`DEFAULT_CONFIG.recoveryTimeoutSeconds: 600`（fresh install 无 config 文件时用）与 bundled `config.yaml` 的 `recovery_interval: 600` 必须等价（都是 600 秒 = 旧 10 分钟）。
- **验收**：实测 `recovery_timeout: 10`（旧）与 `recovery_interval: 600`（新）经全链路后产出**相同的 600000ms**，且日志打印 "600 seconds" 而非 "600 minutes"。

### 注释引用（文档性，建议同步）
`state.ts`（:157,383,389,398,406,420）、`routes/responses/ws.ts`（:78,83）、`anthropic/sanitize/result.ts`（:21）、`history/types.ts`（:118，注意 :18 EndpointType **不改**）、`anthropic/client.ts`（:80）、`web-search/{backends,orchestrator}.ts`、`fetch-utils.ts`（:24,28）。

**明确排除**（非 config key，绝不改）：`history/types.ts:18` 的 `EndpointType = "...openai-responses..."`；`routes/status/route.ts:166-167` 的 status 响应字段 `upstream_websocket`。

---

## 五、前端（`ui/`，与后端手写解耦，需同步改）

前端 config 类型**完全手写**（`ui/src/types/config.ts` 无 `~backend` 导入），经 `ui/src/api/http.ts:11-14` re-export。`efforts_overrides`/`thinking_block_sanitize` 在前端**零出现**（#2/#3 前端无改动）。

### `ui/src/types/config.ts`（14 处）
- `ConfigYamlResponse` + `EditableConfig` 两个接口：
  - 顶层删 `stream_idle_timeout`/`fetch_timeout`/`stale_request_max_age`/`compress_tool_results_before_truncate`；新增 `timeouts?: { stream_idle?, response_header?, stale_request_max_age? }` 和 `auto_truncate?: { compress_tool_results? }` 子对象。
  - `"openai-responses"`→`openai_responses`，内部 `upstream_websocket`→`upstream_ws`。
  - `rate_limiter.recovery_timeout`→`recovery_interval`。

### `ui/src/composables/useConfigEditor.ts`（~8 处）
- :46-48 顶层 spread（stream_idle/fetch/stale）→ 改为 `normalizeScalarSection(input.timeouts, ["stream_idle","response_header","stale_request_max_age"])`（参照 :50-62 既有 `shutdown`/`rate_limiter` 写法）。
- :53-55 `openai-responses`→`openai_responses`，字段列表 `upstream_websocket`→`upstream_ws`。
- :60 `recovery_timeout`→`recovery_interval`。
- :63-65 compress → 新增 `auto_truncate` 分支。

### `ui/src/pages/vuetify/VConfigPage.vue`（~12 处）
- :51-54 `topLevelField(...)` → `nestedField("timeouts", ...)` / `nestedField("auto_truncate", "compress_tool_results", false)`。
- :70-71 `nestedField("openai-responses", ...)`→`openai_responses`，`upstream_websocket`→`upstream_ws`。
- :82 `recovery_timeout`→`recovery_interval`。
- **:146/:168 两处 `Pick<EditableConfig, ...>` 类型守卫 union**：新增 `"timeouts"`/`"auto_truncate"`，改 `"openai-responses"`→`openai_responses`（否则 `setNested`/`nestedField` 类型不过）。
- template v-model（:239,353,364,371,378）：本地 ref 名可保留（非 config key），仅其 field 定义改。"Timeouts" `ConfigSection`（:359-391）模板布局不变，仅绑定机制从 topLevel 改 nested。

### `ui/dist/`
构建产物，源改完 `bun run build:ui` 重新生成，**不手改**。

---

## 六、测试更新

### 后端 `tests/config/`（约 81 处行级）
- **config-hot-reload.it.test.ts**：FIELDS 数组 `configKey` 字符串改新路径（:170/177/184/198/274/382/500/507/514/521/542 等，`stateKey` 不变）；EXEMPT 里 `rate_limiter.recovery_timeout`→`recovery_interval`（:578）；注释 :498。
- **config-merge.unit.test.ts**：`efforts_overrides`→`effort_overrides`（9 处）、`fetch_timeout`→`timeouts.response_header` 嵌套（9 处）。
- **config-validation.unit.test.ts**：`efforts_overrides`→`effort_overrides`（:53,87,90）。
- **config-yaml-routes.http.test.ts**（改动最大，~45 处）：fetch_timeout→timeouts.response_header（26）、recovery_timeout→recovery_interval（6）、openai-responses/upstream_websocket（7）、stream_idle（4）、stale_request_max_age（4）、compress（3）。:908 的 `field: "fetch_timeout"` 验证错误路径改 `timeouts.response_header`。
- **config-schema-json-export.unit.test.ts**：顶层 key 断言数组（:45,47,48）——移除 stream_idle_timeout/fetch_timeout、加 `timeouts`、`openai-responses`→`openai_responses`。

### 新增 `tests/config/config-compat.unit.test.ts`（兼容层专项）
表驱动验证每条迁移：写旧 key → 经 `validateConfig` → 断言新 key 生效 + 旧 key 被剥离 + warn 一次。重点：
- `recovery_timeout: 10`（分钟）→ `recovery_interval: 600`（秒）的 ×60 换算。
- `openai-responses: { upstream_websocket: true }` → `openai_responses: { upstream_ws: true }`（section + 内部字段双重映射，值不丢）。
- 顶层 timeout 三项 → 合并进同一 `timeouts` section（deepMerge 累积）。
- 用户同时写新旧键时新键 wins（`deepMergeMissingOnly` 语义）。

### 前端测试
- **ui/vitest/config-page.test.ts**（4 处）：fixture :127/137、错误串 :222/240。
- **ui/tests/config-editor.test.ts**（~19 处）：`fetch_timeout` fixture/断言改嵌套 `timeouts` 形态（这些 `toEqual({ fetch_timeout: 30 })` 类断言会因结构移动而 break，须改嵌套对象）。

---

## 七、文档

- **`config.yaml`** + **`config.example.yaml`**：新建 `timeouts:` section 收三项（含注释说明 response_header=请求到响应头）；`compress_tool_results` 移入 `auto_truncate:`；`openai-responses:`→`openai_responses:` + 内部 ws 改名；`recovery_timeout`→`recovery_interval`（注释标单位=秒）；`efforts_overrides`→`effort_overrides`；`thinking_block_sanitize_check`→`thinking_block_sanitize`。
- **`docs/DESIGN.md`**：运行时选项大表（config 来源列）所有改名项同步；hot-reload 章节；路由/section 描述。
- **CLAUDE.md / 其它 docs**：grep 到的 config-key 引用同步（多在 docs/sync-ghc-api、docs/archive，按需）。

**bundled 关系澄清（H1）**：`PATHS.BUNDLED_CONFIG_YAML` 指向**仓库根 `config.yaml`**（paths.ts `locateBundledConfig()` 向上找 `config.yaml`，非 `config.example.yaml`），且经 `validateConfig` 加载——所以**只有 `config.yaml` 是功能 load-bearing**（漏改旧键会导致每次启动从项目自带 bundled 触发 deprecation warn）；`config.example.yaml` 纯文档。

**注释最终全扫（H2）**：源码/测试中残留旧 key 名的注释（如 `web-search/orchestrator.ts:301`、`backends.ts:308`、`fetch-utils.ts:24,28`、多个 `*.it.test.ts:～` 注释）按原则8 同步。**不靠手列清单**——改完用 `grep -rn` 全扫 8 个旧 key 字符串做收尾，区分 config-section 用法与 EndpointType（后者不改）。

---

## 八、暂缓项（完整记录，本次不做）

**前端残留已废弃键 `immutable_thinking_messages` / `auto_cache_control`**（违反原则9 类型权威）：
- 根因：`ui/src/types/config.ts:30,37,76,83` + `useConfigEditor.ts:184,191` + `VConfigPage.vue:60,68,285,300` + `config-page.test.ts:133` 仍用这两个早已被后端 `DEPRECATED_KEYS` 迁移的旧键（后端迁移为 `thinking_block_message_policy` enum / `cache_control` enum）。
- 当前行为：前端 UI 仍以 bool 开关呈现旧概念，发送旧键给后端，后端静默迁移——功能可用但 UI 与最新版本不对齐。
- 理想架构：前端 anthropic 表单把 `immutable_thinking_messages`(bool) 换成 `thinking_block_message_policy`(enum 下拉)、`auto_cache_control`(bool) 换成 `cache_control`(enum)。
- 为何暂缓：属于「前端表单功能演进」，超出「配置项重命名」范围（原则4）。本次新建的 compat 层已能继续兼容这两个旧键，不阻塞。
- 若做需改：上述 11 处 + 新增两个 enum 下拉组件绑定 + 对齐后端 enum 取值。

---

## 九、验证

> 仅修改可执行代码后验证（原则12）。改 .md/.yaml 注释不单独触发。

1. **类型检查**：`bun run typecheck`（后端）+ `bun run typecheck:ui`（前端，vue-tsc）—— 重点验证 VConfigPage.vue 的 `Pick<>` union 改对、前端嵌套 section 类型自洽。
2. **重新生成 schema 产物**：`bun run generate:config-schema`，确认 `config.schema.json` 不再含任何旧键（grep 8 个旧 key 应为空）。
3. **后端测试**：`bun run test:backend`（含改后的 config-hot-reload/merge/validation/yaml-routes/schema-json-export + 新增 config-compat）。完整性守卫（config-hot-reload 的 "every ConfigSchema leaf key is tested or exempt" + config-schema-json-export 顶层键断言）会强制所有新 key 登记，是天然的漏改探测器。
4. **前端测试**：`bun run test:ui`（bun + vitest）。
5. **Lint**：`eslint --fix`（不用 prettier 直接跑）。
6. **兼容层端到端实测**（核心验收）：写一份**完全用旧键**的 config.yaml fixture（含 `openai-responses`/`fetch_timeout`/`recovery_timeout: 10` 等），跑 `validateConfig` + `applyConfigToState`，断言运行时 state 与用新键时**逐字段等价**。两个必测点：(a) `recovery_timeout: 10`（分钟）经 compat ×60 + 全链路秒化后 == `recovery_interval: 600` == **600000ms**，且日志打印 "600 seconds"（C2）；(b) PUT 旧键 body（如 `{fetch_timeout: 30}`）经 `validateConfigInput` → 200 且写回 `timeouts.response_header: 30`（C3）。
7. **构建前端**：`bun run build:ui` 重新生成 dist。
8. **subagent review**（原则6）：改完用独立 subagent 复核——重点核对「无遗漏的硬编码旧 key（含注释，靠最终 grep 全扫）」「EndpointType `openai-responses` 未被误改」「rate_limiter 秒化全链路（compat ×60 + start.ts 默认 + DEFAULT_CONFIG + 换算 + 日志 + 前端 panel）都改对且单位一致」「config.schema.json 已重新生成提交」等绝对断言。

---

## 执行顺序

0. **先写记忆**（用户要求，见下方说明）：把「计划/重大产出在请求批准前主动跑 subagent audit/review，不等用户提醒」固化进 auto-memory。
1. compat.ts（新建兼容层 + `renameLeaf`/`renameSection` helper + path 反推 + 迁移规则） → 2. schema.ts（新形状 + 移除 DEPRECATED_KEYS） → 3. validation.ts（接线，含 `validateConfigInput` 也跑迁移 C3） → 4. config.ts / route.ts / start.ts / **adaptive-rate-limiter.ts（秒化全链路 C2）** → 5. 后端测试（含新 compat 测试 + PUT 旧键测试） → 6. 前端 types/composable/page **+ DashboardRateLimiterPanel（秒化 C2）** → 7. 前端测试 → 8. config.yaml/example + DESIGN.md → 9. **`generate:config-schema` 重新生成并提交 config.schema.json（C1）** → 10. typecheck + 全测试 + lint + 兼容层端到端实测 + build:ui + subagent review。

# ui-v4 Config 页结构化表单 — 设计规格（spec）

> 日期：2026-07-05
> 范围：`ui-v4/src/components/config/`（前端）+ `src/lib/config/`（后端字段描述符，见 §3）
> 类型：新功能（退役旧 `ui/` 的对等 gating，见 [TODO.md](../TODO.md)）
> 状态：**规格已定稿**（决策已签 2026-07-05，见 §12）；HOW 见 [plan](../plans/2026-07-05-ui-v4-config-form.md)
> 设计依据：[DESIGN.md §7 Config](../DESIGN.md)、config 调研（后端 SSOT = `src/lib/config/schema.ts`）
> **审查追溯**：经架构 subagent 对抗审查（2026-07-05）修订——补 `history.limit` 遗漏、anthropic 嵌套/record 的 PUT 整体替换语义、enum 无导出常量的前置事实、help 来源、字段联动、raw 双向同步一致性陷阱；均已并入 §3/§5/§6/§8/§12。

---

## 1. 目标与非目标

### 目标
- 把 ConfigPage 从**占位 raw JSON textarea**（`JSON.stringify`/`JSON.parse` 全量编辑）升级为**结构化分组表单**：左侧 section 导航 + 字段控件 + 校验高亮 + 敏感字段遮蔽 + requires-restart 标记。
- **完整覆盖后端 `ConfigSchema` 的全部 ~80 字段 / ~13 分区**（against-yagni：不做旧 Vue 那样的 ~9 分区子集；schema-driven 让全覆盖成本可控）。
- 保留 **raw 编辑模式**，与结构化表单**共存可切换**（DESIGN §7：默认 raw + 可切结构化；本 spec 修正为「结构化为主视图，raw 作逃生舱」，见 §6）。
- 编辑语义忠实后端：**sparse partial PUT**、`null`=删键、strict Zod 校验的 per-field 错误回填、collections 整体替换、requires-restart 提示。

### 非目标
- 不改后端 config **运行时行为 / schema 语义**（只**新增**一层 UI 字段描述符 + re-export，见 §3；不动 `ConfigSchema` 本身的校验）。
- 不做 config **版本历史 / diff / 回滚**（PUT 已 preserve YAML 注释；历史交给文件系统/git）。
- 不做多环境 config 切换、导入导出文件（raw 模式已可复制粘贴全文）。

---

## 2. 现状基线（改动锚点）

| 文件 | 现状 |
|---|---|
| `ui-v4/src/components/config/ConfigPage.tsx` | 占位：`useState("")` + `<textarea>`，`JSON.stringify(query.data)` 展示、`JSON.parse(text)` 保存，仅捕获 JSON parse error |
| `ui-v4/src/hooks/useConfigYaml.ts` | `GET /api/config/yaml`（返回**用户** config.yaml 的 JSON 对象，稀疏、可空、**未遮蔽敏感字段**）+ `PUT`（sparse 覆盖） |
| `ui-v4/src/types/status.ts` `ConfigYaml` | `{ [key: string]: unknown }` —— **frontend-loose，零字段结构**，注释自承理想应源自后端 |

关键既有约束（调研已核验，`file:line` 见调研报告）：
- **后端 SSOT = `src/lib/config/schema.ts`** 的 Zod `ConfigSchema`（`Config = z.infer<...>`）。每字段 optional、每标量叶子接受 `null`（=删键）。
- **PUT `/api/config/yaml`**：sparse partial 合并（保留 YAML 注释）；strict `ConfigSchema.safeParse` **硬失败 per-field**（400 `{error, details:[{field,message,value?}]}`）；先跑 legacy-key 迁移再校验；collections（`model_overrides`/`system_prompt_overrides`/`anthropic.system_rewrite_reminders`/`anthropic.tool_non_deferred`）整体替换；空 rewrite 数组归一为 `false`。
- **GET `/api/config/yaml` 不遮蔽** `anthropic.api_key` —— 结构化表单**必须**把它当 secret 处理（遮蔽、write-only、set/not-set 指示；发 `null` 删除）。另有 `/api/config`（effective 快照，只读、已遮蔽），本表单**不用**它（要编辑用户文件原值）。
- **启动期字段**（改后需重启、非热重载）：`proxy`、`ghc_api_base_url`、`rate_limiter.*`、`model_refresh_interval`（`state.ts` `CONFIG_MANAGED_DEFAULTS` 未含者）。表单须打 **requires-restart** 标记。

---

## 3. 核心架构决策：字段元数据源（schema-driven，后端描述符）

**这是本 spec 的中枢决策，决定后续一切。**

### 问题
结构化表单要知道每个字段的：路径、分区、标签、控件类型、enum 取值、数值范围/单位、是否敏感、是否 requires-restart、帮助文案、默认值。这些**元数据从哪来**？

### 已核验的关键事实（决定性证据）
**旧 Vue `ui/` 的 Config 表单是手写镜像 schema 的，且已经漂移**——它用的字段名（`strip_server_tools`/`dedup_tool_calls`/`auto_cache_control` 等）都是后端 `compat.ts` 已重命名的**旧名**，且 `auto_cache_control`（boolean）已变成 `cache_control`（enum）**类型都变了**。手写镜像**必然漂移**，这是项目内的实证失败样本。

### 决策：**后端字段描述符 registry（SSOT-types）+ re-export + drift-guard 测试**
- 在后端**与 `schema.ts` 同址**新增 `src/lib/config/field-descriptors.ts`：一份 `CONFIG_FIELD_DESCRIPTORS`，每字段一条 `{ path, section, label, control, enumValues?, min?, max?, unit?, sensitive?, requiresRestart?, deprecated?, dependsOn?, help?, default? }`。
- **前置事实（审查核验）**：`schema.ts` 的 enum 取值**全部内联**在 `nullableEnum([...] as const)` / `z.literal(...)` 里，**无导出常量**（schema.ts:225/323/331/339/346/358/418…；唯一导出常量是 `REPAIR_ITEMS`）。故「描述符引用既有常量」**不成立**，须二选一（见 §12-A）：**(a)** 前置把 ~10 组 enum 取值提取为 `schema.ts` 导出 `const`，描述符 + Zod 共用（推荐，真 SSOT）；**(b)** 描述符重复声明 enum，且 **drift-guard 扩展为「path 集 + 每 enum 字段的取值集」双向比对**（否则 enum 漂移不可见）。
- 前端经 `~backend/lib/config/field-descriptors` **纯值 re-export**（纯模块——只 import `zod` + schema 常量 + 字面量，**不碰 `~/lib/state`**，rollup 安全；见记忆 `feedback-verify-ui-with-build-not-just-typecheck`），渲染**通用 schema-driven 表单**。
- **drift-guard 测试**（后端）：断言「描述符 path 集 ≡ `ConfigSchema` 叶子 path 集」。**实现非平凡**（审查提示）——需一个穿透 `.nullable/.optional/.transform/.superRefine` wrapper 链的 schema 遍历器（~30-50 行），并**明确叶子定义**：`object` 递归进、`record`/`union`/`array`/`scalar` 停（否则双向差集永不为空）。叶子粒度须与描述符 path 粒度完全一致。**deprecated 字段**（`history.limit`）仍是合法 path，须进描述符（见 §12-D），否则 drift-guard 红。

### 为何这样（对齐项目价值观）
- **single-source-of-truth-types**：类型/元数据在拥有方（后端）定义一次、前端 re-export。
- **richest-data-flow**：表单自动覆盖全部字段 + 未来新字段自动出现（补描述符即可），不裁剪。
- **against-yagni**：一次性把描述符建全（~80 条），而非手写子集表单再逐个补。
- 破了旧 Vue 的漂移失败模式（`long-term-wins`）。

### 未采纳（record-not-adopted）
- **前端手写镜像表单**（旧 Vue 路子）——否。已实证漂移（旧名/旧类型），违反 SSOT-types。
- **zod-to-json-schema → 通用表单**——否。JSON Schema 丢 UI 元数据（分区/标签/敏感/重启/帮助/`false`-字面量判别 union/rewrite-rule 复合控件），仍需补一层 UI-hints → 反而比描述符 registry 更碎。**实证**：项目已有 `scripts/generate-config-json-schema.ts` 用 `z.toJSONSchema`（:23-32），其自身注释承认 transform/refinement/discriminated-union 的 `false` 字面量 + superRefine regex 校验**无法表达进 JSON Schema**（退化成开放 `{}`）——佐证此路丢信息。
- **描述符放前端**——否。放后端才是 SSOT（与 schema 同址、同 PR 改、drift-guard 守）。

> **这是唯一需要用户拍板的架构分叉**（见 §12 待确认）。其余为实现细节。

---

## 4. 字段 → 分区映射（覆盖全 schema，控件类型见 §5）

按后端 schema 的天然嵌套分区（`.strict()` section 对象）。`anthropic` 巨大，再拆子组（Radix Accordion 折叠，见 §5）。

| 分区 | 字段（控件） |
|---|---|
| **Transport & startup** ⚠restart | `proxy`(text/url) · `ghc_api_base_url`(text/url) · `model_refresh_interval`(number,s) |
| **System prompt** | `system_prompt_prepend`/`_append`(textarea) · `system_prompt_overrides`(rewrite-rules, show-model) |
| **Model routing** | `model_overrides`(key-value map) · `disabled_models`(string-list) · `sanitize_tool_names`(toggle) |
| **Rate limiter** ⚠restart | `retry_interval`·`request_interval`·`recovery_interval`·`consecutive_successes`(number) |
| **Anthropic ▸ Headers** | `strict_request_headers`·`strict_response_headers`·`strip_attribution_header`(toggle) · `request_header_blacklist`/`_whitelist`·`response_header_blacklist`/`_whitelist`(string-list) · `beta_strip_headers`·`partner_strip_features`(record<str,str[]>) |
| **Anthropic ▸ Thinking** | `thinking_block_message_policy`(enum) · `thinking_block_sanitize`·`thinking_coerce_adaptive`·`thinking_signature_compat`(disc-enum w/ `false`) |
| **Anthropic ▸ Tools** | `tool_strip_server`·`tool_inject_claude_code`·`tool_strip_read_result_tags`·`tool_search`·`memory_tool`·`tool_decode_all_input_fields`·`tool_recover_call_text`·`tool_backfill_question`(toggle) · `tool_dedup_calls`·`tool_rewrite_history_server`(disc-enum) · `tool_non_deferred`(string-list) · `tool_repair_malformed_input`(multi-select tags) · `tool_decode_input_fields`·`effort_overrides`·`retry_reject_body_fields`(record<str,str[]>) |
| **Anthropic ▸ Streaming/protect** | `stream_keepalive_mode`(enum) · `stream_keepalive_ping_sec`·`stream_commit_after_sec`·`protect_streaming_max_retries`·`protect_streaming_buffer_cap_bytes`·`protect_streaming_heartbeat`(number) · `protect_streaming_generation`(disc-enum) · `protect_streaming_escalate_context`(toggle) |
| **Anthropic ▸ Context editing** | `context_editing`(enum) · `context_editing_trigger`/`_keep_tools`/`_keep_thinking`(number) |
| **Anthropic ▸ Cache** | `cache_control`(enum) · `extended_cache_ttl`(nested: enabled/tools_system_ttl/messages_ttl) |
| **Anthropic ▸ Misc** | `warmup`·`refusal_sse_rewrite`(enum) · `system_messages_sanitize`(disc-enum) · `system_rewrite_reminders`(bool\|rewrite-rules) · `model_capabilities`(nested record/bool) · `api_key`(**secret**) |
| **OpenAI Responses** | `normalize_call_ids`·`upstream_ws`·`fix_stream_ids`·`client_ws_keep_open`·`strip_image_generation_tool`(toggle) · `max_ws_frame_bytes`·`max_client_ws_connections`·`max_upstream_ws_connections`(number) |
| **History** | `success_limit`·`failure_limit`·`reaper_interval`(number) · `db_path`(text) · `limit`(number, **@deprecated** —— 仍在 schema，drift-guard 要求进描述符，标 deprecated + 隐藏/只读，见 §12-D) |
| **Auto-truncate** | `enabled`·`compress_tool_results`(toggle) · `target_factor`(number,0-1) · `max_retries`·`compress_threshold`(number) |
| **Web search** | `enabled`(toggle) · `backend`(text: ""/searxng/model-id) |
| **Timeouts** | `stream_idle`·`response_header`·`upstream_keepalive`·`stale_request_max_age`(number,s) |
| **Shutdown** ⚠restart-ish | `graceful_wait`·`abort_wait`(number,s) |

---

## 5. 控件类型（Radix-based，Terminal Amber）

复用 §3 描述符的 `control` 字段分发；控件建在 Radix headless 上（延续本项目 Radix 迁移，样式桥见 [radix-styling.md](../radix-styling.md)）。控件集（对标旧 Vue 的 ConfigText/Number/Toggle/Enum/StringList/KeyValueList/RewriteRules/Section，但用当前字段名 + Radix）：

| control | 控件 | Radix/原语 | 备注 |
|---|---|---|---|
| `text` / `url` | 单行输入 | 原生 `<input>` | url 做 scheme 提示校验 |
| `textarea` | 多行 | 原生 `<textarea>` | system prompt |
| `number` | 数字 + min/max/unit | 原生 `<input type=number>` | 后缀单位（s/min/bytes） |
| `toggle` | 布尔 | **Radix `Switch`** | |
| `enum` | 单选下拉 | **Radix `Select`**（复用 §已建 FilterSelect 模式） | |
| `disc-enum` | 含 `false` 字面量的判别 union | **Radix `Select`**（`false` 作一个选项 "off"） | thinking_*/tool_dedup 等 |
| `string-list` | 字符串数组增删 | 原生 input + chips | blacklist/whitelist/disabled_models |
| `key-value` | Record<str,str> | 行编辑 | model_overrides |
| `record-list` | Record<str,str[]> | 键 + string-list | effort_overrides 等 |
| `record-bool` | Record<str,bool> | 键 + toggle | `model_capabilities.tool_search_overrides` |
| `rewrite-rules` | RewriteRule[] 编辑 | from/to/method/model 行 | system_prompt_overrides |
| `bool-or-rules` | `boolean \| RewriteRule[]` 复合 | toggle 切「关/自定义规则」+ 规则列表 | `anthropic.system_rewrite_reminders`（union bool/array，schema.ts:319） |
| `nested` | 嵌套对象 | 子分组渲染（**整体 dirty**，见 §8） | extended_cache_ttl/model_capabilities |
| `secret` | 遮蔽写-only | 原生 password input + set/not-set | api_key |

分区壳用 **Radix `Accordion`**（`anthropic` 子组折叠，长表单可读）；左侧 section 导航跳转。

> §4 的 `disabled_models`/`sanitize_tool_names`/`model_overrides` 等是 schema **顶层散字段**（非 section 对象），归入「Model routing」是 **UI-only 分组**（drift-guard 按真实 path 判定，不受 UI 分组影响）。

## 5.5 字段联动（条件禁用 / 钳制）—— 结构化表单相对 raw 的核心价值

schema 有多组语义依赖，表单应**条件禁用/提示**避免无效组合（JSDoc 已注明）：
- `web_search.backend` 仅 `web_search.enabled` 时有意义。
- `context_editing_trigger`/`_keep_tools`/`_keep_thinking` 仅 `context_editing≠"off"` 时生效（schema.ts:323-326）。
- `extended_cache_ttl.tools_system_ttl`/`messages_ttl` 仅 `extended_cache_ttl.enabled` 时；且 `messages_ttl ≤ tools_system_ttl` 钳制（schema.ts:335）。
- `request/response_header_blacklist`/`_whitelist` 仅在对应 `strict_*_headers` 模式下生效（schema.ts:164-208 JSDoc「active when strict_*: true/false」）——表单据 strict 开关提示哪份 list 生效。
- `protect_streaming_*` 子字段仅 `protect_streaming_generation≠false` 时相关。

联动为**软提示 + 禁用**（不阻止保存，后端校验权威）；这些依赖描述符可带 `dependsOn` 元数据表达。

---

## 6. Raw ↔ 结构化共存（含一致性陷阱，待 §12-C 拍板）

DESIGN §7 原文「默认 raw + 可切结构化」。**本 spec 修正**：结构化为**主视图**（新价值所在），raw 作**逃生舱**（供结构化未覆盖的边缘 / 排障）。

> **审查暴露的一致性陷阱（必须拍板，见 §12-C）**：`GET /api/config/yaml` 返回的是 config.yaml 被 `.toJSON()` 的 **JSON 对象**（route.ts:85，**已丢 YAML 注释/字段序**），而 PUT 靠 `parseDocument` 增量改**保留**注释——仅在**结构化 sparse PUT** 成立。若 raw 视图展示 GET 的 JSON 并允许「全文编辑后 save」，则：① 注释在 raw 视图不可见（GET 无注释）；② raw 全量 save 与结构化 sparse dirty 的 `null`=删键/未设=用默认语义**不可通约**（全量会把所有 GET 字段固化为 explicit set，破坏「未设→用 bundled 默认」）。
>
> **候选方案**（§12-C 选）：(a) raw 视图**只读展示 + 复制**（不可编辑，纯排障窗），编辑一律走结构化；(b) raw 视图可编辑但 save 也走**同一 sparse-dirty 引擎**（raw 解析后与初始态 diff，只发改动键，注释由后端 preserve）；(c) 后端加一个「返回 YAML 原文」的 GET 变体供 raw 视图真正全文编辑。推荐 **(a)**（最简、无语义冲突；结构化已覆盖全字段，raw 无需可编辑）。

两视图共享同一 `useConfigYaml` 数据 + dirty/save 状态。

---

## 7. 敏感字段
`anthropic.api_key`：secret 控件——不回显值（GET 虽返回明文，前端**收到即视为已设、不显明文**，只显 `●●● (set)` / `(not set)`）；输入新值才发；清空发 `null` 删除。**绝不**把 api_key 值写进任何日志 / raw 视图明文展示（raw 视图对 secret 字段也遮蔽，或明确警示）。→ 对齐 ADR `internal-tool-security-posture`（内部工具默认全暴露，但 api_key 是**真实凭据**、不豁免）。

> **审查提示的 dirty 陷阱**：secret 的初始表单态**必须是「已设标记」而非占位字符串**。若把初始值设为 `●●●` 占位符再做 stringify diff，会误判 dirty 并把 `●●●` 当真值 PUT。规则：secret 未被用户输入 → **不进 sparse body**（后端 setScalar 未见键 → 保留原值，route.ts:292-298 核验）；仅用户键入新值才 dirty+发。

---

## 8. 编辑语义

- **sparse dirty tracking**：只把**改动过**的字段纳入 PUT body（sparse override），未动字段不发。稳定 JSON stringify 比对判 dirty（对标旧 Vue useConfigEditor）。
- **null=删键**：字段被清空/重置为「用未设」→ 发 `null`（后端删该键，回落 bundled 默认）。UI 区分「显式设值」vs「未设（用默认）」。
- **merge 行为三分（后端 route.ts:257-290 核验，前端按描述符 `mergeMode` 区分）**：
  - **per-key**：顶层 section（`history`/`timeouts`/`rate_limiter`/`shutdown`/`openai_responses`/`auto_truncate`）+ anthropic 顶层——`setNestedScalarContainer` 逐子键 merge。前端**只发 sparse 子键、绝不整份发**（否则丢隐藏键如 deprecated `history.limit`）。
  - **whole**：anthropic 子对象（`extended_cache_ttl`/`model_capabilities`）+ record 字段（`effort_overrides`/`beta_strip_headers`/`partner_strip_features`/`retry_reject_body_fields`/`tool_decode_input_fields`）——value 被 `setIn` 整体写。改子键 → 整份重发。
  - **collection**：`model_overrides`/`system_prompt_overrides`/`anthropic.system_rewrite_reminders`/`anthropic.tool_non_deferred`——`replaceCollection` 整体替换。
  - `mergeMode` 是描述符字段（从 route.ts 机械派生 + drift-guard 守），前端 `computeSparsePatch` 据此决定 sparse 子键 vs 整份 value。**control 类型 ≠ mergeMode**（不可从 control 反推）。
- **requires-restart 提示**：改了 startup 字段（proxy/ghc_api_base_url/rate_limiter/model_refresh_interval）→ 保存后 toast「部分改动需重启生效」。
- **保存**：PUT sparse body → 成功 invalidate 重拉；`resetConfigCache` 热重载后端已做。

---

## 9. 校验

- **客户端镜像**（即时反馈）：描述符带 min/max/enum → 控件即时校验（数字范围、enum 取值、url scheme）。**不重造 Zod**——只做轻量 UX 前置校验；权威校验在后端。
- **服务端 400 回填**：PUT 失败返回 `{error, details:[{field, message, value?}]}` → 按 `field` 路径把错误**回填到对应控件**（字段级红色高亮 + message），而非只顶部报一条。这是结构化表单相对 raw 的核心价值。
- JSON/YAML 解析错误（raw 视图）沿用现有顶部报错。

---

## 10. 后端改动（新增 + 视 §12 决策的前置改造，不动 schema 语义）

1. **（视 §12-A1a）schema.ts enum 提取**：把 ~10 组内联 `nullableEnum([...])` 的取值提为导出 `const`，Zod + 描述符共用（零语义变化，纯重构）。
2. **`src/lib/config/field-descriptors.ts`**（新）：`CONFIG_FIELD_DESCRIPTORS`（~80 条）+ `ConfigFieldDescriptor` 类型。纯模块（无 state 依赖），供前端 `~backend` re-export。
3. **drift-guard 测试**（新）：schema 遍历器（穿透 wrapper、明确叶子定义）→ 断言 `descriptors path 集 ≡ ConfigSchema 叶子 path 集`（含 deprecated `history.limit`）；视 §12-A1b 再加 enum-set 比对。
4. **（视 §12-A2a）关键 JSDoc → Zod `.describe()`**：让 help 可运行时提取。
5. **（视 §12-C-c）** 若选 raw 全文编辑：加「返回 YAML 原文」GET 变体。
6. 前端 `types/status.ts` 的 `ConfigYaml`：保持 loose 或收紧为 `Partial<Config>`（type-only re-export）——实现期定。

> 后端只加「UI 元数据 + 守卫 + 可选纯重构」，**零运行时行为改动**，回归风险低。

---

## 11. 测试

- **纯逻辑（bun）**：dirty diff（sparse override，**按 mergeMode 两级粒度**）、null-delete 归一、per-key vs whole vs collection 三种 merge 行为、服务端 error `field`→控件路径映射、字段联动（禁用 + enum 钳制）。
- **组件（vitest + userEvent）**：各控件类型渲染 + 编辑触发 onChange；分区 Accordion；secret 遮蔽 + 未键入不发；requires-restart toast；服务端 400 回填字段高亮；raw 只读切换 + secret mask。
- **后端（bun）**：descriptor drift-guard（≡ schema）；descriptor 每条 control 合法。

---

## 12. 决策（已签 2026-07-05）

**A. 元数据架构 → 全 SSOT**：后端描述符 registry + drift-guard；**A1** = 提取 schema enum 为导出常量（描述符+Zod 共用）；**A2** = 关键 JSDoc 迁 Zod `.describe()`（help 可运行时提取）。
**B. 字段覆盖 → 全 ~80 字段**（against-yagni + richest-data-flow）。
**C. raw 视图 → 只读展示 + 复制**（纯排障窗，编辑一律走结构化；无 sparse/全量语义冲突）。
**D. deprecated 字段（`history.limit`）→ 进描述符标 deprecated + 隐藏/只读**（drift-guard 天然通过）。

---

## 13. 分阶段（供 writing-plans 细化）

1. **P0 描述符地基**：（视 §12-A）schema.ts enum 提取为导出常量 + 关键 JSDoc→`.describe()` → 后端 `field-descriptors.ts`（全字段，含 deprecated）+ drift-guard 测试（schema 遍历器）+ 前端 re-export + 纯逻辑（dirty/null/整体替换/error-map）bun 测。**无 UI**。
2. **P1 控件库**：Radix-based 控件集（text/number/toggle/enum/secret 等）+ 通用 schema-driven 渲染器 + 分区 Accordion。golden 控件测试。
3. **P2 编辑语义 + 校验**：sparse PUT / null-delete / collections / requires-restart / 服务端 400 回填 / 客户端镜像校验。
4. **P3 raw 只读 + 收尾**：raw 只读展示 + 复制（secret mask）+ secret 遮蔽打磨 + a11y + 回填 DESIGN §7 / TODO.md（Config 对等达成）。

每 phase：`typecheck:ui-v4` + `build:ui-v4`（真 rollup，验 `~backend` 纯模块）+ `test:ui-v4` + eslint 全绿 → 细粒度提交 → subagent audit。不自启 dev server。

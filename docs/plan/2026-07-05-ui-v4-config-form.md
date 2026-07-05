# ui-v4 Config 页结构化表单 — 实施计划

> **实施状态：未实施**（规划待审）
> **审查追溯**：经架构 subagent 审查（2026-07-05，claims 已对 route.ts/config.ts 独立核验）修订——merge 行为三分（per-key/whole/collection，防「保存丢隐藏键」）+ 描述符 `mergeMode` 元数据 + 配套 drift-guard、复用 `unwrapSchema`/`mergeBySchema` 遍历器 + 补 superRefine、`.describe()` 提取 PoC spike、enum 提取分标量/disc-union、computeSparsePatch 两级粒度、raw 视图 secret mask、联动含 enum 钳制、requires-restart 的 camelCase↔snake 映射 + model_refresh_interval 实测、config-schema-json-export 回归靶。
> **日期**：2026-07-05
> **规格依据**：[docs/spec/2026-07-05-ui-v4-config-form.md](../spec/2026-07-05-ui-v4-config-form.md)（决策已签 §12：全 SSOT · 全 ~80 字段 · raw 只读 · deprecated 进描述符）
> **kickoff**：[2026-07-05-ui-v4-config-form-kickoff.md](2026-07-05-ui-v4-config-form-kickoff.md)
> **目标**：ui-v4 ConfigPage 占位 raw-JSON textarea → 结构化 schema-driven 表单（Radix + Terminal Amber）

## 0. Commit invariants（每 commit 终态成立，中间态绝不半坏）

1. **后端零运行时行为改动**：P0 只加 UI 元数据 + 守卫 + 纯重构（enum 提常量 / JSDoc→describe），`ConfigSchema` 校验语义不变；既有 config 测试全绿。
2. **drift-guard 恒绿**：描述符 path 集 ≡ `ConfigSchema` 叶子 path 集（含 deprecated `history.limit`）；新增 schema 字段不补描述符 → 测试红。
3. **`~backend` 纯模块**：`field-descriptors.ts` 只 import `zod` + schema 常量 + 字面量，**不碰 `~/lib/state`**；前端 re-export 后 `build:ui-v4`（真 rollup）绿。
4. **merge 行为三分 + 描述符 `mergeMode`（命脉，防「保存丢键」）**：核验 `mergeConfigIntoDocument`（route.ts:257-290）后端有**三种**语义,前端必须逐字段区分（不可混为「整体替换」一类）：
   - **`per-key`**：顶层 section（`history`/`timeouts`/`rate_limiter`/`shutdown`/`openai_responses`/`auto_truncate`）+ anthropic 顶层——`setNestedScalarContainer` 逐子键 `setScalar`。前端**只发改动的 sparse 子键**,**绝不整份发**（否则丢隐藏键，如 deprecated `history.limit`）。
   - **`whole`**：anthropic 的**子对象**（`extended_cache_ttl`/`model_capabilities`）+ **record 字段**（`effort_overrides`/`beta_strip_headers`/`partner_strip_features`/`retry_reject_body_fields`/`tool_decode_input_fields`）——其 value 被 `setIn` 整体写入。改任一子键 → **整份重发该 value**。
   - **`collection`**：`model_overrides`/`system_prompt_overrides`/`anthropic.system_rewrite_reminders`/`anthropic.tool_non_deferred`——`replaceCollection` 整体替换。
   - **落成元数据**：每描述符带 `mergeMode: "per-key"|"whole"|"collection"`,从 route.ts 真实 dispatch **机械派生**（不靠 control 类型反推——control ≠ mergeMode）。加 **drift-guard**：断言描述符 mergeMode 集 ≡ route.ts merge dispatch（从 `ANTHROPIC_COLLECTION_KEYS` + setNestedScalarContainer 调用点派生），防前后端双源漂移。`computeSparsePatch` 据 mergeMode 决定 sparse 子键 vs 整份 value。
5. **secret 不误发**：api_key 未被用户键入 → 不进 PUT body（初始态是「已设标记」非占位串，spec §7）。
6. **每 phase 门禁全绿**：`typecheck:ui-v4` + `build:ui-v4` + `test:ui-v4`（bun+vitest）+ `bunx eslint ui-v4/src`（**无缓存**，0 error）+ 后端 `bun test`（config 相关）。
7. 不自启 dev server；需实测让用户开 5173 目视核对。

## 1. Phase 0 — 后端描述符地基（无 UI）

**后端（`src/lib/config/`）**：
- **P0 spike（先做，poc-first）**：① `.describe()` 挂载/提取——Zod v4 里 `.describe(s)` 挂 wrapper 链哪层、`schema.description` getter 是否穿透 `.nullable().transform().optional()`,PoC 三形态（标量 helper 链 / `.object().strict()` / `z.union([literal…])`）确认提取 API,结论写死。② 复用现成遍历器——`config.ts:334-398` 的 `unwrapSchema`/`mergeBySchema` 已穿透 ZodOptional/Nullable/Pipe + 递归 ZodObject/ZodRecord,drift-guard 遍历器**基于它扩展**（补 `.superRefine()` 分支,`ProxySchema`/`GhcApiBaseUrlSchema` schema.ts:622-670 需穿透）,别手搓第二个。正样本探针先证遍历器对 6 种真实形状（nullableSection / disc-union / z.record / 嵌套 object / string+superRefine / array+superRefine）各返回预期叶子集（独立 oracle，遍历器叶子判定不自证）。
- **enum 提取**（A1，**分两类**）：① 真 `nullableEnum([...] as const)`（context_editing/cache_control/warmup/refusal_sse_rewrite/thinking_block_message_policy/stream_keepalive_mode/ttl）→ 提为导出 `const`,`nullableEnum(CONST)`,`z.infer` 不变。② **disc-union** `z.union([z.literal(false), z.literal(...)...])`（thinking_block_sanitize/thinking_coerce_adaptive/system_messages_sanitize/thinking_signature_compat/tool_rewrite_history_server/tool_dedup_calls/protect_streaming_generation）——**非 enum**,提取须保 `z.union([z.literal(false), ...VALUES.map(z.literal)])`,`false` 保 boolean 字面量（别退化成字符串 "false"）。零 `z.infer` 变化验证靠既有测试。
- **JSDoc → `.describe()`**（A2，据 spike 结论）：关键字段注释迁 Zod `.describe(...)`,供描述符 help 运行时提取。
- **merge-behavior 表**（新，从 route.ts:257-290 机械派生）：每 path → `per-key`/`whole`/`collection`（见 invariant 4）,喂进描述符 `mergeMode`。
- **`field-descriptors.ts`**（新）：`ConfigFieldDescriptor` + `CONFIG_FIELD_DESCRIPTORS`（全 ~80 字段,含 deprecated `history.limit` 标 `deprecated:true`,含 `mergeMode`/`dependsOn`）。控件类型 spec §5（含 record-bool/bool-or-rules）。
- **drift-guard 测试**（新,bun）：① path 集 ≡ schema 叶子 path 集（复用扩展后的遍历器,含 deprecated）;② `mergeMode` 集 ≡ route.ts merge dispatch;③（可选）disc-union 取值集比对（防 L1 重构漂移）。
- **requires-restart 集**：`CONFIG_MANAGED_DEFAULTS`（state.ts:1157+）用 **camelCase runtime 键**,描述符 path 是 snake_case——需 camelCase↔snake_case 映射对齐,且 `model_refresh_interval` **实测**热重载与否（在 DEFAULTS 中 → 疑似 hot-reloadable,勿照 spec §2 断言,用实际覆盖面做 oracle）。
- **回归靶**（隐藏依赖）：enum/describe 重构触及 `scripts/generate-config-json-schema.ts` + `config-schema-json-export.unit.test.ts`（断言 `cache_control.enum`）——须仍绿。

**前端**：
- `~backend/lib/config/field-descriptors` re-export（纯值 + type）。`build:ui-v4` 验纯。
- **纯逻辑 lib**（`ui-v4/src/lib/config-form.ts`，bun 测）：`computeSparsePatch(initial, current, descriptors)`——**两级粒度**（据 `mergeMode`）：`per-key` 字段只发改动的 sparse 子键；`whole`/`collection` 字段改任一子键则整份发该 value;`null`=删键;secret 未被用户键入 → 不入 body。`mapServerErrors(details) → Map<path, message>`;`evaluateDependencies(values, descriptors) → { disabledPaths, constrainedEnums }`（联动含 enum 钳制，见 P2）。

**门禁**：后端 config 测试绿 + drift-guard 绿 + `build:ui-v4` 绿（纯模块）+ 前端纯逻辑 bun 测绿。

## 2. Phase 1 — 控件库 + 通用渲染器

- **Radix-based 控件**（`ui-v4/src/components/config/controls/`）：text/url/textarea/number(min/max/unit)/toggle(`Switch`)/enum(`Select`)/disc-enum(`Select`, `false`→"off")/string-list/key-value/record-list/record-bool/rewrite-rules/bool-or-rules/nested/secret。每控件契约 `{ descriptor, value, onChange, error?, disabled? }`。样式桥 [radix-styling.md](../../ui-v4/docs/radix-styling.md)。
- **通用渲染器** `ConfigField`（按 `descriptor.control` 分发）+ `ConfigSection`（Radix `Accordion` 分组，anthropic 子组）。左侧 section 导航。
- **golden 控件测试**（vitest + userEvent）：每控件渲染 + 编辑触发 onChange；Switch/Select 交互；secret 遮蔽；disabled 态。

**门禁**：四门禁绿；5173 核对控件视觉/交互。

## 3. Phase 2 — 编辑语义 + 校验 + 联动

- **ConfigPage 重构**：结构化视图编排（descriptors → sections → fields），接 `useConfigYaml` + `computeSparsePatch` 保存。
- **sparse dirty / null-delete / 整体替换**：接 P0 的 `computeSparsePatch`；nested/record/collections 整份发（invariant 4）。
- **secret**（invariant 5）：api_key 初始「已设标记」，仅键入才 dirty。
- **requires-restart**：改 startup 字段 → 保存后 toast。
- **服务端 400 回填**：PUT 失败 `details[].field` → `mapServerErrors` → 字段级红色高亮 + message（结构化相对 raw 的核心价值）。
- **客户端镜像校验**：描述符 min/max/enum/url → 控件即时校验（轻量 UX，非重造 Zod）。
- **字段联动**（spec §5.5）：`evaluateDependencies` → `{ disabledPaths, constrainedEnums }` → 条件禁用 + **enum 选项钳制**（`messages_ttl ≤ tools_system_ttl`：tools=5m 时 messages 的 1h 选项禁用）+ 提示（web_search.backend↔enabled、context_editing_*↔context_editing、ttl 子字段↔enabled、whitelist/blacklist↔strict）。软提示不阻止保存（后端权威）。

**门禁**：四门禁绿 + 组件测试（dirty/null/整体替换/secret/错误回填/联动）；5173 核对保存往返。

## 4. Phase 3 — raw 只读 + 收尾

- **raw 只读视图**：顶栏 toggle 切「结构化 / raw」；raw = 只读 `<pre>` + 复制按钮（GET JSON，纯排障，不可编辑——决策 C）。**secret 遮蔽**：GET 返回明文 api_key（route.ts:85 不遮蔽），raw 视图渲染/复制前对 `anthropic.api_key` mask（spec §7，真实凭据不豁免）。
- **secret 遮蔽打磨** + a11y（表单 label/aria、错误关联 `aria-describedby`、Accordion 键盘、section 导航）。
- **doc-sync**：回填 DESIGN §7 Config（占位→结构化）、TODO.md（Config 对等达成、解除退役 gating）、plan 状态→已完成。

**门禁**：四门禁绿；5173 全表单走查（各 section / 保存 / 错误 / secret / raw 切换）；phase 末 subagent audit。

## 5. Phase 小结

| Phase | 范围 | 阻塞后续 |
|---|---|---|
| P0 | 后端 enum/describe 重构 + descriptors + drift-guard + 前端 re-export + 纯逻辑 | 是（地基） |
| P1 | Radix 控件库 + 通用渲染器 + Accordion | 是（P2 依赖） |
| P2 | 编辑语义 + 校验 + 联动 + ConfigPage 编排 | 否 |
| P3 | raw 只读 + a11y + doc-sync | 否 |

每 phase 细粒度提交（显式 pathspec、conventional、不加模型署名）；phase 末派 subagent audit（裁判轴：正确性 + 完整 + SSOT/richest-data-flow，非 ROI/YAGNI）。

## 6. 非目标（spec §1 + record-not-adopted）
- 不改 config 运行时/schema 校验语义（只加 UI 元数据 + 守卫 + 纯重构）。
- 不做 config 版本/diff/回滚、多环境切换、导入导出文件。
- raw **不可编辑**（决策 C）——不做 raw↔结构化双向 sparse 同步（无语义冲突）。
- 前端**不重造 Zod 校验**（轻量镜像 + 服务端权威）。

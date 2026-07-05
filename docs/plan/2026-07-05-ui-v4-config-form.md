# ui-v4 Config 页结构化表单 — 实施计划

> **实施状态：未实施**（规划待审）
> **日期**：2026-07-05
> **规格依据**：[docs/spec/2026-07-05-ui-v4-config-form.md](../spec/2026-07-05-ui-v4-config-form.md)（决策已签 §12：全 SSOT · 全 ~80 字段 · raw 只读 · deprecated 进描述符）
> **kickoff**：[2026-07-05-ui-v4-config-form-kickoff.md](2026-07-05-ui-v4-config-form-kickoff.md)
> **目标**：ui-v4 ConfigPage 占位 raw-JSON textarea → 结构化 schema-driven 表单（Radix + Terminal Amber）

## 0. Commit invariants（每 commit 终态成立，中间态绝不半坏）

1. **后端零运行时行为改动**：P0 只加 UI 元数据 + 守卫 + 纯重构（enum 提常量 / JSDoc→describe），`ConfigSchema` 校验语义不变；既有 config 测试全绿。
2. **drift-guard 恒绿**：描述符 path 集 ≡ `ConfigSchema` 叶子 path 集（含 deprecated `history.limit`）；新增 schema 字段不补描述符 → 测试红。
3. **`~backend` 纯模块**：`field-descriptors.ts` 只 import `zod` + schema 常量 + 字面量，**不碰 `~/lib/state`**；前端 re-export 后 `build:ui-v4`（真 rollup）绿。
4. **整体替换字段不 sparse**：nested（extended_cache_ttl/model_capabilities）+ record（effort_overrides 等）+ collections 一律整份发（后端 setScalar 语义，spec §8）。
5. **secret 不误发**：api_key 未被用户键入 → 不进 PUT body（初始态是「已设标记」非占位串，spec §7）。
6. **每 phase 门禁全绿**：`typecheck:ui-v4` + `build:ui-v4` + `test:ui-v4`（bun+vitest）+ `bunx eslint ui-v4/src`（**无缓存**，0 error）+ 后端 `bun test`（config 相关）。
7. 不自启 dev server；需实测让用户开 5173 目视核对。

## 1. Phase 0 — 后端描述符地基（无 UI）

**后端（`src/lib/config/`）**：
- **enum 提取**（A1）：把 ~10 组内联 `nullableEnum([...] as const)` 的取值提为导出 `const`（如 `export const CONTEXT_EDITING_VALUES = [...] as const`），Zod schema 与描述符共用。零语义变化（`z.infer` 不变），既有测试兜底。
- **JSDoc → `.describe()`**（A2）：关键字段（~30+ 有 JSDoc 者）的注释迁为 Zod `.describe(...)`，供描述符 help 运行时提取；保留原 JSDoc 或让 describe 成唯一源（实现期定，避免双源漂移）。
- **`field-descriptors.ts`**（新）：`ConfigFieldDescriptor` 类型 + `CONFIG_FIELD_DESCRIPTORS`（全 ~80 字段，含 deprecated `history.limit` 标 `deprecated:true`）。每条 `{ path, section, label, control, enumValues?, min?, max?, unit?, sensitive?, requiresRestart?, deprecated?, dependsOn?, help?, default? }`；enum/help 引 A1/A2 的源。控件类型见 spec §5（含 record-bool / bool-or-rules）。
- **drift-guard 测试**（新，bun）：schema 遍历器——穿透 `.nullable/.optional/.transform/.superRefine/nullableSection` wrapper 链拿 `ZodObject.shape`；叶子规则 **object 递归进、record/union/array/scalar 停**（叶子粒度 = 描述符 path 粒度）。断言 `descriptors path 集 ≡ schema 叶子 path 集`（双向差集空）。视需要加 enum-set 比对（A1 已共用常量 → enum 天然一致，可选）。
- **requires-restart 集**：从 `state.ts` `CONFIG_MANAGED_DEFAULTS` 反推（未含者 = startup-only），描述符 `requiresRestart` 与之一致（可加断言）。

**前端**：
- `~backend/lib/config/field-descriptors` re-export（纯值 + type）。`build:ui-v4` 验纯。
- **纯逻辑 lib**（`ui-v4/src/lib/config-form.ts`，bun 测）：`computeSparsePatch(initial, current, descriptors)`（sparse dirty + null-delete + 整体替换字段整份 + secret 未键入不入）、`mapServerErrors(details) → Map<path, message>`、`evaluateDependencies(values, descriptors) → disabled paths`。

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
- **字段联动**（spec §5.5）：`evaluateDependencies` → 条件禁用 + 提示（web_search.backend↔enabled、context_editing_*↔context_editing、ttl 子字段↔enabled、whitelist/blacklist↔strict、messages_ttl≤tools_system_ttl）。

**门禁**：四门禁绿 + 组件测试（dirty/null/整体替换/secret/错误回填/联动）；5173 核对保存往返。

## 4. Phase 3 — raw 只读 + 收尾

- **raw 只读视图**：顶栏 toggle 切「结构化 / raw」；raw = 只读 `<pre>` + 复制按钮（GET JSON，纯排障，不可编辑——决策 C）。
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

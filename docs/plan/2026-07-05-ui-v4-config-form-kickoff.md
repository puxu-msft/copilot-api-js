# Kickoff：ui-v4 Config 页结构化表单

复制以下内容开启新会话执行。

---

你在 copilot-api-js 仓库实施 **ui-v4 ConfigPage：占位 raw-JSON textarea → 结构化 schema-driven 表单**。

**先读**（按序）：
1. [docs/spec/2026-07-05-ui-v4-config-form.md](../spec/2026-07-05-ui-v4-config-form.md)（WHAT/WHY + 决策已签 §12：全 SSOT · 全 ~80 字段 · raw 只读 · deprecated 进描述符 + 字段→分区映射 §4 + 控件 §5 + 联动 §5.5 + 敏感 §7 + 整体替换语义 §8）
2. [docs/plan/2026-07-05-ui-v4-config-form.md](2026-07-05-ui-v4-config-form.md)（commit invariants + P0-P3）
3. 后端 SSOT：`src/lib/config/schema.ts`（Zod）、PUT 合并 `src/routes/config/route.ts:257-321`（整体替换语义）、`src/lib/state.ts` `CONFIG_MANAGED_DEFAULTS`（requires-restart 反推）
4. [ui-v4/docs/radix-styling.md](../../ui-v4/docs/radix-styling.md)（Radix 样式桥 + 测试 gotchas：userEvent 必需、role 变化、Portal DOM 时机）

**核心不变量（每 commit 终态成立）**：① 后端零运行时行为改动（P0 只加元数据+守卫+纯重构，config 测试全绿）② drift-guard 恒绿（描述符 path 集 ≡ schema 叶子 path 集，含 deprecated history.limit）③ `field-descriptors.ts` 纯模块（不碰 `~/lib/state`，`build:ui-v4` 真 rollup 验）④ 整体替换字段（extended_cache_ttl/model_capabilities 嵌套 + effort_overrides 等 record + collections）整份发、不 sparse 子键（否则丢兄弟键）⑤ secret api_key 未键入不进 PUT body（初始态是「已设标记」非占位串）⑥ 每 phase：`bun run typecheck:ui-v4` + `bun run build:ui-v4` + `bun run test:ui-v4` + `bunx eslint ui-v4/src`（**无缓存**，0 error，见记忆 `tooling-eslint-cache-false-pass`）+ 后端 `bun test` config 相关。

**从 Phase 0 开始**：后端 enum 提取为导出常量 + 关键 JSDoc→Zod `.describe()` → `src/lib/config/field-descriptors.ts`（全字段 + drift-guard 测试的 schema 遍历器，叶子规则：object 递归进、record/union/array/scalar 停）→ 前端 `~backend` re-export → 纯逻辑 `lib/config-form.ts`（computeSparsePatch / mapServerErrors / evaluateDependencies）+ bun 测。P0 门禁绿后进 P1（Radix 控件库）。

**红线**：
- `~backend` 只引纯模块（descriptors 纯，别拉 state；否则 rollup 崩）。
- 整体替换字段绝不 sparse 子键发（invariant 4，spec §8，对着 route.ts:257-321 核验后端语义）。
- secret 初始态「已设标记」非占位串（invariant 5，spec §7）。
- 不改 schema 校验语义；不重造 Zod;raw 只读不可编辑（决策 C，无双向同步）。
- 控件建 Radix headless + Terminal Amber `data-[state]`;Radix 测试用 userEvent 非 fireEvent.click。
- 不自启 dev server;需实测让用户开 5173 目视核对。

**每 phase 收尾**：门禁全绿 → 细粒度提交（显式 pathspec、conventional、不加模型署名）→ phase 末派 subagent audit（裁判轴：正确性 + 完整 + SSOT/richest-data-flow，非 ROI/YAGNI）→ 落地后回填 DESIGN §7 + TODO.md（Config 对等达成）+ plan 状态。

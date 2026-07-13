# Phase 0 执行报告 — error-shaping config scaffolding

状态：**DONE_WITH_CONCERNS**

## 提交

| commit | 内容 |
|---|---|
| `170340fb` | `feat: add error-shaping config schema (4 keys)` — task 0.1，`schema.ts` + 测试文件初版 |
| `6fddd1fd` | `feat: wire error-shaping config keys through config.ts + state.ts` — task 0.2，`config.ts` + `state.ts` 全部触点 + 测试文件补全 |
| `67ca59b7` | `test: register error-shaping keys in config-hot-reload completeness guard` — 实现中发现的第 5 个必改点（见下）|

## 测试结果

- `bun test tests/config/error-shaping-config.unit.test.ts` → **6 pass / 0 fail，14 expect() calls**。
- `bun test tests/config/config-hot-reload.it.test.ts`（完整性守卫 + 全部 R1/R2/R3 表格用例）→ **310 pass / 0 fail，330 expect() calls**。
- `bun run typecheck`（全仓，含 `tests/e2e-ui/tsconfig.json`）→ 干净通过，无输出。
- `bunx eslint`（无缓存）：
  - `src/lib/config/config.ts` `src/lib/state.ts` `tests/config/error-shaping-config.unit.test.ts` `tests/config/config-hot-reload.it.test.ts` → **0 error**。
  - `src/lib/config/schema.ts` → **2 个 prettier 空行错误（行 54、727）**，经 `git diff 170340fb^ 170340fb -- src/lib/config/schema.ts` 核对，**均不在本次改动的 diff hunk 内**，且用 `git show 170340fb^:src/lib/config/schema.ts` 核实这两处在我改动前就已存在（原第 719 行随插入偏移到第 727 行）。判定为**改动前既有的存量债**，不在本任务范围内顺手清；仅记录在此，未动手修改（若要修需额外一次 `prettier --write` 触碰到无关行，可能与并发会话冲突，故未做）。
- 非目标目录守卫：`git diff --stat 170340fb^ HEAD -- src/lib/codec/openai-cc/ src/lib/codec/openai-responses/` → 空，确认未触碰。

## 4 个新增键实现摘要

`anthropic.error_shaping_enabled` / `error_ask_user_question` / `error_auq_template` / `error_selfheal_delegate` 已贯通三触点：
- `src/lib/config/schema.ts`：`AnthropicConfigSchema` 新增 4 个字段（`nullableBoolean()`/`nullableString()`/`z.record()`），插入于 `refusal_error_type` 之后、`tool_backfill_question` 之前。
- `src/lib/config/config.ts`：`applyConfigToState()` 内追加 4 个 `if (a.xxx !== undefined) setAnthropicBehavior({...})` 映射。
- `src/lib/state.ts`：`MutableState` 接口字段、`CONFIG_MANAGED_DEFAULTS`（默认值 `true/false/""/{}`）、`setAnthropicBehavior` 的 `Pick<>` 允许列表、`resetConfigManagedState()`、`mutableState` 初始字面量，共 6 处均已补齐。

## 与计划文档不符之处（已按"以真实代码为准"原则修正，逐条记录）

1. **schema 导出名**：plan 示例写的 `AnthropicBehaviorConfigSchema` 不存在，真实导出名是 `AnthropicConfigSchema`。已改用真实名。
2. **reset 函数名**：plan 示例写的 `resetConfigManagedStateForTests` 不存在，真实且唯一的导出是 `resetConfigManagedState`（无 test-only 包装）。已直接使用。
3. **`applyConfigToState()` 签名**：plan 示例假设它接受一个配置对象参数（`applyConfigToState({ anthropic: {} } as never)`），但真实签名是**零参数** `applyConfigToState(): Promise<Config>`，从 `PATHS.CONFIG_YAML` 磁盘路径读取。已改用 `buffered-retry-keys.test.ts` / `config-hot-reload.it.test.ts` 同款隔离 tmp-dir harness（mkdtemp 换 `PATHS.APP_DIR`/`PATHS.CONFIG_YAML` → `writeConfig()` 写 YAML → `resetConfigCache()` → `applyConfigToState()`）。

## 超出 plan 字面"3 触点"范围的追加改动（已做，非请求但认为必要）

1. **`cloneState()` / `cloneStatePatch()`**（`src/lib/state.ts`）：为新 Record 类型字段 `errorSelfhealDelegate` 补充浅拷贝逻辑，与其他 Record 类型字段（如 `toolSearchOverrides`）保持一致，避免测试快照/恢复路径共享可变引用。plan 未提及此触点，但类比既有 Record 字段的处理方式判断为必需，已做。
2. **`tests/config/config-hot-reload.it.test.ts` 完整性守卫注册**（新发现的第 5 个触点，非 plan 列出的 3 个）：该文件有一个基于 `ConfigSchema` 生成的 JSON Schema 遍历所有叶子键的 `Coverage completeness` 测试，任何新增 schema 键不注册到 `FIELDS`/`EXEMPT` 就会让该测试失败（已实测复现：`orphans` 从预期 `[]` 变成 4 个新键）。已在 `anthropic.refusal_error_type` 之后插入 4 条 `FIELDS` 表项，给予与其他 `anthropic.*` 键相同的 R1（apply）/R2（retain-on-absence hot-reload）/R3（reset）三重覆盖，随后实测复现失败 → 修复 → 复测转绿（310/310）。

## 结论

Phase 0 的 4 个键已通过 schema → config → state 三触点 + 完整性守卫共 5 个触点全部接通，测试/typecheck/lint（除已确认的存量债外）/非目标目录守卫均通过。标记 **DONE_WITH_CONCERNS** 仅因：(a) 发现并修复了 plan 未列出的第 5 个触点（完整性守卫注册）；(b) `schema.ts` 存在 2 处与本次改动无关的存量 prettier 债务未清理（不影响本任务交付）。

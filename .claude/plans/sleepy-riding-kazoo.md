# Plan: 统一 config hot-reload 测试 — 表驱动 + 完整性守卫 + 语义统一

## Context

[tests/component/config-hot-reload.test.ts](tests/component/config-hot-reload.test.ts) 当前为每个 config 字段手写一条 test。这种 per-field 风格有两个问题：

1. **新字段无覆盖即静默通过**。例如刚加的 `model_preference` 若不显式补一条 test，hot-reload 路径就完全没验证——刚才的对话就出现了这个漏洞。
2. **语义不一致难以辨识**。同一个文件里 `fetch_timeout` 是 "retain on absence"，而 `disabled_models` / `system_prompt_overrides` / `efforts_overrides` / `strip_beta_headers` / `reject_body_fields` / `model_overrides` 是 "reset on absence"——但只有 disabled_models / model_overrides 在 [config.ts:248-289](src/lib/config/config.ts#L248-L289) 的注释里写明了；其他几个是隐式 `?? {}` / `?? []`，用户读 yaml 时无法预测。

用户决定：(1) **完整重写**测试为表驱动 + 完整性守卫；(2) **顺手统一 merge 语义为 retain**（即所有 collection 字段都遵循「config 中缺省 → 保留运行时旧值」的统一规则，与 scalar 字段一致；只有 `resetConfigManagedState()`（PUT /api/config）才把字段拨回默认）。

预期成果：

- 新增任何 config 字段时，测试守卫会立即 fail 直到该字段被登记到测试矩阵或豁免清单。
- 所有 hot-reload 字段语义统一（retain-on-absence），用户行为可预测。
- 已知不参与 hot-reload 的字段（rate_limiter、proxy）在豁免清单中显式记录原因，成为活文档。

## Design

### Part A — 行为统一：collection 字段改为 retain-on-absence

修改 [src/lib/config/config.ts](src/lib/config/config.ts) `applyConfigToState()`：

| 字段 | 当前行为 | 改为 |
|------|---------|------|
| `disabled_models` | `setDisabledModels(config.disabled_models ?? [])` 无脑替换为空 | `if (config.disabled_models !== undefined) setDisabledModels(config.disabled_models)` |
| `anthropic.efforts_overrides` | `setAnthropicBehavior({ effortsOverrides: a.efforts_overrides ?? {} })` 无脑替换为 `{}` | `if (a.efforts_overrides !== undefined) setAnthropicBehavior({ effortsOverrides: a.efforts_overrides })` |
| `anthropic.strip_beta_headers` | 同上 | 同模式改造 |
| `anthropic.reject_body_fields` | 同上 | 同模式改造 |
| `system_prompt_overrides` | 已经是 `if (...!== undefined)` 守卫，**但**空数组分支显式回退到 `[]`——保留，因为这正确表达「用户故意写空数组 = 清空规则」 | 不变 |
| `model_overrides` | `if (config.model_overrides)` 在缺省时不动 state（已是 retain），但 truthy 检查会把 `{}` 当缺省 | 改为 `!== undefined`，让 `model_overrides: {}` 也走进分支（用户故意写空 = 清空到 defaults） |
| `model_preference` | 已经 `!== undefined` 守卫 | 不变 |
| 其他 scalar 字段 | 已经 `!== undefined` 守卫 | 不变 |

**关键差异**：「键完全缺省」= retain；「键存在但写空值（`[]` / `{}`）」= 用户显式覆盖。Zod schema 的 `null → undefined` transform 已经处理了 PUT API 的「删除」语义；这层改动只影响 yaml 文件本身的解释。

**Reset 路径不变**：`resetConfigManagedState()` 仍然把所有 collection 字段拨回 `CONFIG_MANAGED_DEFAULTS`（空数组/空对象/默认列表）。PUT `/api/config/yaml` 流程先调 reset 再 apply，所以用户在 UI 里清空一项 → reset → 重新 apply 全表 → 该项落到 default。语义跟现在一致。

**向后兼容风险**：用户 yaml 里只写 `model_overrides: { opus: foo }` 时，今天 `disabled_models` 会被重置为空；改造后会保留上次值。**这正是用户想要的统一语义**——一致性 > 隐式重置。这是一次性的行为变更，需要在 commit message 和 changelog 里突出说明。

### Part B — 测试矩阵元数据

新增 `tests/component/config-hot-reload/registry.ts`（或类似位置），定义：

```ts
type StateKey = keyof State

/** Sample value used to exercise R1 (apply). Must differ from CONFIG_MANAGED_DEFAULTS so the test catches no-ops. */
type FieldSpec = {
  configKey: string             // yaml leaf path, e.g. "anthropic.tool_search"
  stateKey: StateKey
  sampleYamlValue: string       // yaml fragment to inject (raw value side of the leaf)
  expectedStateValue: unknown   // value `state[stateKey]` should hold after apply
  defaultStateValue: unknown    // value after resetConfigManagedState()
  /**
   * - retain      → typical case (this plan unifies most fields here)
   * - reset-to-default-on-explicit-empty → field has a "user wrote {} to mean default" semantic
   *   (model_overrides after Part A — write {} reverts to DEFAULT_MODEL_OVERRIDES)
   */
  mergeSemantic: "retain"
}

const FIELDS: ReadonlyArray<FieldSpec> = [
  { configKey: "fetch_timeout", stateKey: "fetchTimeout", sampleYamlValue: "30", expectedStateValue: 30, defaultStateValue: 300, mergeSemantic: "retain" },
  { configKey: "anthropic.tool_search", stateKey: "toolSearchEnabled", sampleYamlValue: "false", expectedStateValue: false, defaultStateValue: true, mergeSemantic: "retain" },
  // ... one entry per leaf
]

/** Fields explicitly outside hot-reload coverage, with reason. */
const EXEMPT: ReadonlyArray<{ configKey: string; reason: string }> = [
  { configKey: "rate_limiter.retry_interval", reason: "Stateful singleton constructed once in start.ts; not re-init on reload" },
  { configKey: "rate_limiter.request_interval", reason: "same as above" },
  { configKey: "rate_limiter.recovery_timeout", reason: "same as above" },
  { configKey: "rate_limiter.consecutive_successes", reason: "same as above" },
  { configKey: "proxy", reason: "initProxy() runs once in start.ts before any network requests; changing requires restart" },
]
```

### Part C — 表驱动测试

新 [tests/component/config-hot-reload.test.ts](tests/component/config-hot-reload.test.ts)（完全重写）跑三组：

**R1: applies sample value**
```ts
describe.each(FIELDS)("hot-reload R1: $configKey", (f) => {
  test("applied to state", async () => {
    await writeConfig(yamlForField(f))
    await applyConfigToState()
    expect(state[f.stateKey]).toEqual(f.expectedStateValue)
  })
})
```

**R2: retain on absence (unified semantic)**
```ts
describe.each(FIELDS)("hot-reload R2: $configKey", (f) => {
  test("retained when key absent on reload", async () => {
    await writeConfig(yamlForField(f))
    await applyConfigToState()
    expect(state[f.stateKey]).toEqual(f.expectedStateValue)

    resetConfigCache()
    await writeConfig("")  // empty yaml — every key absent
    await applyConfigToState()
    expect(state[f.stateKey]).toEqual(f.expectedStateValue)  // retained
  })
})
```

**R3: reset restores default**
```ts
describe.each(FIELDS)("hot-reload R3: $configKey", (f) => {
  test("resetConfigManagedState restores default", () => {
    setStateForTests({ [f.stateKey]: f.expectedStateValue } as Partial<State>)
    resetConfigManagedState()
    expect(state[f.stateKey]).toEqual(f.defaultStateValue)
  })
})
```

**Completeness guard** —— 关键守卫：

```ts
test("every ConfigSchema leaf key is either tested or explicitly exempt", () => {
  const allLeaves = enumerateLeafKeys(ConfigSchema)
  const known = new Set([
    ...FIELDS.map(f => f.configKey),
    ...EXEMPT.map(e => e.configKey),
  ])
  const orphans = [...allLeaves].filter(k => !known.has(k))
  expect(orphans).toEqual([])  // 新加字段忘记登记 → 这条 fail
})
```

`enumerateLeafKeys()` 用 `z.toJSONSchema(ConfigSchema, { io: "input" })`（[scripts/generate-config-json-schema.ts:23](scripts/generate-config-json-schema.ts#L23) 已经验证可行）的输出递归提取叶子路径，跳过 `Record<string, ...>` 类型字段（model_overrides、efforts_overrides 等——这些字段本身要列在 FIELDS 里作为整体）。

### Part D — 保留的人工 sanity test

某些字段需要保留独立 test 来验证非典型分支（不在表驱动覆盖范围内）：

- `dedup_tool_calls: true → "input"` 归一化逻辑
- `rewrite_system_reminders` 既能是 boolean 又能是 array
- `model_preference` 的「omitted family keeps default」per-family 语义（表驱动只覆盖顶层 key 整体）
- `history.limit` 同步到 `setHistoryMaxEntries`（侧效应）
- `model_refresh_interval` 触发 `syncModelRefreshLoop()`（侧效应）

这些放到 `describe("special semantics", () => {...})` 块。

## Files to modify

| 文件 | 改动 |
|------|------|
| [src/lib/config/config.ts](src/lib/config/config.ts) | Part A：4 个 collection 字段（`disabled_models`、`efforts_overrides`、`strip_beta_headers`、`reject_body_fields`）改 retain 语义；`model_overrides` truthy 检查改 `!== undefined` |
| [tests/component/config-hot-reload.test.ts](tests/component/config-hot-reload.test.ts) | 完全重写：表驱动 R1/R2/R3 + 完整性守卫 + 少量 special-semantics 保留 |
| 新增 `tests/component/config-hot-reload/registry.ts` | FieldSpec 表 + EXEMPT 清单 + `enumerateLeafKeys()` helper |
| [docs/DESIGN.md](docs/DESIGN.md) | 在「运行时选项」表头或附近补一行：所有 collection 字段统一 retain-on-absence，缺省值通过 `resetConfigManagedState()` / PUT API 恢复 |
| `CHANGELOG` 或 commit message | 突出说明行为变更（disabled_models 等不再随每次 reload 被隐式清空） |

## Verification

1. `bun run typecheck` 通过。
2. `bun x eslint` 改动文件无问题。
3. `bun test tests/component/config-hot-reload.test.ts`：
   - R1/R2/R3 每个 FIELD 三条 test 全 pass
   - completeness guard pass
   - special-semantics 块 pass
4. **守卫验证**：临时给 `ConfigSchema` 加一个虚假 key 不登记 → completeness test 报错并列出 orphan key 名；移除后恢复绿。
5. **行为变更验证**：手动构造序列「先 yaml 写 `disabled_models: [foo]` → apply → 再 yaml 写 `fetch_timeout: 30` → apply」，确认第二次 apply 后 `state.disabledModels` 仍为 `["foo"]`（旧实现会清空）。
6. 跑全量 component + unit 测试套件，确认无回归——尤其是 `system-prompt-config-integration.test.ts`、`per-model-config.test.ts`、`model-resolver.test.ts`。

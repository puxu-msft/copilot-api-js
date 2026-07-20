# Phase 0：config 三触点新增 4 键

**依赖**：无（可作为第一个开工的 Phase）
**产出**：`error_shaping_enabled` / `error_ask_user_question` / `error_auq_template` / `error_selfheal_delegate` 四个新配置键，贯通 schema.ts → config.ts → state.ts 三触点 + 热重载。此 Phase 完成后其余 Phase 才能读到这些键的运行时值（`state.errorShapingEnabled` 等）。

## 涉及文件

- `src/lib/config/schema.ts`（`anthropic` 对象内，紧邻 `refusal_*` 三键之后，约 469 行后）
- `src/lib/config/config.ts`（`applyConfigToState` 内，紧邻 678 行 `refusal_error_type` 映射之后）
- `src/lib/state.ts`（`CONFIG_MANAGED_DEFAULTS` 常量 + `setAnthropicBehavior` 的 `Pick<>` 列表 + `mutableState` 初始字面量 + `resetConfigManagedState()`，共 4 处）
- `tests/config/error-shaping-config.unit.test.ts`（新增）

## 接口消费/产出

- **产出**：`state.errorShapingEnabled: boolean`、`state.errorAskUserQuestion: boolean`、`state.errorAuqTemplate: string`、`state.errorSelfhealDelegate: Readonly<Record<string, "proxy" | "delegate">>`
- **消费方**：Phase 1（决策引擎从调用方接收 `ErrorShapingConfig`，由 Phase 2-5 从 `state.*` 读出后组装传入——本 Phase 只负责让 `state.*` 有正确的值，不改 `error-shaping.ts`）

## 任务 0.1：schema.ts 新增 4 键 zod 校验

- [ ] 写失败测试 `tests/config/error-shaping-config.unit.test.ts`：
  ```ts
  import { describe, expect, test } from "bun:test"
  import { AnthropicBehaviorConfigSchema } from "~/lib/config/schema" // 确认实际导出名——若 anthropic 键嵌在更大 schema 内，改用该更大 schema 的 .shape.anthropic 或等价子解析
  
  describe("error-shaping config schema", () => {
    test("accepts all 4 keys with valid values", () => {
      const parsed = AnthropicBehaviorConfigSchema.parse({
        error_shaping_enabled: true,
        error_ask_user_question: false,
        error_auq_template: "model={model} status={status}",
        error_selfheal_delegate: { "adaptive-thinking-rejection-retry": "delegate", "tool-field-rejection-retry": "proxy" },
      })
      expect(parsed.error_shaping_enabled).toBe(true)
      expect(parsed.error_selfheal_delegate).toEqual({ "adaptive-thinking-rejection-retry": "delegate", "tool-field-rejection-retry": "proxy" })
    })

    test("rejects invalid error_selfheal_delegate value (not proxy/delegate)", () => {
      expect(() => AnthropicBehaviorConfigSchema.parse({ error_selfheal_delegate: { foo: "bogus" } })).toThrow()
    })

    test("all 4 keys optional — absent config parses to undefined (warn-and-continue philosophy, no required keys)", () => {
      const parsed = AnthropicBehaviorConfigSchema.parse({})
      expect(parsed.error_shaping_enabled).toBeUndefined()
      expect(parsed.error_selfheal_delegate).toBeUndefined()
    })
  })
  ```
  （先用 `grep -n "export const.*Schema" src/lib/config/schema.ts` 确认实际导出的 schema 变量名与 `anthropic` 子对象的访问路径，替换上面占位的 `AnthropicBehaviorConfigSchema` 引用——不得凭猜测硬编码不存在的导出名。）
- [ ] 跑测试确认红（`bunx bun test tests/config/error-shaping-config.unit.test.ts` 或项目约定的 `bun test` 命令）
- [ ] 最小实现：在 schema.ts 的 `anthropic` 对象内追加
  ```ts
  /** 上游错误 → 客户端可行动形态整形总开关。关闭时三个终点（forward.ts / 终点①② / S5 canonical rewrite）逐字节回退现状。默认 true。 */
  error_shaping_enabled: nullableBoolean(),
  /** B 类：content_filtered / 402 / 403(token-refresh 耗尽) 是否合成 AskUserQuestion 轮次而非拍平成错误帧。仅交互式部署应开启（无服务端探测信号，见 plan D-0）。默认 false。 */
  error_ask_user_question: nullableBoolean(),
  /** AUQ 问题文案模板，占位符 {model}/{request_id}/{error_type}/{status}，复用 renderRefusalTemplate。空=内置默认。 */
  error_auq_template: nullableString(),
  /** D 类：按反应式策略名配置「proxy 自修 vs 透传委派 CC 自愈」。键=策略 .name（如 "adaptive-thinking-rejection-retry"），值 "proxy"|"delegate"。未列=proxy（默认更可控）。 */
  error_selfheal_delegate: z.record(z.string(), z.enum(["proxy", "delegate"])).optional(),
  ```
- [ ] 确认绿
- [ ] 提交：`git add -- src/lib/config/schema.ts tests/config/error-shaping-config.unit.test.ts && git commit -F <msgfile> -- src/lib/config/schema.ts tests/config/error-shaping-config.unit.test.ts`（`feat: add error-shaping config schema (4 keys)`）

## 任务 0.2：config.ts 映射 + state.ts 三处 touch point

- [ ] 写失败测试（同文件追加 describe block）：
  ```ts
  import { applyConfigToState } from "~/lib/config/config"
  import { resetConfigManagedStateForTests, state } from "~/lib/state" // 确认实际的 reset 导出名（RESETTERS 里应有一条 state 相关 reset）

  describe("error-shaping config → state (three touch points)", () => {
    afterEach(() => resetConfigManagedStateForTests())

    test("defaults match CONFIG_MANAGED_DEFAULTS when config omits the keys", () => {
      applyConfigToState({ anthropic: {} } as never)
      expect(state.errorShapingEnabled).toBe(true)
      expect(state.errorAskUserQuestion).toBe(false)
      expect(state.errorAuqTemplate).toBe("")
      expect(state.errorSelfhealDelegate).toEqual({})
    })

    test("applies configured values", () => {
      applyConfigToState({ anthropic: { error_shaping_enabled: false, error_selfheal_delegate: { "system-reject-retry": "delegate" } } } as never)
      expect(state.errorShapingEnabled).toBe(false)
      expect(state.errorSelfhealDelegate).toEqual({ "system-reject-retry": "delegate" })
    })

    test("hot-reload: re-applying a fresh empty config resets to defaults (no stale delegate entries leak across reloads)", () => {
      applyConfigToState({ anthropic: { error_selfheal_delegate: { "system-reject-retry": "delegate" } } } as never)
      applyConfigToState({ anthropic: {} } as never) // 模拟第二次加载（热重载）
      // 依据既有 config.ts 语义核实：未显式传键是否保留上次值还是回落默认——须与其他 Record 类型键（如 tool_strip_fields）的既有热重载语义保持一致，写测试前先读 config-hot-reload.it.test.ts 确认预期方向
    })
  })
  ```
  （最后一个 test 的具体断言方向需要先读 `tests/config/config-hot-reload.it.test.ts` 确认既有 Record 类型键在「配置里缺省该键」时的语义——是「保留上次热重载值」还是「重置默认」，本计划必须和既有同类键（如 `retry_reject_body_fields`）保持一致，不擅自发明新语义。）
- [ ] 跑测试确认红
- [ ] 最小实现：
  - `config.ts`（678 行后追加）：
    ```ts
    if (a.error_shaping_enabled !== undefined) setAnthropicBehavior({ errorShapingEnabled: a.error_shaping_enabled })
    if (a.error_ask_user_question !== undefined) setAnthropicBehavior({ errorAskUserQuestion: a.error_ask_user_question })
    if (a.error_auq_template !== undefined) setAnthropicBehavior({ errorAuqTemplate: a.error_auq_template })
    if (a.error_selfheal_delegate !== undefined) setAnthropicBehavior({ errorSelfhealDelegate: a.error_selfheal_delegate })
    ```
  - `state.ts` `CONFIG_MANAGED_DEFAULTS`（追加，紧邻其他 Anthropic 行为默认值旁）：
    ```ts
    errorShapingEnabled: true,
    errorAskUserQuestion: false,
    errorAuqTemplate: "",
    errorSelfhealDelegate: {} as Readonly<Record<string, "proxy" | "delegate">>,
    ```
  - `state.ts` `setAnthropicBehavior` 的 `Pick<MutableState, ...>` 列表追加 `"errorShapingEnabled" | "errorAskUserQuestion" | "errorAuqTemplate" | "errorSelfhealDelegate"`
  - `state.ts` `mutableState` 初始字面量 + `resetConfigManagedState()` 两处，各追加一行 `errorSelfhealDelegate: { ...CONFIG_MANAGED_DEFAULTS.errorSelfhealDelegate },`（Record 类型需要显式浅拷贝，避免跨请求共享引用——`errorShapingEnabled`/`errorAskUserQuestion`/`errorAuqTemplate` 是标量，随顶层 `...CONFIG_MANAGED_DEFAULTS` 自动继承，无需单独一行）
- [ ] 确认绿
- [ ] 提交（`feat: wire error-shaping config keys through config.ts + state.ts`）

## 任务 0.3：MutableState 类型声明 + JSDoc

- [ ] 确认 `MutableState` 接口（`state.ts` 顶部）里补 4 个字段声明 + JSDoc（参照 280-320 行 `streamKeepaliveMode` 等字段的注释风格）——这一步通常会被 TypeScript 编译错误强制暴露（`Pick<>` 引用不存在字段会报错），可作为「类型系统前置逼出全站点」的验证：跑 `bun run typecheck` 确认无残留错误
- [ ] 提交（若与 0.2 是同一提交也可合并，视改动是否已经在同一 commit 里）

## Phase 0 完成检查

- [ ] `bun run typecheck` 全绿
- [ ] `bunx eslint src/lib/config/schema.ts src/lib/config/config.ts src/lib/state.ts tests/config/error-shaping-config.unit.test.ts`（无缓存，全量核实，参照 `tooling-eslint-cache-false-pass` 记忆）
- [ ] 确认未改动 `src/lib/codec/openai-cc/` / `src/lib/codec/openai-responses/` 任何文件（非目标守卫）

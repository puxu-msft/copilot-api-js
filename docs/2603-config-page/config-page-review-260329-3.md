# config-page design-vs-implementation review 260329-3

## 审阅方法

逐项对照 `docs/config-page-design.md` 的每个章节，与当前代码实现进行比对。重点关注：设计偏离、未完成事项、未覆盖的测试用例。

## 设计偏离

### 1. [需更新设计文档] `rate_limiter` 的 merge 策略与设计文档不一致

**设计文档**（L233-248）把 `rate_limiter` 列为 **collection 整段替换**：

> collection 整段替换 | `model_overrides`, `anthropic.rewrite_system_reminders`（array 形式）, `system_prompt_overrides`, **`rate_limiter`**

**实际实现**（`route.ts:478`）使用 `setNestedScalarContainer`（nested scalar partial merge）：

```ts
if (hasOwn(body, "rate_limiter")) setNestedScalarContainer(doc, ["rate_limiter"], body.rate_limiter)
```

这意味着 rate_limiter 的部分更新（只发送一个子字段）会保留其他 sibling，而不是整段替换。实施文档已解释偏离原因——避免与 anthropic 同源的 sibling 误删问题。

**判断：** 实现比设计更稳健，偏离合理。但设计文档应同步更新，将 `rate_limiter` 从 "collection 整段替换" 移到 "nested scalar setIn/deleteIn" 行。

### 2. [需更新设计文档] GET /api/config/yaml 对非法 YAML 的错误处理

**设计文档**（L470）：

> config.yaml 解析失败（非法 YAML） | GET 返回 500 + 错误信息，前端显示错误提示

**实际实现**（`config.ts:216-234` `loadRawConfigFile`）：对 parse error 直接 throw，Hono 会返回 500。但 GET handler（`route.ts:60-63`）没有 try-catch，所以非法 YAML 会导致未处理异常，Hono 默认返回 500 Internal Server Error（无结构化错误信息）。

**判断：** 功能上 500 是对的，但设计文档说"返回 500 + 错误信息"——当前实现返回的是 Hono 默认错误页面，不是结构化 JSON。这对前端 error 处理够用（`useConfigEditor` 会 catch 并显示 error），但如果想返回可读的错误信息（如 "Invalid YAML at line 5"），需要在 GET handler 加 try-catch。

**严重程度：低。** 非法 YAML 是边缘场景，且设计文档明确说 "不提供 config.yaml 语法错误的可视化修复"。

## 未覆盖的测试用例

按设计文档测试计划逐项比对：

### 后端测试缺失项

| 设计文档测试计划 | 状态 | 说明 |
|---|---|---|
| **1.3** config.yaml 包含所有已知字段 → 返回完整 ConfigYamlResponse | ❌ 缺少 | 只测了部分字段 |
| **2.3** 非法 regex pattern 返回 400 | ❌ 缺少 | 只测了合法 inline flags，没测非法 regex |
| **2.7** 合法完整配置 → 200 | ❌ 缺少 | 没有发送所有字段的成功测试 |
| **3.3** 清空不存在的字段 → 文件不变 | ❌ 缺少 | 只测了清空存在的字段 |
| **3.4** 修改 nested scalar（anthropic.strip_server_tools） | ❌ 缺少 | sibling 测试有，但没有单独的"修改 nested scalar 保留注释"测试 |
| **3.5** 清空 nested scalar（shutdown.graceful_wait: null）子 key 删除但容器保留 | ❌ 缺少 | 整 section 删除有测试，但单个子 key 清空没有 |
| **3.6-3.8** 整段替换 model_overrides（增删改） | ❌ 缺少 | model_overrides 只在校验测试中出现，没有 merge 行为测试 |
| **3.9** 整段替换 rewrite rules array | ❌ 缺少 | anthropic sibling 测试覆盖了添加，但没有"替换已有 rules"的测试 |
| **3.10** 未发送顶层 key 保持原样 | ✅ 被空 body 测试间接覆盖 | |
| **5.2** PUT 删除 anthropic.strip_server_tools → runtime 回退 | ❌ 缺少 | 只测了 fetch_timeout 和 shutdown 的回退 |
| **5.4** PUT 删除 model_overrides → runtime 回退 DEFAULT_MODEL_OVERRIDES | ❌ 缺少 | |
| **5.5** PUT 删除 system_prompt_overrides → runtime 回退空 array | ❌ 缺少 | |
| **5.8** resetConfigManagedState 不被普通 per-request 热重载调用 | 部分覆盖 | component test 有"empty config does not mutate state"，但不是专门测试 reset 不被调用 |

### 前端测试缺失项

| 设计文档测试计划 | 状态 | 说明 |
|---|---|---|
| **7.4** 修改后恢复到原值 → isDirty 变回 false | ❌ 缺少 | 只测了修改后 isDirty=true 和 discard 后 false |
| **9.5** 点击 Save 含 restart 字段 → toast 额外提示 | 部分覆盖 | composable 测试有，VConfigPage 集成测试没有 |

## 其他观察

### GET /api/config/yaml 返回的是 raw yaml parse 结果，不是设计文档定义的 ConfigYamlResponse 类型

`loadRawConfigFile()` 返回 `Config` 类型（`yaml.parse()` 的原始结果），而设计文档定义了 `ConfigYamlResponse` 类型。两者结构实际上是一致的（`Config` 接口的定义覆盖了 `ConfigYamlResponse` 的所有字段），但如果 config.yaml 包含未知字段，`loadRawConfigFile` 会把它们也返回——而设计文档的 `ConfigYamlResponse` 只列出了已知字段。

这不是 bug（前端会忽略未知字段），但值得注意。

### `rewrite_system_reminders: "yes"` 的校验

设计文档校验表（L261）说 `rewrite_system_reminders: "yes"` 应返回 400。实际实现（`route.ts:258-262`）在 `validateAnthropic` 中只检查 boolean 类型或 array，string `"yes"` 会进入 `validateRewriteRules` 被 "Must be an array, boolean, or null" 拒绝。功能正确。

## Summary

| 类别 | 数量 |
|------|------|
| 设计偏离（需更新设计文档） | 2（rate_limiter merge 策略、GET 500 错误格式） |
| 未覆盖的后端测试用例 | ~10 条（设计文档列了 30+ 条，实现覆盖了约 16 条） |
| 未覆盖的前端测试用例 | 2 条 |
| 阻塞性 bug | 0 |

**核心功能全部实现正确**，没有发现新的 bug。偏离点都是合理的改进。主要差距在测试覆盖——设计文档的测试计划比较详尽（9 大类 60+ 用例），实际实现覆盖了核心路径但跳过了一些边缘用例。这些缺失的测试不影响当前功能正确性，但会降低回归保护。

设计文档本身需要同步更新 `rate_limiter` 的 merge 策略描述。

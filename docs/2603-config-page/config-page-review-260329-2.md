# config-page-design implementation review 260329-2

## 审阅范围

按照 `docs/config-page-design.md` 的设计文档，对 Codex 实施的完整 Config 页面进行全面校验。覆盖后端路由、YAML merge 逻辑、state 管理、前端页面/组件/composable、导航变更、类型定义和测试。

## Findings

### 1. [高] `anthropic` 部分更新会误删未发送的 sibling 字段

`src/routes/config/route.ts:489-508` 中 `mergeConfigIntoDocument()` 处理 anthropic 时，通过解构创建了一个新对象：

```ts
setNestedScalarContainer(doc, ["anthropic"], {
  strip_server_tools: anthropic.strip_server_tools,
  immutable_thinking_messages: anthropic.immutable_thinking_messages,
  dedup_tool_calls: anthropic.dedup_tool_calls,
  strip_read_tool_result_tags: anthropic.strip_read_tool_result_tags,
  context_editing: anthropic.context_editing,
})
```

问题：当前端只发送 `{ anthropic: { rewrite_system_reminders: [...] } }` 时，解构出来的其他字段（如 `anthropic.strip_server_tools`）为 `undefined`。`Object.entries({ strip_server_tools: undefined })` 会产出 `["strip_server_tools", undefined]`，随后 `setScalar()` 对 `undefined` 执行 `doc.deleteIn()`——未发送的 anthropic 子字段从文件中被删除。

这违反了设计文档的核心规则："未发送的字段保持原文件不动"。

修复方案：不应解构创建新对象，而应直接传 `anthropic` body 对象给 `setNestedScalarContainer`，使其只遍历实际存在的 key。同时，`setNestedScalarContainer` 作为"只处理 scalar 子字段"的 helper，应通过显式的 exclude set 参数跳过 `rewrite_system_reminders` 这类 collection 字段（如 `excludeKeys?: Set<string>`），而不是靠运行时值类型推断——职责边界由字段集合定义比运行时猜测更稳妥。

### 2. [低] General section 缺少 `requires-restart` 标注

VConfigPage.vue 中 Rate Limiter section 正确加了 `requires-restart` prop（L365），但 General section（包含 `proxy` 字段）没有加（L199-214）。

保存后 `hasRestartFields` 能正确检测到 proxy 变化并在 toast 中提示，但用户在编辑前缺少视觉预警。

### 3. [极低] `ConfigKeyValueList` 会渲染空错误节点

`ui/history-v3/src/components/config/ConfigKeyValueList.vue:87-93` 的 duplicate key 错误渲染使用独立 `v-for`，对每个 entry 都生成一个 `<div class="text-caption text-error">`（即使没有 duplicate），产生多余空 DOM 节点。

可以将 `v-if="duplicateKey(index)"` 提到 `v-for` 的 div 上，或将 duplicate error 内联到对应 `v-text-field` 的 `error-messages` prop。

## 测试覆盖评估

### 已有覆盖（不应算缺失）

| 测试点 | 覆盖位置 |
|-------|---------|
| `CONFIG_MANAGED_DEFAULTS` 与 `mutableState` 一致性 | `tests/component/config-hot-reload.test.ts` |
| Route variant / 导航切换 / `/v/config` special-case | `ui/history-v3/tests/route-variants.test.ts` |
| `model_overrides` / `rewrite_system_reminders` 运行态替换语义 | `tests/component/config-hot-reload.test.ts` |

### 仍值得补充的测试

| 测试点 | 说明 |
|-------|------|
| `anthropic` 部分更新 sibling 保留 | 回归测试：只更新一个 anthropic 子字段，断言其他子字段不被删除 |
| `PUT {}` 空 body | 断言配置语义不变（已有关键字段和注释结构保留），不要求字节级一致——YAML 重新序列化可能产生合法的格式微调 |
| 负数超时值返回 400 | `fetch_timeout: -1` → 400 |
| 空 key model_overrides 返回 400 | `"": "target"` → 400 |
| `useConfigEditor.save()` 网络失败 | 非 ApiError 异常时的 error 状态和 toast |

## 举一反三

此次发现的 anthropic sibling 误删 bug 揭示了两条通用原则：

### 1. nested partial update 必须严格区分三种语义

对任何 nested object 的 merge 逻辑，都必须区分：

- **缺失字段（key 不存在于 body）**：保持原值
- **`null`**：删除
- **具体值**：覆盖

不能先构造一个带 `undefined` 的"合成对象"，再把 `undefined` 解释为删除。这种模式会反复产出同类 bug。

### 2. 每个 nested section 都应有 sibling-preservation 回归测试

凡是支持部分更新的 nested section（`anthropic`、`shutdown`、`history` 等），都应补一条标准回归测试：

- 原文件里有多个 sibling
- 请求只更新其中一个
- 断言其他 sibling 完整保留

这样可以系统性防止 merge helper 在未来重构时引入误删。

## 可选改进

以下建议有助于维护性，但不应与 bug 修复混排，优先级低于 correctness：

- **拆分 route.ts**（539 行）：校验函数 → `validation.ts`，YAML merge → `yaml-merge.ts`
- **删除 identity helper**：`useConfigEditor.ts` 中的 `normalizeNullableNumber` 和 `normalizeNullableBoolean` 是纯 `return value`

## Summary

| 优先级 | 问题 | 状态 |
|-------|------|------|
| 高 | anthropic 部分更新误删 sibling 字段 | 需立即修复 |
| 低 | General section 缺少 requires-restart 标注 | 建议修复 |
| 极低 | ConfigKeyValueList 空错误 DOM 节点 | 可选改进 |

实施整体质量高，设计文档的核心要求都得到了正确落地。唯一的实质性 bug 是 anthropic 的 merge 逻辑，修复后即可投入使用。

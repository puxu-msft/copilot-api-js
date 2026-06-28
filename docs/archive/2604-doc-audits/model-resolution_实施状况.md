> **⚠️ 已归档（2026-06-28）——陈旧的 2026-04-14 文档审查快照，勿当当前状态依据。** 见同目录 [README.md](README.md)。
> 本快照为 2026-04-14 对 docs/model-resolution.md 的逐条核验，point-in-time、未重新核验，仅作历史记录。

# model-resolution.md 实施状况

> 审查日期：2026-04-14
> 对照源码验证 docs/model-resolution.md 中每项声明的准确性

## 总体评价：准确，步骤编号有细微结构差异

---

## 逐项验证

### 1. "resolveModelName()（src/lib/models/resolver.ts）"

**状态：✅ 准确**

函数 `resolveModelName` 在 `src/lib/models/resolver.ts` 行 164 导出。

### 2. 五步解析流程

**状态：⚠️ 大体准确，步骤编号与代码结构有差异**

文档描述 5 步：
1. 检查 raw name 是否在 `modelOverrides` 中
2. 别名/规范化解析
3. 检查解析后的名称是否在 overrides 中
4. 检查 family 级别的 override
5. Override 目标支持链式解析 + 循环检测

实际代码中，还有一个"步骤 0" — bracket 记法规范化（`opus[1m]` → `opus-1m`，行 166）。链式解析和循环检测在 `resolveOverrideTarget()`（行 212-242）中实现，它被步骤 1、3、4 共用调用，而不是一个独立的步骤 5。

**结论**：功能上完全正确，但"链式解析是第 5 步"这个描述在架构上略有误导。

### 3. 修饰符后缀

**状态：✅ 准确**

- `extractModifierSuffix()`（行 132）处理 `-fast` 和 `-1m` 修饰符
- `normalizeBracketNotation()`（行 147）转换 bracket 记法（如 `opus[1m]` → `opus-1m`）

### 4. MODEL_PREFERENCE 优先级列表

**状态：✅ 准确**

`MODEL_PREFERENCE`（行 22-39）定义：
- opus: `["claude-opus-4.6", "claude-opus-4.5", "claude-opus-41"]`
- sonnet: `["claude-sonnet-4.6", "claude-sonnet-4.5", "claude-sonnet-4"]`
- haiku: `["claude-haiku-4.5"]`

### 5. config.yaml 的 model_overrides

**状态：✅ 准确**

`Config` 接口（`src/lib/config/config.ts` 行 248）有 `model_overrides?: Record<string, string>`。应用逻辑（行 417-419）将用户配置与默认值合并。

### 6. 默认 overrides

**状态：✅ 准确**

`DEFAULT_MODEL_OVERRIDES`（`src/lib/state.ts` 行 445-449）：
- `opus` → `claude-opus-4.6`
- `sonnet` → `claude-sonnet-4.6`
- `haiku` → `claude-haiku-4.5`

### 7. 相关代码

**状态：✅ 准确**

三个文件均存在且相关：`resolver.ts`、`client.ts`、`endpoint.ts`。

---

## 文档未覆盖的功能

| 遗漏项 | 说明 |
|--------|------|
| Bracket 记法规范化 | `normalizeBracketNotation()` 作为"步骤 0"未明确提及（尽管 `opus[1m]` 示例暗示了它） |
| `resolveOverrideTarget()` | 链式解析的具体函数名和循环检测实现细节 |

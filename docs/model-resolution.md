# Model 解析

## 概述

`resolveModelName()`（`src/lib/models/resolver.ts`）将用户请求的模型名解析为实际可用的模型 ID。短别名（`opus`/`sonnet`/`haiku`）与任意映射**只经 `model_overrides` 配置驱动**——没有内置的 family 偏好回退，也不再自动剥离日期后缀。

## 解析流程

1. 剥离路由后缀 `@cc`/`@responses`/`@messages`（若有），供翻译矩阵定出站腿。
2. Bracket 归一化：`opus[1m]` → `opus-1m`。
3. 整名 override 查找（按归一化拼写匹配）：如 `opus` → `claude-opus-4.8`、`claude-opus-4.6` → `claude-opus-4.8`。
4. 修饰符后缀（`-1m`/`-fast`）：整名无 override 但 base 有时，重定向 base 再重挂后缀。
5. 别名/规范化（`resolveModelNameCore`）：连字符版本 `claude-opus-4-6` → 点形式 `claude-opus-4.6`，随后对规范化后的名字再查一次 override。
6. Override 目标支持链式解析 + 循环检测。

未命中任何 override 的名字**原样透传**，由上游（GHC）自行接受或拒绝。

## 日期后缀不再自动剥离

以前 `claude-haiku-4-5-20251001` 会被隐式剥成 `claude-haiku-4.5`。该逻辑已移除（`VERSIONED_RE` 不再匹配 `-YYYYMMDD`，`DATE_ONLY_RE` 已删）：把带日期的快照名映射到规范 id 现在是**显式的 `model_overrides` 决定**，而非隐藏魔法。

- 命中 override → 按配置解析（可指向规范名或任意重定向目标）。
- 未命中 → 原样透传给上游，GHC 拒绝，**失败可见**，而非被静默改写。

GHC 上游只认点形式、无日期的 id（如 `claude-haiku-4.5`），因此外部客户端（裸 Anthropic SDK、硬编码带日期 id 的 subagent 等）发来的带日期名需在 config 里逐条列出。本项目自己的 `/start` Claude Code 集成写入的是 GHC 规范 id（`setup-claude-code.ts`），不发带日期名，不受影响。

bundled `config.yaml` 的 `model_overrides` 已给出一组常用带日期名 → 规范名的默认映射，按实际客户端增删：

```yaml
model_overrides:
  claude-haiku-4-5-20251001: claude-haiku-4.5
  claude-sonnet-4-5-20250929: claude-sonnet-5
  claude-opus-4-1-20250805: claude-opus-4.8
```

保留的行为：连字符 → 点规范化（`claude-haiku-4-5` → `claude-haiku-4.5`，GHC 上游也不认连字符形式）仍自动进行——只移除了日期这一维。

## 修饰符后缀

支持修饰符后缀处理：
- `claude-opus-4-6-fast` → `claude-opus-4.6-fast`
- `opus[1m]` → `opus-1m` → 经 `opus` override + `-1m`

## Model Overrides

用户可通过 config.yaml 的 `model_overrides` 配置任意映射（如 `gpt-4o: claude-opus-4.8`），支持链式解析。**仅列出的精确键受影响**——不做 family 级传播。要重定向整个 family，请逐个列出其规范名。Override 键按归一化拼写（大小写、点/连字符）匹配，故 `claude-opus-4.8` 与 `claude-opus-4-8` 视为同一键。

相关代码：`src/lib/models/resolver.ts`、`src/lib/models/normalize-id.ts`、`src/lib/models/model-name.ts`、`src/lib/models/client.ts`、`src/lib/models/endpoint.ts`

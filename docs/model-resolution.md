# Model 解析

## 概述

`resolveModelName()`（`src/lib/models/resolver.ts`）将用户请求的模型名解析为实际可用的模型 ID。

## 解析流程

1. 检查 raw name 是否在 `modelOverrides` 中（如 `opus` → `claude-opus-4.6`）
2. 别名/规范化解析：短别名（`opus` → 最佳可用）、连字符版本（`claude-opus-4-6` → `claude-opus-4.6`）、日期后缀（`claude-opus-4-20250514` → 最佳可用 opus）
3. 检查解析后的名称是否在 overrides 中
4. 检查 family 级别的 override（如 `opus` → `claude-opus-4.6-1m` 时，`claude-opus-4-6` 也被重定向）
5. Override 目标支持链式解析 + 循环检测

## 修饰符后缀

支持修饰符后缀处理：
- `claude-opus-4-6-fast` → `claude-opus-4.6-fast`
- `opus[1m]` → `opus-1m` → `claude-opus-4.6-1m`

## 优先级列表

每个模型家族有一个优先级列表（`models/resolver.ts` 中的 `MODEL_PREFERENCE`）。使用短别名时，会选择优先级列表中第一个可用的模型。

## Model Overrides

用户可通过 config.yaml 的 `model_overrides` 配置任意映射（如 `gpt-4o: claude-opus-4.6`），支持链式解析和 family 级别重定向。

内置默认：
- `opus` → `claude-opus-4.6`
- `sonnet` → `claude-sonnet-4.6`
- `haiku` → `claude-haiku-4.5`

相关代码：`src/lib/models/resolver.ts`、`src/lib/models/client.ts`、`src/lib/models/endpoint.ts`

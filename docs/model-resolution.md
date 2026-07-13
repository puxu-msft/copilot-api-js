# Model 解析

## 概述

`resolveModelName()`（`src/lib/models/resolver.ts`）将用户请求的模型名解析为实际可用的模型 ID。短别名（`opus`/`sonnet`/`haiku`）与任意映射**只经 `model_overrides` 配置驱动**——没有内置的 family 偏好回退，也不再自动剥离日期后缀。

## 解析流程

1. 剥离路由后缀 `@cc`/`@responses`/`@messages`（若有），供翻译矩阵定出站腿。
2. Bracket 归一化：`opus[1m]` → `opus-1m`。
3. 整名 override 查找（按归一化拼写匹配）：如 `opus` → `claude-opus-4.8`、`claude-opus-4.6` → `claude-opus-4.8`。
4. 修饰符后缀（`-1m`/`-fast`）：整名无 override 但 base 有时，重定向 base 再重挂后缀。
5. 别名/规范化（`resolveModelNameCore`）：**拼写规范化数据驱动**——按 `normalizeForMatching`（大小写、点/连字符不敏感）在活的 `/models` 目录里回查，命中则返回该模型的**真实 id**（如 `claude-opus-4-6` → 目录里的 `claude-opus-4.6`）。随后对规范化后的名字再查一次 override。
6. Override 目标支持链式解析 + 循环检测。

未命中任何 override、且在 `/models` 目录里无拼写等价项的名字**原样透传**，由上游（GHC）自行接受或拒绝。

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

保留的行为：连字符 → 点的**拼写规范化**（`claude-haiku-4-5` → `claude-haiku-4.5`，GHC 上游也不认连字符形式）仍进行——但**不再靠硬编码的 `claude-{family}-{major}-{minor}` 正则**，而是按 `/models` 目录**数据驱动**（`canonicalizeFromCatalog`，拼写不敏感回查、返回真实 id）。这比正则更正确：对**任意**含点的模型 id 都成立（含非-Claude 的 `gemini-3.1-pro-preview`/`gpt-5.5`），绝不产出目录里不存在的名字，且新模型自动工作、零 config。它是同一模型的拼写等价（类似大小写不敏感），非策略决定，故留在 resolver 而非塞进 `model_overrides`。

> 注：`normalizeModelId`（`normalize-id.ts`）是**独立的 state-free 纯函数**——前端经 `~backend` 在浏览器里用它把上游响应名归一化到 `/models` id 做遥测 join，无法依赖后端 catalog，故它仍用 `VERSIONED_RE` 正则。请求侧（resolver）与响应/前端侧（normalizeModelId）是不同消费者，只是历史上共用过该正则。

**边界**：空 `/models` 目录下不再做连字符→点转换（数据驱动无源，返回原样）——这是本次唯一的可观测行为差异。生产中 `cacheModels()` 在服务开始前运行（失败即 `exit(1)`），运行期目录永不为空，故此边界不可达；单测需先 `setModels(...)` 才有规范化源。

## 修饰符后缀

支持修饰符后缀处理：
- `claude-opus-4-6-fast` → `claude-opus-4.6-fast`
- `opus[1m]` → `opus-1m` → 经 `opus` override + `-1m`

## Model Overrides

用户可通过 config.yaml 的 `model_overrides` 配置任意映射（如 `gpt-4o: claude-opus-4.8`），支持链式解析。**仅列出的精确键受影响**——不做 family 级传播。要重定向整个 family，请逐个列出其规范名。Override 键按归一化拼写（大小写、点/连字符）匹配，故 `claude-opus-4.8` 与 `claude-opus-4-8` 视为同一键。

相关代码：`src/lib/models/resolver.ts`、`src/lib/models/normalize-id.ts`、`src/lib/models/model-name.ts`、`src/lib/models/client.ts`、`src/lib/models/endpoint.ts`

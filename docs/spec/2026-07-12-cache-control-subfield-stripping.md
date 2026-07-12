# Spec: cache_control 子字段剥离 + sanitize 语义收窄

- 状态：草案（待 subagent 评审 → 用户批准 → writing-plans）
- 日期：2026-07-12
- 归属：`docs/spec/`（模块契约 / 兼容行为，见 CLAUDE.md 文档路由）
- 相关：ADR `docs/decisions/2026-07-05-richest-data-flow.md`、skill `ghc-api-reference` / `ghc-anthropic-upstream`

## 1. 问题（What & Why）

### 1.1 触发实例

Claude Code 2.1.206（`agent-sdk/0.3.199`）经本项目 `anthropic-messages` 端点请求 `claude-opus-4-8`，上游返回：

```
HTTP 400  system.1.cache_control.ephemeral.scope: Extra inputs are not permitted
request_id: req_011CcwL3uKA8N7zE8HoQsNQi
```

实测原始请求（`/mnt/q/my/Downloads/req_1783821234150_118_claude-opus-4.8.json.zst`）确认：

```json
system[1].cache_control = { "type": "ephemeral", "scope": "global" }   // 400 元凶
system[2].cache_control = { "type": "ephemeral" }                       // 正常
```

请求头 `anthropic-beta` 含 `prompt-caching-scope-2026-01-05`。即 `scope: "global"` 是 Claude Code 的正规新特性（全局作用域 prompt cache），由该 beta 启用。**GHC 上游（→ Anthropic 后端）未启用此 beta**，于是把 `scope` 当未知字段拒绝。request_id 是 Anthropic 格式，因为 GHC 把后端校验错误透传回来。

### 1.2 根因

本质是「**客户端 beta 集合 ⊋ GHC 支持的 beta 集合**」。Claude Code 持续发送 GHC 未必支持的新 beta（同请求还有 `mid-conversation-system-2026-04-07`、`advanced-tool-use-2025-11-20`、`effort-2025-11-24` 等）。`scope` 是首个「往 body 现有字段内部塞子字段」的形态，恰好被现有的顶层字段剥离机制漏过——现有 `collectRejectedFields` 剥的是**顶层 body 字段**，`filterUnsupportedBetas` 剥的是**beta token**，`stripToolFields` 剥的是**tool 顶层字段**，**没有「cache_control 内部子字段」这个粒度**。

### 1.3 为何默认 passthrough 会漏

`cacheControlMode` 默认 `passthrough`（[state.ts:1390](../../src/lib/state.ts#L1390)），[applyCacheControlMode](../../src/lib/anthropic/request-preparation.ts#L916) 的 `case "passthrough"` 纯 `break`，原样转发 → `scope` 直达上游 400。而 `sanitize`（整体重建 cache_control）与 `proxied`（全删客户端 cache_control 再自注入）走的是「重建/全删」语义，对 `scope` 天然免疫，但代价是丢弃客户端精调的断点。

## 2. 目标与非目标

### 目标
- **G1**：消除 `cache_control.scope` 类 400，且**保留** passthrough 的客户端精调断点（只挖已知地雷，不整体重建）。
- **G2**：一般化——未来任何新的「GHC 未支持 cache_control 子字段」踩一次 400 即自愈，零改代码。
- **G3**：收窄 sanitize 语义，使其「规范化」职责不再越权替客户端做 TTL 降级决策。

### 非目标
- 不改 proxied（其「全删客户端断点、GHC 式重建」是刻意语义，不涉及保留客户端 ttl）。
- 不处理「GHC 未支持 beta」的其他形态（如顶层新字段、tool 新字段）——那些已有对应机制。本 spec 只补 cache_control 子字段这一粒度缺口。
- 不做白名单法（见 §6 决策记录）。

## 3. 方案总览（判据）

| 决策 | 取值 | 判据 |
|---|---|---|
| 剥离策略 | **黑名单 B + 反应式学习 C** | 黑名单只剥确认地雷、不误杀 GHC 其实支持但我们没登记的字段（GHC 总滞后于 Claude Code）；反应式补「新字段先踩一次 400」的缺口 |
| 作用范围 | **仅 passthrough** | sanitize/proxied 对未知子字段已免疫，无需接黑名单/学习集 |
| sanitize | **收窄：保留客户端合法 ttl** | 剥非法子字段是其应有之义，但强制 TTL 降级是越权；TTL 覆盖应由 extended 特性以「只升不降」叠加 |
| 学习键 | **endpoint-level（model-agnostic）** | 「GHC 未支持某 cache_control 子字段」是上游版本属性、非 per-model，对齐 tool-field-rejection |

## 4. Phase 0：sanitize 语义收窄

### 4.1 现状（越权）

[applyCacheControlMode](../../src/lib/anthropic/request-preparation.ts#L924) 的 sanitize：

```ts
walkCacheControl(wire, (_current, section) => (section === "messages" ? messagesEphemeral : toolsSystemEphemeral))
```

丢弃 `_current`，无条件换成层预算对象（`ephemeralFor(layerTtl)`）。这把两件事混在一起：① 剥掉非 `{type,ttl}` 子字段（正确）；② **无条件设定 TTL**（越权——extended 未激活时，客户端的 `ttl:"1h"` 被误降为 5m 默认）。

### 4.2 新语义

sanitize 改为「保留白名单字段 `{type, ttl}` 重建」，TTL 取「客户端合法 ttl」与「extended 升级值」的 max（只升不降）：

```
sanitizeOne(current, section):
  result = { type: "ephemeral" }
  clientTtl  = current.ttl in {"5m","1h"} ? current.ttl : "5m"
  layerTtl   = extendedTtlActive ? (section=="messages" ? messagesTtl : toolsSystemTtl) : "5m"
  effective  = max(clientTtl, layerTtl)   // 顺序 5m < 1h
  if effective == "1h":  result.ttl = "1h"
  return result   // scope 等非白名单子字段：只挑 type+ttl 重建，自动剥除
```

### 4.3 行为矩阵（Phase 0 唯一可观测变化）

| 客户端 cache_control | extended 未激活（默认） | extended 激活 |
|---|---|---|
| `{ephemeral}` | `{ephemeral}` | `{ephemeral, ttl:1h}`（升级） |
| `{ephemeral, ttl:1h}` | **`{ephemeral, ttl:1h}`**（现状误降 5m → 修正保留） | `{ephemeral, ttl:1h}` |
| `{ephemeral, ttl:1h, scope}` | **`{ephemeral, ttl:1h}`**（剥 scope、保 ttl） | `{ephemeral, ttl:1h}` |

唯一可观测变化：extended 未激活时，客户端 `ttl:1h` 不再被误降级为 5m。符合 richest-data-flow（不替客户端做 TTL 降级决策）。

### 4.4 边界（按 invariant 自定）

extended 激活但某层 clamp 到 5m（messages 层，见 [resolveExtendedTtls](../../src/lib/anthropic/request-preparation.ts#L176)）而客户端要 1h → **保留客户端 1h**（max 只升不降）。理由：客户端原始请求已是合法 TTL 组合；clamp 只约束「我们主动写」的场景，不该反向压低客户端诉求。

### 4.5 golden 测试

改动前先捕获现有 sanitize 对上述矩阵的输出（锁旧行为），改后断言新矩阵。`wireHasOneHourTtl` / beta 头 mirror 逻辑（[applyCacheControlMode](../../src/lib/anthropic/request-preparation.ts#L950)）保持不变——beta 头仍 iff wire 里真有 1h ttl。

## 5. Phase 1：passthrough 黑名单子字段过滤

### 5.1 读取端（三源 union，对齐 [collectStripBetas](../../src/lib/anthropic/request-preparation.ts#L228)）

新增 `collectUnsupportedCacheControlSubfields(model): Set<string>`：

- **源① 内置硬编码**：`{ "scope" }`（确认地雷，默认生效，无需 config 显式开——它是 bug 修复非可选增强）
- **源② config**：新键 `anthropic.strip_cache_control_subfields`，`Record<modelPattern, string[]>`，per-model + 通配 `"*"`，经 `collectAllMatching(model, state.stripCacheControlSubfields)` 合并
- **源③ negotiation 学习集**：Phase 1 **接口留空**（读取端已 union，值恒空），Phase 2 写入 → 读取端零改动

### 5.2 filter 原语（保对象、删子字段）

区别于现有 [walkCacheControl](../../src/lib/anthropic/request-preparation.ts#L1173)「整体替换/删除」，新增「就地删除黑名单子字段、保留其余」的变体。复用同一 system/messages/tools + 嵌套 content 递归骨架（避免第二套遍历逻辑），handler 改为对 cache_control 对象 `delete cc[field]`（field ∈ 黑名单）。

不变量：
- **保留** `type` / `ttl` / 一切非黑名单字段（含未来合法字段——黑名单法不误杀）。
- 黑名单为空时**完全不动** wire（Phase 1 若源①被 config 清空 + 源③空 → no-op）。
- 覆盖嵌套：`message.content[].cache_control`、`tool_result.content[].cache_control`。

### 5.3 接线

[applyCacheControlMode](../../src/lib/anthropic/request-preparation.ts#L921) 的 `case "passthrough"`：`break` 前调用 filter。`disabled`/`sanitize`/`proxied` 不动。

`ctx.wroteExtendedTtl` = `wireHasOneHourTtl(wire)` 逻辑不变（passthrough 客户端 1h 断点仍被正确 mirror 到 beta 头）。

### 5.4 config / state 落点（对齐 stripBetaHeaders 三处）

- schema.ts：加 `strip_cache_control_subfields`（`Record<string, string[]>`，nullable），紧邻 [cache_control](../../src/lib/config/schema.ts#L413)
- state.ts：加 `readonly stripCacheControlSubfields: Record<string, Array<string>>` + clone 逻辑（[801/837 附近](../../src/lib/state.ts#L801)）+ CONFIG_MANAGED_DEFAULTS（[1473/1477 附近](../../src/lib/state.ts#L1473)，默认 `{}`）+ patch 键白名单（[1175/1179 附近](../../src/lib/state.ts#L1175)）
- 注意：源①内置 `{scope}` 在**读取端**注入，不在 config 默认值里（config 默认 `{}` 表示"无额外覆盖"，与内置正交）

### 5.5 测试

单元覆盖：剥 `scope` / 保留合法 `ttl`+`type` / per-layer（system·messages·tools）/ 嵌套 tool_result.content / config 追加字段生效 / 空黑名单 no-op / passthrough 保留其余客户端断点不变。集成：模拟 §1.1 的实测 body，断言过 passthrough 后 `system[1].cache_control == {type:ephemeral}`、`system[2]` 不变。

## 6. Phase 2：反应式学习腿

### 6.1 negotiation cache（endpoint-level）

feature-negotiation.ts 加 `markAnthropicUnsupportedCacheControlSubfield(field)` / `getUnsupportedCacheControlSubfields(): string[]`，键控 endpoint（model-agnostic），对齐 [markAnthropicUnsupportedToolFields](../../src/lib/anthropic/feature-negotiation.ts#L402)。持久化进 negotiation state 文件（v2 schema），纳入 Learned 页管理（TTL/pin，对齐现有 negotiation-lifecycle）。

### 6.2 retry strategy

match `cache_control.<variant>.<field>: Extra inputs are not permitted`，`matchAll` 解析全部字段（多字段一次剥，对齐 tool-field H1），mark → `prepareHints`（新增 `excludeCacheControlSubfields`）剥掉重试。手写（非 `createReactiveRejectionStrategy`），因为 batch matchAll + model-agnostic mark 不匹配原语的 single-token/per-model 形状（与 tool-field 同理）。

### 6.3 遮蔽风险（承重）

`Extra inputs` 已被 [tool-field](../../src/lib/request/strategies/tool-field-rejection-retry.ts#L84)（`tools\.\d+\.\w+\.<field>`）与 body-field（top-level lookbehind）两 matcher 认领。cache_control 路径 `system.1.cache_control.ephemeral.scope` 理论上两者都不匹配（非 `tools.N`、非顶层），但**必须写认领归属回归测试**独立证实新腿不被首命中遮蔽（教训：记忆 `methodology-new-strategy-shadowed-by-broader-first-match`），并确认 driver 里的 ordering。新正则须容 `system` / `messages` / `tools` 三种 section 前缀 + 索引 + 嵌套路径。

### 6.4 reactive → proactive 收敛

学到的字段经 §5.1 源③自动进入下次请求的 passthrough 预剥（学一次 → 后续预剥，对齐 tool-field 双层）。

## 7. 分阶段与验证

- **Phase 0** 独立可测可提交（sanitize 收窄，golden 矩阵）。不阻塞后续。
- **Phase 1** 独立消除 scope 400（无 driver retry 接线风险）。依赖 Phase 0 无（正交）。
- **Phase 2** 涉及 retry ordering + 遮蔽验证，风险隔离到独立阶段。
- 读取端三源 union 在 Phase 1 一步建好，Phase 2 只加「写源③」，读取端零返工。
- **empirical-verification**：Phase 1/2 用 §1.1 实测 body 作正样本 oracle 验证剥离触达目标；遮蔽风险用独立回归测试证实，不自证。

## 8. 决策记录（record-not-adopted）

- **否 A（白名单法）**：白名单会误杀「GHC 其实支持、我们没登记」的字段；GHC 上游总滞后于 Claude Code，白名单等于持续追平 Anthropic 合法字段表。违背 passthrough「保留精调、只挖地雷」+ richest-data-flow。改用黑名单 B。
- **否「直接切默认 sanitize/proxied 绕过」**：会丢弃客户端精调断点（sanitize 整体重建 / proxied 全删）。用户明确要保留精调。
- **否「sanitize 不动」（我最初误判）**：曾以「TTL 覆盖是 extended 依赖的」为由主张不改，实为语义耦合——extended 借用 sanitize 的无条件覆盖实现升级，撑大了 sanitize 职责。正确分层：sanitize 只规范化（保留客户端 ttl），extended 叠加「只升不降」升级。收窄为 Phase 0。
- **proxied 不动**：其「全删客户端断点、GHC 式重建」是刻意语义，不涉及保留客户端 ttl。

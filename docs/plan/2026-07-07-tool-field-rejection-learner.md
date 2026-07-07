> **实施状态（2026-07-07）：✅ 已完整落地**。三腿全实现（内置默认 + 端点级反应式学习 + config 声明/逃生口）+ C1 前置修复 + C2 deny 守卫 + H1 matchAll + H2 可逆。两轮 plan 对抗审查 + 一轮交付审计（全 file:line 核验通过）。测试 3694 全绿、typecheck/eslint 干净、新策略 100% 覆盖。收尾采纳交付审计三小项：L2 日志降噪（内置-only 降 debug）、L1 codec 映射直测、M1 web_search hop 边界文档化（→ deferred-backlog）。活文档已同步：[DESIGN.md](../DESIGN.md) 配置表、[request-pipeline.md](../request-pipeline.md)、[anthropic-compat.md](../anthropic-compat.md)、[tool-use.md](../tool-use.md)、skill `ghc-anthropic-upstream`。
>
> 原始触发：`400 tools.0.custom.eager_input_streaming: Extra inputs are not permitted`（新版 Claude Code 挂在每 tool 上、GHC 上游版本较旧拒之）。

---

# 计划（v2，已过两轮对抗 subagent 审查）：unknown-tool-field 反应式学习 + 预剥

> v1 → v2 变更来源：接线核验 + 对抗设计两个 subagent 审查。承重修订见文末「审查采纳记录」。

## Context（为什么做）

新版 Claude Code 给每个 tool 定义挂 `eager_input_streaming`（Anthropic 较新的工具输入急流式优化字段）。CC 直连官方 Anthropic 认它，但本代理原样透传给 **GHC 上游**（版本较旧），GHC 严格判别联合校验遇未知字段直接 400：

```
tools.0.custom.eager_input_streaming: Extra inputs are not permitted
```

实测取证（`GET :4141/history/api/entries/req_1783438945268_546`）：inbound 每 tool keys=`['name','description','input_schema','eager_input_streaming']`;`.custom.` 是 pydantic 判别标签，**wire 上是 tool 顶层扁平键**。message-tools.ts 管线 `{...normalized}` 原样展开、anthropic.ts `Tool` 类型无此字段 → 未知字段无脑透传。

**目标**：不硬编码单字段，复刻本项目「反应式学习 + config∪cache 预剥」模板（server-tool / partner-feature 同款），让代理**自动学会**剥除任何被 GHC 以「Extra inputs are not permitted」拒绝的**未知**工具字段;`eager_input_streaming` 作已知安全默认使首请求零 400。

## 设计：三源预剥 + 反应式学习，全对齐 server-tool + partner-feature

### 剥除源合并语义（`stripToolFields` 核心）

对每个 tool 删除以下**顶层键并集，再减去两道守卫**：

```
strip_set = BUILTIN_STRIP_TOOL_FIELDS ∪ collectStripToolFields(model) ∪ getUnsupportedToolFields(endpoint) ∪ perAttempt.excludeToolFields
final = strip_set − collectKeepToolFields(model) − LEGIT_TOOL_KEYS
```

- `BUILTIN_STRIP_TOOL_FIELDS = ["eager_input_streaming"]`（实测取证的已知安全默认，镜像 `BUILTIN_REJECTED_FIELDS`）。
- **`LEGIT_TOOL_KEYS = {name, description, input_schema, type, defer_loading, cache_control}` 恒不剥**（C2 守卫）：这些是 GHC 合法建模的 tool 键。若它们被报「Extra inputs」，那是**上游 transform 把 tool 判别键改错、pydantic 落错变体**的信号（root-cause），应放行到裸 400 + 响亮告警让人排查，绝不静默剥掉掩盖 bug。
- `collectKeepToolFields(model)` ← config `anthropic.tool_keep_fields`：**可逆性逃生口**（H2）。将来某 GHC 上游若开始支持 `eager_input_streaming`，operator 用它解除内置强制剥除。镜像 structured-outputs「如何恢复」的文档化恢复路径。

`stripToolFields` 返回剥除详情（字段集 + 受影响 tool 数），经 prepare-step meta / telemetry 到达 history（**M2 可观测性**：预剥是内置默认生效后的**常态路径**，不能只 `consola.debug`）。

### 1. 反应式学习策略（新文件 `tool-field-rejection-retry.ts`）

用 `createReactiveRejectionStrategy` 原语的手写变体（因需 matchAll 批量 + 端点级 mark，照 structured-outputs 手写范式）：

- **match(error)**：仅 400;正则 `/tools\.\d+\.\w+\.([a-z_]\w*): Extra inputs are not permitted/gi`（变体段 `\w+` 容数字后缀 — **M3**;capture 后强制紧跟 `:` 落实「仅顶层字段」，嵌套 `input_schema.foo` 不匹配 — 已 oracle 验证）。用 **`matchAll` 解析全部字段**（**H1**）。**deny 守卫**：从结果剔除 `LEGIT_TOOL_KEYS`;若全部落在 LEGIT 内 → 返回 null（不认领 → 裸 400 + warn）。
- **mark**：`markAnthropicUnsupportedToolFields(fields)` —— **端点级、模型无关**（**M1**）。
- **remediate**：`{ action:"retry", payload, prepareHints:{ excludeToolFields: fields }, meta:{ strippedToolFields: fields } }`。

### 2. PrepareHints → opts → wire 完整透传（含 v1 遗漏的 codec.ts 最后一环）

- `PrepareHints` 加 `excludeToolFields?`（镜像 `excludeServerToolTypes`）。
- **codec.ts `prepareAnthropicWire` 加一行** `...(env.prepareHints.excludeToolFields && {...})` —— **v1 整段遗漏此文件**。
- `PrepareAnthropicRequestOptions` 加 `excludeToolFields?`;透传到 `buildWirePayload` → `stripToolFields`（`stripServerTools` 之后）。
- `Tool` 类型加 `eager_input_streaming?: boolean`（显式「知道且故意不转发」）。

### 3. 【C1 — 承重前置】收紧 body-field 正则 + 策略重排序

独立 oracle 已证 body-field 正则会 capture tool 路径字段、driver 首命中即止、body-field 排在前 → 不修则学习器 dead-on-arrival。

- **收紧** context-management-retry.ts `EXTRA_INPUTS_PATTERN` 为 `/(?<![.\w])([a-z_]\w*):\s*Extra inputs are not permitted/i`（附带修既有 latent bug）。
- **重排序** strategies.ts：tool-field 排在 body-field **之前**（防御纵深）。计数 13 → 14。

### 4. Negotiation 缓存（feature-negotiation.ts，**端点级** 6 站点）

模型无关存储（M1）：declare / mark+get / NegotiationStateFile 字段 / persist snapshot / load / 共享 `clearNegotiationMaps`。

### 5. Config：`tool_strip_fields` + `tool_keep_fields`

镜像 `partner_strip_features`（`Record<string, Array<string>>`;`"*"`=全模型）。state.ts 每键 8 站点。compat.ts 无需改（partner_strip_features 本就无迁移条目）。

### 6. 测试

策略单测（matchAll/变体数字/deny/one-shot/非匹配）、`stripToolFields`（四源 − keep − LEGIT / 删顶层键 / not-mutate）、缓存 roundtrip、prepare 端到端、codec 映射直测、C1 回归、meta-test 计数更新。

## 审查采纳记录（record-not-adopted）

**采纳（阻塞项）**：C1 正则冲突、C2 deny 守卫、H1 matchAll、H2 可逆性、codec.ts 映射遗漏、feature-negotiation 6 站点、state.ts 8 站点、类型 Record≠Map、计数 13→14。

**采纳为设计取舍**：M1 端点级模型无关缓存、M2 预剥可观测性（收尾细化为「内置-only debug / 其余 warn」降噪）、M3 变体段 `\w+`。

**交付审计（第三轮）采纳**：L1 codec 映射直测、L2 日志降噪、M1 web_search hop 边界文档化（→ deferred-backlog）。

**未采纳/降级**：
- 「先只硬编码剥 eager、学习器推后」—— 违背完整意图 + against-yagni，**否**。
- H2 备选「seed 放 config 默认值」—— config replace 语义会静默丢 seed（footgun），改采「BUILTIN 并集 + `tool_keep_fields` 减法」。
- compat.ts 改动（v1 列入）—— 核实无需，删除。

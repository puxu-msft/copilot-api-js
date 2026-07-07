# RFC: 反应式 per-model 上游拒绝协商 —— 完整性 pass

- 状态：DRAFT v3（R1+R2 对抗 review 已并入并逐条独立核验；O1–O5 已定，O6 推荐 (c) 待确认。R2 的 §3.2 FAIL 修正：payload.model 在 sanitize 已是解析名、无需改签名。待 O6 确认 + §3.2 定向 R3 后转 plan）
- 日期：2026-07-07
- 关联：ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)、ADR [internal-tool-security-posture](../decisions/2026-07-05-internal-tool-security-posture.md)、skill `telemetry-architecture`、skill `history-sqlite-schema`
- 触发实例：Claude Code 后台 `haiku` 请求（映射到 Vertex-routed `claude-sonnet-4.6`/`claude-haiku-4.5`）携带 inline `role:"system"` 消息 → 上游 400 → 无任何反应式恢复。

---

## 1. 问题陈述（带 file:line 证据的债务清单）

本项目已有一套「反应式 per-model 上游拒绝协商」框架：strategy 检测特定上游 400 → 从错误 body 学习 → 持久化到 negotiation-states.json → 重新准备 → 重试；并有 per-model config 孪生让操作员预声明。但这套框架**覆盖不完整**，多处「部分覆盖」缺口会让请求**永久 400、零反应式恢复**。

本 RFC 的债务清单（经实测 + subagent 审计 + 逐 file:line 独立复核确认）：

### 已观测（生产 history 语料确认）

| # | 缺口 | 证据 | 现状 |
|---|---|---|---|
| A | inline `role:"system"` 消息被上游严格后端拒绝，**无任何 strategy 匹配** | 实测 9 条终态失败；错误 `Unexpected role "system". The Messages API accepts a top-level system parameter`；唯一缓解是 proactive `sanitizeInlineSystemMessages`（[sanitize/system-messages.ts:102](../../src/lib/anthropic/sanitize/system-messages.ts#L102)），受 `system_messages_sanitize` 驱动、**默认 false/passthrough**（[schema.ts:268](../../src/lib/config/schema.ts#L268) 注释自认「default — will 400 upstream if present」） | 无反应式；默认关 |
| B | effort **零支持**变体 `... does not support reasoning effort`（无 `supported values:[...]` 列表）→ parse 在 :580 返 null → learn false → abort。且 negotiation 缓存**无法表达「已知空集」**（`[]` 与「未学习」在 5 处碰撞、含 snapshot/load 两处使空集不可持久化） | 实测 req_1783390118141_26（body 含 `code:invalid_reasoning_effort`、attemptCount=1）。`parseInvalidEffortError` 双正则须匹配（[request-preparation.ts:580](../../src/lib/anthropic/request-preparation.ts#L580)）；空集碰撞详见 §3.3 | effort-learning 部分覆盖 |
| C | `Tool 'web_search' not found in provided tools` 措辞与 deferred-tool 正则不匹配、补救也不对 | deferred-tool 正则是 `Tool reference '…' not found in available tools`（[deferred-tool-retry.ts:42](../../src/lib/request/strategies/deferred-tool-retry.ts#L42)）；唯一缓解是 proactive `tool_rewrite_history_server:"downgrade"`（[schema.ts:304](../../src/lib/config/schema.ts#L304)）**默认 false** | 无反应式；默认关 |

### 理论（审计发现、未在当前语料触发，但 parse 逻辑确凿会落空）

| # | 缺口 | 证据 |
|---|---|---|
| D | structured-outputs 的 `canHandle` 只放行 `structured_outputs`，而 `parseDisallowedPartnerFeature` 是**通用的**——其他 partner feature（`extended_thinking`/`vision`/…）被成功解析却被 canHandle 拒绝 → 落空 | [structured-outputs-rejection-retry.ts:124-126](../../src/lib/request/strategies/structured-outputs-rejection-retry.ts#L124) |
| E | server-tool-rejection 只硬编码 `web_search`（正则 + `web_search_` 前缀），其他 native server tool（`web_fetch`/`code_execution`/…）同类拒绝落空 | [server-tool-rejection-retry.ts:44](../../src/lib/request/strategies/server-tool-rejection-retry.ts#L44) |
| F | token-limit 只有 2 条正则（openai / `prompt is too long: N tokens > N maximum`），`max_tokens`-inclusive 或 Vertex 措辞的 context-length 400 匹配不上 → 被归 `bad_request`、auto-truncate 永不触发 | [parsing.ts:6,14](../../src/lib/error/parsing.ts#L6)、[classify.ts:230](../../src/lib/error/classify.ts#L230) |
| G | deferred-tool 的 `parseToolReferenceFromResponse` 对双层包裹 body `if(!message) return null` 先返回、不回退 raw text（姊妹策略 legacy-thinking / context-management 用 `parsed.error?.message ?? responseText`）| [deferred-tool-retry.ts:172-178](../../src/lib/request/strategies/deferred-tool-retry.ts#L172) |

### 可观测性（richest-data-flow 缺口）

| # | 缺口 | 证据 |
|---|---|---|
| H | 中途失败 attempt 的**完整上游错误 body 未持久化**——`AttemptSnapshot.error` 只有 `{status, message(标签), type}`，无 `rawBody`/`responseText`（[events.ts:115](../../src/lib/observability/events.ts#L115)）。终态失败经 outboundResponse.rawBody 存了，但 retry-恢复的请求，其失败 attempt 的错误 body 在源头丢失 → 事后无法核对「学习依据」 | 实测 req_1783322545677_656：attempt[0] 只有 `error:"Failed to create messages"` + responseHeaders，无 rawBody |

### 明确排除（非本 RFC 范围，审计确认非反应式框架缺口）

- `unrepairable malformed tool_use input (AskUserQuestion)`（语料 11 次，最高频）：这是**响应侧** repair 失败（上游 200 但 `tool_use.input` JSON.parse + 全部 repair 层失败，[handler-v4.ts:754-780](../../src/routes/messages/handler-v4.ts#L754) 记为 failed+upstreamSucceeded:true）。重试同请求会复现同样畸形生成——**有意终态失败**，属不同子系统（响应内容修复），不纳入本 RFC。

---

## 2. 根因定性（为什么是"服务模式"不是"模型能力"）

实测全家族 role:system 行为（亲手探针，非推断）：

| 解析后 outbound 模型 | inline role:system | 推断服务路径 |
|---|---|---|
| claude-sonnet-4-6 | **拒绝 400** | 严格（config 已文档化为 Vertex AI） |
| claude-haiku-4-5-20251001 | **拒绝 400** | 严格（Vertex 未证实） |
| claude-opus-4-8 | 接受 200（226 次） | 宽容（first-party） |
| claude-sonnet-5 | 接受 200 | 宽容（first-party） |

**结论：不是模型智力能力。** `messages` 里能否出现 `role:"system"` 是 **API 请求 schema 校验**，服务端点在任何推理前就裁决。拒绝是和已文档化的 Vertex beta-flag 拒绝、structured_outputs 拒绝**同一族**（服务层 org policy）。GHC 宽容 first-party 路径显然在转发前 hoist 了 inline system；严格路径（Vertex/partner）直接送 canonical 校验。

**建模抉择（已定）：能力框架，非 vertex 硬断言。** 因为 (1) 我们能可靠观测的是**症状**（该 outbound 模型拒绝 inline system），不是**成因**（是否 Vertex）；(2) 反应式学入的信号（通用 system-role 400）**不带 vertex 标记**，硬归 Vertex 是无依据推断；(3) 实测 haiku-4.5 也拒绝，但无法证明它是字面 Vertex。故 config 键与 state 集以**观测症状**命名，注释写明「Vertex 是此账号已知成因，但不硬断言」。

**判别轴（实测钉死）：`resolveModelName` 返回的最终 outbound 名。** 判别必须 key 在**最终解析名**上——它已折叠任何 override 链。注意映射本身是**链式可递归的**（[resolver.ts:218](../../src/lib/models/resolver.ts#L218) `resolveOverrideTarget` 递归 + `seen` 环守卫），但递归在 target 是已知模型 id 时停（`state.modelIds.has(target) → return target`）——这正解释实测 `haiku → claude-sonnet-4.6` 停在 sonnet-4.6（它是已知模型 id），未续走 `claude-sonnet-4.6 → claude-sonnet-5`。故"单跳"是此配置下的巧合、非架构属性；判别取终态名即可，无需关心链的形状。inbound 别名（`haiku`）判别是错的。且后台/title 请求**无专属 inbound header 标记**（实测 header 集与主请求一致），唯一信号是所选模型——正是本轴。

---

## 3. 架构

### 3.1 统一抽象：per-model「拒绝能力」集 + 通用反应式学习骨架

现有框架已有的三支柱（保留、复用）：
- **per-model config 孪生**（`stripBetaHeaders`/`stripPartnerFeatures`/`rejectBodyFields`/`effortsOverrides`），经 [per-model-config.ts](../../src/lib/anthropic/per-model-config.ts) 的 `findMostSpecific`/`collectAllMatching` 匹配 resolved model。
- **持久 negotiation 缓存**（negotiation-states.json，[feature-negotiation.ts](../../src/lib/anthropic/feature-negotiation.ts)），config 声明 ∪ 运行时学入。
- **reactive strategy**（[src/lib/request/strategies/](../../src/lib/request/strategies/)），检测 → 学 → 重试。

本 RFC 补全其覆盖，并抽出一个**通用「错误 body → per-model 能力标记」学习 primitive**，让 C/D/E 复用同一骨架（parse → learn → persist → canHandle 脚手架）。**范围界定（WARN-7）**：该 primitive 统一 learn/persist/`canHandle` 脚手架，但**补救动作分两类**——C/D/E 是**字段/工具剥离**（`PrepareHints.excludeServerToolTypes` / strip `output_config.format`），A 是**消息 role 重写**（system→user，内容变换，且须在 prepare 或 strategy `handle` 里做、不在 sanitize，见 §3.2）。故 primitive 只统一 C/D/E 的 strip 类补救 + 全体的 learn/persist；A 的 remediation arm 单列，不假装复用同一 strip 骨架。

### 3.2 A：inline role:system 自动清洗（能力框架）

- **config**：新增 `anthropic.system_reject_models`（模型名子串集，match resolved outbound model），默认 `[claude-sonnet-4.6, claude-haiku-4.5]`（实测确认）。注释写明能力语义 + Vertex 已知成因。
- **模式**：新增 `anthropic.system_reject_mode`（复用 `SystemMessagesSanitizeMode` 枚举），默认 `as_user`（保位置、对 prompt-cache 最友好）。
- **有效模式解析**（具体胜通配，match 用 `normalizeForMatching`/`findMostSpecific`，同 `effortsOverrides`——NIT 修复：默认 `[claude-sonnet-4.6, claude-haiku-4.5]` 点名靠归一化才能匹配真实 resolved 名 `claude-sonnet-4-6`/`claude-haiku-4-5-20251001`）：`model ∈ (config system_reject_models ∪ 学入 systemRejectModels) → system_reject_mode`；否则 → 全局 `system_messages_sanitize`（保留、默认 false）。
- **持久化槽（WARN 修复，与 B 的 O5 对称）**：反应式学入的「拒绝 inline-system」事实须存 negotiation 缓存的 `systemRejectModels: Set<model>`（config 声明 ∪ 运行时学入，snapshot/load 同 sibling 的 `Set<string>` 映射如 partnerFeatures）。否则反应式只自愈当前请求、后续同模型仍 400——与框架 learn-persist-then-proactively-skip 模式不一致。
- **接线（proactive 侧）—— 阶段与前提修正（FAIL 修复）**：inline-system 清洗在 **S3 sanitize rewrite**（`sanitizeAnthropicMessages(payload)`，[payload-rewrites.ts:118](../../src/lib/anthropic/payload-rewrites.ts#L118) order 300 → [request-rewrite-adapter.ts:52](../../src/lib/codec/anthropic/request-rewrite-adapter.ts#L52) → [sanitize/index.ts:95](../../src/lib/anthropic/sanitize/index.ts#L95)）；**非** [handler-v4.ts:201](../../src/routes/messages/handler-v4.ts#L201)（那是 `preprocessAnthropicMessages` dedup+strip-read-tags）。关键：`payload.model` 在此**已是解析后 outbound 名**（[handler-v4.ts:193](../../src/routes/messages/handler-v4.ts#L193) `wireBody={...payload, model:resolvedName}`）。故有效模式**在 `sanitizeAnthropicMessages` 内部从 `payload.model` 直接算**——**无需改签名 / 无需 thread 全调用方**（推翻 v2 的 plumbing 主张）。web-search sanitize 路径（orchestrator/web-search-direct）经同一 `sanitizeAnthropicMessages` 透明覆盖。
- **count-tokens（独立调用点）**：[count-tokens.ts:50](../../src/routes/messages/count-tokens.ts#L50) **直接**调 `sanitizeInlineSystemMessages`（不经 `sanitizeAnthropicMessages`），须用其已解析的 `anthropicPayload.model` 同样算有效模式——否则 count-tokens 与请求路径分叉、对 reject 集模型 400。
- **反应式侧 —— 机制（O6，含新选项 c）**：pipeline 每 attempt 只重跑 `prepareAnthropicRequest`（[pipeline.ts:272](../../src/lib/request/pipeline.ts#L272)），**S3 sanitize 不重跑**。反应式 A：检测 `Unexpected role "system"` 400 → 学入 `systemRejectModels`（持久）→ 修复当前 in-flight 请求。修复机制三候选（O6）：**(a)** strategy 在 `handle` 直接 role-rewrite `effectivePayload.messages`；**(b)** inline-system 下移进 `prepareAnthropicRequest`（每 attempt 跑，但 **strand `inlineSystemConverted` 遥测**——现由 [sanitize/index.ts:138](../../src/lib/anthropic/sanitize/index.ts#L138) 经 pipelineInfo 捕获，迁走须重新接线）；**(c)** strategy 学入后调 `getResanitize()`（[codec.ts:122](../../src/lib/codec/anthropic/codec.ts#L122)，siblings auto-truncate/legacy-thinking 已用此重跑 sanitize 链）——学入后重跑 S3，有效模式已含新学模型 → 自动 role-rewrite。**(c) 最一致**（复用既有 hook、不 strand 遥测、proactive/reactive 同一份 sanitize 逻辑）。学入日志如实写「推断（Vertex 已知成因）」。

### 3.3 B：effort 零支持剥离（存储表达须重做）

**已捕获真实 body**（req_1783390118141_26 + 用户报错）：`{"error":{"message":"output_config.effort \"high\" was provided, but model claude-haiku-4.5 does not support reasoning effort","code":"invalid_reasoning_effort"}}`。**含 `code:"invalid_reasoning_effort"`**，故 `canHandle`（[effort-learning-retry.ts:64](../../src/lib/request/strategies/effort-learning-retry.ts#L64)）**会触发**——失败发生在 parse。

**失败点是 :580 非 :588（FAIL-2 修正）**：`parseInvalidEffortError` 要求 `by model X;`（[:578](../../src/lib/anthropic/request-preparation.ts#L578)）**和** `supported values:[...]`（[:579](../../src/lib/anthropic/request-preparation.ts#L579)）**双匹配**，零支持变体两者皆无 → [:580](../../src/lib/anthropic/request-preparation.ts#L580) `return null`。`:588` 对本变体是死代码。故须**新增 parse 分支**识别零支持措辞，非放宽 :588。

**核心难点：negotiation 缓存无法表达「已知空集」（FAIL-1）。** `[]` 与「未学习」在 **5 处**碰撞，「空集=可学」不是放宽一行能解决：

| 站点 | 现状 | 后果 |
|---|---|---|
| [request-preparation.ts:648](../../src/lib/anthropic/request-preparation.ts#L648) `findSupportedEfforts` | `if (learned && learned.length>0)` | 存下的 `[]` 被跳过 → 落到 metadata/undefined |
| [request-preparation.ts:736](../../src/lib/anthropic/request-preparation.ts#L736) `clampEffortLevel` | `if (!supported) return` | undefined → 不剥 |
| [request-preparation.ts:740](../../src/lib/anthropic/request-preparation.ts#L740) `clampEffortLevel` | `if (supportedIndices.length===0) return` | 空集 → 不剥（第 5 处） |
| [feature-negotiation.ts:246](../../src/lib/anthropic/feature-negotiation.ts#L246) `snapshotEffortMap` | `if (value.length>0) out[key]` | **空集永不写盘** |
| [feature-negotiation.ts:302](../../src/lib/anthropic/feature-negotiation.ts#L302) `loadEffortMap` | `values.length===0 continue` | **即便写了也加载即丢** |

后两处使「不支持 effort」这一事实**无法跨重启存活**，直接违反 negotiation 缓存的持久契约（[feature-negotiation.ts:5-7](../../src/lib/anthropic/feature-negotiation.ts#L5)「All entries are permanent」）。

**修法（O5 已定 = (a) 独立集）**：新增 negotiation 缓存的 `effortUnsupported: Set<model>`，与 `supportedEfforts` map **完全分离**——「已知不支持」= 成员身份，**永不存空数组**，故 snapshot/load 对称平凡（一串模型名、无 length-0 特判），碰撞按构造消失；`supportedEfforts` map 及其 5 处现有逻辑**原样不动**。改动仅：① 新 parse 分支识别零支持措辞 → 学入 `effortUnsupported`；② `findSupportedEfforts`/`clampEffortLevel` **前置**一句 `if (effortUnsupported.has(model)) → 剥除 output_config.effort`（先于现有子集逻辑）；③ snapshot/load 加对称的 `effortUnsupported` 字段；④ 写入互斥：一个模型不同时在 `supportedEfforts` 与 `effortUnsupported`。effort-learning strategy 的 `handle` 逻辑不变（learn 返 true → 重试 → 重准备读到 unsupported → 剥除）。

### 3.4 C：web_search-not-found 反应式化

- 优先方案：新增反应式 strategy 检测 `Tool '…' not found in provided tools`（注意区别于 deferred-tool 的 `Tool reference '…' not found in available tools`）→ 触发既有 server-tool-history downgrade（[rewrite-server-tool-history.ts](../../src/lib/anthropic/sanitize/rewrite-server-tool-history.ts)）→ 重试。
- **Open question O1**（见 §6）：是「加反应式 strategy」还是「翻转 `tool_rewrite_history_server` 默认为 downgrade」——需用户裁决。

### 3.5 D/E/F/G：变体缺口补全

- **D**：把 structured-outputs strategy 的 `canHandle` 从「只 structured_outputs」放宽为「有已知 strip-target 的 partner feature 表」，用 per-feature strip-target 映射表驱动。**注意每 feature 有两处 strip 站点（NIT-8）**：reactive strategy 自身的 strip（[structured-outputs-rejection-retry.ts:102](../../src/lib/request/strategies/structured-outputs-rejection-retry.ts#L102)）+ prepare 侧 per-feature step（[request-preparation.ts:698](../../src/lib/anthropic/request-preparation.ts#L698)），映射表须同时驱动两者。
- **E**：把 server-tool-rejection 的硬编码 web_search 正则 + 前缀改为 per-tool 表（缓存结构已通用）。
- **F**：给 `parseTokenLimitError` 加 `max_tokens`-inclusive / 其他措辞正则变体（**需先捕获真实上游 body 做 golden**，见 §7）。
- **G**：deferred-tool 的 `parseToolReferenceFromResponse` 改用 `parsed.error?.message ?? responseText`（对齐姊妹策略），修双层包裹落空。

### 3.6 H：失败 attempt 完整错误 body 持久化

- 扩 `AttemptSnapshot.error` 携带 `rawBody`/`responseText`（[events.ts:115](../../src/lib/observability/events.ts#L115)）；attempt_failed 路径把它持久化为 per-attempt response stage（entry_stages）。
- richest-data-flow：后端完整存，前端可选择性呈现。**不**为「无消费者」裁剪——它正是反应式学习的事后审计依据。

---

## 4. Cutover 计划（分 phase，每 phase 含 commit invariant）

> **总不变量**：每个 commit 结束时 typecheck 绿 + 测试套件通过 + 无「给要拒的请求白做/重复处理」的半破碎态。反应式 strategy 只在其目标 400 上触发，对其他请求零副作用。

- **P1 —— 框架 + A + B（承重，最重）**
  - 抽通用 learn/persist/canHandle primitive（strip 类补救；A 的 role-rewrite remediation 单列，见 §3.1）。
  - A：config schema（`system_reject_models`/`system_reject_mode`）+ state 接线 + `systemRejectModels` negotiation Set（config ∪ 学入）+ 有效模式在 `sanitizeAnthropicMessages` 内从 `payload.model` 算（含 count-tokens 独立点）+ 反应式机制（O6 定，推荐 c=getResanitize）。
  - B：新 parse 分支（零支持措辞）+ 独立 `effortUnsupported` 集（O5=a，supportedEfforts 逻辑不动）+ `clampEffortLevel`/`findSupportedEfforts` 前置剥除。
  - invariant：A/B 的反应式 + 声明式双路径都覆盖；B 经 persist→reload golden；默认 config 下 role:system reject 集含实测两模型（O2 定）。
- **P2 —— C（server-tool history 反应式）**
  - 依 O1 裁决：加 strategy 或翻默认。
- **P3 —— D/E/F/G（变体缺口）**
  - 格式独立、可并行；F 需先 golden-capture 真实 body。
- **P4 —— H（可观测性）**
  - AttemptSnapshot 扩展 + per-attempt error body 持久化 + history 投影 surfaced。
  - invariant：终态失败 body 保留不回归；新增中途失败 body 持久化经 golden 验证。

DAG：P1 是其余前置（抽出的 primitive 被 P2/P3 复用）。P3 内部各子项格式独立可并行。P4 独立、可与 P2/P3 并行。

---

## 5. 范围外

- `unrepairable malformed tool_use`（响应侧 repair，§1 已述排除）。
- 修改 Claude Code / superpowers 插件的 role:system 注入行为（上游、我们改不了；role:system 是 Claude Code 系统性包装多种中途注入的机制，非单插件 bug）。
- 用户未提交 config 的 `haiku`/`claude-haiku-4.5` 映射修复（本 feature 落地后自愈；可另行手改）。
- 计数/telemetry 语义变更（已确认：retry-恢复计 completed、只认终态；见 §附录）。

---

## 6. Open Questions（用户已解答）

- **O1（C 实现路径）→ 已定：加反应式 strategy**（对称于框架、默认不变）。
- **O2（默认 reject 集）→ 已定：内置 `[claude-sonnet-4.6, claude-haiku-4.5]`**（此账号实测）。
- **O3（F 范围）→ 已定：本轮做**（前置：先捕获真实上游 token-limit body 做 golden，再加正则）。
- **O4（D/E 广度）→ 已定：补当前已知** feature/tool（非完全数据驱动表）。
- **O5（B 存储表达）→ 已定：(a) 独立 `effortUnsupported: Set<model>`**（见 §3.3；碰撞按构造消失、supportedEfforts 逻辑不动）。
- **O6（A 反应式机制）→ 待最终确认**：R2 新揭示**选项 (c) learn-then-`getResanitize()`**（[codec.ts:122](../../src/lib/codec/anthropic/codec.ts#L122)，siblings 已用）——最一致、不 strand `inlineSystemConverted` 遥测、proactive/reactive 同一份 sanitize 逻辑。用户初选 (b)，但 (b) 会 strand 该遥测且改动面更大；**RFC 推荐改选 (c)**，待用户确认。

---

## 7. 验证

- **A**：探针 harness 复现生产接线——对 reject 集模型发带 inline system 的请求 → 断言 outbound 无 system 角色、上游 200；对非 reject 模型 → 断言透传（除非全局开）。反应式：mock 上游首发 400（role:system）→ 断言学入 + 重试 outbound 已清洗。
- **B**：mock 上游 `does not support reasoning effort` 400 → 断言学入「已知不支持」+ 重试 outbound 无 `output_config.effort`。**必含 persist→reload golden（WARN-6）**：学入后经 `snapshotEffortMap` 写盘 → `loadPersistedFeatureNegotiation` 重载 → 重准备仍剥除——否则 §3.3 的持久化碰撞（snapshot/load 丢空集）会在绿测套件下于首次重启回归。镜像 §7 对 H 的「不回归 tripwire」纪律。
- **C/D/E/G**：各 mock 对应 400 → 断言学/剥/重试。
- **F**：先在真实/捕获的上游 body 上做 golden，再加正则；无真实 body 不做（O3）。
- **H**：golden——多 attempt 记录断言 attempt[0] 保留完整 rawBody（改动前先证终态失败 body 已存的等价 tripwire 不回归）。
- **通用**：每 strategy 用**正样本证 canHandle 触达目标**（先证正则匹配真实错误串），wire 正确性用 GHC 独立 oracle（实测），非字节自洽。连跑 flaky/时序测试 10-25 次确认确定性。

---

## 附录：计数语义（实测确认，非本 RFC 改动，仅记录契约）

retry 后成功的请求**计 completed、不计失败**——分类只认 entry 终态（[queries.ts:36-37](../../src/lib/history/queries.ts#L36)：`success===false ⟺ state==="failed"`）。中途 `request.attempt_failed` 与终态 `request.failed` 是独立事件（[events.ts:205,222](../../src/lib/observability/events.ts#L205)）。实测 req_1783322545677_656：attempt[0] failed → body-field-rejection-retry → attempt[1] ok → 终态 completed，不在 success=false 列表。故 §1 的 155 条失败语料全是**终态失败**、未被瞬时恢复污染 → 缺口信号干净。这也是 H 缺口的动机：中途失败 body 未持久化，事后无法核对反应式学习依据。

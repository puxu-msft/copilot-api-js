# RFC: 反应式 per-model 上游拒绝协商 —— 完整性 pass

- 状态：DRAFT（待 ≥3 轮对抗 subagent review + 用户解答 open questions 后转 plan）
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
| B | effort **零支持**变体 `... does not support reasoning effort`（无 `supported values:[...]` 列表）→ parse 返 null → abort | 实测 req_1783390118141_26：attemptCount=1、outbound 带 `output_config:{effort:"high"}` 发给 claude-haiku-4.5 → 400。`parseInvalidEffortError` 要求同时匹配 `by model X;` + `supported values:[...]`（[request-preparation.ts:580](../../src/lib/anthropic/request-preparation.ts#L580)），且 [:588](../../src/lib/anthropic/request-preparation.ts#L588) `if (supported.length===0) return null` 显式拒学空集 | effort-learning 部分覆盖 |
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

**判别轴（实测钉死）：解析后的 outbound 模型。** 模型映射是**单跳非链式**（实测 `haiku → claude-sonnet-4.6` 到此为止，不再走 `claude-sonnet-4.6 → claude-sonnet-5`），故真正决定路由的是 outbound 名。inbound 别名（`haiku`）判别是错的。且后台/title 请求**无专属 inbound header 标记**（实测 header 集与主请求一致），唯一信号是所选模型——正是本轴。

---

## 3. 架构

### 3.1 统一抽象：per-model「拒绝能力」集 + 通用反应式学习骨架

现有框架已有的三支柱（保留、复用）：
- **per-model config 孪生**（`stripBetaHeaders`/`stripPartnerFeatures`/`rejectBodyFields`/`effortsOverrides`），经 [per-model-config.ts](../../src/lib/anthropic/per-model-config.ts) 的 `findMostSpecific`/`collectAllMatching` 匹配 resolved model。
- **持久 negotiation 缓存**（negotiation-states.json，[feature-negotiation.ts](../../src/lib/anthropic/feature-negotiation.ts)），config 声明 ∪ 运行时学入。
- **reactive strategy**（[src/lib/request/strategies/](../../src/lib/request/strategies/)），检测 → 学 → 重试。

本 RFC 补全其覆盖，并抽出一个**通用「错误 body → per-model 能力标记」学习 primitive**，让 A/C/D/E 复用同一骨架（避免每类各写一遍 parse+learn+persist），差异只在：匹配正则、被剥/改的目标、补救动作。

### 3.2 A：inline role:system 自动清洗（能力框架）

- **config**：新增 `anthropic.system_reject_models`（模型名子串集，match resolved outbound model），默认 `[claude-sonnet-4.6, claude-haiku-4.5]`（实测确认）。注释写明能力语义 + Vertex 已知成因。
- **模式**：新增 `anthropic.system_reject_mode`（复用 `SystemMessagesSanitizeMode` 枚举），默认 `as_user`（保位置、对 prompt-cache 最友好）。
- **有效模式解析**（具体胜通配）：`model ∈ reject 集 → system_reject_mode`；否则 → 全局 `system_messages_sanitize`（保留、默认 false，作用于所有模型）。
- **反应式**：新 strategy 检测 `Unexpected role "system"` 400 → 学入持久 reject 集 → 重清洗（as_user）→ 重试。学入日志如实写「推断（Vertex 已知成因）」。
- **接线**：把有效模式 thread 进现有 message-sanitize 阶段的 `sanitizeInlineSystemMessages`（纯函数、已显式收 mode，[system-messages.ts:102](../../src/lib/anthropic/sanitize/system-messages.ts#L102)）；resolved model 在 `prepareAnthropicRequest`（[request-preparation.ts:401](../../src/lib/anthropic/request-preparation.ts#L401)）已有。

### 3.3 B：effort 零支持剥离

- 扩 `parseInvalidEffortError`：新增识别零支持变体（`does not support reasoning effort`，无 supported 列表）→ 返回 `supported: []`（显式空集 = 已知「不支持」）。
- 放宽 [:588](../../src/lib/anthropic/request-preparation.ts#L588) `supported.length===0 → null`：改为「空集是可学的已知能力」（需与 negotiation 缓存的空集表达一致——空集 ≠ 未知）。
- 扩 `clampEffortLevel`（[:728](../../src/lib/anthropic/request-preparation.ts#L728)）：支持集为空 → **完全剥除 `output_config.effort`**（非钳值）。
- effort-learning strategy 的 `handle` 无需改（learn 返 true 后重试即可，重准备读到空集 → 剥除）。

### 3.4 C：web_search-not-found 反应式化

- 优先方案：新增反应式 strategy 检测 `Tool '…' not found in provided tools`（注意区别于 deferred-tool 的 `Tool reference '…' not found in available tools`）→ 触发既有 server-tool-history downgrade（[rewrite-server-tool-history.ts](../../src/lib/anthropic/sanitize/rewrite-server-tool-history.ts)）→ 重试。
- **Open question O1**（见 §6）：是「加反应式 strategy」还是「翻转 `tool_rewrite_history_server` 默认为 downgrade」——需用户裁决。

### 3.5 D/E/F/G：变体缺口补全

- **D**：把 structured-outputs strategy 的 `canHandle` 从「只 structured_outputs」放宽为「有已知 strip-target 的 partner feature 表」，用 per-feature strip-target 映射表驱动。
- **E**：把 server-tool-rejection 的硬编码 web_search 正则 + 前缀改为 per-tool 表（缓存结构已通用）。
- **F**：给 `parseTokenLimitError` 加 `max_tokens`-inclusive / 其他措辞正则变体（**需先捕获真实上游 body 做 golden**，见 §7）。
- **G**：deferred-tool 的 `parseToolReferenceFromResponse` 改用 `parsed.error?.message ?? responseText`（对齐姊妹策略），修双层包裹落空。

### 3.6 H：失败 attempt 完整错误 body 持久化

- 扩 `AttemptSnapshot.error` 携带 `rawBody`/`responseText`（[events.ts:115](../../src/lib/observability/events.ts#L115)）；attempt_failed 路径把它持久化为 per-attempt response stage（entry_stages）。
- richest-data-flow：后端完整存，前端可选择性呈现。**不**为「无消费者」裁剪——它正是反应式学习的事后审计依据。

---

## 4. Cutover 计划（分 phase，每 phase 含 commit invariant）

> **总不变量**：每个 commit 结束时 typecheck 绿 + 测试套件通过 + 无「给要拒的请求白做/重复处理」的半破碎态。反应式 strategy 只在其目标 400 上触发，对其他请求零副作用。

- **P1 —— 框架 + A + B（承重）**
  - 抽通用「错误 body → per-model 能力标记」学习 primitive。
  - A：config schema（`system_reject_models`/`system_reject_mode`）+ state 接线 + 有效模式解析 + reactive strategy + 有效模式 thread 进 sanitize。
  - B：`parseInvalidEffortError` 零支持变体 + 空集可学 + `clampEffortLevel` 剥除。
  - invariant：A/B 的反应式 + 声明式双路径都覆盖；默认 config 下 role:system reject 集含实测两模型。
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

## 6. Open Questions（写代码前请用户解答）

- **O1（C 的实现路径）**：`Tool 'web_search' not found` 用「加反应式 strategy」还是「翻转 `tool_rewrite_history_server` 默认为 downgrade」？前者对称于框架、默认不变；后者一行改默认但改变所有请求的 proactive 行为。
- **O2（默认 reject 集）**：`system_reject_models` 默认是否内置 `[claude-sonnet-4.6, claude-haiku-4.5]`（此账号实测），还是默认空 + 靠反应式学入（更中立、首次必 400 一次再自愈）？
- **O3（F 范围）**：token-limit 变体是否本轮做？取决于能否捕获真实上游 body（无 golden 不做，避免猜正则）。
- **O4（D/E 广度）**：D/E 是把**当前已知**的 feature/tool 补齐，还是做成完全数据驱动的表（未知项也能声明式扩展而不改码）？

---

## 7. 验证

- **A**：探针 harness 复现生产接线——对 reject 集模型发带 inline system 的请求 → 断言 outbound 无 system 角色、上游 200；对非 reject 模型 → 断言透传（除非全局开）。反应式：mock 上游首发 400（role:system）→ 断言学入 + 重试 outbound 已清洗。
- **B**：mock 上游 `does not support reasoning effort` 400 → 断言学入空集 + 重试 outbound 无 `output_config.effort`。
- **C/D/E/G**：各 mock 对应 400 → 断言学/剥/重试。
- **F**：先在真实/捕获的上游 body 上做 golden，再加正则；无真实 body 不做（O3）。
- **H**：golden——多 attempt 记录断言 attempt[0] 保留完整 rawBody（改动前先证终态失败 body 已存的等价 tripwire 不回归）。
- **通用**：每 strategy 用**正样本证 canHandle 触达目标**（先证正则匹配真实错误串），wire 正确性用 GHC 独立 oracle（实测），非字节自洽。连跑 flaky/时序测试 10-25 次确认确定性。

---

## 附录：计数语义（实测确认，非本 RFC 改动，仅记录契约）

retry 后成功的请求**计 completed、不计失败**——分类只认 entry 终态（[queries.ts:36-37](../../src/lib/history/queries.ts#L36)：`success===false ⟺ state==="failed"`）。中途 `request.attempt_failed` 与终态 `request.failed` 是独立事件（[events.ts:205,222](../../src/lib/observability/events.ts#L205)）。实测 req_1783322545677_656：attempt[0] failed → body-field-rejection-retry → attempt[1] ok → 终态 completed，不在 success=false 列表。故 §1 的 155 条失败语料全是**终态失败**、未被瞬时恢复污染 → 缺口信号干净。这也是 H 缺口的动机：中途失败 body 未持久化，事后无法核对反应式学习依据。

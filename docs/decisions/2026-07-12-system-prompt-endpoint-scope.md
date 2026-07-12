# ADR：system prompt 重写按 endpoint+model 作用域（顶层键 + scope 字段，而非 vendor 命名空间搬家）

日期：2026-07-12
状态：Accepted（用户 2026-07-12 明确选择「反过来，保留顶层 system_prompt，但增加字段声明应用在哪些模型上」，并确认 model+endpoint 两轴 + 条目列表形态）
关联：[DESIGN.md](../DESIGN.md)「运行时选项」配置表（`systemPromptOverrides`/`systemPromptPrepend`/`systemPromptAppend` 三行）、`src/lib/config/schema.ts`（`ENDPOINT_SCOPE_VALUES` / `SystemPromptEntrySchema`）、`src/lib/system-prompt/override.ts`（`scopeMatches`）、`src/lib/pipeline/envelope.ts`（`ClientFormat`）。

## 背景

顶层三键 `system_prompt_overrides` / `system_prompt_prepend` / `system_prompt_append` 对**全部 4 个入站端点**（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses / Gemini generateContent）**无差别生效**——它们共享同一份 `state.systemPromptOverrides` + 全局 prepend/append 文本。

需求是让 system prompt 重写**按端点独立配置**——起因：不同客户端（Claude Code vs Codex CLI vs Gemini 客户端）经不同入站端点进来，需要注入/改写不同的 system prompt；而通用翻译矩阵（4 入站 × 3 出站）下，**同一 GHC 模型可经多个端点访问**，故「模型」与「端点」是两个正交的作用域轴。

现状里 `system_prompt_overrides` 的每条 rule **已支持 `model` 正则过滤**（[override.ts](../../src/lib/system-prompt/override.ts) `applyOverrides` 早有 `modelPattern` 单轴 skip），但 `prepend`/`append` 是无作用域的单字符串，且**端点轴完全缺失**。

## 决策

**保留顶层三键，给每条 rule / prepend-append 条目增加 `endpoint` 作用域字段（与既有 `model` 轴组成两轴 AND），并把 `prepend`/`append` 从单字符串升级为「带作用域的条目列表」。**

- **两轴作用域**（rule 与 entry 对称）：`model`（模型名正则、大小写不敏感、既有）+ `endpoint`（`ClientFormat` 枚举 `anthropic`/`openai-cc`/`openai-responses`/`gemini`，单值或数组）。AND 语义：present 轴须命中、absent 轴匹配全体。
- **端点标识符复用内核类型**：`endpoint` 取值直接对齐 [`ClientFormat`](../../src/lib/pipeline/envelope.ts)（**入站客户端格式**），不另造枚举、不做映射层。schema 层内联同值常量 `ENDPOINT_SCOPE_VALUES`（附「MUST stay in sync」注释）以避免 config schema 依赖 pipeline 层。
- **`prepend`/`append` 升级为 union**：config 接受 `string`（旧式无作用域单条，**向后兼容**）\| 单条 `{text, model?, endpoint?}` \| 条目数组（top-down 求值、命中者按序 `\n\n` 拼接）。
- **共享 primitive**：scope 编译抽 `config.ts` 的 `compileScope`（rule/entry 共用）、匹配抽 `override.ts` 的 `scopeMatches`（两轴 AND）。prepend/append 预编译进新 state 字段 `systemPromptPrepend`/`systemPromptAppend`（与 `systemPromptOverrides` 对称）。
- **端点由调用点注入**：4 个处理器加 `endpoint` 参数，5 处 handler 各传字面量（`processOpenAIMessages` 被 Chat 与 Gemini 共用，由调用点分别传 `openai-cc` / `gemini` 自然区分）。

## 理由

- **零迁移、纯新增、完全向后兼容**：不改键名、不动 vendor section，旧配置（含旧 string prepend/append、无 endpoint 的 overrides）逐字节等价。契合项目**配置哲学**（配置不享代码的「无向后兼容负担」，键重命名须留兼容层）。
- **集中管理 + 末端作用域声明**，契合 `richest-data-flow`：配置集中在顶层三键，「应用在哪」的决策下放到每条 rule/entry 的 scope 字段，而非把配置**物理打散**进各 vendor 命名空间。
- **两轴正交是本质需求**：翻译矩阵下同模型跨端点必须能区分（例 `gpt-5.5` 经 Anthropic messages vs 经 Responses），单 model 轴表达不了；单 endpoint 轴又丢掉既有 model 粒度。两轴 AND 是最小完备表达。
- **复用 `ClientFormat` 避免造轮子**：端点标识符已是内核既有类型，直接复用保证类型整合、消除映射漂移。

## 影响

- **正向**：4 端点独立配置能力；`prepend`/`append` 获得与 `overrides` 对称的作用域 + 多条目能力；scope 编译/匹配抽共享 primitive（DRY）。
- **成本**：`prepend`/`append` 编译进 state 后，`applyConfigToState` 的 retain-on-absence 语义（生产正确、支持 hot-reload）使**测试需显式清零** state 字段（`resetApplyState` 只清标志位不清 state）——已在 `beforeEach` 补 `setAnthropicBehavior({...:[]})`，并同时堵住 `overrides` 被测试顺序掩盖的同类隐患。
- **范围**：schema / state（clone/setter/3 处 defaults）/ config（compileScope + compileSystemPromptEntries + apply）/ override（scopeMatches + 4 处理器）/ 5 handler。typecheck + lint + 75 测试全绿。

## 未采纳的备选

- **把三键收窄进各 vendor 命名空间**（handover 原方案：`anthropic.system_prompt_*` / `openai.cc.*` / `openai.responses.*` / `gemini.*`，兼容层把旧顶层键映射到 `anthropic.*`）——**被否**（用户 2026-07-12 反转方向）。理由：① 要把整个 `openai_responses` vendor section 搬进 `openai.responses.*`，牵动全部 9 个现有键的 compat 迁移，范围远大于 system_prompt；② 旧顶层键只映射到 `anthropic.*` 会**静默失效** OpenAI/Responses/Gemini 的存量重写；③ 把「一份 system prompt 配置」物理打散进 4 个命名空间，违背 `richest-data-flow` 的「集中数据、末端决策」。作用域字段方案零迁移即达成同等（且更强，支持数组多端点）的端点区分能力。
- **仅 model 轴**（把既有 `model` 过滤扩展到 prepend/append，不加 endpoint 轴）——被否。翻译矩阵下无法区分「同模型走不同端点」，是本质表达力缺失。
- **仅 endpoint 轴**（只按端点、丢 model 粒度）——被否。是对现有 `overrides` `model` 能力的倒退。
- **prepend/append 保持单条 + 单作用域**（不升级为条目列表）——被否。无法表达「Claude 系一套、gpt 系另一套」的多分支，用户明确选「条目列表」。

# 新增 `anthropic.system_messages_sanitize` 配置项:处理 messages 里混入的 inline system 消息

## Context(背景与动机)

**问题**:发往 Anthropic Messages API(`/v1/messages`)的请求,若 `messages` 数组里混入了 `role:"system"` 的消息,上游返回:

```
HTTP 400: messages: Unexpected role "system". The Messages API accepts a top-level `system` parameter, not "system" as an input message role.
```

Anthropic 规范要求 system 只能放在顶层 `system` 参数。inline system 通常来自**用 OpenAI 习惯的客户端**,或 **Claude Code 把对话中途注入的 system 级上下文**(hook 输出/规则/提醒)作为 message 发出。

**现状(基于当前代码 + 探针实测,非旧导出)**:`sanitizeAnthropicMessages` 当前版本输入 `[user,system,assistant,user]` → 原样输出,直接转发触发 400。`request-preparation.ts` 只处理顶层 system;`auto-truncate` 仅在截断时偶然跳过**开头**的 system(默认关闭,不处理中间)。SDK 类型 `MessageParam.role` 含 `"system"`(`@anthropic-ai/sdk/.../messages.d.ts:781`),inline system 逃过类型检查。

**真实数据形态**(导出 history entry,旧版本但形态有效):65 个 `role:"system"` 散布在 848 条消息中(位置 1,12,15,30,…,**非仅开头**),content 均为 string,且**已有顶层 `system`**;内容为 `SessionStart hook additional context`、`Contents of .../rules/*.md`、`The TodoWrite tool…` 等。

**目标**:作为代理宽容处理(原则8 根因修复)。新增可配置开关 `anthropic.system_messages_sanitize`,4 种策略 + 关闭。**默认 `false`(透传,保持现状)**。

**推荐开启值 = `as_user`**:这些 inline system 是**带位置语义的上下文注入**,`as_user` 保留原始对话位置、最忠实。`merge` 破坏时序且巨大化(并损害 prompt cache,见下);`drop_invalid` 丢失上下文;`as_assistant` 语义错误(把上下文伪装成模型输出)+ 风险最高,**标注为实验性/不推荐**。

## 设计

### 配置项
- 路径 `anthropic.system_messages_sanitize`,类型 `false | "drop_invalid" | "merge" | "as_user" | "as_assistant"`,默认 `false`,支持热重载(scalar retain-on-absence),state 字段 `systemMessagesSanitize`。

### 核心纯函数

```ts
// src/lib/anthropic/sanitize/system-messages.ts
export function sanitizeInlineSystemMessages(
  messages: Array<MessageParam>,
  system: MessagesPayload["system"],
  mode: false | "drop_invalid" | "merge" | "as_user" | "as_assistant",
): { messages: Array<MessageParam>; system: MessagesPayload["system"]; convertedCount: number }
```

mode 由参数传入(不直接读 state)→ 可纯函数单测,符合 DI 纪律。

### 文本提取(统一规则,覆盖审查攻击面4)
- content 为 string → 直接取。
- content 为 array → 拼接所有 `text` block;遇非 text block(image 等)→ `consola.warn` 记录后跳过(原则7:不静默丢弃,留可观测)。
- **提取结果为空(空串/纯空白)→ 该 inline system 一律 drop**,绝不转成 `user:[]`/`assistant:[]` 空 content(否则上游 400)。此规则消除大部分顺序敏感性。

### 四种模式语义

| 模式 | 行为 |
|------|------|
| `false` | 早退,原样返回(保持对象 identity) |
| `drop_invalid` | 删除所有 inline system |
| `merge` | 提取文本按序拼接,**追加到顶层 `system` 末尾**(`\n\n` 分隔);从 messages 删除。system 为 string→拼接;array→追加 `{type:"text",text}` block;undefined→设为提取文本。提取为空的不追加 |
| `as_user` | role 改 `"user"`(content 保留),合并相邻同 role |
| `as_assistant` | role 改 `"assistant"`,合并相邻同 role(避开带签名 thinking 的 assistant),再 `ensureAnthropicStartsWithUser` 保证 `messages[0]` 合法 |

### 关键约束与边界(全部来自对抗审查,已亲验)

1. **集成顺序(攻击面5,已亲验 `system-reminders.ts:47` 不判 role)**:新步骤放在 **`removeAnthropicSystemReminders` 之后**、`processToolBlocks` 之前。先让 reminder 在 `role:"system"` 形态下被现有逻辑清洗,再做 inline 处理;配合"空提取→drop"避免把已删空的 reminder 固化成空 user。
2. **相邻同 role 合并**:复用 `deduplicate-tool-calls.ts:131-149` 的实现(已处理 string/array content 归一 + thinking-block 保护)。提取为共享 helper 或参照。
3. **thinking 保护**:合并绝不并入带签名 thinking 的 assistant(`shouldPreserveThinkingBlocks`,`thinking-immutability.ts:44`),否则损坏签名 400。
4. **messages[0] 合法性**:`as_assistant` 用 `ensureAnthropicStartsWithUser`(`tool-utils.ts:75`)丢弃开头非法 assistant。`as_user` 无此问题。
5. **as_user/as_assistant 副作用(攻击面1/2,文档化)**:inline system 落在 tool_use↔tool_result 之间时,合并后文本成为工具回合的尾注(`as_user`,语义降级但合法)或并入 tool_use turn(`as_assistant`,语义污染)。`as_user` 主路径靠相邻合并兜底不报错;`as_assistant` 风险最高,标注不推荐。
6. **merge × cache_control(攻击面3,文档化)**:merge 使顶层 system 巨大化 + 追加 volatile 文本,会显著降低 prompt cache 命中率(`proxied` 模式 breakpoint 钉在易变文本上)。文档明确此权衡,推荐用 `as_user`。
7. **幂等性(已亲验主路径)**:放 `sanitizeAnthropicMessages`(每次 retry 重跑),四模式天然幂等——第一遍后无 `role:"system"`,后续早退,merge 不重复追加(驱动条件是"是否还有 inline system")。

### 集成点(`src/lib/anthropic/sanitize.ts` 主路径)

```
countAnthropicContentBlocks(messages)
sanitizeAnthropicSystemPrompt(payload.system)            → sanitizedSystem
removeAnthropicSystemReminders(messages)                 → messages          // 先 reminder
[NEW] sanitizeInlineSystemMessages(messages, sanitizedSystem, state.systemMessagesSanitize)
                                                          → { messages, system: newSystem, convertedCount }
processToolBlocks(messages, payload.tools)
finalizeAnthropicSanitization(payload, messages, newSystem, ...)   // newSystem 含 merge 结果
```

`finalizeAnthropicSanitization`(`result.ts:29,66`,已亲验)接收 system 参数并写回 payload。`convertedCount` 作为 **独立** `SanitizationStats` 字段(攻击面6:不混入 `blocksRemoved` 口径)。

### web_search 路径修复(审查 C1,已亲验 `orchestrator.ts:346,400` 丢 system)

`runFirstHopProbe`/`completeWebSearch` 两处预跑 sanitize 时只取 `.payload.messages`、丢弃 `.payload.system`。merge 模式下 inline system 内容永久丢失(data loss,违原则7)。修复:两处改为取回 system:

```ts
const s = sanitizeAnthropicMessages(firstHopBase)
const firstHopPayload = { ...firstHopBase, system: s.payload.system, messages: s.payload.messages }
```

### count_tokens 端点修复(审查 H2,已亲验 `count-tokens.ts:51` 直发原始 payload)

`countTokensViaAnthropic` 把原始 payload(含 inline system)直发 `api.anthropic.com/.../count_tokens`,mode 非 false 时会 400(有本地 fallback,仅配 `ANTHROPIC_API_KEY` 时触发)。修复:发请求前对 payload 应用同样的 inline-system 处理(复用纯函数),消除无谓的失败上游请求。

## 改动文件清单

### Config 链路(模板 `thinking_block_sanitize`,已亲验行号)
1. `src/lib/config/schema.ts` — `AnthropicConfigSchema` 加 union + JSDoc(:167 模板)
2. `src/lib/state.ts` — 5 处:interface 字段(~157)、`setAnthropicBehavior` Pick(:660-691)、`CONFIG_MANAGED_DEFAULTS`(:840,默认 `false`)、`resetConfigManagedState`(:896)、`mutableState` init(:966)
3. `src/lib/config/config.ts` — `applyConfigToState` 加 `if (a.system_messages_sanitize !== undefined)`(:401 scalar 模式)。类型自动推断,无需改类型声明
4. `config.yaml` + `config.example.yaml` — `anthropic:` 加注释 + `system_messages_sanitize: false`(注释列 5 取值 + 标 `as_user` 推荐、`as_assistant` 实验性、`merge` 降 cache)
5. `config.schema.json` — 改完 schema.ts 后 `bun run generate:config-schema` 重新生成(不手改)
6. `src/lib/config/validation.ts` — 无需改(通用)

### 核心逻辑
7. `src/lib/anthropic/sanitize/system-messages.ts` — **新建**,`sanitizeInlineSystemMessages` + 文本提取 helper(含空提取 drop、非 text warn)。相邻合并复用 `deduplicate-tool-calls.ts:131-149`
8. `src/lib/anthropic/sanitize.ts` — `sanitizeAnthropicMessages` 在 reminder 之后集成(传 `state.systemMessagesSanitize`)
9. `src/lib/anthropic/sanitize/result.ts` — `SanitizationStats` 加独立字段记 `convertedCount`(日志)
10. `src/lib/anthropic/web-search/orchestrator.ts` — 两处取回 system(C1 修复)
11. `src/routes/messages/count-tokens.ts` — `countTokensViaAnthropic` 发请求前处理 inline system(H2 修复)

### 文档
12. `docs/DESIGN.md` — 配置表(:240-280)加 `systemMessagesSanitize` 行 + hot-reload 语义段补登记(M3)

### 测试
13. `tests/config/config-hot-reload.it.test.ts` — `FIELDS` 加条目(`configKey:"anthropic.system_messages_sanitize"`, `stateKey:"systemMessagesSanitize"`, `sampleYamlValue:"merge"`, `expectedStateValue:"merge"`, `defaultStateValue:CONFIG_MANAGED_DEFAULTS.systemMessagesSanitize`)(已亲验 `FieldSpec` 结构 :112-120 匹配)
14. `tests/anthropic/system-messages-sanitize.unit.test.ts` — **新建**纯函数测试,覆盖:
    - 五模式基本行为 + 无 inline system 时各模式 no-op + 幂等
    - `merge`:system string/array/undefined 三形态;多个按序;追加末尾
    - **对抗 case(来自审查)**:空提取→drop(不产生空 content);array 含 image→warn+跳过;`as_user`/`as_assistant` 在 **tool_use↔tool_result 之间**插 system 的配对完整性断言;`as_assistant` 不并入带签名 thinking(identity 保持);`as_assistant` 开头 system 被丢弃
15. `tests/anthropic/message-sanitizer.it.test.ts`(或新建 .it)— 端到端:`setStateForTests({systemMessagesSanitize:...})` 过 `sanitizeAnthropicMessages`,断言无 `role:"system"` + merge 后顶层 system 含合并文本 + reminder/inline 顺序正确

## 验证

仅改可执行代码(原则12),完整验证:
1. `bun run generate:config-schema`
2. `bun run typecheck`
3. `bun run lint:all`(eslint --fix)
4. `bun run test:backend`(新 unit + hot-reload R1/R2/R3 + 完整性守卫)
5. 针对性:`bun test tests/anthropic/system-messages-sanitize.unit.test.ts`、`bun test tests/config/config-hot-reload.it.test.ts`
6. 每步修复后跑 subagent review 复核(原则6)

## 暂缓/不做
- **不**改 SDK 类型 `MessageParam.role` 含 `"system"`(上游 SDK 定义,运行时处理已覆盖)
- **不**在 OpenAI/Chat Completions/Responses 路径加同类处理(那些格式 system role 合法)
- `/api/config` GET 白名单(`route.ts:25-72`)**不**加 `systemMessagesSanitize`——该白名单本就未列全部 anthropic 字段(`thinkingBlockSanitizeCheck` 等均未列),无完整性守卫,与现有惯例一致

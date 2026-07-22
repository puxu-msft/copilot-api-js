# Spec: sanitize 统一为 driver hook 链 + 空消息策略可配（DI-10）

> 状态：草案 v2（2026-07-22，用户定方向后重写）。来源：继承债台账 [docs/v4/06-inherited-issues.md](../v4/06-inherited-issues.md) DI-10。
> **用户拍板**：① 默认值**绝不**为字节等价妥协（架构健康 > 向后兼容，允许强制迁移旧→新）；② sanitize 绝不是核心主线的一部分——统一进一条独立 hook 链，默认取架构最优。

## 背景与问题

"空消息"处理在两个管线用**相反哲学、不同 stage、不同数据结构**，且 sanitize 整体在 OpenAI 侧**赖在主线里**：

| 处 | 行为 | 位置 | stage |
|---|---|---|---|
| OpenAI sanitize | 删整条空消息（`return null`） | `openai/sanitize.ts:48/83`，**codec.parse 硬编码**（`codec/openai-cc/codec.ts:400`、`codec/gemini/codec.ts:232`） | S1（主线内联）|
| cc-to-responses | 空 assistant turn 注入占位 | `openai/translate/cc-to-responses.ts:188` | 出站翻译腿 |
| Anthropic sanitize | 块级空清理（不删整条） | `anthropic/sanitize/content-blocks.ts` | **已是 S3 注册 rewrite**（`codec/anthropic/request-rewrite-adapter.ts`）|

**两个真问题**：
1. **架构不对称**：Anthropic sanitize 已是 driver S3 的可插拔 rewrite；OpenAI sanitize 还硬编码在 codec.parse 主线。sanitize 是旁路清理关注点，不该嵌在主数据流里。
2. **行为不可配、跨路径无统一契约**：空消息删/保的哲学冲突（M7/M8），且写死。

## 目标

1. **把 OpenAI-family sanitize 从 codec.parse 主线抬进 driver S3 rewrite registry**（对标 Anthropic 已有的 request-rewrite-adapter）。终态：**所有格式的请求 sanitize 都是 driver 的注册 rewrite，主数据流（codec.parse）不含 sanitize**。
2. 空消息策略抽成这条链上的**一个命名、可配 rewrite**（`openai.empty_message_policy`）。
3. **默认取架构最优的单一策略**（见下），不为字节等价妥协；旧行为差异记入迁移说明。
4. Anthropic 已在链上；纳入同一 registry 概念下统一表述。

## 最优默认：空即删除，交错约束是正交的 wire 层职责

**空消息就是噪声，默认删除**（含空 assistant turn）——空的就不该留在历史/请求里。这是 sanitize 的本职（清理噪声），也是最干净的默认。不搞"按角色保留"的花哨语义（我最初提的 `semantic` 想复杂了：保空 assistant turn 是错的，空就是空）。

即默认 `empty_message_policy: "delete"`。用户可配 `keep_placeholder`（全保占位）/ `off`（不动）覆盖。

**唯一例外 = 上游协议的交错硬约束，且它是正交的 wire/翻译层职责，不归 `empty_message_policy` 管**：某些上游（如 Responses API）要求 role 严格交错 / turn 结构完整，不接受"空 turn 被删后 role 连续"。这种情况由**翻译/prepare 层**在该约束**真实存在时**注入最小占位——这是**协议正确性**，不是空消息策略的默认，也不是通用最优。

分层澄清：
- sanitize hook 默认 `delete`——删掉所有空消息（clean 语义纯粹，包括空 assistant turn）。
- cc-to-responses（→ Responses API）的占位注入**保留为协议交错兜底**：仅当删空后会破坏 Responses 要求的 role 交错时触发，加注释明确它是 **Responses 协议约束、不受 `empty_message_policy` 控制**。
- 其它不要求交错的路径：空消息删就删，无占位。

## 前置重构（DI-10 的主要工作量）

把 OpenAI sanitize 从 `codec.parse` 抬进 driver S3。参照 `codec/anthropic/request-rewrite-adapter.ts` 的 payload-rewrite → env-rewrite 适配模式：
- openai-cc / gemini codec 的 sanitize 调用点从 parse 移除；
- 包成 `RequestRewrite`（`pipeline/rewrite-registry.ts` 接口），经 `deps.requestRewrites` 注入 driver；
- codec.parse 退化为纯解析（model 解析 + body 提取 + ctx 创建），**不含 sanitize**。

这也顺带修 06 台账的 **DI-3 半**（codec.parse 不再 in-place 改 payload）与 v4 的 **P1.4-SCOPE**（OpenAI 请求改写没进单一链）。

## 配置面（新增，`openai.*`）

```yaml
openai:
  # 空消息策略。delete=删所有空消息含空 assistant turn（默认，clean 语义纯粹）；
  # keep_placeholder=保留占位；off=不动。上游交错约束由翻译层正交兜底、不受此控制。
  empty_message_policy: delete   # delete | keep_placeholder | off
```

touch：`config/schema.ts`（`nullableEnum`，样例 `refusal_sse_rewrite:582`）、`state.ts` 四处、`config/config.ts` applyConfigToState（样例 `sanitize_tool_names:828`）、`config.yaml`。

## 实现塑形（how 留给 plan）

1. 单一 `isEmptyMessage(message)` 谓词（`openai/empty-message.ts`）。**有 tool_calls 的 assistant 不算空**（删了丢工具调用）；空 assistant（无 text 无 tool_calls）算空、默认删。
2. `createEmptyMessagePolicyRewrite(state)` —— `appliesTo` gate format + policy，`apply` 按策略处理 CC `Array<Message>`。
3. 前置：OpenAI sanitize 整体抬进 S3 registry（openai-cc + gemini codec request-rewrite 适配）。
4. cc-to-responses 占位注入降级为协议兜底 + 注释分层。

## 测试

- `isEmptyMessage` 谓词单测（空 user/tool/assistant → 空；有 tool_calls 的 assistant → 非空）。
- rewrite 单测：3 种 policy × 空/非空消息，golden。
- **交错兜底**：翻译层（cc-to-responses）在删空后仍满足 Responses role 交错约束（golden 断言删空 assistant 后的 input 序列合法）。
- **sanitize 抬进 S3 后 wire 等价**（除空消息语义变更外，其它 sanitize 行为不变——golden 守）。
- config wiring（apply → state → rewrite 行为）。

## 迁移说明（无字节等价妥协的显式代价）

- CC 入站：空 assistant turn 从"隐式在 codec.parse 删"→"在 S3 sanitize rewrite 删"（同样删除，位置从主线移到 hook 链）。行为对客户端一致；变的是**架构位置**，不是删/留。
- 若客户端依赖"保留空 turn"，配 `keep_placeholder`。
- Responses 路径的交错兜底行为不变（仍由翻译层保证 role 交错）。

## 验收标准

1. codec.parse **不再含 sanitize**——所有格式 sanitize 是 driver S3 注册 rewrite（架构对称）。
2. `empty_message_policy` 三值可切换、行为符合定义，默认 `delete`（空即删，含空 assistant turn）。
3. `isEmptyMessage` 单一谓词跨路径一致。
4. 除空消息语义的有意变更外，其它 sanitize 行为 wire 等价（golden）。

## 待用户定夺（阻塞 plan）

1. **默认 `delete` 认同？**（空即删，含空 assistant turn；上游交错约束由翻译层正交兜底，不归 empty_message_policy）——已按你的纠正定为此，除非你要别的默认。
2. **Anthropic 块级清理**：首版是否纳入同一 registry 统一表述（它已是 rewrite，主要是概念归位），还是只做 OpenAI 抬升、Anthropic 保持现状？
3. 范围确认：这是中型重构（sanitize 主线剥离 + registry 化 + 新 config），是否走完整 plan → subagent review → 分阶段实现？

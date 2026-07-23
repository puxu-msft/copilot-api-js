# Kickoff: sanitize 挪出主线 + 空消息策略可配（DI-10）

> 复制本文件全文到新会话启动实现。自包含——开场读完 spec + 本文即可开工。
> **本任务从一个上下文已满的长会话交接而来**，DI-10 的方向已被用户拍死，无需再问 open question。

## 你要做什么（一句话）

把**所有格式的请求 sanitize 从主数据流（`codec.parse`）剥离**，改成 driver S3 的注册 rewrite（对标 Anthropic 已有的 `request-rewrite-adapter`），并把"空消息删除"抽成一条可配 rewrite（`openai.empty_message_policy`，默认 `delete`）。终态：**codec.parse 对所有格式都不含 sanitize；sanitize 是主线之外的可插拔 hook 链**。

## 先读（按序）

1. **spec（权威、已定稿）**：[docs/spec/2026-07-21-empty-message-policy-configurable.md](../spec/2026-07-21-empty-message-policy-configurable.md) —— 背景/目标/最优默认/前置重构/配置面/实现塑形/测试/验收，「已定决策」节是用户拍板。
2. **继承债台账**：[docs/v4/06-inherited-issues.md](../v4/06-inherited-issues.md) DI-10 条 + 顺带修的 DI-3 半 / P1.4-SCOPE。
3. **v4 rewrite registry 规格**：[docs/v4/03-spec/rewrite-registry.md](../v4/03-spec/rewrite-registry.md)（RequestRewrite 接口 / assembleRequestRewrites / order 契约）。
4. **对标实现（Anthropic 已挪出主线的样板）**：`src/lib/codec/anthropic/request-rewrite-adapter.ts`（payload-rewrite → env-rewrite 适配模式）。

## 用户已拍死的决策（别再问）

- **默认 `delete`**：空消息就是噪声、就该删（含空 assistant turn）。**不搞"按角色保留"**（我最初提的 `semantic` 被用户否掉了：空就是空）。
- **交错约束是翻译层的正交职责**：某些上游（Responses API）要求 role 交错，删空后 role 连续会违约——这由**翻译层（cc-to-responses）按需注入占位兜底**，**不归 `empty_message_policy` 管**、也不该让 sanitize 为它扭曲。
- **默认绝不为字节等价妥协**：架构健康 > 向后兼容（用户一贯原则，[[feedback-optimize-long-term-maintainability]]）。sanitize 挪位置对客户端行为一致（还是删），变的是架构位置——但**不要**用"零改动"约束绑住自己。
- **Anthropic 也纳入**：所有格式 sanitize 都挪出主线。Anthropic 已是 rewrite，主要是归位对齐 + 确保 codec.parse 对所有格式都不含 sanitize。
- **走完整流程**：plan → subagent review（异模型对抗）→ 分阶段 TDD 实现。

## 现状锚点（实现前务必复核行号，代码在漂移）

- OpenAI sanitize 硬编码在主线：`src/lib/openai/sanitize.ts`（`sanitizeOpenAIMessages`，空消息 `return null` 在 :48/:83），被 `codec/openai-cc/codec.ts` 与 `codec/gemini/codec.ts` 的 **parse** 调用。
- cc-to-responses 占位注入：`src/lib/openai/translate/cc-to-responses.ts`（`convertAssistantMessage` 尾部，空 assistant turn 注入 output_text=""）——这是交错兜底，保留 + 加注释说明它不受 empty_message_policy 控制。
- Anthropic 样板：`src/lib/codec/anthropic/request-rewrite-adapter.ts` + `anthropic/sanitize/`。
- config 加法样例：`config/schema.ts` 的 `nullableEnum`（如 `refusal_sse_rewrite`）；`state.ts` 四处（接口字段/key 联合/CONFIG_MANAGED_DEFAULTS/reset）；`config/config.ts` applyConfigToState（样例 `sanitize_tool_names`）；`config.yaml`。
- pipeline registry：`src/lib/pipeline/rewrite-registry.ts`（RequestRewrite 接口）、driver 经 `deps.requestRewrites` 消费（`src/lib/pipeline/driver.ts`）。

## 建议 plan 阶段划分（plan 会话细化）

1. **P1 — `isEmptyMessage` 谓词 + empty-message rewrite**：单一谓词（`openai/empty-message.ts`，有 tool_calls 的 assistant 不算空）+ `createEmptyMessagePolicyRewrite(state)`（delete/keep_placeholder/off）+ config 全链（schema/state/config.ts/yaml）+ 谓词/rewrite 单测。**此阶段先不挪 sanitize，只加 rewrite + config，暂不接线**（纯新增可独立验证）。
2. **P2 — OpenAI sanitize 抬进 S3**：把 openai-cc / gemini codec 的 sanitize 从 parse 移除，包成 RequestRewrite 经 deps.requestRewrites 注入 driver；codec.parse 退化为纯解析。golden 守 wire（除空消息策略生效外，其它 sanitize 行为不变）。
3. **P3 — Anthropic 归位对齐 + 交错兜底注释**：确认 Anthropic sanitize 在同一 registry 概念下表述一致、codec.parse 对所有格式都不含 sanitize；cc-to-responses 占位注入加"协议交错约束、不受 empty_message_policy 控制"注释。
4. **P4 — 收尾**：06 台账 DI-10 标闭合 + 顺带闭合 DI-3 半 / P1.4-SCOPE；DESIGN.md sanitize 位置更新；CHANGELOG。

## 红线（项目通用）

- 中文对话。不碰工作区文件（不 checkout/reset/rm）。git add/本地 commit 允许，push 需同意。不自动启服务器、不 kill 进程。`bun run typecheck` / `bun run test:backend` / `bunx eslint <file>` 验证。
- **并发会话**：本仓库常有并发 agent，精确 pathspec 暂存、`git diff --cached --stat` 对账（数量级不符=污染）。
- TDD：改行为前先写/改测试；golden 预捕获守"sanitize 挪位置不改客户端可观测行为"。
- 每阶段 subagent 对抗 review（异模型），亲自复核其 file:line 断言。
- 完整根因、不打补丁；命名反映职责；不为列宽折行（printWidth 160）。

## 验收（spec 权威）

1. codec.parse 对所有格式**不含 sanitize**（架构对称）。
2. `empty_message_policy` 三值可切换，默认 `delete`。
3. `isEmptyMessage` 单一谓词跨路径一致。
4. 除空消息策略生效外，其它 sanitize 行为 wire 等价（golden）。

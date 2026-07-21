# Spec：入站 system-prompt 格式分发 hook（v3）

- **日期**：2026-07-20（v3 修订 2026-07-21，经 GPT reviewer 两轮对抗审 + 现实核查后收窄）
- **状态**：草案 v3（待复审 → 用户审阅 → 转 plan）
- **类型**：内部架构重构（瘦核心 + 单一可插拔入站缝）
- **关联**：v4 rewrite-registry（`docs/v4/03-spec/rewrite-registry.md`）、对称四点 hook（`docs/rfc/2026-07-14-symmetric-four-point-hooks.md`）、backlog「retry 策略可插拔化」、记忆 [[feedback-prefer-async-await-uniform-over-sync-isolation]]

## 0. 版本演进（诚实记录，避免误导后来者）

- **v1**：提议把 system-prompt override + preprocess 剥进 S3 `rewrite-registry`。→ GPT reviewer 逼出 3 BLOCK + 2 MAJOR（已核实）：两者都是 **pre-translation** 关切，S3 是 post-translation 错缝。
- **v2**：改挂 S1b「InboundUnit registry」+ S0「pre-parse 单元」。→ reviewer 复审逼出：**这是为 N=1 成员发明的平行 registry（过度设计）**、无 driver 接入机制、gemini 中段顺序会破字节等价、S0「driver 缝」根本不存在（parse 是 runRequest 首行、preprocess 在 route 层）。
- **v3（本版）现实核查的关键事实**：`preprocessAnthropicMessages`（`sanitize/index.ts:43`）**已经**是独立函数、route 直接调；`processAnthropicSystem`/`processOpenAIMessages`/`processResponsesInstructions`（`system-prompt/override.ts`）**已经**是 per-format 函数、各 codec translateInbound 已各自调用。**「剥离成 per-format 纯函数」这件事基本已完成**。

**故 v3 的真实增量很小**：不新增 registry、不改 preprocess（已提取）；只引入**单一格式分发 hook**，把现在散在 3 个 codec 的 system-prompt 直接调用，统一成一个命名的、可插拔的入站缝（用户 2026-07-21 决策：「这正是 hook 该发挥作用的地方——一个按 format 路由给不同纯函数的 hook」）。

## 1. 目标

引入 `applyInboundSystemPrompt(env): Promise<RequestEnvelope>`——**单一格式分发入口**，内部按 `env.clientFormat` 路由到既有 per-format 纯函数（`processAnthropicSystem`/`processOpenAIMessages`/`processResponsesInstructions`）。anthropic/cc/responses 三个 codec 的 translateInbound 改为调用这个统一分发（替换现在的直接调用），得到一个可被 config/未来用户 hook 集中拦截/替换的入站锚点。

**非目标澄清**：这不是把行为逻辑搬家（逻辑已在 per-format 函数里、不动），而是**统一调用入口 + 建立单一 pluggable 锚点**。

## 2. 现状（均已核实 file:line）

- **per-format 函数已存在**：`processAnthropicSystem`（override.ts:97）、`processOpenAIMessages`（:131）、`processResponsesInstructions`（:192），均 `async`、内部 `await applyConfigToState()`。
- **调用点**：anthropic `codec.ts:256`、cc `codec.ts:257`、responses `codec.ts:320` —— 均在各自 translateInbound、操作 `env.body`（system/messages/instructions），**翻译不在这些格式的 translateInbound 内**（它们不做格式翻译，anthropic 是 identity、cc/responses 原生）。
- **gemini 特殊（硬约束，核实成立）**：`gemini/codec.ts:217-236` translateInbound 顺序为 `Gemini→CC 翻译 → processOpenAIMessages(system-prompt) → sanitizeOpenAIMessages → fillMaxCompletionTokens(O10)`，且 `truncateBaseline = ccPayload`（注入后、sanitize 前快照，`:236`）。system-prompt 注入**夹在中段、操作中间 CC messages（非 env.body）、且 truncate baseline 依赖它在 sanitize 前跑**。
- **config-freshness 现状**：`handler-v4.ts:341` `if(payload.system) await applyConfigToState()`——除喂 system-prompt 新鲜度外，**顺带保 parse 阶段 `state.sanitizeToolNames`（`codec.ts:437`）新鲜度**。CC 路由是**无条件**独立 reload（`chat-completions/handler-v4.ts:169`）。

## 3. 设计（v3）

### 3.1 格式分发 hook

```
// src/lib/system-prompt/inbound.ts (新)
export async function applyInboundSystemPrompt(env: RequestEnvelope): Promise<RequestEnvelope> {
  switch (env.clientFormat) {
    case "anthropic": {
      const body = env.body as MessagesPayload
      if (!body.system) return env
      return env.with({ body: { ...body, system: await processAnthropicSystem(body.system, body.model, "anthropic") } })
    }
    case "openai-cc": { /* processOpenAIMessages over env.body.messages */ }
    case "openai-responses": { /* processResponsesInstructions over env.body.instructions */ }
    default: return env   // gemini 不走 env 层分发,见 3.2
  }
}
```

- anthropic/cc/responses 的 translateInbound 改为 `return applyInboundSystemPrompt(env)`（替换现在的内联直接调用），保持各自 early-return 语义（无 system/instructions 跳过）。
- 分发 hook 是 anthropic/cc/responses 三格式的**单一 pluggable 锚点**——未来 config gate / 用户 hook 可在此集中挂载。

### 3.2 gemini：记录在案的中段例外（保字节等价）

- gemini **不走** env 层分发：其 system-prompt 注入操作**中间 CC messages**、且被 truncateBaseline 时序钉在 sanitize 前。gemini translateInbound **继续在其中段锚点**直接调 `processOpenAIMessages(ccPayload.messages, ...)`（现状不动）。
- 显式文档化：gemini 是 per-format 顺序例外——它印证了「分发 hook 只能覆盖 env-body-shaped 的三格式」，不是均匀四格式。分发 hook 的 `default` 分支 return env（gemini env-level 无操作）。
- **不尝试**把 gemini 塞进统一分发（会改注入相对 sanitize/O10 的顺序 + truncateBaseline → 破字节等价，v2 复审已证）。

### 3.3 config-freshness：route reload 改无条件（修 v1 遗留的 BLOCK3 隐患）

> 注：本项**独立于分发 hook**，是核查中发现的既有隐患，顺带修正。

- `handler-v4.ts:341` `if(payload.system) await applyConfigToState()` 改**无条件** `await applyConfigToState()`（对齐 CC 路由 `:169`），保 parse 阶段 `sanitizeToolNames` 新鲜度不依附 system 分支。
- **plan 阶段须核实**：§2 注释说「无条件 reload 会重置 system-less 测试设的 state」——受影响测试改为 config 文件驱动（对齐 CC 路由既有做法），不直接改 state。
- 若此项风险经 plan 评估过大，可拆为独立 commit / 独立评估，不阻塞分发 hook 主体。

## 4. 数据流（v3，无新缝）

```
route pre-parse: preprocessAnthropicMessages (已提取,不动) + 无条件 applyConfigToState()
S1a parse (同步)
  → client.inbound hook (见 pre-injection 原生 body)
S1b translateInbound (async, per-codec):
     anthropic/cc/responses → applyInboundSystemPrompt(env)  ← 新:统一分发 hook
     gemini → 翻译 → processOpenAIMessages(中段) → sanitize → O10  ← 不动(例外)
S2 translateOut → S3 runRewriteIn → S4 ...
```

## 5. 测试与验收（字节等价硬约束）

- **golden 预捕（改动前锁）**：**全四格式**带 system-prompt override+prepend+append，锁 upstream wire body 逐字节等价（三格式经分发 hook、gemini 经原中段路径均不变）；gemini 额外锁 `truncateBaseline` 仍是注入后/sanitize 前快照。
- **分发 hook 单元测试**：`applyInboundSystemPrompt` 四分支（anthropic/cc/responses 各自路由正确 + gemini default 返回 env 原样）+ 各自 early-return（无 system/instructions 跳过、不 reload）。
- **config-freshness 测试**：改配置后单请求即生效——system-prompt **与** parse 侧 sanitizeToolNames 两路都测（config 文件驱动，非直接改 state）。
- **dry-run**：`inspectRequest` 四格式 translate-inbound stage 快照不变。

## 6. 风险与不变量

- **缝位正确性**（两轮审查的核心教训）：pre-translation 行为不进 post-translation registry;不虚构不存在的 driver 缝。
- **gemini 中段顺序 + truncateBaseline**：绝不动 gemini 注入相对 sanitize/O10 的位置（golden 锁）。
- **config-freshness 双路**：override 文本（per-format 函数内 await）+ parse 侧 sanitizeToolNames（route 无条件 reload）。
- **诚实 scope**：本 spec 增量小（一个分发函数 + 3 处调用点改 + 1 处 route reload 修）——不夸大为「大重构」。

## 7. 不在本次 scope

- **retry 策略可插拔化（接缝②，16 策略）**——**已定为下一独立项**，写入 `docs/todo/deferred-backlog.md`「retry 策略可插拔化」节，另起 spec。这是真正最大的未插件化区域。
- **async 化 S3 `RequestRewrite` 链**——独立项（爆炸半径:`request-rewrite-adapter.ts` / `openai-cc/reverse-anthropic-rewrite.ts` / `thinking-quarantine/proactive-filter.ts:111` + ≥5 测试站点），符合用户 async 偏好、可独立做。记 backlog。
- **跨格式 sanitize 对称（S3）**、**14 sanitizer 拆细**、**对用户 hook 模块暴露分发点**——后续。

## 8. 迁移 / 上线

- **零 config 变更、零行为变更**（四格式字节等价）——纯内部结构重构（统一调用入口）。
- 无向后兼容负担;不留双轨。

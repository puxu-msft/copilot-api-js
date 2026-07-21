# Spec：剥离 system-prompt / preprocess 成 pre-translation 入站单元（v2）

- **日期**：2026-07-20（v2 修订 2026-07-21，经 GPT reviewer 对抗审逼出 3 BLOCK + 2 MAJOR 后重写）
- **状态**：草案 v2（待复审 → 用户审阅 → 转 plan）
- **类型**：内部架构重构（瘦核心 + 内建行为可插拔单元）
- **关联**：v4 pipeline rewrite-registry（`docs/v4/03-spec/rewrite-registry.md`）、对称四点 hook（`docs/rfc/2026-07-14-symmetric-four-point-hooks.md`）、记忆 [[feedback-prefer-async-await-uniform-over-sync-isolation]]

## 0. v1 → v2 变更（审查逼出的根本修正）

v1 提议把两个行为剥进既有 S3 `rewrite-registry`（`RequestRewrite`）。**GPT reviewer 对抗审证伪了这个缝位**（逐条已亲手对照代码核实成立）：

- **两个行为都是 pre-translation 关切，S3 是 post-translation 的错 registry**：driver 阶段序为 S1a parse → S1b translateInbound → **S2 translateOut（翻译在此）** → S3 runRewriteIn（`driver.ts:327/329/352`）。到 S3 时 translate 腿的 `env.body` 已是上游目标形状、非客户端原生——system-prompt override（须作用于原生 `system`、翻译前）放 S3 按 `clientFormat` 分派是错的。
- **preprocess 更早**：`preprocessAnthropicMessages` 在 route 层、**parse 之前**跑（`handler-v4.ts:348`），parse 把 post-preprocess 结果存为 `truncateBaseline`（`codec.ts:408`）。并入 S3 会把重试 baseline 从 post- 变 pre-preprocess，改变重试实际 wire——故 v1 的「并入 anthropic-sanitize」被否。

**v2 正确形状**：不进 S3。引入/复用 **pre-translation 入站缝**——system-prompt override 挂 **S1b（translateInbound，已 async）**、preprocess 归位为 **S0 pre-parse 声明单元**。「async 化 S3 rewrite 链」从本 scope 必需**降级为另立项**（见 §7）。

## 1. 目标与动机

把仍内联在 route/codec 的两类 **pre-translation 请求整形**行为，剥成**声明式入站单元**，使核心变薄、行为可独立测试/保序/未来可开关。仍是「瘦核心 + 内建行为可插拔」（选项 A 内部架构）的聚焦推进。

两个目标：
1. **system-prompt override / prepend / append**（**全四格式** anthropic/cc/responses/gemini）——当前散在各 codec `translateInbound`（S1b）内联注入。
2. **Anthropic 消息 preprocess**（`preprocessAnthropicMessages`：dedup-tool-calls + strip-read-tags）——当前 route 层 pre-parse 内联。

用户偏好 [[feedback-prefer-async-await-uniform-over-sync-isolation]]（全面 async）**在 S1b 天然满足**——translateInbound 已 async，剥进来的入站单元原生 async，无需为此改 S3。

## 2. 现状（约束基线，均已核实 file:line）

- **阶段序**：S1a parse（同步）→ client.inbound hook → **S1b translateInbound（async，`driver.ts:327`）** → S2 translateOut（翻译，`:329`）→ S3 runRewriteIn（同步，`:352`）。
- **system-prompt 注入现状**：anthropic `codec.ts:253-258`（translateInbound `await processAnthropicSystem`）、cc/responses/gemini 各自 translateInbound 内 `processOpenAIMessages`/`processResponsesInstructions`（gemini `codec/gemini/codec.ts:217-221`）。**四格式都在 S1b。**
- **preprocess 现状**：`handler-v4.ts:348` route pre-parse，产 `preprocessInfo` 传入 `runMessagesDriver`；parse 存 post-preprocess `truncateBaseline`（`codec.ts:408`），重试策略消费（`anthropic-cell.ts:158`）。
- **config-freshness 现状**：`handler-v4.ts:341` `if(payload.system) await applyConfigToState()`——**除喂 system-prompt 新鲜度外，还顺带保证 parse 阶段 `state.sanitizeToolNames` 读取（`codec.ts:437` → `tool-name-sanitize.ts:41`）的新鲜度**（parse 早于 translateInbound）。CC 路由是**无条件**独立 reload（`chat-completions/handler-v4.ts:169`）；responses 无 route reload（其 translateInbound 自 reload）。
- **既有 registry 已 async 基础**：`inspectRequest` 已 `Promise`、`withCapturingManagerAsync` 已存在、translateInbound 已 async。

## 3. 设计（v2）

### 3.1 system-prompt override → S1b 声明式入站单元（async）

- 定义**入站单元契约**（新的小 interface，pre-translation 专用，区别于 post-translation 的 `RequestRewrite`）：
  ```
  interface InboundUnit {
    name: string
    order: number
    appliesTo(env): boolean          // 按 clientFormat + config 态门控
    apply(env): Promise<InboundResult>   // async;返回 {env, changed}
  }
  ```
- `system-prompt-override` 单元：`appliesTo` 覆盖**全四格式**（anthropic/cc/responses/gemini——修 v1 BLOCK：gemini 不能漏），内部按 `env.clientFormat` 分派到 `processAnthropicSystem`/`processOpenAIMessages`/`processResponsesInstructions` 等价逻辑；`apply` 内 `await applyConfigToState()` 保 freshness + 两轴 scope（model+endpoint）原样。
- driver 在 S1b 组装并 `await` 运行入站单元链（filter+sort+await，与 `runRewriteIn` 同构但 async 且在 translateInbound 阶段）。各 codec translateInbound 的 system-prompt 注入段**移除**（gemini 等的**格式翻译仍留** translateInbound，只搬 system-prompt）。
- **保留原「无 system 早返回」语义**：`appliesTo` 判 `env.body.system` 存在性（对应格式的 system/instructions 字段），无则跳过——不触发无谓 reload（修 v1 遗留的待定角落）。

### 3.2 preprocess → S0 pre-parse 声明单元

- `preprocessAnthropicMessages` 从 `handler-v4.ts` 移出，成 **pre-parse 声明单元**（`anthropic-preprocess`），在 driver/codec 的 parse **之前**运行，产出 `preprocessInfo` 经既有通道传入 parse——**保住 parse 存 post-preprocess `truncateBaseline` 的时序**（修 v1 MAJOR2）。
- 不并入 S3 `anthropic-sanitize`（v1 的 (b) 已否）。preprocess 与 sanitize 缝位不同（pre-parse vs post-translation），各自独立单元。

### 3.3 config-freshness：改无条件 route reload、对齐 CC（修 BLOCK3）

- `handler-v4.ts:341` 的 `if(payload.system) await applyConfigToState()` 改为**无条件** `await applyConfigToState()`（对齐 `chat-completions/handler-v4.ts:169`），**保住 parse 阶段 `sanitizeToolNames` 新鲜度**——不再依附 system 分支。
- system-prompt 单元 `apply` 内仍自持 `await applyConfigToState()`（幂等）保其自身 freshness。两处幂等、语义清晰（一保 parse 侧 tool-name、一保 override 侧文本）。
- 注意 §2 提到「无条件 reload 会重置 system-less 测试设的 state」——plan 阶段须核实：改无条件后受影响测试改为 config 文件驱动（非直接改 state），对齐 CC 路由既有做法。

### 3.4 保序

- S0 pre-parse：`anthropic-preprocess`。
- S1b 入站单元：`system-prompt-override`（单元链，未来可加更多入站单元）。
- 两缝独立，无跨缝 order 交织。

## 4. 数据流（v2）

```
S0 pre-parse:  anthropic-preprocess (dedup+strip-read-tags) → preprocessInfo
S1a parse (同步) → 存 post-preprocess truncateBaseline
  → client.inbound hook (见 pre-injection 原生 system)
S1b translateInbound (async):
     ├─ system-prompt-override 入站单元链 (await, 全四格式分派)
     └─ 格式翻译 (gemini CC 翻译等, 保留)
S2 translateOut (翻译)
S3 runRewriteIn (同步, 不动)  ← anthropic-sanitize/reverse/quarantine 等仍在此
S4 exchange ...
route pre-parse: 无条件 await applyConfigToState() (保 sanitizeToolNames 新鲜度)
```

## 5. 测试与验收（字节等价硬约束）

- **golden 预捕（改动前锁）**：**全四格式**（anthropic/cc/responses/gemini）带 system-prompt override+prepend+append 配置 + anthropic preprocess 场景，锁 upstream wire body + `pipelineInfo`/`initialSanitizationInfo`/`messageMapping` **子字段**（修 MINOR：显式点名 messageMapping，防合并悄改粒度）+ **preprocess 命中 × 自动截断重试**场景锁 truncateBaseline 仍 post-preprocess（修 MAJOR2）。
- **入站单元契约测试**：S1b 单元链 await/顺序;S0 pre-parse 单元时序（在 parse 前、baseline post-preprocess）。
- **单元测试**：`system-prompt-override` 四格式 + 两轴 scope（AND）+ prepend/append 空串 + 无 system 早返回不 reload;`anthropic-preprocess` dedup/strip 计数。
- **dry-run inspection**：`inspectRequest` 四格式 rewrite/inbound stage 快照含新单元、顺序正确。
- **config-freshness 测试**：改配置后单请求即生效（system-prompt **与** sanitizeToolNames 两路都测，config 文件驱动）。

## 6. 风险与不变量

- **缝位正确性（本次核心教训）**：pre-translation 行为绝不放 post-translation registry。system-prompt=S1b、preprocess=S0。
- **保序**：system-prompt override 作用于原生 `system`，须在翻译（S2）前——S1b 满足。
- **truncateBaseline 时序**：preprocess 须 pre-parse，parse 存 post-preprocess baseline 不变（golden 锁）。
- **config-freshness 双路**：override 文本（S1b 单元 await）+ parse 侧 sanitizeToolNames（route 无条件 reload）两路都保。
- **async 正确性不豁免**：入站单元链每步 `await`、异常传播（never-swallow）。参 [[methodology-sync-to-async-persistence-refactor-invariants]]。

## 7. 不在本次 scope（记录以免误并）

- **async 化 S3 `RequestRewrite` 链**（本 scope 不需要了）——**另立独立项**：`RequestRewrite.apply` 全面 async 波及 3 个生产 impl（`request-rewrite-adapter.ts`、`openai-cc/reverse-anthropic-rewrite.ts`、`thinking-quarantine/proactive-filter.ts:111` order 250）+ ≥5 测试站点（`quarantine-proactive-filter.it`、`quarantine-e2e.it`、`rewrite-registry.unit`、`inspect-request.unit`、`driver.unit`）。符合用户 async 偏好、可独立做，但爆炸半径已知。记 `docs/todo/deferred-backlog.md`。
- **接缝② retry 策略统一**、**跨格式 sanitize 对称（S3）**、**14 sanitizer 拆细**、**对用户 hook 暴露**——均后续/另项。

## 8. 迁移 / 上线

- **零 config 变更、零行为变更**（四格式字节等价）——纯内部结构重构。
- 无向后兼容负担;不留双轨。

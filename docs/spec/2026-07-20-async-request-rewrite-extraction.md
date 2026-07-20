# Spec：async RequestRewrite 链 + 剥离 system-prompt / preprocess 进 registry

- **日期**：2026-07-20
- **状态**：草案（待用户审阅 → 转 plan）
- **类型**：内部架构重构（瘦核心 + 内建行为可插拔单元）
- **关联**：v4 pipeline rewrite-registry（`docs/v4/03-spec/rewrite-registry.md`）、对称四点 hook（`docs/rfc/2026-07-14-symmetric-four-point-hooks.md`）、记忆 [[feedback-prefer-async-await-uniform-over-sync-isolation]]

## 1. 目标与动机（what & why）

把仍**内联在核心（route handler / codec S1b）**的两类请求整形行为，剥离成 v4 `rewrite-registry` 的 `RequestRewrite` 单元，使核心变薄、行为可独立测试/保序/未来可开关。这是「瘦核心 + 内建行为可插拔」方向的一次聚焦推进——**不是从零造插件系统**（rewrite-registry 已存在且成熟），而是把剩余内联行为迁进这套既有契约。

两个剥离目标：
1. **system-prompt override / prepend / append**（跨格式：anthropic / cc / responses）——当前在各 codec 的 `translateInbound`（S1b）里 async 注入。
2. **Anthropic 消息 preprocess**（`preprocessAnthropicMessages`：dedup-tool-calls + strip-read-tags）——当前在 `routes/messages/handler-v4.ts` route 层计算、经 `preprocessInfo` 喂给 codec。

**枢纽约束**：`RequestRewrite.apply` 当前是**同步**的（`apply(env): RewriteResult`），而 system-prompt 注入是 **async**（`await applyConfigToState()` 读新配置 + `processAnthropicSystem` 等）。用户明确选择**方案 2：把 RequestRewrite 链整体 async 化**，并声明**极度倾向全面引入 async/await、不为保持同步而围堵 async**（[[feedback-prefer-async-await-uniform-over-sync-isolation]]，推翻旧对称四点 PoC 的「同步 parse + 隔离 async」取向）。

## 2. 现状（约束基线）

- **rewrite-registry 已存在**：`src/lib/pipeline/rewrite-registry.ts` 定义 `RequestRewrite`（`name`/`order`/`appliesTo`/`apply`）+ `ResponseRewrite`，`assembleRequestRewrites` = filter-by-appliesTo + sort-by-order。
- **响应侧已全 registry 化**：Anthropic 5 单元 + Responses fixIds。
- **请求侧已有一个单元**：`anthropic-sanitize`（`codec/anthropic/request-rewrite-adapter.ts`），单块内聚（包 `runAnthropicPayloadRewrites`），已消费 `deps.preprocessInfo` 写 `pipelineInfo`/`initialSanitizationInfo` side-channel。
- **async 基础设施已就位**：`inspectRequest` 已是 `Promise<RequestInspection>`、`withCapturingManagerAsync` 已存在、`translateInbound` 已 async。故 async 爆炸半径**只剩** `runRewriteIn`（S3，当前同步）+ `RequestRewrite.apply` 签名 + `anthropic-sanitize` 的 apply body。
- **重复 reload**：`handler-v4.ts` 的 `if(payload.system) await applyConfigToState()` 与 `translateInbound` 内 `processAnthropicSystem` 的 `await applyConfigToState()` 是两次幂等调用。

## 3. 设计

### 3.1 使能改动：RequestRewrite 契约全面 async（统一，不做 union）

- `RequestRewrite.apply(env): Promise<RewriteResult>`（**统一 Promise，不用 `RewriteResult | Promise<...>` 联合**——避免同步/异步双态分叉，符合用户 async-uniform 偏好）。
- `runRewriteIn`（`driver.ts` S3）：`function → async function ...: Promise<RequestEnvelope>`，循环 `const result = await rewrite.apply(current)`。
- `assembleRequestRewrites` 保持**同步**（纯 filter + sort，不涉 IO）。
- 调用方：`runRequest`（已 async）在 S3 处加 `await`；`inspectRequest` 的镜像 rewrite 循环（已在 async 函数内）加 `await`。
- 现有 `anthropic-sanitize` 的 `apply` body 当前同步——签名改 async 后 body 不变（自然返回 resolved Promise）。

### 3.2 剥离一：system-prompt override → 跨格式 async RequestRewrite

- 新单元（命名 `system-prompt-override`；三格式共享一个单元、`appliesTo` 覆盖 anthropic/cc/responses，内部按 `env.clientFormat` 分派到 `processAnthropicSystem`/`processOpenAIMessages`/`processResponsesInstructions` 的等价逻辑）。
- `apply` 内做 `await applyConfigToState()` + 对应格式的 override/prepend/append（两轴 scope：model + endpoint，语义原样保留）。
- 从三个 codec 的 `translateInbound` **移除 system-prompt 注入段**；gemini 的**格式翻译**仍留 `translateInbound`（只搬 system-prompt 那部分，不动格式翻译）。
- **config-freshness 收敛**：删掉 `handler-v4.ts` 的前置 `await applyConfigToState()`（system-prompt 分支），freshness 改由本单元 `apply` 内的 `await` 保证——单点、不重复。
- **order**：`system-prompt-override`（建议 `order 200`），早于 `anthropic-sanitize`（300）。

### 3.3 剥离二：preprocess 并入 anthropic-sanitize（采纳 3.2(b)）

- `preprocessAnthropicMessages`（dedup-tool-calls + strip-read-tags）从 `handler-v4.ts` route 移出，**并入** `anthropic-sanitize` 单元 `apply` 内首步。
- 消除跨单元 `preprocessInfo` side-channel 传递：现由 route 计算后经 `deps.preprocessInfo` 传入，合并后单元自算 preprocess，直接产出 `pipelineInfo.preprocessing`。
- 内部顺序：`preprocess → runAnthropicPayloadRewrites`（保持原 route→codec 的先后）。
- side-channel 回写（`initialSanitizationInfo` / `pipelineInfo` / `thinking` feature）**逐字节保持**。

### 3.4 保序契约

请求侧 order 常量（对齐 `RESPONSE_REWRITE_ORDER` 同款）：
- `systemPromptOverride: 200`
- `anthropicSanitize: 300`（含 preprocess）

anthropic 链：`system-prompt-override(200) → anthropic-sanitize(300)`；cc/responses 链：仅 `system-prompt-override(200)`。

## 4. 数据流 / 阶段

```
S1a parse (client-native, 同步)
  → client.inbound hook (仍见 pre-injection 原生 system)
S1b translateInbound (async)   ← 只留格式翻译(gemini CC 翻译);system-prompt 注入已移出
S2 translateOut (client→upstream 格式)
S3 runRewriteIn (async)        ← await 链:system-prompt-override(200) → anthropic-sanitize(300,含 preprocess)
S4 exchange ...
```

## 5. 测试与验收（行为字节等价是硬约束）

- **golden 预捕（改动前锁）**：anthropic / cc / responses 三格式，带 system-prompt override + prepend + append + preprocess 配置的请求，锁 upstream wire body + `pipelineInfo`/`sanitizationInfo` side-channel，证重构前后**逐字节等价**（真 invariant = 对在意消费者无可观测变化，[[feedback-byte-equivalence-is-proxy-calibrate-by-consumer]]）。
- **async 契约测试**：rewrite 链 `await` 正确、顺序不变、`assembleRequestRewrites` 仍同步。
- **单元测试**：`system-prompt-override` 单元三格式 + 两轴 scope（model/endpoint AND）+ prepend/append 空串路径；`anthropic-sanitize` 合并 preprocess 后的 preprocessInfo 产出。
- **dry-run inspection**：`inspectRequest` 三格式路径 `rewrite-in` stage 快照含新单元、顺序正确。
- **config-freshness 测试**：改配置后单请求即生效（证 reload 收敛没破坏 freshness）——config 文件驱动、非直接改 state（[[reference-server-vs-test-app-dual-notfound-mirror]] 的 config 中间件教训）。

## 6. 风险与不变量

- **async 正确性纪律不豁免**：偏好 async 不等于豁免 async 陷阱——本 spec 无 fire-and-forget/持久化落盘，但 rewrite 链每步须 `await`、异常须传播（never-swallow）。参 [[methodology-sync-to-async-persistence-refactor-invariants]]。
- **保序**：system-prompt override 必须早于 sanitize（override 改 `system` 字段、sanitize 读它）。order 常量锁定 + 契约测试。
- **config-freshness 时序**：删 route 前置 reload 后，freshness 全靠单元 `apply` 内 `await applyConfigToState()`——须确保该单元**总是**在读 config 态前 await（对无 system 的请求也要跑 override 单元吗？→ `appliesTo` 或 early-return 保持原「无 system 早返回」语义，避免无谓 reload）。
- **爆炸半径已实测收窄**：`inspectRequest`/`withCapturingManagerAsync`/`translateInbound` 已 async（对称四点那次完成），非本次新引入。

## 7. 不在本次 scope（记录以免误并）

- **接缝② retry 策略**（16 个）统一进 registry —— 单独立项，形状不同（跨 attempt 决策）。
- **跨格式 sanitize 对称**（OpenAI/Gemini 的 codec `sanitize.ts` 入 registry）—— 后续。
- **14 个 sanitizer 拆成独立单元** —— v4 有意保留单块内聚，不拆。
- **对用户 hook 模块暴露这些内部扩展点**（选项 B/C）—— 本次是纯内部架构（选项 A）。

## 8. 迁移 / 上线

- **零 config 变更、零行为变更**（字节等价）——纯内部结构重构。
- 无向后兼容负担（内部接口）；不留双轨。

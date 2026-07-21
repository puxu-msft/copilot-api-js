# 入站 system-prompt 格式分发 hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引入单一格式分发函数 `applyInboundSystemPrompt(env)`，把散在 anthropic/cc/responses 三个 codec 的 system-prompt 注入直接调用统一成一个可插拔入站锚点，行为逐字节等价。

**Architecture:** 新增 `src/lib/system-prompt/inbound.ts` 的 `applyInboundSystemPrompt(env): Promise<RequestEnvelope>`，按 `env.clientFormat` switch 路由到既有 per-format 函数（`processAnthropicSystem`/`processOpenAIMessages`/`processResponsesInstructions`），每分支**逐字节镜像**该格式 translateInbound 当前逻辑；switch 穷尽 `ClientFormat` 四值 + `assertNever` 兜底。三个 codec 的 translateInbound 改为委托本函数。gemini 不动（其注入在中段、操作中间 CC messages、被 truncateBaseline 时序钉死）。顺带修 config-freshness 隐患（route reload 改无条件）。

**Tech Stack:** TypeScript / Bun / Hono；测试 `bun test`。

## Global Constraints

- **字节等价硬约束**：四格式 upstream wire body 逐字节不变；gemini `truncateBaseline` 仍为注入后/sanitize 前快照。
- **逐格式镜像现状**：anthropic 有 `if (!body.system) return env` early-return；cc/responses **无**外层 early-return（内部函数自处理 undefined）。分发函数每分支必须**精确复制**对应格式当前逻辑，不得统一化。
- **穷尽性**：switch 覆盖 `ClientFormat` 全四值（`"anthropic" | "openai-cc" | "openai-responses" | "gemini"`），`default` 用 `assertNever` 编译期兜底（复审 nit）。
- **gemini 不进 env 层分发**：其 case 是 `return env` passthrough（生产不触达、仅为穷尽 + 自文档）。
- **提交纪律**：显式 pathspec、conventional commits、无模型署名（CLAUDE.md）。
- **不杀 4141 主服务器**；测试服务器用非 4141 端口。
- **权威 spec**：`docs/spec/2026-07-20-inbound-system-prompt-dispatch-hook.md`。

---

### Task 1: 创建 `applyInboundSystemPrompt` 分发函数 + 单元测试

**Files:**
- Create: `src/lib/system-prompt/inbound.ts`
- Modify: `src/lib/system-prompt/index.ts`（barrel 加 re-export）
- Test: `tests/system-prompt/inbound.unit.test.ts`

**Interfaces:**
- Consumes: `processAnthropicSystem`/`processOpenAIMessages`/`processResponsesInstructions`（`~/lib/system-prompt`，均 `async`）、`RequestEnvelope`（`~/lib/pipeline/envelope`，有 `.clientFormat`/`.body`/`.with()`）、`assertNever`（`~/lib/observability`）、payload 类型（`~/types/api/{anthropic,openai-chat-completions,openai-responses}`）。
- Produces: `applyInboundSystemPrompt(env: RequestEnvelope): Promise<RequestEnvelope>`。

- [ ] **Step 1: 写失败测试**

创建 `tests/system-prompt/inbound.unit.test.ts`。用最小 fake env（`clientFormat` + `body` + `with` 闭包）驱动四分支。

```ts
import { describe, expect, test } from "bun:test"

import type { RequestEnvelope } from "~/lib/pipeline/envelope"

import { applyInboundSystemPrompt } from "~/lib/system-prompt/inbound"

// 最小 fake env：只实现分发函数触达的 clientFormat/body/with。
function fakeEnv(clientFormat: string, body: unknown): RequestEnvelope {
  const env = {
    clientFormat,
    body,
    with(patch: { body?: unknown }) {
      return fakeEnv(clientFormat, patch.body ?? body)
    },
  }
  return env as unknown as RequestEnvelope
}

describe("applyInboundSystemPrompt", () => {
  test("anthropic：无 system 时 early-return 原 env（不改 body 引用）", async () => {
    const env = fakeEnv("anthropic", { model: "m", messages: [] })
    const out = await applyInboundSystemPrompt(env)
    expect(out.body).toBe(env.body) // 同引用 = 未改
  })

  test("gemini：passthrough 返回原 env（不经 env 层分发）", async () => {
    const env = fakeEnv("gemini", { model: "m", contents: [] })
    const out = await applyInboundSystemPrompt(env)
    expect(out).toBe(env)
  })

  test("anthropic：有 system 时经 processAnthropicSystem 注入到 system 字段", async () => {
    const env = fakeEnv("anthropic", { model: "m", system: "hi", messages: [] })
    const out = await applyInboundSystemPrompt(env)
    // system 被处理（至少不再是原引用的 body；system 字段仍存在）
    expect(out.body).not.toBe(env.body)
    expect((out.body as { system?: unknown }).system).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test tests/system-prompt/inbound.unit.test.ts`
Expected: FAIL（`Cannot find module ~/lib/system-prompt/inbound` 或 `applyInboundSystemPrompt is not a function`）。

- [ ] **Step 3: 写分发函数**

创建 `src/lib/system-prompt/inbound.ts`。每分支**逐字节镜像**对应 codec translateInbound 现状（见 `src/lib/codec/{anthropic,openai-cc,openai-responses}/codec.ts` 的 `translateInbound`）：

```ts
import type { RequestEnvelope } from "~/lib/pipeline/envelope"
import type { MessagesPayload } from "~/types/api/anthropic"
import type { ChatCompletionsPayload } from "~/types/api/openai-chat-completions"
import type { ResponsesPayload } from "~/types/api/openai-responses"

import { assertNever } from "~/lib/observability"
import {
  //
  processAnthropicSystem,
  processOpenAIMessages,
  processResponsesInstructions,
} from "~/lib/system-prompt"

/**
 * 单一格式分发入口（spec docs/spec/2026-07-20-inbound-system-prompt-dispatch-hook.md §3.1）：
 * 按 `env.clientFormat` 路由到既有 per-format system-prompt 注入函数。anthropic/cc/responses
 * 三个 codec 的 translateInbound（S1b）委托本函数，得到一个可插拔入站锚点。每分支逐字节镜像
 * 对应 codec 的现状逻辑（anthropic 有 !system early-return；cc/responses 无外层 early-return）。
 *
 * gemini 不经此入口：它在 translateInbound 中段对中间 CC messages 注入、且被 truncateBaseline
 * 时序钉死（gemini/codec.ts）——这里的 `gemini` case 是 passthrough，生产不触达，仅为穷尽 ClientFormat
 * + 自文档。新增第 5 个 ClientFormat 时 `assertNever` 编译期报错。
 */
export async function applyInboundSystemPrompt(env: RequestEnvelope): Promise<RequestEnvelope> {
  switch (env.clientFormat) {
    case "anthropic": {
      const body = env.body as MessagesPayload
      if (!body.system) return env
      const system = await processAnthropicSystem(body.system, body.model, "anthropic")
      return env.with({ body: { ...body, system } })
    }
    case "openai-cc": {
      const body = env.body as ChatCompletionsPayload
      const messages = await processOpenAIMessages(body.messages, body.model, "openai-cc")
      return env.with({ body: { ...body, messages } })
    }
    case "openai-responses": {
      const body = env.body as ResponsesPayload
      const instructions = await processResponsesInstructions(body.instructions, body.model, "openai-responses")
      return env.with({ body: { ...body, instructions } })
    }
    case "gemini":
      return env
    default:
      return assertNever(env.clientFormat)
  }
}
```

在 `src/lib/system-prompt/index.ts` 末尾加：

```ts
export * from "./inbound"
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `bun test tests/system-prompt/inbound.unit.test.ts && bun run typecheck`
Expected: PASS；typecheck 绿（`assertNever(env.clientFormat)` 证明 switch 穷尽）。

- [ ] **Step 5: lint 单文件**

Run: `bunx eslint src/lib/system-prompt/inbound.ts tests/system-prompt/inbound.unit.test.ts`
Expected: 无 error（忽略 baseline-browser-mapping info）。

- [ ] **Step 6: 提交**

```bash
git add -- src/lib/system-prompt/inbound.ts src/lib/system-prompt/index.ts tests/system-prompt/inbound.unit.test.ts
git commit -m "feat(system-prompt): add applyInboundSystemPrompt format-dispatch hook"
```

---

### Task 2: 三个 codec translateInbound 委托分发函数（行为字节等价）

**Files:**
- Modify: `src/lib/codec/anthropic/codec.ts:253-258`（translateInbound body）
- Modify: `src/lib/codec/openai-cc/codec.ts:255-259`（translateInbound body）
- Modify: `src/lib/codec/openai-responses/codec.ts:318-322`（translateInbound body）
- Test: 复用既有 codec/e2e 套件作字节等价 oracle（下方命令）

**Interfaces:**
- Consumes: `applyInboundSystemPrompt`（Task 1）。
- Produces: 无新导出（内部委托）。

- [ ] **Step 1: 先跑既有相关套件、锁基线绿（golden 预捕）**

Run: `bun test tests/anthropic tests/openai tests/responses tests/gemini 2>&1 | tail -15`
Expected: 记录当前 pass/fail 数作基线（改动后须完全一致）。若有预存失败，记下来区分。

- [ ] **Step 2: 改 anthropic codec translateInbound**

`src/lib/codec/anthropic/codec.ts`，把现有 translateInbound body 替换为委托（注释保留缝位说明）：

```ts
    // S1b (RFC 2026-07-14 §4): 委托统一入站分发（spec 2026-07-20-inbound-system-prompt-dispatch-hook）。
    // client.inbound 仍见 pre-injection 原生 system（分发在 translateInbound 内、S1a→S1b 之后）。
    translateInbound(env) {
      return applyInboundSystemPrompt(env)
    },
```

文件顶部加 import：`import { applyInboundSystemPrompt } from "~/lib/system-prompt"`（若已 import `processAnthropicSystem` 且不再直接用，删之）。

- [ ] **Step 3: 改 cc codec translateInbound**

`src/lib/codec/openai-cc/codec.ts` 同法替换 body 为 `translateInbound(env) { return applyInboundSystemPrompt(env) }`，import 换成 `applyInboundSystemPrompt`（删不再用的 `processOpenAIMessages` import）。

- [ ] **Step 4: 改 responses codec translateInbound**

`src/lib/codec/openai-responses/codec.ts` 同法替换，import 换成 `applyInboundSystemPrompt`（删不再用的 `processResponsesInstructions` import）。

- [ ] **Step 5: typecheck + 跑套件对账字节等价**

Run: `bun run typecheck && bun test tests/anthropic tests/openai tests/responses tests/gemini 2>&1 | tail -15`
Expected: typecheck 绿；pass/fail 数与 Step 1 基线**完全一致**（零回归 = 字节等价）。gemini 套件必须仍全绿（证明未动 gemini 路径）。

- [ ] **Step 6: dry-run inspection 冒烟（可选但推荐）**

Run: `bun test tests/pipeline/inspect-request.unit.test.ts 2>&1 | tail -5`
Expected: PASS（translate-inbound stage 快照不变）。

- [ ] **Step 7: lint + 提交**

```bash
bunx eslint src/lib/codec/anthropic/codec.ts src/lib/codec/openai-cc/codec.ts src/lib/codec/openai-responses/codec.ts
git add -- src/lib/codec/anthropic/codec.ts src/lib/codec/openai-cc/codec.ts src/lib/codec/openai-responses/codec.ts
git commit -m "refactor(codec): route anthropic/cc/responses translateInbound through applyInboundSystemPrompt"
```

---

### Task 3: config-freshness — route reload 改无条件（修既有隐患）

> 独立于分发 hook（spec §3.3）。现状 `if(payload.system) await applyConfigToState()` 顺带保 parse 阶段 `sanitizeToolNames` 新鲜度；改无条件对齐 CC 路由。

**Files:**
- Modify: `src/routes/messages/handler-v4.ts:341`
- Test: `tests/anthropic/`（config-freshness，config 文件驱动）

**Interfaces:**
- Consumes: `applyConfigToState`（已 import）。
- Produces: 无。

- [ ] **Step 1: 写/定位 freshness 失败测试**

先 grep 既有 config-freshness 测试：`rg -l 'sanitizeToolNames|applyConfigToState' tests/anthropic tests/routes`。若已有覆盖「改 config→单请求 sanitizeToolNames 生效」的测试，跑它确认现状；若无，新增一条 config 文件驱动的测试（改配置文件→发 anthropic 无 system 请求→断言 tool 名按新 `sanitize_tool_names` 处理）。

Run: `bun test tests/anthropic 2>&1 | tail -8`（记录基线）

- [ ] **Step 2: 改无条件 reload**

`src/routes/messages/handler-v4.ts:341`：

```ts
  // 无条件 reload（对齐 CC 路由 chat-completions/handler-v4.ts）：除喂 system-prompt 新鲜度外，
  // 保 parse 阶段 state.sanitizeToolNames（codec.ts）读取新鲜度——不再依附 payload.system 分支。
  await applyConfigToState()
```

（删去 `if (payload.system)` 条件；同步更新上方 335-339 行注释里「reloaded config before parse ONLY when a system was present」的过时描述。）

- [ ] **Step 3: 核实受影响测试（无条件 reload 会重置 system-less 测试设的 state）**

Run: `bun test tests/anthropic tests/routes 2>&1 | tail -12`
Expected: 若有测试因「直接改 state 被无条件 reload 冲掉」而失败——按 CLAUDE.md 纪律改为 **config 文件驱动**（非直接改 state），对齐 CC 路由既有做法。逐个修绿，不放任。

- [ ] **Step 4: 全量后端套件回归**

Run: `bun test tests/ 2>&1 | tail -15`（或项目脚本 `bun run test:backend`）
Expected: 零新增失败（对比 Task 2 Step 1 的预存失败集）。

- [ ] **Step 5: lint + 提交**

```bash
bunx eslint src/routes/messages/handler-v4.ts
git add -- src/routes/messages/handler-v4.ts tests/anthropic
git commit -m "fix(messages): unconditional config reload preserves sanitizeToolNames freshness"
```

---

## Self-Review（对照 spec）

- **spec §3.1 分发 hook** → Task 1 ✅（含 nit：`assertNever` 穷尽）。
- **spec §3.2 gemini 例外** → Task 2 不动 gemini + Task 1 gemini case passthrough ✅。
- **spec §3.3 config-freshness** → Task 3 ✅。
- **spec §5 字节等价 golden** → Task 2 Step 1/5 既有套件对账（四格式）；gemini truncateBaseline 由「不动 gemini」保证 ✅。
- **spec §5 分发 hook 单元测试** → Task 1 四分支 ✅。
- **spec §5 config-freshness 测试** → Task 3 双路（config 文件驱动）✅。
- **Type consistency**：`applyInboundSystemPrompt(env: RequestEnvelope): Promise<RequestEnvelope>` 全程一致；三 codec 委托签名与 codec `translateInbound?(env): Promise<env>` 契约相容（现状即 async 返回 env）。
- **注意**：Task 2 把 `async translateInbound(env){...}` 改为 `translateInbound(env){ return applyInboundSystemPrompt(env) }`（去掉 `async`、直接返回 Promise）——两者对 driver 的 `await deps.codec.translateInbound?.(...)` 等价；若 codec 类型要求 `async`，保留 `async` + `return await`。plan 执行时以 typecheck 为准。

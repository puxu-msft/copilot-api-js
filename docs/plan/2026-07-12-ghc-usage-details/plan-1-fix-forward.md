# Phase 1 — fix-forward（类型 + 提取 + G6）

**Goal:** 从此每条新请求（流式 + 非流式）都完整捕获 cache_write + 模态/prediction 明细进 `UsageData`，且非流式补存 rawBody。**不碰历史行**（那是 Phase 2）。

**前置：** Phase 0 CONCLUSION.md 已定净公式（下称「子集分支」或「additive 分支」）。

**Global Constraints 提醒：** 类型双拥有点锁步（C1）；穷举 `usageFromTotalInput` 站点（H1/H2）。

---

### Task 1.1：新建 GHC 扩展 usage 类型

**Files:**
- Create: `src/types/api/ghc-usage.ts`
- Test: `tests/ghc-usage.test.ts`

**Interfaces:**
- Produces: `GhcPromptTokensDetails`、`GhcCompletionTokensDetails`、`GhcInputTokensDetails`（responses 侧）——后续 accumulator/handler import 这些做结构化读取。

- [ ] **Step 1：写类型（无运行逻辑，测试用类型断言守卫）**

`src/types/api/ghc-usage.ts`：
```ts
/**
 * GHC (GitHub Copilot) 对 OpenAI-format usage 的扩展字段，非 OpenAI 标准。
 * 我们的 usage 类型来自 `openai` SDK 的 CompletionUsage（PromptTokensDetails 只
 * 声明 audio_tokens/cached_tokens），看不见这些扩展。故在此自有定义、不 augment
 * SDK（SSOT：GHC 扩展的拥有方是本项目）。见 docs/spec/2026-07-12-ghc-usage-details.md §4。
 */

/** chat/completions 帧的 prompt_tokens_details（GHC 扩展）。 */
export interface GhcPromptTokensDetails {
  cached_tokens?: number | null
  cache_write_tokens?: number | null
  text_tokens?: number | null
  audio_tokens?: number | null
  image_tokens?: number | null
  video_tokens?: number | null
}

/** chat/completions 帧的 completion_tokens_details（GHC 扩展）。 */
export interface GhcCompletionTokensDetails {
  reasoning_tokens?: number | null
  text_tokens?: number | null
  audio_tokens?: number | null
  image_tokens?: number | null
  video_tokens?: number | null
  accepted_prediction_tokens?: number | null
  rejected_prediction_tokens?: number | null
}

/** responses 帧的 input_tokens_details（GHC 扩展；cache_write 在这里而非 prompt_tokens_details）。 */
export interface GhcInputTokensDetails {
  cached_tokens?: number | null
  cache_write_tokens?: number | null
  text_tokens?: number | null
  audio_tokens?: number | null
  image_tokens?: number | null
  video_tokens?: number | null
}

/** 归一化非空整数：null/undefined/NaN/负数 → undefined；否则该数。用于「非空才挂」。 */
export function nonNegOrUndef(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
}
```

- [ ] **Step 2：写测试**

`tests/ghc-usage.test.ts`：
```ts
import { expect, test } from "bun:test"
import { nonNegOrUndef } from "~/types/api/ghc-usage"

test("nonNegOrUndef filters null/NaN/negative", () => {
  expect(nonNegOrUndef(5)).toBe(5)
  expect(nonNegOrUndef(0)).toBe(0)
  expect(nonNegOrUndef(null)).toBeUndefined()
  expect(nonNegOrUndef(undefined)).toBeUndefined()
  expect(nonNegOrUndef(-1)).toBeUndefined()
  expect(nonNegOrUndef(Number.NaN)).toBeUndefined()
})
```

- [ ] **Step 3：跑测试**

Run: `bun test tests/ghc-usage.test.ts`
Expected: PASS（4 断言）。

- [ ] **Step 4：提交**

```bash
git add -- src/types/api/ghc-usage.ts tests/ghc-usage.test.ts
git commit -F <msg> -- src/types/api/ghc-usage.ts tests/ghc-usage.test.ts
# msg: "feat(types): GHC extended usage details type (cache_write + modality/prediction)"
```

---

### Task 1.2：扩 `UsageData` + `ResponseData.usage` 锁步（含 reasoning 可选化）

**Files:**
- Modify: `src/lib/history/types.ts:197-203`（`UsageData`）
- Modify: `src/lib/context/types.ts:59-65`（`ResponseData.usage` 内联）
- Test: `tests/usage-data-shape.test.ts`

**Interfaces:**
- Produces: 扩展后的 `UsageData`——新增可选 `input_tokens_details` + `output_tokens_details` 扩项，`reasoning_tokens` 转可选。

- [ ] **Step 1：写「两形状可互赋值」的类型守卫测试**

`tests/usage-data-shape.test.ts`：
```ts
import { expect, test } from "bun:test"
import type { UsageData } from "~/lib/history/types"
import type { ResponseData } from "~/lib/context/request"

// 编译期锁步守卫：UsageData 必须可赋给 ResponseData["usage"]，反之亦然。
// 若两拥有点漂移（如一处 reasoning 必填一处可选），此文件 typecheck 直接报错。
test("UsageData and ResponseData.usage stay mutually assignable", () => {
  const u: UsageData = { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, input_tokens_details: { text: 1 }, output_tokens_details: { reasoning_tokens: 4, accepted_prediction_tokens: 5 } }
  const r: ResponseData["usage"] = u
  const back: UsageData = r
  expect(back.cache_creation_input_tokens).toBe(3)
  expect(back.input_tokens_details?.text).toBe(1)
  expect(back.output_tokens_details?.accepted_prediction_tokens).toBe(5)
})
```

- [ ] **Step 2：跑测试确认失败（类型不存在）**

Run: `bun run typecheck`
Expected: FAIL —`input_tokens_details` / `accepted_prediction_tokens` 不在类型上。

- [ ] **Step 3：改 `UsageData`（拥有点 A）**

`src/lib/history/types.ts` 的 `UsageData` 改为：
```ts
export interface UsageData {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** 输入侧模态分解（GHC 扩展，blob-only；多为 null，非空才挂）。 */
  input_tokens_details?: { text?: number; audio?: number; image?: number; video?: number }
  /** 输出侧：reasoning（转可选，与非零才挂一致）+ 模态 + prediction（GHC 扩展，blob-only）。 */
  output_tokens_details?: {
    reasoning_tokens?: number
    text?: number
    audio?: number
    image?: number
    video?: number
    accepted_prediction_tokens?: number
    rejected_prediction_tokens?: number
  }
}
```

- [ ] **Step 4：改 `ResponseData.usage` 内联（拥有点 B，逐字对齐）**

`src/lib/context/types.ts` 的 `ResponseData.usage` 内联改为与上面**同形**：
```ts
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    input_tokens_details?: { text?: number; audio?: number; image?: number; video?: number }
    output_tokens_details?: {
      reasoning_tokens?: number
      text?: number
      audio?: number
      image?: number
      video?: number
      accepted_prediction_tokens?: number
      rejected_prediction_tokens?: number
    }
  }
```

- [ ] **Step 5：跑 typecheck + 全测试确认可选化无破坏**

Run: `bun run typecheck && bun test tests/usage-data-shape.test.ts`
Expected: PASS。若 typecheck 在别处报 `reasoning_tokens` 可选化的错，读该处：应已用 `?.`/`?? 0`（spec §10 已核 telemetry/serialize/stats 均安全）；若有裸 `.reasoning_tokens` 访问，补 `?.`。

- [ ] **Step 6：提交**

```bash
git add -- src/lib/history/types.ts src/lib/context/types.ts tests/usage-data-shape.test.ts
git commit -F <msg> -- src/lib/history/types.ts src/lib/context/types.ts tests/usage-data-shape.test.ts
# msg: "feat(types): extend UsageData + ResponseData.usage lockstep with cache_creation details (blob-only)"
```

---

### Task 1.3：扩 `usageFromTotalInput`（cacheCreation + details 直通）

**Files:**
- Modify: `src/lib/request/usage-normalize.ts`
- Test: `tests/usage-normalize.test.ts`（若无则建）

**Interfaces:**
- Consumes: `UsageData`（Task 1.2）。
- Produces: `usageFromTotalInput(args: { totalInput, output, cacheRead?, cacheCreation?, reasoning?, inputDetails?, outputDetails? }): UsageData`。

- [ ] **Step 1：写测试（子集分支——按 Phase 0 结论；若 additive 见 Step 3 注）**

`tests/usage-normalize.test.ts` 追加：
```ts
import { expect, test } from "bun:test"
import { usageFromTotalInput } from "~/lib/request/usage-normalize"

test("usageFromTotalInput subtracts cache_write from input (subset branch)", () => {
  // prompt=1000, cached=600, cache_write=300 → net input = 100
  const u = usageFromTotalInput({ totalInput: 1000, output: 50, cacheRead: 600, cacheCreation: 300, reasoning: 10 })
  expect(u.input_tokens).toBe(100)
  expect(u.cache_read_input_tokens).toBe(600)
  expect(u.cache_creation_input_tokens).toBe(300)
  expect(u.output_tokens_details?.reasoning_tokens).toBe(10)
})

test("usageFromTotalInput omits cache_creation when zero + attaches details when present", () => {
  const u = usageFromTotalInput({ totalInput: 100, output: 5, cacheRead: 0, cacheCreation: 0, inputDetails: { image: 12 }, outputDetails: { accepted_prediction_tokens: 3 } })
  expect(u.cache_creation_input_tokens).toBeUndefined()
  expect(u.input_tokens_details?.image).toBe(12)
  expect(u.output_tokens_details?.accepted_prediction_tokens).toBe(3)
})
```

- [ ] **Step 2：跑确认失败**

Run: `bun test tests/usage-normalize.test.ts`
Expected: FAIL（`cacheCreation`/`inputDetails` 参数不存在）。

- [ ] **Step 3：改 `usageFromTotalInput`**

`src/lib/request/usage-normalize.ts` 的 `usageFromTotalInput` 改为（**additive 分支**：把 `netInputTokens(args.totalInput, cacheRead, cacheCreation)` 改成 `netInputTokens(args.totalInput, cacheRead)` 即不减 cache_write，其余不变）：
```ts
export function usageFromTotalInput(args: {
  totalInput: number
  output: number
  cacheRead?: number
  cacheCreation?: number
  reasoning?: number
  inputDetails?: { text?: number; audio?: number; image?: number; video?: number }
  outputDetails?: { text?: number; audio?: number; image?: number; video?: number; accepted_prediction_tokens?: number; rejected_prediction_tokens?: number }
}): UsageData {
  const cacheRead = args.cacheRead ?? 0
  const cacheCreation = args.cacheCreation ?? 0
  const inDetails = pruneEmpty(args.inputDetails)
  const reasoning = args.reasoning && args.reasoning > 0 ? { reasoning_tokens: args.reasoning } : undefined
  const outDetails = pruneEmpty({ ...reasoning, ...args.outputDetails })
  return {
    // 子集分支：减 cacheRead + cacheCreation。additive 分支：只减 cacheRead。
    input_tokens: netInputTokens(args.totalInput, cacheRead, cacheCreation),
    output_tokens: args.output,
    ...(cacheRead > 0 && { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation > 0 && { cache_creation_input_tokens: cacheCreation }),
    ...(inDetails && { input_tokens_details: inDetails }),
    ...(outDetails && { output_tokens_details: outDetails }),
  }
}

/** 剔除对象里所有 undefined/null 值；全空返回 undefined（「非空才挂」）。 */
function pruneEmpty<T extends Record<string, number | undefined>>(obj: T | undefined): T | undefined {
  if (!obj) return undefined
  const out = {} as T
  let any = false
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && Number.isFinite(v)) { (out as Record<string, number>)[k] = v; any = true }
  }
  return any ? out : undefined
}
```

- [ ] **Step 4：跑测试通过**

Run: `bun test tests/usage-normalize.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/request/usage-normalize.ts tests/usage-normalize.test.ts
git commit -F <msg> -- src/lib/request/usage-normalize.ts tests/usage-normalize.test.ts
# msg: "feat(usage): usageFromTotalInput carries cacheCreation + modality/prediction details"
```

---

### Task 1.4：Responses 类型 `input_tokens_details.cache_write`

**Files:**
- Modify: `src/types/api/openai-responses.ts:214-216`
- Test: 复用 typecheck（无独立断言）。

- [ ] **Step 1：改 `ResponsesUsage.input_tokens_details`**

把 `input_tokens_details?: { cached_tokens: number }` 扩为：
```ts
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; text_tokens?: number; audio_tokens?: number; image_tokens?: number; video_tokens?: number }
```
（`cached_tokens` 转可选与其它对齐；现有读取点 `?? 0` 安全。）

- [ ] **Step 2：typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3：提交**

```bash
git add -- src/types/api/openai-responses.ts
git commit -F <msg> -- src/types/api/openai-responses.ts
# msg: "feat(types): ResponsesUsage.input_tokens_details adds cache_write + modality"
```

---

### Task 1.5：两个 stream accumulator 累积新字段

**Files:**
- Modify: `src/lib/openai/stream-accumulator.ts`
- Modify: `src/lib/openai/responses-stream-accumulator.ts`
- Test: `tests/stream-accumulator-usage.test.ts`（新）

**Interfaces:**
- Produces: accumulator 上新增 `cacheWriteTokens: number` + `inputDetails?` + `outputDetails?`，供 recording.ts（Task 1.6）读取。

- [ ] **Step 1：写测试（chat accumulator 读 prompt_tokens_details.cache_write_tokens）**

`tests/stream-accumulator-usage.test.ts`：
```ts
import { expect, test } from "bun:test"
import { accumulateOpenAIStreamEvent, createOpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"
import type { ChatCompletionChunk } from "~/types/api/openai-chat-completions"

test("openai accumulator captures cache_write_tokens", () => {
  const acc = createOpenAIStreamAccumulator()
  const chunk = { model: "gpt-5.5", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 }, completion_tokens_details: { reasoning_tokens: 10, accepted_prediction_tokens: 4 } } } as unknown as ChatCompletionChunk
  accumulateOpenAIStreamEvent(chunk, acc)
  expect(acc.cachedTokens).toBe(600)
  expect(acc.cacheWriteTokens).toBe(300)
  expect(acc.outputDetails?.accepted_prediction_tokens).toBe(4)
})
```

- [ ] **Step 2：跑确认失败**

Run: `bun test tests/stream-accumulator-usage.test.ts`
Expected: FAIL（`cacheWriteTokens` 不存在）。

- [ ] **Step 3：改 chat accumulator**

`stream-accumulator.ts`：`OpenAIStreamAccumulator` 接口加 `cacheWriteTokens: number`、`inputDetails?: {...}`、`outputDetails?: {...}`；`createOpenAIStreamAccumulator` 初始化 `cacheWriteTokens: 0`；`accumulateOpenAIStreamEvent` 的 `if (parsed.usage)` 块内加（import `GhcPromptTokensDetails`/`GhcCompletionTokensDetails`/`nonNegOrUndef`）：
```ts
    const pd = parsed.usage.prompt_tokens_details as GhcPromptTokensDetails | undefined
    const cw = nonNegOrUndef(pd?.cache_write_tokens)
    if (cw !== undefined) acc.cacheWriteTokens = cw
    acc.inputDetails = { text: nonNegOrUndef(pd?.text_tokens), audio: nonNegOrUndef(pd?.audio_tokens), image: nonNegOrUndef(pd?.image_tokens), video: nonNegOrUndef(pd?.video_tokens) }
    const cd = parsed.usage.completion_tokens_details as GhcCompletionTokensDetails | undefined
    acc.outputDetails = { text: nonNegOrUndef(cd?.text_tokens), audio: nonNegOrUndef(cd?.audio_tokens), image: nonNegOrUndef(cd?.image_tokens), video: nonNegOrUndef(cd?.video_tokens), accepted_prediction_tokens: nonNegOrUndef(cd?.accepted_prediction_tokens), rejected_prediction_tokens: nonNegOrUndef(cd?.rejected_prediction_tokens) }
```

- [ ] **Step 4：改 responses accumulator（cache_write 在 input_tokens_details）**

`responses-stream-accumulator.ts`：接口加 `cacheWriteInputTokens: number` + `inputDetails?` + `outputDetails?`；初始化 0；`response.completed` 分支内加（读 `event.response.usage.input_tokens_details` 的 `cache_write_tokens` 及模态，`output_tokens_details` 的 prediction/模态）。字段位置见 spec §5.2 M3。

- [ ] **Step 5：跑测试 + typecheck**

Run: `bun test tests/stream-accumulator-usage.test.ts && bun run typecheck`
Expected: PASS。

- [ ] **Step 6：提交**

```bash
git add -- src/lib/openai/stream-accumulator.ts src/lib/openai/responses-stream-accumulator.ts tests/stream-accumulator-usage.test.ts
git commit -F <msg> -- src/lib/openai/stream-accumulator.ts src/lib/openai/responses-stream-accumulator.ts tests/stream-accumulator-usage.test.ts
# msg: "feat(stream): accumulators capture cache_write + modality/prediction details"
```

---

### Task 1.6：流式主写路径 `recording.ts:138/180`（H1）

**Files:**
- Modify: `src/lib/request/recording.ts:138`（`buildOpenAIResponseData`）+ `:180`（`buildResponsesResponseData`）
- Test: `tests/recording-usage.test.ts`（新）

- [ ] **Step 1：写测试（buildOpenAIResponseData 把 acc.cacheWriteTokens 送进 usage.cache_creation_input_tokens）**

```ts
import { expect, test } from "bun:test"
import { buildOpenAIResponseData } from "~/lib/request/recording"
import { createOpenAIStreamAccumulator } from "~/lib/openai/stream-accumulator"

test("buildOpenAIResponseData forwards cache_write to cache_creation", () => {
  const acc = createOpenAIStreamAccumulator()
  acc.inputTokens = 1000; acc.outputTokens = 50; acc.cachedTokens = 600; acc.cacheWriteTokens = 300
  const rd = buildOpenAIResponseData(acc, "gpt-5.5")
  expect(rd.usage.cache_creation_input_tokens).toBe(300)
  expect(rd.usage.input_tokens).toBe(100) // 子集分支
})
```

- [ ] **Step 2：跑确认失败**

Run: `bun test tests/recording-usage.test.ts` → FAIL。

- [ ] **Step 3：改 recording.ts:138 + :180**

`buildOpenAIResponseData` 的 `usage:` 改为传 `cacheCreation` + details：
```ts
    usage: usageFromTotalInput({ totalInput: acc.inputTokens, output: acc.outputTokens, cacheRead: acc.cachedTokens, cacheCreation: acc.cacheWriteTokens, reasoning: acc.reasoningTokens, inputDetails: acc.inputDetails, outputDetails: acc.outputDetails }),
```
`buildResponsesResponseData`（:180）同理，`cacheCreation: acc.cacheWriteInputTokens`。

- [ ] **Step 4：跑测试 + typecheck**

Run: `bun test tests/recording-usage.test.ts && bun run typecheck` → PASS。

- [ ] **Step 5：提交**

```bash
git add -- src/lib/request/recording.ts tests/recording-usage.test.ts
git commit -F <msg> -- src/lib/request/recording.ts tests/recording-usage.test.ts
# msg: "feat(recording): streaming main path carries cache_write to cache_creation"
```

---

### Task 1.7：穷举 handler 提取点（非流式 + 流式 abort/partial）（H2）

**Files:**
- Modify: `src/routes/chat-completions/handler-v4.ts`（:256/:378/:393）
- Modify: `src/routes/responses/handler-v4.ts`（:229/:398/:412）
- Modify: `src/routes/gemini/handler-v4.ts`（:216）
- Modify: `src/routes/responses/ws.ts`（:365/:380）
- Test: `tests/handler-usage-extraction.test.ts`（新，针对非流式 renderNonStreamingV4 可测部分）

- [ ] **Step 1：grep 穷举确认站点**

Run: `grep -rn 'usageFromTotalInput' src/routes/ src/lib/request/recording.ts`
Expected: 列出全部站点。逐一核对是否已在 Task 1.6 覆盖（recording 的 2 个）；其余为本 task。

- [ ] **Step 2：改非流式提取点（有 `usage?.prompt_tokens_details` 可读的）**

chat-completions `handler-v4.ts:256` 的 `usageFromTotalInput({...})` 加：
```ts
      cacheCreation: (usage?.prompt_tokens_details as GhcPromptTokensDetails | undefined)?.cache_write_tokens ?? undefined,
      inputDetails: { text: nonNegOrUndef((usage?.prompt_tokens_details as GhcPromptTokensDetails | undefined)?.text_tokens), /* audio/image/video 同 */ },
      outputDetails: { accepted_prediction_tokens: nonNegOrUndef((usage?.completion_tokens_details as GhcCompletionTokensDetails | undefined)?.accepted_prediction_tokens), /* … */ },
```
responses `handler-v4.ts:229` 读 `resp.usage?.input_tokens_details`（M3）；gemini `handler-v4.ts:216` 读 `prompt_tokens_details`。

- [ ] **Step 3：改流式 abort/partial 站点（:378/:393/:398/:412/ws:365/:380）**

这些从 accumulator 构建 partial usage。把 `cacheRead: acc.cachedTokens` 一行补 `cacheCreation: acc.cacheWriteTokens`（chat/gemini）或 `acc.cacheWriteInputTokens`（responses/ws），并透传 details。**每个站点都改，别漏**（richest-data-flow：中断流也留）。

- [ ] **Step 4：写非流式提取测试**

对 `renderNonStreamingV4` 的 usage 构建（可提取为纯函数测，或用现有非流式 handler 测试夹具）断言 cache_write→cache_creation。若难以隔离，至少加一个 `usageFromTotalInput` 调用参数快照测试。

- [ ] **Step 5：跑全测试 + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS。修任何因可选化/新字段引发的既有测试失败（读实际代码，别猜）。

- [ ] **Step 6：提交**

```bash
git add -- src/routes/chat-completions/handler-v4.ts src/routes/responses/handler-v4.ts src/routes/gemini/handler-v4.ts src/routes/responses/ws.ts tests/handler-usage-extraction.test.ts
git commit -F <msg> -- <上述路径>
# msg: "feat(handlers): extract cache_write + details at all usage sites (non-streaming + partial)"
```

---

### Task 1.8：G6 非流式 rawBody 补存

**Files:**
- Modify: 非流式 handler（`renderNonStreamingV4` 等）+ codec `renderResponseNonStreaming` 传递原始文本
- Test: `tests/nonstreaming-rawbody.test.ts`（新）

**背景：** `legFromUpstreamResponse`（`context/request.ts:149`）已把 `responseData.responseText → rawBody`。缺的是把 `upstream.nonStream` 的原始上游响应体文本透传到 `responseData.responseText`（现被解析后丢）。

- [ ] **Step 1：定位原始文本 seam**

Run: `grep -rn 'renderResponseNonStreaming\|nonStream' src/lib/codec/ src/lib/pipeline/`
读 `upstream.nonStream` 的类型：确认原始响应文本在何处可得（若 codec 只拿到已解析 JSON，需在 transport 层保留原始 text 并透传）。**若原始 text 在当前 seam 不可得，本 task 需在 transport/codec 增一个 `rawText` 字段透传**——读代码定位，别臆造。

- [ ] **Step 2：写测试（非流式 responseData 带 responseText）**

断言非流式路径构建的 `ResponseData.responseText` 等于原始上游 body 字符串（用夹具喂一个已知原始 JSON）。

- [ ] **Step 3：实现透传**

在 `renderNonStreamingV4` 的 `responseData` 加 `responseText: <原始上游 body 字符串>`。三腿（chat/responses/gemini）都做。

- [ ] **Step 4：跑测试 + typecheck**

Run: `bun test tests/nonstreaming-rawbody.test.ts && bun run typecheck` → PASS。

- [ ] **Step 5：提交**

```bash
git add -- <改动路径> tests/nonstreaming-rawbody.test.ts
git commit -F <msg> -- <路径>
# msg: "feat(history): capture raw upstream body into rawBody for non-streaming (G6)"
```

**Phase 1 完成判据：** `bun test` 全绿 + `bun run typecheck` 绿；新流式/非流式请求的 history entry 的 `usage.cache_creation_input_tokens` 在 cache-write 时非 0（Phase 3 用户实测验证）。

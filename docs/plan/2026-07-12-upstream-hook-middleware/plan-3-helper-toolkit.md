# Phase 3：helper 工具箱 ✅ 实施完成

> 依赖：Phase 0（`UpstreamHook` 类型 + `origin.ts` 的 `tagStream`/`rawStream`⚠️见下）。**可与 Phase 1/2 真并行**（评审 HIGH-1：`origin.ts` 已上移 Phase 0 Task 0.7，Phase 3 不再依赖 Phase 2）。产出：hook 文件从 `~/lib/pipeline/hooks` 导入的 helper 集。

> 注：`rawStream` 是本 Phase Task 3.1 建的 toolkit 内部函数；`tagStream`/`HOOK_ORIGIN` 来自 Phase 0 `origin.ts`。

**Interfaces produced（hook 作者 import 的公共面）**：

```ts
// src/lib/pipeline/hooks/index.ts —— barrel，hook 文件 import { … } from "~/lib/pipeline/hooks"
export function sse(event: string | undefined, dataObj: unknown): UpstreamFrame
export function streamOf(frames: Array<UpstreamFrame>, headers?: Headers): UpstreamStream  // tagged hook-mock
export function mockAnthropicMessage(text: string): UpstreamStream
export function mockCcChunks(text: string): UpstreamStream
export function mockGeminiResponse(text: string): UpstreamStream
export function mockUpstreamError(status: number, body?: unknown): never  // throws HTTPError
export namespace mockUpstreamError { export function toolFieldRejection(): never; export function serverToolRejection(): never; export function cacheControlSubfield(): never }
export function replayFromHistory(selector: string | { model?: string; endpoint?: string; latest?: boolean }): Promise<UpstreamStream>  // tagged hook-replay
export function delay(ms: number): <T>(s: T) => Promise<T>
export function truncateAfter(n: number, stream: UpstreamStream): UpstreamStream
```

---

## Task 3.1：`sse` + `streamOf` 积木

**Files:** Create `src/lib/pipeline/hooks/toolkit.ts`；Test `tests/pipeline/hooks/toolkit.unit.test.ts`。

```ts
export function sse(event: string | undefined, dataObj: unknown): UpstreamFrame {
  return { ...(event && { event }), data: typeof dataObj === "string" ? dataObj : JSON.stringify(dataObj) }
}
/** Internal: build an UpstreamStream from frames WITHOUT any hook-origin tag. */
export function rawStream(frames: Array<UpstreamFrame>, headers = new Headers()): UpstreamStream {
  async function* gen() { for (const f of frames) yield f }
  return { frames: gen(), headers }
}
/** Public: mock stream tagged hook-mock (so history/UI mark it synthetic). */
export function streamOf(frames: Array<UpstreamFrame>, headers = new Headers()): UpstreamStream {
  return tagStream(rawStream(frames, headers), "hook-mock")  // Phase 2 tagStream/HOOK_ORIGIN
}
```

- [ ] **Step 1：写失败测试** — `sse("message_start", {type:"message_start"})` → `{event, data:JSON}`；`streamOf([...])` 迭代产出帧 + 带 `HOOK_ORIGIN==="hook-mock"`（读 `readOrigin`）。
- [ ] **Step 2-4：跑失败 → 写 → 跑绿** → **Step 5：commit**。

## Task 3.2：格式 mock（Anthropic/CC/Gemini）+ 独立 oracle 校验

**Files:** Modify `toolkit.ts`；Test 同上（**独立 oracle**，勘探 D.2）。

`mockAnthropicMessage(text)` 产出合法 Anthropic SSE 序列（`message_start` → `content_block_start` → `content_block_delta`(text) → `content_block_stop` → `message_delta` → `message_stop`），每帧经 `sse(eventName, obj)`。CC/Gemini 同理产各自合法序列。

**独立 oracle（非自证，勘探 D.2）**：

```ts
// test：把 mockAnthropicMessage 的帧喂进 fresh accumulator，断言重建出 text
import { createAnthropicStreamAccumulator, accumulateAnthropicStreamEvent, getTextContent } from "~/lib/anthropic/stream-accumulator"
const acc = createAnthropicStreamAccumulator()
for await (const f of mockAnthropicMessage("hello").frames) accumulateAnthropicStreamEvent(parseFrame(f), acc)
expect(acc.sawMessageStop).toBe(true)
expect(getTextContent(acc)).toBe("hello")
```

- [ ] **Step 1：写失败 oracle 测试**（三格式各一，用对应 accumulator 工厂重建断言 text + sawMessageStop）。
- [ ] **Step 2-4：跑失败 → 写三个 mock → 跑绿**（oracle 证帧序列合法，非自比对）。
- [ ] **Step 5：commit**。

## Task 3.3：`mockUpstreamError` + reactive 策略预设

**Files:** Modify `toolkit.ts`；Test 同上 + Phase 5 集成实测。

**契约（评审 H3，勘探 D.1/D.3）**：产真 `HTTPError`，`body` 序列化进 `responseText`：

```ts
import { HTTPError } from "~/lib/error"
export function mockUpstreamError(status: number, body?: unknown): never {
  throw new HTTPError(`hook mock ${status}`, status, typeof body === "string" ? body : JSON.stringify(body ?? {}))
}
mockUpstreamError.toolFieldRejection = () =>
  mockUpstreamError(400, "tools.0.custom.eager_input_streaming: Extra inputs are not permitted")
mockUpstreamError.serverToolRejection = () =>
  mockUpstreamError(400, { error: { message: "The use of the web search tool is not supported.", code: "unsupported_value" } })
mockUpstreamError.cacheControlSubfield = () =>
  mockUpstreamError(400, "system.1.cache_control.ephemeral.scope: Extra inputs are not permitted")
mockUpstreamError.unsupportedBeta = () =>  // 评审 MEDIUM-2：spec §4.2 明列的第 4 个预设，正则 BETA_ERROR_PATTERN 存在
  mockUpstreamError(400, "unsupported beta header(s): interleaved-thinking-2025-05-14")
```

> 4 个预设对应 4 条真实 reactive 学习腿（spec §4.2）：`toolFieldRejection`/`serverToolRejection`/`cacheControlSubfield`/`unsupportedBeta`（后者命中 `src/lib/request/strategies/unsupported-beta-retry.ts` 的 `BETA_ERROR_PATTERN = /unsupported beta header\(s\)|invalid beta flag/i`）。namespace 声明须同步补 `unsupportedBeta(): never`。

- [ ] **Step 1：写失败测试** — `mockUpstreamError(400, {...})` 抛 `HTTPError`、`.status===400`、`.responseText` 含 body；预设的 responseText 匹配各策略正则（用勘探 D.3 的正则直接断言 `TOOL_FIELD_EXTRA_INPUTS.test(err.responseText)===true`）。
- [ ] **Step 2-4：跑失败 → 写 → 跑绿**（策略真触发在 Phase 5 端到端实测，此处只证 responseText 命中正则）。
- [ ] **Step 5：commit**。

## Task 3.4：`replayFromHistory`（格式分层，评审 H4）

**Files:** Modify `toolkit.ts`；Test 同上。

**H4 保真分层**（勘探 C.2 + spec §5）：history `raw` 只存 data 负载、`type` 对无 event 帧伪造成 `"message"`：
- Anthropic：`{ event: rec.type, data: rec.raw }`（`type` 是真 event 名，无损）。
- CC/Gemini：伪造标签（`type==="message"` 且原 chunk 无 event）→ `{ data: rec.raw }`（**不写 event 行**）。

```ts
export async function replayFromHistory(selector): Promise<UpstreamStream> {
  const entry = await findHistoryEntry(selector)  // 查 history（用 ~/lib/history 读 API）
  const recs = entry.attempts.at(-1)?.upstreamResponse?.sseEvents ?? []
  const isAnthropic = entry.clientResponse?.format === "anthropic" || /* endpoint 判断 */ ...
  const frames = recs
    .filter((r) => !r.synthetic)  // 真实上游帧（上游轨本无 synthetic，防御性）
    .map((r) => isAnthropic ? { event: r.type, data: r.raw } : { data: r.raw })
  return tagStream(rawStream(frames, rebuildHeaders(entry)), "hook-replay")  // rawStream from Task 3.1
}
```

> `findHistoryEntry(selector)` / `rebuildHeaders(entry)` 是本 helper 内部辅助——**执行第一步先查 `~/lib/history` 现有读 API 的确切签名**（如按 reqId 读 entry 的函数），据实接线；勘探报告未覆盖 history 读 API，故此处标为执行时确认点（非 placeholder，是明确的接线任务）。

- [ ] **Step 1：写失败测试** — 造一条含 Anthropic sseEvents 的假 history entry → `replayFromHistory` 产出带 `event` 行的帧、`HOOK_ORIGIN==="hook-replay"`；造 CC entry（`type:"message"` 无 event）→ 产出**不含** `event` 行。
- [ ] **Step 2-4：跑失败 → 写（含 history 查询接线，用 `~/lib/history` 现有读 API）→ 跑绿**。
- [ ] **Step 5：commit**。

## Task 3.5：`delay` / `truncateAfter` + barrel 导出

**Files:** Modify `toolkit.ts`；Create `src/lib/pipeline/hooks/index.ts`（barrel re-export toolkit + loader 公共面）；Test 同上。

```ts
export function delay(ms: number) { return async <T>(s: T): Promise<T> => { await Bun.sleep(ms); return s } }
export function truncateAfter(n: number, stream: UpstreamStream): UpstreamStream {
  async function* gen() { let i = 0; for await (const f of stream.frames) { if (i++ >= n) return; yield f } }
  return { ...stream, frames: gen() }
}
```

- [ ] **Step 1：写失败测试** — `truncateAfter(2, streamOf([a,b,c]))` 只产 2 帧；`delay(10)` 包装可 await。barrel `import { mockUpstreamError, replayFromHistory } from "~/lib/pipeline/hooks"` 可解析。
- [ ] **Step 2-4：跑失败 → 写 + barrel → 跑绿 + typecheck**。
- [ ] **Step 5：写 hook 作者文档（评审 LOW-3）** — 建 `src/lib/pipeline/hooks/README.md`（或 barrel 顶部 JSDoc），显式写两条 spec 要求的警告：① `onExchange` 被调 **L1×L2 次**（同一客户端请求内多次，spec §3.2），有状态 hook 须知；② 不调 `next` 的 mock 流**绕过** `guardSseIterable`（idle/shutdown/client-abort 守卫）+ rate-limiter（spec §4.2），要测超时/断流须自行在 raw 逃生口构造。commit。

**Phase 3 出口验收**：全 helper 单测绿（格式 mock 经独立 accumulator oracle 校验、mockUpstreamError 命中策略正则）；barrel 从 `~/lib/pipeline/hooks` 可导入；`typecheck` 绿。

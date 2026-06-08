# 设计：自动 decode tool_use input 中的 stringified JSON 字段

## 背景与根因

上游模型在生成 tool_use（如 `AskUserQuestion`）时，**偶发**地把本应是 array/object 的参数序列化成 JSON 字符串塞进 input：

```json
{ "type":"tool_use", "name":"AskUserQuestion",
  "input": { "questions": "[{\"header\":\"...\",\"options\":[...]}]" } }
```

正常应为 `"questions": [{...}]`（array）。客户端 `JSON.parse(input)` 后 `input.questions` 是 string，无法被 harness 正常消费。

证据已坐实（history sseEvents 原始 partial_json）：copilot-api **不**改写格式，畸形来自上游模型偶发。

## 目标与边界（方案 C）

- **只在响应侧 decode**：上游 tool_use 的 input 顶层字段是 stringified JSON 时，decode 成 object/array 再**转发给客户端**。
- **history 保持忠实**：`sseEvents`（上游原始事件）+ accumulated response（用于 history 的 `response.content`）**都不改**，保留 stringified 形态以暴露问题。
- **前端展示层独立 decode**：history UI 的 ToolUseBlock 在渲染时 decode，便于查看；不改 store 数据。
- **不做请求侧 sanitize 防御**：历史里的畸形已在响应侧被修过，理论上不会再进下一轮请求。

## 配置项（均在 `anthropic` section）

| config.yaml | state 字段 | 类型 | bundled 默认 |
|---|---|---|---|
| `anthropic.decode_tool_input_fields` | `decodeToolInputFields` | `Record<string, Array<string>>`（工具名 → 顶层字段名列表） | `{ AskUserQuestion: ["questions"] }` |
| `anthropic.decode_all_tool_input_fields` | `decodeAllToolInputFields` | `boolean` | `false` |

- 精确映射复用现有 `Record<string,Array<string>>` 形状（同 `efforts_overrides`/`strip_beta_headers`）。
- merge 策略：**per-key**（注册到 `RECORD_MERGE_STRATEGIES`），让用户在 bundled 默认上叠加，而非整表替换。
  - 注意：现有 efforts/strip_beta/reject 都是 "replace"（默认）。本字段选 per-key 是因为 bundled 提供 AskUserQuestion 默认，用户通常只想**追加**别的工具，不想被迫重写 AskUserQuestion。与 `model_overrides` 同理。
- hot-reload：retain-on-absence（同其他 anthropic record 字段）。
- 通用开关 on 时，精确映射成为子集，无冲突；通用开关是「所有工具的所有顶层字段」。

## 核心纯函数

新建 `src/lib/anthropic/decode-tool-input.ts`：

```ts
/** 迭代解析可能被多次序列化的 JSON 字符串；仅当结果是 object/array 才算成功 */
function tryDecodeJsonString(value: string): unknown | undefined {
  let parsed: unknown = value
  let didParse = false
  while (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) } catch { return didParse ? parsed_if_obj : undefined }
    didParse = true
  }
  return (typeof parsed === "object" && parsed !== null) ? parsed : undefined
}

/**
 * 按 config 决定目标字段，对 input 顶层 string 字段尝试 decode。
 * - input 非 plain object → 原样返回（含 null/array/string）
 * - 字段值非 string、或 decode 失败、或结果非 object/array → 保留原值
 * - 有改动 → 返回**新对象**；无改动 → 返回原引用（caller 可用 === 判断 modified）
 */
export function decodeToolUseInput(
  name: string,
  input: unknown,
  cfg: { fields: Record<string, Array<string>>; all: boolean },
): unknown
```

字段选择：
- `cfg.all` → input 的所有 own enumerable 顶层 key
- 否则 → `cfg.fields[name] ?? []`（工具不在 map → 空 → 不处理）

**关键安全语义**：decode 失败或结果是标量 → **保留原始字符串**（绝不清空、绝不破坏本应是字符串的字段）。这与现有 `parseStringifiedInput`（失败返回 `{}`，针对整个 input）不同——字段级失败必须无损。

## 后端响应侧接入

### 非流式（易）

`handleDirectAnthropicNonStreamingResponse`（handler.ts:714）：

```
reqCtx.complete({ ...content: response.content })   // 不变：history 存原始 stringified
...
finalResponse = filterServerToolBlocksFromResponse(finalResponse)
finalResponse = decodeToolInputBlocksInResponse(finalResponse)  // 新增：只改返回客户端的副本
return c.json(finalResponse)
```

`decodeToolInputBlocksInResponse(resp)`：遍历 `resp.content`，对 `type==="tool_use"` 的 block 调 `decodeToolUseInput`，有改动则替换 block（immutable）。

### 流式（核心难点）

上游对一个 tool_use block 发：`content_block_start{input:{}}` → N×`content_block_delta{input_json_delta, partial_json}` → `content_block_stop`。客户端拼接 partial_json 后 parse。要 decode 必须等完整 JSON。

**策略：对「需要 decode 的 tool_use block」缓冲 input deltas，stop 时重写。**

新建 stateful `createToolInputStreamDecoder()`，接口与 serverToolFilter 并列但「一进可多出」：

```ts
processEvent(parsed, raw): Array<ServerSentEventMessage>   // 返回要转发的事件序列（0/1/多个）
```

逻辑：
- `content_block_start`：
  - 若 `block.type==="tool_use"` 且 `shouldDecode(name)`（name 在 map 或 all 开启）→ 标记该 index 为「缓冲中」，记录 name，**转发** start 原样（input 仍是 `{}`）。
  - 否则透传。
- `content_block_delta`（input_json_delta）：
  - 若该 index 缓冲中 → 累积 `partial_json`，同时保存原始 raw 事件，**返回 `[]`（suppress）**。
  - 否则透传。
- `content_block_stop`：
  - 若该 index 缓冲中 →
    - 拼接完整 `partial_json` 字符串，`JSON.parse`：
      - **成功** → `decodeToolUseInput(name, obj)` → 重新 `JSON.stringify` → 返回 `[ delta{input_json_delta, partial_json: 新JSON}, stop ]`（用原 index）。
      - **失败**（上游中断/畸形）→ **fallback**：返回 `[...缓冲的原始 deltas, stop]`（原样重放，无损，保留现有 safeParseJson 容错）。
    - 清理该 index 缓冲状态。
  - 否则透传。
- 其他事件（message_*, ping, error, text/thinking deltas）：透传。

handler `processOneStreamEvent` 改动：
```
// sseEvents 记录上游原始 parsed —— 不变，保持忠实（在 decoder 之前）
if (parsed) sseEvents.push({...})
...
// 先过 input decoder（可能 0/1/多个），再每个过 serverToolFilter
const decodedEvents = toolInputDecoder.processEvent(parsed, rawEvent)
for (const ev of decodedEvents) {
  const evParsed = safeParse(ev.data)
  const forwardData = serverToolFilter.rewriteEvent(evParsed, ev.data ?? "")
  if (forwardData === null) continue
  await stream.writeSSE({ data: forwardData, event: ev.event, id, retry })
}
```

**协作顺序**：decoder 在前、serverToolFilter 在后。
- decoder 只处理普通 `tool_use`（非 server_tool_use），与 serverToolFilter 处理的 server tool 互斥，无重叠。
- decoder 用**原 index** 吐事件，serverToolFilter 的 index 重映射只依赖 content_block_start 建立映射、delta/stop 沿用——decoder 吐的新 delta 用原 index，serverToolFilter 正确映射。✓
- decoder 缓冲期 suppress deltas，但 serverToolFilter 对这些 index 的映射在 start 时已建立；stop 时 decoder 吐 delta+stop，serverToolFilter 正常处理。✓

**零开销/零风险**：非目标 block（绝大多数）decoder 直接透传，不缓冲、不解析。风险局限在 AskUserQuestion 等已配置工具。

**accumulator 不变**：accumulator 累积上游原始 partial_json（stringified），buildAnthropicResponseData → history `response.content` 保持 stringified（忠实）。decoder 只改转发流。✓

## 前端展示层 decode

`ui/src/components/message/ToolUseBlock.vue`：纯展示层 decode，不改 store。

- 新增 computed `displayInput`：对 `props.block.input`，若是 object，对其顶层 string 字段尝试 `JSON.parse`（结果为 object/array 才替换），产生展示用副本。
- `VueJsonPretty :data="displayInput"`、`isObjectInput`、`inputJson`(copy) 基于 displayInput。
- 前端 decode 无需 config（展示层尽量友好），对**所有**顶层 string 字段尝试（与后端 all 模式同逻辑，但仅影响渲染）。
- 保留 `_parseError` 分支不变。

抽出共享纯逻辑 `tryDecodeJsonString` 到前端可用位置？后端在 `src/lib/anthropic/`，前端 `~backend/*` 可 re-export。但该函数无副作用、极小——可在前端 `ui/src/utils/` 复制一个等价实现，或从后端 re-export。**倾向 re-export**（单一来源），路径 `~backend/lib/anthropic/decode-tool-input`。需确认该后端文件不引入 node-only 依赖（纯 JS，安全）。

## 测试

1. `tests/unit/decode-tool-input.test.ts`（新）：纯函数
   - 精确字段命中 / 未命中工具 / all 模式
   - double-serialized 字符串
   - 非 JSON 字符串字段 → 保留原值
   - 解析为标量（`"123"`、`"\"x\""`）→ 保留原值
   - input 非 object（null/array/string）→ 原样
   - 无改动返回原引用
2. `tests/unit/...` 流式 decoder：
   - 目标 block：start + 多 delta + stop → 输出 start + 单 delta(decoded) + stop
   - 非目标 block：完全透传
   - parse 失败 → fallback 原样重放
   - 与 serverToolFilter 串联的 index 一致性（component 级）
3. 非流式 helper：response.content 中 tool_use decode
4. **`tests/component/config-hot-reload.test.ts`**：FIELDS 矩阵登记两个新字段（否则完整性守卫 fail）
   - `decode_tool_input_fields`（record，per-key）
   - `decode_all_tool_input_fields`（boolean）
5. `ui/vitest/` ToolUseBlock：stringified 字段渲染为展开 JSON 树

## 涉及文件清单

后端：
- `src/lib/config/schema.ts`：`AnthropicConfigSchema` +2 字段；注册 per-key merge
- `src/lib/state.ts`：State +2 readonly 字段；`setAnthropicBehavior` keys +2；`CONFIG_MANAGED_DEFAULTS` +2；`resetConfigManagedState` +2；clone 处理
- `src/lib/config/config.ts`：`applyConfigToState` apply +2
- `src/lib/anthropic/decode-tool-input.ts`（新）：纯函数 + 流式 decoder + 非流式 helper
- `src/routes/messages/handler.ts`：流式 pump 接入 decoder；非流式接入
- `config.yaml`（bundled）：写入默认 `decode_tool_input_fields: { AskUserQuestion: [questions] }` + `decode_all_tool_input_fields: false`
- `docs/DESIGN.md`：运行时选项表 +2 行

前端：
- `ui/src/components/message/ToolUseBlock.vue`：displayInput computed

测试：上述 5 项。

## 风险与权衡

1. **流式 delta 粒度改变**（多 delta → 单 delta）：对 tool_use 无害（客户端 stop 前不用 input）。已记录。
2. **流式时序**：目标 block 的 input 在 stop 时一次性到达，而非增量。AskUserQuestion 等无流式渲染需求，可接受。
3. **per-key vs replace merge**：选 per-key 以保护 bundled AskUserQuestion 默认。用户若要完全清空需 `resetConfigManagedState`（PUT /api/config）或显式覆盖。
4. **前端 decode 无 config**：展示层对所有 string 字段尝试，可能把「本应是 JSON 文本的字符串」也展开——但仅影响 history 查看，无副作用，且更友好。
5. **未覆盖 server_tool_use**：聚焦 tool_use（AskUserQuestion 是 tool_use）。server_tool_use 的 input 字段级 decode 暂不做。

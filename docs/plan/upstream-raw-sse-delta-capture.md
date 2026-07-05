# 完整记录上游原始 SSE delta —— 补上诊断盲区

## Context（为什么做这个改动）

本会话反复出现客户端报 `Your tool call was malformed and could not be parsed`,但 copilot-api 侧 History 里这些请求全部 `status=completed`、`stop_reason=tool_use`、有正常 `output_tokens`。为定位「是上游返回问题还是代理问题」,深入代码后发现一个**诊断盲区**:

- **史料缺失（根因）**:[handler.ts:636](src/routes/messages/handler.ts#L636) 记录 `sseEvents` 时**有意排除 `content_block_delta`**(注释写 "Record non-delta SSE events")。而 `content_block_delta` 正是承载 `input_json_delta`(tool 参数)、`thinking_delta`、`text_delta`、`signature_delta` 的唯一载体。
- 后果:History 里 `response.content` 是 accumulator 三层加工的**衍生品**(累积 → `mapAnthropicContentBlocks` → `safeParseJson`),不能反映「上游逐个 delta 发了什么」「客户端实际收到什么字节」。面对实测异常(某 entry `thinking:""` + tool_use `input:{}` 却有 201 output_tokens)无法定论。
- 这违反项目 **CLAUDE.md 原则3**:「History 系统应记录请求/响应生命周期中所有可观测的原始数据,不主动丢弃任何可能有诊断价值的信息。前端展示可以选择性呈现,但后端存储必须完整。」

**目标**:后端完整记录上游原始 delta(可观测史料完整),前端选择性呈现(避免刷屏)。下次再现 malformed 时即可凭 delta 原文一锥定音。

## 范围确认

- `sseEvents.push` 仅存在于 anthropic 的 [src/routes/messages/handler.ts](src/routes/messages/handler.ts) 一处;OpenAI chat-completions / responses 路径不记录原始 SSE,本次**不涉及**。
- 类型层([SseEventRecord](src/lib/history/types.ts#L118))与存储层(serialize/sqlite)早已支持任意 `type`,无需改动——[history-store.test.ts:763](tests/component/history-store.test.ts#L763) 已用 `content_block_delta` 测过存储。
- 无测试锁死「handler 排除 delta」的旧行为,去掉排除不破坏现有测试。

## 实施

### 1. 后端：完整记录（核心，遵循原则3，不加开关）

[src/routes/messages/handler.ts:635-642](src/routes/messages/handler.ts#L635) `processOneStreamEvent` 内:

- 去掉对 `content_block_delta` 的排除,仅保留排除 `ping`(纯 keepalive 噪音,无诊断价值)。
- 同步修正注释:由「Record non-delta SSE events for history debugging」改为说明「记录除 ping keepalive 外的全部原始 event,含 delta —— 诊断 tool_use input / thinking 内容完整性的唯一原始史料(原则3)」。

```ts
// 改后（示意）
if (parsed && parsed.type !== "ping") {
  sseEvents.push({ offsetMs: Date.now() - streamState.streamStartMs, type: parsed.type, data: parsed })
}
```

体积说明:delta 数量多,但 `blob_gz` 为 gzip,重复的 `input_json_delta` 分片压缩率高;`history.limit` reaper 行数上限不变。遵循原则3 默认完整记录,不引入 config 开关(若未来体积成为实测问题再议)。

### 2. 前端：选择性呈现（配套，原则3「前端可选择性呈现」）

[ui/src/components/detail/SseEventsSection.vue](ui/src/components/detail/SseEventsSection.vue) 目前 `eventSummary` / `eventColor` **未处理 `content_block_delta`**,加 delta 后会出现大量无摘要裸行。最小适配:

- `eventSummary` 增加 `content_block_delta` 分支:读 `data.delta.type`,按类型给出有诊断价值的摘要片段——
  - `input_json_delta` → `partial_json` 片段(tool 参数,最关键)
  - `text_delta` → `text` 片段
  - `thinking_delta` → `thinking` 片段
  - `signature_delta` → `signature(N chars)` 标记
- `eventColor` 给 `content_block_delta` 一个低调色(如复用 `dim`/`default`),避免在大量 delta 下视觉噪音。
- 该 section 已 `:default-collapsed="true"`,默认折叠即可缓解刷屏;`useTocTree` 的 `sseEvents (N)` 数量变大属真实信息,不改。

聚合连续 delta 折叠为可选增强,本次不做(保持简单,KISS)。

## 验证

仅修改了 `.ts` / `.vue` 可执行文件,需运行验证(原则9):

- 后端:`bun run typecheck` + `bun run lint:all` + `bun test`(重点 `tests/component/history-store.test.ts`、`tests/component/request-context.test.ts`)
- 前端:`bun run typecheck:ui` + `bun run test:ui`
- 端到端(由用户启动服务器,**不自动启动**,原则7):触发一次含 tool_use 的 `/v1/messages` 请求 → 在 UI 详情页 "SSE Events" 区应看到 `content_block_delta` 行,且 `input_json_delta` 摘要展示 `partial_json` 内容;或直接查 `~/.local/share/copilot-api/history.db` 新 entry 的 `sseEvents` 含 delta 序列。
- 复现验证:下次再出现 malformed 时,对照该 entry 的 delta 原文即可判定 tool_use `input` 是否在上游就为空 → 最终区分上游 vs 代理。

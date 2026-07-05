# 空 thinking block 400 修复 + History 转发态记录 + 命名对齐重构

> **实施状态：已完成**
> **落地**：—
> **现状锚点**：运行时选项 `thinkingBlockSanitizeCheck`；`src/lib/history/sqlite/schema.ts` 四腿命名
> **备注**：三阶段全落地；config 键落地为 thinking_block_sanitize（去 _check 后缀），能力等价

## Context

**触发问题**：客户端（Claude Code）回传 `{type:"thinking", thinking:"", signature:""}` 双空 thinking block，sanitize 管道原样透传给上游 → `HTTP 400: messages.N.content.0.thinking: each thinking block must contain thinking`。

**根因诊断（已实测确认）**：
- history 记录的是**入站原始 payload**（`originalSnapshot`，request.ts 之前），证明双空块是客户端发来的。
- 加密 thinking（`thinking:""` + **有效 signature**）是上游正常行为；正常对话 signature 链完整（4142 实例 _12→_28 每轮 upSigLen 精确出现在下一轮入站）。
- 失败块是 signature **也为空**（双空）。来源是某轮响应转发，但流式转发链（`toolInputDecoder`/`serverToolFilter`/`forwardToClient`）经完整静态审计**不丢 signature_delta**——故无法仅凭现有 history 定位仓库代码确切故障点。
- **诊断盲区**：`reqCtx.complete()` 记录的是上游原始响应（在工具名还原/decode 之前）；**proxy→client 转发态完全没记录**。要看到"客户端实际收到的 thinking 是否缺 signature"，必须新增转发态记录。

**两条主线**：
1. **止血**：sanitize 管道增加"移除损坏空 thinking block"的 pass（不论 signature 为什么丢，双空块都不该发给上游）。
2. **补全 history 原始数据 + 架构对称**：新增 proxy→client 转发态记录（诊断工具）、sseEvents 改存 raw（字节完整）、补全 keepalive 时序、命名对齐。

**已确认决策**：分阶段（阶段1 先止血）；阶段2 覆盖全部 endpoint；阶段3 用 `entries_v2` 新表（不管旧数据）。

---

## 阶段 1（P0 止血）：空 thinking sanitize pass + 配置项

新增配置 `anthropic.thinking_block_sanitize_check`: `false | "empty_thinking" | "empty_any"`，默认 `"empty_thinking"`。

### 关键修正（务必遵守）
`hasThinkingSignatureBlocks`（thinking-immutability.ts:12）**不校验 signature 有效性**——双空块会让消息 `shouldPreserveThinkingBlocks → true`。因此新 pass **必须逐块判断**（只删 `thinking.trim()===""` 的 thinking 块），**不能复用 `shouldPreserveThinkingBlocks` 整条守卫**，否则空块永远删不掉。非空 thinking 块（含有效签名）天然不命中删除条件，签名链不受影响。

### 文件清单
- **`src/lib/config/schema.ts`**（AnthropicConfigSchema ~142，dedup_tool_calls 旁）：显式 union（不能用 nullableEnum，值混 boolean+string）：
  ```ts
  thinking_block_sanitize_check: z
    .union([z.literal(false), z.literal("empty_thinking"), z.literal("empty_any"), z.null()],
      { error: "Must be one of: false, empty_thinking, empty_any" })
    .optional().transform((v) => v ?? undefined),
  ```
- **`src/lib/state.ts`**（三处）：MutableState 接口加 `readonly thinkingBlockSanitizeCheck`；`setAnthropicBehavior` Pick union(605) 加该键；`CONFIG_MANAGED_DEFAULTS`(764) 加 `thinkingBlockSanitizeCheck: "empty_thinking"`，resetConfigManagedState 块(810) 补该键。
- **`src/lib/config/config.ts`**（applyConfigToState ~398）：`if (a.thinking_block_sanitize_check !== undefined) setAnthropicBehavior({ thinkingBlockSanitizeCheck: a.thinking_block_sanitize_check })`
- **`src/lib/anthropic/sanitize/content-blocks.ts`**：新增 `filterEmptyThinkingBlocks(messages)`（逐块过滤 `thinking.trim()===""`，参考 filterEmptyAnthropicTextBlocks:13 但**不带守卫短路**）。
- **`src/lib/anthropic/sanitize/result.ts`**（finalizeAnthropicSanitization line 30 前）：按 `state.thinkingBlockSanitizeCheck` 开关，在 `filterEmptyAnthropicTextBlocks` 前先跑 `filterEmptyThinkingBlocks`。`totalBlocksRemoved`(32) 基于 countAnthropicContentBlocks 自动计入。`"empty_any"` 当前与 `"empty_thinking"` 行为等价（空 text 本就常驻过滤），差异语义留作扩展位。
- **测试**：`tests/config/config-hot-reload.it.test.ts` FIELDS(237-250 旁) 加 FieldSpec（configKey `anthropic.thinking_block_sanitize_check`, stateKey `thinkingBlockSanitizeCheck`, sampleYamlValue `empty_any`）；新增 sanitize unit 测试（`tests/anthropic/` 下，参考既有 sanitize 测试）：双空块被删 / 非空 thinking（有 signature）保留 / 混合消息只删空块 / `false` 时保留。
- **yaml**：`config.yaml:204`、`config.example.yaml:230` 旁加注释字段。

### 验证
`bun run typecheck` → `bun run test:backend`（含 hot-reload + 新 unit）→ 构造双空 thinking 请求确认不再 400，`false` 开关复现 400。**阶段1 不触碰 history/前端，独立可合并止血。**

---

## 阶段 2：响应转发态 + sseEvents raw + keepalive（全 endpoint）

### 数据结构（HistoryEntry 顶层新增）
```ts
forwardedResponse?: {
  content?: MessageContent | null     // 非流式：改写后真正返回 client 的 content
  sseEvents?: Array<SseEventRecord>   // 流式：转发给 client 的 SSE 序列（已经 filter/decode 改写）
}
```
- **独立顶层字段**，不塞进 `response`（语义是上游响应）。blob catch-all 使持久化零成本。
- 上游原始流仍存 `entry.sseEvents`（不动）；转发态存 `entry.forwardedResponse.sseEvents`。两者并存 = "上游发了什么 vs 客户端收到什么"对照视图，正是诊断本类 bug 的核心。

### SseEventRecord 改 raw（types.ts:114）
```ts
export interface SseEventRecord {
  offsetMs: number
  type: string   // parsed?.type ?? rawEvent.event ?? "keepalive"，供索引/着色/summary
  raw: string    // 原始 SSE data 字节；keepalive/parse 失败也能存（rawEvent.data ?? ""）
}
```
统一字节完整性，消除当前"parsed 存对象、keepalive 丢失"的不一致。**注**：阶段1前已在 handler.ts processOneStreamEvent 加了 keepalive 记录（`{type, data}` 形态），阶段2 此处统一重写为 raw 形态。

### 捕获时机（硬约束：必须在 `complete/fail` 之前 set，因 complete 内部即 emit + toHistoryEntry）
- **RequestContext**（context/types.ts + request.ts）：加 `forwardedResponse` getter + `setForwardedResponse()`；HistoryEntryData 加字段；toHistoryEntry(356) 输出。
- **非流式**（messages/handler.ts:811）：当前 complete(817) → 改写(838-852) → c.json(854)。将改写计算上移到 complete 之前 → `setForwardedResponse({content: finalResponse.content})` → `complete(上游 responseData)` → `c.json(finalResponse)`。
- **流式**（messages/handler.ts forwardToClient:792 / processOneStreamEvent:693）：在 `writeSSE`(802) 前把最终 `forwardData`（字符串）push 进 `forwardedSseEvents`；`forwardData===null`（suppress）跳过——只记真正发出的帧。数组经参数透传（同 sseEvents:680 透传方式）。流结束在 `setSseEvents`(623) 旁 `setForwardedResponse({sseEvents: forwardedSseEvents})`。

### 全 endpoint 覆盖（模式一次，逐个适配）
模式：每个 endpoint 在其"转发给 client"等价点收集 forwardedSseEvents（流式）/ 改写后 content（非流式），在 `complete/fail` 前 `setForwardedResponse`。先 `grep -rn "setSseEvents\|writeSSE\|c.json" src/routes` 定位各点：
- `src/routes/messages/handler.ts`（anthropic，主路径）
- `src/routes/chat-completions/handler.ts`
- `src/routes/responses/handler.ts` + `responses/ws.ts` + `responses/fallback.ts`
- gemini 路由（`grep` 定位）

### 前端
- `ui/src/components/detail/SseEventsSection.vue`（eventSummary 19-74）：改 `JSON.parse(event.raw)`（try-catch 回退）。
- 新增转发态展示区（对照 entry.sseEvents 与 entry.forwardedResponse.sseEvents）——详情面板加 section，复用 SseEventsSection。

### 验证
`bun run typecheck` + `npm run typecheck:ui` → `bun run test:backend`（context/request + serialize round-trip 确认 forwardedResponse 进出 blob）→ **复现诊断**：部署到测试实例（4142），用 Claude Code 发带 thinking 的请求，对照 `forwardedResponse.sseEvents` 是否含 signature_delta，**定位仓库代码确切故障点**（todo：阶段2 部署后即可完成根因定位）。

---

## 阶段 3：命名对齐 + entries_v2 新表

### 命名方案（对齐 httpHeaders 已有的 inbound/outbound 四段术语）
| 当前 | 概念 | 新名 |
|------|------|------|
| `request` | client→proxy 原始 | `inboundRequest` |
| `effectiveRequest` | sanitized 中间态（不在传输轴）| **保留** |
| `wireRequest` | proxy→upstream | `outboundRequest` |
| `response` | upstream→proxy | `outboundResponse` |
| `forwardedResponse`(阶段2) | proxy→client | `inboundResponse` |

### entries_v2 新表（不管旧数据）
- **`src/lib/history/sqlite/schema.ts`**：表名 `entries` → `entries_v2`（新 schema + 新字段名）。索引同步改名。
- **`src/lib/history/sqlite/connection.ts`**：建表/migrate helper 指向 `entries_v2`。旧 `entries` 表保留不读（数据废弃，无兼容映射、无 deserialize 旧→新 key shim——这是用户决策，简化实现）。
- **`write.ts`/`read.ts`**：INSERT/SELECT 的表名 + 列引用同步。`querySummaries` 显式列清单、`rowToSummary` 字面量同步。

### 降破坏决策
- **区分运行时 API vs 持久化 schema**：只重命名 HistoryEntry 输出键 + 前端读取；RequestContext 运行时 getter（`ctx.response` 等）保留旧名，handler/pipeline 几乎不动。
- **EntrySummary 扁平字段不变**（`requestModel`/`responseModel` 已是语义名），列表页零改动。

### 前端（详情面板 ~4 文件）
- `DetailRequestSection.vue:46,52,53` `entry.request`→`entry.inboundRequest`
- `DetailPanel.vue:152,154` `entry.wireRequest`→`outboundRequest`、`entry.response`→`outboundResponse`
- `DetailResponseSection.vue:21-33` `entry.response`→`entry.outboundResponse`
- `entry.forwardedResponse`→`entry.inboundResponse`（阶段2 展示区同步）
- `ui/src/types/index.ts`：re-export 不变（类型名跟后端）。

### 验证
`bun run typecheck` + `npm run typecheck:ui`（TS 报出所有漏改 entry.xxx）→ `bun run test:backend`（serialize round-trip）→ 新表 + 新代码打开 UI 确认详情页正常；旧 DB 打开确认不崩（新表为空，旧表不读）。

---

## 全局收尾
- 每阶段完成后 **subagent review**（executor + 独立 verifier），主线再亲自复核 reviewer 的关键断言（原则6）。
- flaky/时序相关测试连跑 10–25 次确认确定性。
- 阶段2 部署后复现，定位仓库代码 signature 丢失确切路径并文档化（若确认是上游行为而非我方 bug，写入 DESIGN/排查文档）。

## 关键文件总览
- 止血：`sanitize/content-blocks.ts`、`sanitize/result.ts`、`config/schema.ts`、`state.ts`、`config/config.ts`
- 转发态：`context/request.ts`、`context/types.ts`、`history/types.ts`、各 endpoint `routes/*/handler.ts`、`ui/.../SseEventsSection.vue`
- 重构：`history/sqlite/{schema,connection,write,read,serialize}.ts`、前端详情面板 4 文件

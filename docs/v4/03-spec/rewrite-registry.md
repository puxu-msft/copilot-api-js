# 03-spec — Rewrite Registry（请求/响应改写流水线）

把现状 40+ 改写动作（[../02-current-state.md](../02-current-state.md) §2/§3）从"handler 内联 + 注释维系顺序"重组为"命名、可插拔、registry 声明顺序"的 transform 链。

---

## 1. 接口

```ts
// ── 请求侧（S3）──
interface RequestRewrite {
  readonly name: string                         // 唯一名，进 history sanitization 诊断
  readonly order: number                        // 装配排序键（声明顺序契约）
  appliesTo(env: RequestEnvelope): boolean       // format + config(state) + 上下文 gate
  apply(env: RequestEnvelope): RewriteResult
}
interface RewriteResult {
  env: RequestEnvelope                           // 不可变更新后的 envelope
  changed: boolean                               // 是否实际改动（false → 诊断不记）
  stats?: Record<string, number>                 // 如 {orphansRemoved: 2, remindersStripped: 1}
}

// ── 响应侧（S5）──
interface ResponseRewrite {
  readonly name: string
  readonly order: number
  appliesTo(env: RequestEnvelope): boolean
  /** 逐帧 transform；可 emit/replace/suppress/buffer（累积后 flush） */
  transform(frame: UpstreamFrame, state: RewriteState): FrameAction
  /** 流结束时 flush 缓冲（如 tool-input decoder 在 content_block_stop 重写） */
  flush?(state: RewriteState): UpstreamFrame[]
}
type FrameAction =
  | { kind: "emit"; frames: UpstreamFrame[] }    // 替换为 0+ 帧（含原样透传 = [frame]）
  | { kind: "suppress" }                          // 抑制该帧（如 server-tool 过滤）
  | { kind: "buffer" }                            // 缓冲，等 flush（如 tool-input 累积）
```

`RewriteState` 是单请求、单 rewrite 私有的可变状态（跨帧 index 映射、缓冲区）。

---

## 2. 装配器

```ts
function assembleRequestRewrites(env: RequestEnvelope): RequestRewrite[]
// 1. 取该 format 的全部注册 rewrite
// 2. filter(r => r.appliesTo(env))     ← config/state/上下文 gate
// 3. sort by order                      ← 声明顺序契约（取代注释）
function assembleResponseRewrites(env: RequestEnvelope): ResponseRewrite[]  // 同理
```

driver 在 S3 顺序 `apply`，每步 publish `request.rewrite_applied`{name, changed, stats}（envelope-driver §4）。

---

## 3. 顺序契约（从注释升级为 order 键）

现状靠 handler 注释维系的硬顺序，必须在 `order` 声明（违反即潜在上游 400）：

| 契约 | 现状依据 | 说明 |
|---|---|---|
| `tool-preprocess(T*)` < `sanitize(A*)` | 02 §2.2 | A8 tool 块校验依赖最终 tools 数组 |
| `tool-name-sanitize(T7)` 在 T* 后、A* 前 | 02 §2.2 | mapper 用原始 tools 构建，应用在中间 |
| `rewrite-server-tool-blocks(A6)` < `tool-blocks(A8)` | sanitize.ts:103 | 让 tool 引用校验看到降级形态 |
| `thinking-sanitize(A7)` < `tool-blocks(A8)` | sanitize.ts:112 | 让空消息清理生效 |
| `coerce-thinking(B3)` < `adjust-budget(B4)` < `clamp-effort(B5)` | request-preparation.ts:141-143 | thinking 形态依赖链 |
| `build-beta(B8)` < `merge-beta(B9)` < `filter-beta(B10)` | request-preparation.ts:168-172 | beta header 构造链 |

---

## 4. 改写映射（现状函数 → registry 条目）

完整编号见 02 §2/§3。装配分两组：

### 请求改写（RequestRewrite）

| 组 | 条目（name） | order 段 | appliesTo gate | 现状实现 |
|---|---|---|---|---|
| system-prompt | `system-override`（S1/S2/S3） | 000 | `state.systemPromptOverrides` 等 | system-prompt/override.ts（**非幂等，S3 入口一次**） |
| tool-preprocess | `补schema/tool-search/cc-tools/history-stub/sticky-undefer/strip-server`（T1-T6） | 100-160 | 各 config（02 §2.2） | message-tools.ts |
| tool-name | `tool-name-sanitize`（T7/O7/O13） | 200 | `state.sanitizeToolNames` | tool-name-sanitize.ts |
| sanitize | `read-tag/dedup/sys-reminder/sys-msg/server-tool-hist/thinking-strip/tool-blocks/empty-clean`（A1-A9, O1-O6） | 300-390 | 各 config（02 §2.1） | sanitize/* |
| prepare（header/body 最后一公里，**在 S4 每 attempt**） | `reject-fields/coerce-thinking/adjust-budget/clamp-effort/cache-control/beta-build/beta-merge/beta-filter/context-mgmt`（B1-B12） | 400-490 | 各 config + model + negotiation cache + prepareHints | request-preparation.ts 子步骤（**导出私有子步骤**） |
| responses | `strip-image-gen/normalize-call-ids`（O11/O12） | 500-510 | 各 config | responses-tool-filter / responses-conversion |

> **B 组特殊**：prepare（header/body 裁剪）依赖 `prepareHints`（每 attempt 由 strategy 更新），所以它在 **S4 的 `prepareWire(env)` 内每 attempt 跑**，不在 S3 一次性跑（retry-transport.md §3）。S3 跑 system/tool/sanitize（per-request 一次），B 组跑在 S4 attempt 循环。

### 响应改写（ResponseRewrite）

| 条目（name） | order | appliesTo | 现状实现 |
|---|---|---|---|
| `thinking-sig-compat`（A3） | 100 | anthropic ∧ `state.thinkingSignatureCompat` | thinking-signature-compat.ts（短路 return → emit 多帧） |
| `tool-input-decode`（A2） | 200 | anthropic ∧ decode config | decode-tool-input.ts（buffer + flush） |
| `server-tool-filter`（A1+A1b） | 300 | anthropic（始终） | server-tool-filter.ts（suppress/emit + 工具名还原） |
| `cc-tool-name-restore`（C1） | 300 | openai-cc ∧ mapper | tool-name-sanitize.ts |
| `responses-stream-id`（P1） | 100 | openai-responses ∧ `state.fixResponsesStreamIds` | stream-id-sync.ts |
| `responses-tool-name-restore`（P2） | 200 | openai-responses ∧ mapper | tool-name-sanitize.ts |
| `heartbeat`（A4） | 999 | anthropic ∧ `state.anthropicFakeSseHeartbeat` | 合成注入（独立定时器，emit-only） |
| `truncation-marker`（C2） | 000 | openai-cc ∧ verbose ∧ wasTruncated | 合成注入（首帧） |

**顺序契约（响应）**：anthropic `thinking-sig-compat(100)` < `tool-input-decode(200)` < `server-tool-filter(300)`（对齐现状 processOneStreamEvent 穿插序：A3 短路 → A2 decode → A1 filter）。

---

## 5. 与翻译（S6）的边界

ResponseRewrite（S5）只在**当前上游协议的帧**上操作；翻译回客户端（S6 `codec.renderResponse`）在 S5 **之后**。CC-via-Responses 时：上游 Responses 帧先被 codec（S6 在 adapter 内）翻成 CC 帧，**再**进 S5 的 CC 改写——即此路径 S6 在 S5 前。v4 统一为：**S5 改写永远作用于 `targetEndpoint` 协议的帧；S6 翻译到 `clientFormat`**。Responses→CC fallback 中"上游 Responses → CC"发生在 S4/S5 边界（codec 把上游流归一到 targetEndpoint=CC 协议），S6 再 CC→clientFormat（此例 clientFormat 也是 cc，故 S6=identity）。实现时严格按"S5 操作 targetEndpoint 帧、S6 操作 clientFormat 转换"，消除现状混层。

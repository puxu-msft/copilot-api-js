# Observability 接线补丁报告——FIX-OBS-1 / FIX-OBS-2（whole-branch review MEDIUM 跨阶段缺口）

## 背景

whole-branch review 发现 3 个已声明但零生产接线的可观测性枚举，违反 spec AC6 + richest-data-flow ADR：

1. `"error-shaping-canonical"`（`SyntheticOriginKind`，`history/types.ts:183`）——文档承诺 S5 rewrite 产出的 canonical post-commit `event:error` 帧被打标，但 `error-frame-canonical-rewrite.ts` 从未调用 `tagFrameSynthetic`。
2. `"error-shaping-decided"`（`FeatureKind`）——零 `recordFeature` 调用点。
3. `"error-shaping-auq-synthesized"`（`FeatureKind`）——零 `recordFeature` 调用点。

（`error-shaping-selfheal-delegated` 已在 `handler-v4.ts:295` 正确接线，作为参考模式。）

本次任务按 TDD（红→绿）逐一补上这三处接线。

## FIX-OBS-1：`error-shaping-canonical` 帧打标

**文件**：`src/lib/codec/anthropic/error-frame-canonical-rewrite.ts`

在 `transform` 里对 `buildCanonicalErrorFrameFromRaw(frame)` 的产出调用 `tagFrameSynthetic(..., "error-shaping-canonical")`，镜像 `error-shaping.ts:429` AUQ 帧打标的既有模式：

```ts
transform: (frame: UpstreamFrame, _state: RewriteState): FrameAction => {
  if (frame.event !== "error") return { kind: "emit", frames: [frame] }
  // history/types.ts SyntheticOriginKind doc (Phase 3 wiring): this reshaped frame REPLACES the
  // upstream terminator on the FORWARDED track, so it must be tagged distinguishable from genuine
  // upstream traffic (richest-data-flow §3) — mirrors `recover-refusal.ts`'s error-mode frame tagging.
  return { kind: "emit", frames: [tagFrameSynthetic(buildCanonicalErrorFrameFromRaw(frame), "error-shaping-canonical")] }
},
```

只有 FORWARDED track 需要打标——该 rewrite 本就只改写转发轨（upstream track 保留原始上游错误），richest-data-flow ADR 天然满足，无需额外分叉逻辑。

**测试证据**（`tests/codec/anthropic/error-frame-canonical-rewrite.unit.test.ts`，正样本断言，非仅"不抛异常"）：
- 新增测试：reshape 后的 canonical 帧 `readSyntheticKind(frame)` 回读 `toBe("error-shaping-canonical")`。
- 新增测试：非 error 帧的 passthrough 帧 `readSyntheticKind(frame)` 为 `undefined`（只有被重塑的错误帧才打标，避免误伤直通帧）。
- 结果：10 pass / 0 fail（含既有 8 个用例）。

## FIX-OBS-2：`error-shaping-decided` / `error-shaping-auq-synthesized` 接线

先读 `error-shaping-glue.ts` 全文确认了两个 `decide()` 调用点各自的 ctx 可达性：`shapePrecommitError` 通过 `c.get("requestContext")` 拿 `RequestContext`；`shapePostcommitErrorFrame` 原本不持有 ctx，但两个生产调用方（`handler-v4.ts`）在调用现场都已持有 `codec.getContext()`，可作为新增可选参数传入——不是"接不到就硬塞"，而是确认了真实可达路径后才加参数。

### ① `shapePrecommitError`（`src/routes/messages/error-shaping-glue.ts`）

- 把 `const ctx = c.get("requestContext") as RequestContext | undefined` 从 `ask-user-question` 分支内部提到 `decide()` 调用之前（作用域提升），使 `error-shaping-decided` 能覆盖**所有**决策分支，不止 AUQ。
- `decide()` 解出后立即：`ctx?.recordFeature("error-shaping-decided", { decision: decision.kind, errorType: apiError.type, commitPhase: "pre-commit" })`。
- 在 `ask-user-question` 分支内，AUQ 帧/响应构造前加：`ctx?.recordFeature("error-shaping-auq-synthesized", { errorType: apiError.type })`（流式/非流式两个变体共享同一个 `decision`，一次 recordFeature 覆盖两者）。

### ② `shapePostcommitErrorFrame`（同文件）

- 签名新增可选第三参 `ctx?: RequestContext`（向后兼容，不破坏既有调用方/测试）。
- `decide()` 解出后立即：`ctx?.recordFeature("error-shaping-decided", { decision: decision.kind, errorType: apiError.type, commitPhase: "post-commit" })`。
- **生产接线**：`src/routes/messages/handler-v4.ts` 的两个调用点（terminus ① HTTPError 行 587、terminus ①′ network_error 行 597）均已传入现场已有的 `ctx`（`codec.getContext()`），使这条 telemetry 在真实 post-commit 路径上实际触发，而非只在单元测试里被验证。

### 有意排除：`shapeRawStreamErrorFrame` 不接 `error-shaping-decided`

`shapeRawStreamErrorFrame`（H3 流错误 / 截断两个 termini，直连 pump + reverse translate leg 共用）**从不调用 `decide()`**——调用方直接传入一个 wire 级 `errorType` 字符串字面量（如 `"overloaded_error"`/`"timeout_error"`/`"api_error"`），这不是 `ApiErrorType`（`FeatureKind` 文档把 `errorType` 类型定为 `ApiErrorType`）。既没有 `decide()` 产出的 `decision.kind` 可报告，也没有 `ApiErrorType` 可填入 `errorType` 字段——没有可以自然、类型正确地放进 `error-shaping-decided` payload 的内容。

这不是"接不到就跳过"的偷懒，而是该函数本身就在 `decide()` 之外的另一条职责路径上（Phase 3 FIX-2 的说明：G-3 canonical 构造复用，但分类逻辑不复用）。**建议主会话确认**：是否需要为这类"无 ApiError 分类、纯 wire-level 透传"的 canonical 化路径单独定义一个更贴切的 FeatureKind（例如区分 `commitPhase` 之外再加一个 `"raw-stream"` 来源标记），或是维持现状、在 backlog 记录为"已知的、有意的观测覆盖盲区"。本次未新增该维度，因为这超出了"补齐已声明枚举的接线"这一任务边界，属于新枚举设计决策，不应由本次任务单方面拍板。

**测试证据**：
- `tests/routes/messages/error-shaping-glue.unit.test.ts`：新增两个 `describe` 块，覆盖 10 种 `ApiErrorType` × 期望 decision kind 的 `test.each`、aborted/CF-2-disabled 两个"不应记录"负样本、B 类 AUQ-on/AUQ-off/A-C 类"不应记录 auq-synthesized"的正负样本。
- `tests/routes/messages/postcommit-error-shaping.unit.test.ts`：新增一个 `describe` 块，覆盖 terminus ①/①′ 两条路径的正样本、CF-2-disabled 负样本、`ctx` 省略时的向后兼容 no-op 断言。
- 结果：两文件合计 42 pass / 0 fail。

## 验证

- `bun run typecheck`：全仓库绿（含 `tests/e2e-ui` 子项目）。
- `bunx eslint --no-cache`（逐文件、无缓存，避免 targeted lint 的缓存假绿）：初始 4 处 prettier 格式化报错（均在本次改动的行上），`--fix` 后复查 0 error / 0 warning。
- 回归测试：`bun test tests/anthropic/ tests/routes/messages/ tests/pipeline/` → **1896 pass / 7 skip（既有、与本次改动无关）/ 0 fail**，共 170 个测试文件 1903 个测试。
- 集成测试（`.it.test.ts`，端到端经真实路由验证黑盒行为）：`error-shaping-auq.it.test.ts` / `error-shaping-precommit.it.test.ts` / `postcommit-error-shaping.it.test.ts` / `translate-leg-error-shaping.it.test.ts` → **25 pass / 0 fail**。
- 范围核实：`git diff --stat` 确认仅 6 个文件改动，全部在 Anthropic 路径内（`error-frame-canonical-rewrite.ts` + `error-shaping-glue.ts` + `handler-v4.ts` 及其对应的 3 个测试文件）；对 `src/lib/codec/openai-cc`、`src/lib/codec/openai-responses`、`src/lib/pipeline/stream-accumulator.ts` 的 `git diff --stat` 结果为空——零改动，符合约束。
- 未改动 `decide`/`AuqOption`/`buildCanonicalErrorFrame` 的契约签名；`shapePostcommitErrorFrame` 新增的第三参是**可选**参数，不破坏任何既有调用方。

## 遗留关切（供主会话裁决）

1. **`shapeRawStreamErrorFrame` 的 `error-shaping-decided` 观测覆盖盲区**（见上）——建议要么在 backlog 记录为已知盲区，要么后续单独设计一个适配"无 ApiError 分类"路径的 FeatureKind 维度。本次未擅自扩展枚举设计。
2. FIX-OBS-2 对 `shapePrecommitError` 的作用域提升（`ctx` 提前声明）是一处轻微的重构，虽然行为完全等价（原本只在 AUQ 分支内使用，现在同一变量在所有分支内可用），但改变了函数内部结构；已通过全部既有 + 新增单元/集成测试验证行为不变。

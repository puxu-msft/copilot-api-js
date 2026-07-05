# 拦截 Anthropic upstream "refusal" 响应 — 合成可用文本完成

## Context（为什么做）

实测 `req_1782214935133_68`（opus-4.8，432k input、112 tools、adaptive thinking，正经编码轮 "修，然后再看看相关的整体范围"）：上游回了一条**只有一个 thinking 块**（empty text、**有效非空 signature**）、**无 text/tool_use**、`stop_reason:"refusal"` 的流：

```
message_start → content_block_start{thinking,signature:"",thinking:""}
→ content_block_delta{signature_delta:S} → content_block_stop
→ message_delta{stop_reason:"refusal", stop_details:{type:"refusal",explanation:...}} → message_stop
```

当前代码**完全不处理** Anthropic refusal（`refusal` 只在 OpenAI 翻译路径出现），逐字节透传、打 `[OK]`。客户端（Claude Code）拿到一个**空/坏轮**——session 时间线证实：refusal 之后每一轮 user 都变成 "继续"，用户被迫手动推进卡住的轮次。这是首要可观测危害。

**关键澄清**：该 thinking 块**不是** [[thinking-empty-plaintext-poison-client-masks]] 的"双空块"毒（毒需 text **和** signature 都空）。此块 text 空但 signature 有效，而 signature 自包含（[[thinking-signature-self-contained]]），原样回放可被上游接受——这正是时间线里**没有后续 400** 的原因。故**无需剥离该块**。

**目标行为**（用户已选"合成可用文本完成"）：检测 thinking-only refusal → **追加一个合成 text 块** + 把 `stop_reason:"refusal"→"end_turn"`（删 `stop_details`），**不剥 thinking 块**（保留=richest-data，且流式剥离需缓冲整个 thinking 阶段=活 UX 回归）。history 的 `sseEvents` 保留上游原始 refusal 不变。新增 `anthropic.*` 开关，默认 false（opt-in）。

## 设计决策（已对照真实代码验证）

- **接入点 = 新增一条 `ResponseRewrite`** 加进 `ANTHROPIC_RESPONSE_REWRITES`（`src/lib/codec/anthropic/response-rewrite-adapters.ts`），声明 `transform`（流式逐帧）+ `transformWhole`（非流式整体）+ `appliesTo` + `createState`，与现有 4 条 adapter 同形。**无需 buffering、无 flush**——流式只在 refusal 的 `message_delta` 处注入合成帧（驱动 `passThrough` 支持一帧入→多帧出，recover-tool-call 的 `emitCommit` 已是此模式）。
- **history 保真自动成立**：rewrite 只作用于 forwarded 轨；driver 在 S5 链**之前**经 `onUpstreamFrame` 采样原始帧喂 accumulator + `sseEvents`，故记录的 `stop_reason` 仍是原始 `refusal`（history 诚实），客户端收到的是 rewritten `end_turn`。
- **模块粒度 = 单文件** `src/lib/anthropic/recover-refusal.ts`（**不建目录**）。recover-tool-call 用目录是因有 invoke 解析核 + schema 抽取 + CANDIDATE/COMMIT 状态机；refusal 恢复无解析、无缓冲、无状态机，~80 行单文件更清晰。

## 文件改动

### 新建

**`src/lib/anthropic/recover-refusal.ts`** — 纯函数模块（零 I/O、不读 global `state`，由 adapter `appliesTo` 门控），module-top `/** */` 记录 WHY（实测 refusal 形状 / 为何保留有效 signature 的 thinking 块 / 为何流式 append 而非 buffer-strip）。导出：
- `REFUSAL_RECOVERY_TEXT`（合成文本常量，见下）
- `isThinkingOnlyRefusal(stopReason, sawRealContent): boolean` = `stopReason === "refusal" && !sawRealContent`
- `buildSyntheticTextFrames(index): Array<SseFrame>` — 3 帧 `[content_block_start{text,""}, content_block_delta{text_delta}, content_block_stop]`，裸 `{ data }`（无 `event:`，对齐 recover-tool-call `sse()` 合成帧约定）
- `rewriteRefusalMessageDelta(parsed)` — 不可变（解构剔除 `stop_details` + spread，**不 `delete`**）：`{ ...parsed, delta: { ...deltaWithoutStopDetails, stop_reason: "end_turn" } }`，保留 `usage`/`stop_sequence`/`container`
- `recoverRefusalInResponse(response): AnthropicMessageResponse` — 非流式整体助手（镜像 `recoverToolCallTextInResponse`）：`stop_reason!=="refusal"` 或 content 已含 text/tool_use → 原样返回；否则 `content:[...content, {type:"text",text:REFUSAL_RECOVERY_TEXT}]` + `stop_reason:"end_turn"` + 删 `stop_details`

**`docs/refusal-recovery.md`** — 短模块文档（镜像 `docs/tool-call-text-recovery.md` 的位置/风格，**非 RFC**——append-only 小特性，不够 RFC 门槛）：实测 refusal 形状、行为、"保留有效-signature thinking 块"理由、门控、history-保真不变量、默认 off。

### 修改

**`src/lib/codec/anthropic/response-rewrite-adapters.ts`** — import 上述导出；加 `interface RefusalState extends RewriteState { maxIndex: number; sawRealContent: boolean; ctx: RequestContext; featureLogged: boolean }`；加 `refusalRewrite: ResponseRewrite`（`name:"recover-refusal"`、`order: RESPONSE_REWRITE_ORDER.recoverRefusal`、`appliesTo:(env)=>ANTHROPIC(env) && state.recoverRefusalText`、`createState`、`transform`、`transformWhole`、**无 flush**）；append 进 `ANTHROPIC_RESPONSE_REWRITES` 数组。

**`src/lib/pipeline/rewrite-registry.ts`** — `RESPONSE_REWRITE_ORDER` 加 `recoverRefusal: 400`（最后，理由见下）+ 扩 JSDoc 一行。

**`src/lib/state.ts`** — 镜像 `recoverToolCallText` 五处：interface 字段（带 `/** */`）、`setAnthropicBehavior` 的 `Pick<>` union 加 `| "recoverRefusalText"`、`CONFIG_MANAGED_DEFAULTS`、`resetConfigManagedState`、`mutableState` seed。

**`src/lib/config/schema.ts`** — `AnthropicConfigSchema` 在 `tool_recover_call_text` 旁加 `refusal_recover_text: nullableBoolean(),`（类型由 zod 推断，无需手写）。

**`src/lib/config/config.ts`** — `applyConfigToState` 的 anthropic 块加 `if (a.refusal_recover_text !== undefined) setAnthropicBehavior({ recoverRefusalText: a.refusal_recover_text })`（retain-on-absence）。

**`config.yaml`** — anthropic 段 `tool_recover_call_text` 后加注释化 `refusal_recover_text: false` + 2 行 WHY + 文档链接。

**`src/lib/observability/events.ts`** — `FeatureKind`（:113）在 `tool-call-recovered`（:136）旁加 `| "refusal-recovered"`，供 `ctx.recordFeature` 记录激活。

**`tests/config/config-hot-reload.it.test.ts`** — `FIELDS` 加条目（**必须**，否则完整性守卫 fail）：
```
{ configKey: "anthropic.refusal_recover_text", stateKey: "recoverRefusalText",
  sampleYamlValue: "true", expectedStateValue: true,
  defaultStateValue: CONFIG_MANAGED_DEFAULTS.recoverRefusalText },
```

**`src/lib/anthropic/stream-accumulator.ts`**（推荐，richest-data 但独立子任务）— 局部 `MessageDelta`（:365-368）加 `stop_details?: unknown`，accumulator 接口 + factory 加 `stopDetails?: unknown`，`handleMessageDelta` 捕获。accumulator 只见原始帧，故记录的是真实 refusal 类别/解释（非 rewritten end_turn）。

## 流式 `transform` 逻辑（匹配 FrameAction 契约）

`createState: (env) => ({ maxIndex:-1, sawRealContent:false, ctx:env.ctx, featureLogged:false })`

逐帧 `parseFrame(frame.data)`，默认 `{kind:"emit",frames:[frame]}`（原样）：
- `message_start` → 重置 `maxIndex=-1, sawRealContent=false`，emit
- `content_block_start` → `maxIndex=max(maxIndex,index)`；若 `content_block.type ∈ {text,tool_use}` → `sawRealContent=true`；emit
- `content_block_delta`/`content_block_stop`（有 index）→ `maxIndex=max(...)`；emit
- `message_delta`：若 `!isThinkingOnlyRefusal(delta.stop_reason, sawRealContent)` → emit 原样；否则首次 `ctx.recordFeature("refusal-recovered")` + `consola.info`，`idx=maxIndex+1`，emit `[...buildSyntheticTextFrames(idx), {...frame, data:JSON.stringify(rewriteRefusalMessageDelta(parsed))}]`
- 其它（`message_stop`/`ping`/`error`）→ emit 原样

**非流式** `transformWhole(response)` → `recoverRefusalInResponse(response)`。`appliesTo` 已门控，关时 driver 整条跳过 = 逐字节透传；内部 guard 是第二道防线。

## 合成文本（固定常量，非 config）

按项目 quality-over-speculation + YAGNI（recover-tool-call 亦无消息字符串 config）。一条中文常量（信息+非惊吓+可操作，人与 Claude Code agent 皆可读）：

> 上游模型本轮以「拒绝（refusal）」结束，未产出可用回复（仅有思考块）。这通常是上游安全策略对当前请求的瞬时拦截，不代表任务本身有问题。请基于已有上下文换一种表述或拆分步骤后重试；若多次复现，考虑调整措辞、移除可能触发策略的内容，或改用其他模型。

## 命名与 order

- config key **`anthropic.refusal_recover_text`** / state 字段 **`recoverRefusalText`**（concern-first，镜像 `tool_recover_call_text` ↔ `recoverToolCallText`）。
- **order `recoverRefusal: 400`（最后）**：thinking-only refusal 无 tools/无降级文本，故 recover(100)/decode(200)/filter(300) 皆 no-op、thinking-signature-compat(150) 只改 thinking start 的 signature（refusal-recovery 不碰），双向无冲突；跑最后保证 `maxIndex` 反映 densify 后的最终块集，`maxIndex+1` 永不撞 index（与 filter densify 同理）。

## 测试计划（域镜像 + 隔离后缀；golden 预捕获）

- **`tests/anthropic/recover-refusal.unit.test.ts`**（新，纯）：`isThinkingOnlyRefusal` 真值表；`buildSyntheticTextFrames` 精确 3 帧；`rewriteRefusalMessageDelta`（end_turn、删 stop_details、保 usage/stop_sequence、入参不被改）；`recoverRefusalInResponse`（thinking-only→追加+end_turn+无 stop_details / refusal-with-text→identity / 非 refusal→identity / `content:[]`→单 text 块）。
- **`tests/pipeline/recover-refusal-rewrite.unit.test.ts`**（新，仿 `response-rewrite-contract.unit.test.ts` mock-codec）：跑实测序列断言 thinking 帧逐字 + `[text_start(idx=1),text_delta,text_stop,message_delta(end_turn,无 stop_details)]` + message_stop；门控-关逐字节用例（普通 end_turn 流 / refusal 但含真 text 块→`sawRealContent` 关门）；index 用例（thinking idx0→text idx1；两 thinking→text idx2；**无任何 content_block 的 refusal→text idx0**）；`appliesTo`-false 时 rewrite 不入链。
- **`tests/anthropic/response-rewrite-golden.http.test.ts`**（扩）：新增 golden——`recoverRefusalText:true` 跑完整 handler-v4，对捕获的 thinking-only-refusal 上游 SSE 字节锁 forwarded 流 + 断言 `sseEvents`/accumulator 仍保留上游 `refusal`+`stop_details`；非流式整体经 `renderNonStreamingV4` 一例。
- hot-reload 覆盖 = 上面的 `FIELDS` 条目（完整性守卫 + per-field reload 断言）。

## Doc-sync（"完成"的一部分）

- **`config.yaml`** 注释块（主用户面）。
- **`docs/refusal-recovery.md`**（新短文档）。
- **`docs/DESIGN.md`**（**Plan agent 误判此处——表在 DESIGN.md 非 CLAUDE.md**）：① 运行时选项表（:254/:299）`recoverToolCallText` 行后加 `recoverRefusalText` 行；② 活的架构现状 S5 行（:65）"recover/thinking/decode/filter 四条"扩为含 recover-refusal 的第 5 条（order 400）。
- `recover-refusal.ts` module-top JSDoc。
- **CLAUDE.md 不改**（无该表；改即捏造结构）。

## 边界用例（已对抗自审，皆覆盖于测试）

1. refusal **带** text/tool_use → `sawRealContent`/`content.some` 关门，逐字节透传。
2. 多 thinking 块 → `maxIndex` 取最大，text idx 正确。
3. 非流式 `content:[]` → idx0 单 text + end_turn。
4. `recoverRefusalText` + `recoverToolCallText` 同开 → 形状不相交（refusal 无 text 给 recover 检查、`commitTier` 对 "refusal" 返 null），永不双触发；加 both-enabled contract 用例。
5. **无任何 content_block 的 refusal** → maxIndex -1→ synth idx0，合法首 text 块（必测）。
6. `appliesTo` false → driver 整条过滤 = 最干净透传。
7. 合成帧用裸 `{ data }`（对齐既有约定）；golden 字节锁兜底，实现时对真实捕获复核。

## 验证（executable）

改了 `.ts`/`.yaml`，按 `verify-only-on-executable-changes`：
- `bun run typecheck`
- `bun run test:backend`（含新 unit + 扩 golden + hot-reload 守卫）；flaky 无（纯函数+确定性帧）
- `eslint --fix`（不直接 prettier）
- 实测复检（不自启服务器，让用户起）：开 `anthropic.refusal_recover_text: true`，重放/构造 thinking-only refusal，确认客户端收到 text 块 + end_turn、history `sseEvents` 仍 refusal。可经 `/api/debug/dry-run-pipeline`（`stopAfter=rewrite-out`，`entryId=req_1782214935133_68`）离线验证 S5 改写输出而无需打 GHC。

## 收尾

按 `fine-grained-staging-per-phase-commit` 分阶段提交（pure 模块 / adapter+order / config plumbing / 测试 / doc-sync），`git add -- <精确路径>`，conventional commits（`feat:`），提交前 `git diff --cached --stat` 复核仅含本次改动。subagent audit 收尾（显式裁判轴=长远正确+完整）。

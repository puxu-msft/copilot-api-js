# Spec: refusal recovery / error 文本全可配 + 占位符模板

> ⚠️ **部分已过时（2026-07-28）**：本文写作时默认是 `error`、概念名是「thinking-only refusal」。现默认为 `end_turn`（抑制），判据改名 `isContentlessRefusal`，占位符集合也已扩充。**当前契约以 [docs/refusal-recovery.md](../refusal-recovery.md) 为准**；本文保留作为「文案可配置化」这一决策的原始记录。

- **状态**：草案（待用户审 → planning）
- **日期**：2026-07-13
- **相关**：[docs/refusal-recovery.md](../refusal-recovery.md)（三模式现状）、[recover-refusal.ts](../../src/lib/anthropic/recover-refusal.ts)、ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md)（合成物打标范围）、skill `ghc-anthropic-upstream`（thinking-only refusal 根因）、记忆 [config-philosophy-separate-compat-and-warn-continue](../memory/feedback-config-philosophy-separate-compat-and-warn-continue.md)

## 背景与问题

上游（GHC/Anthropic）偶发以 `stop_reason:"refusal"` 结束一轮、仅产出 thinking 块、无 `text`/`tool_use`（thinking-only refusal，skill `ghc-anthropic-upstream` 记录、活例 `req_1783947618475_731`：opus-4.8 思考 25.8k token 后拒绝）。代理按 `anthropic.refusal_sse_rewrite` 三模式处理（`refusal` 透传 / `end_turn` 合成 text 块软着陆 / `error` 发 error 帧并记 fail，默认 `error`）。

`end_turn` 与非流式 `end_turn` 注入的 recovery 文本、以及 `error` 模式合成 error 帧的 message/type，当前均为 [recover-refusal.ts](../../src/lib/anthropic/recover-refusal.ts) 里的**硬编码常量**（`REFUSAL_RECOVERY_TEXT` / `REFUSAL_ERROR_MESSAGE` / `REFUSAL_ERROR_TYPE`），且代码注释明确写「Fixed (not config-driven) — there is no real need for per-deployment customization」。

**该决策需推翻，理由很硬**：`end_turn` 注入的 text 块会被客户端（Claude Code）**baked 进对话历史、作为下一轮请求的一部分回灌上游**。代理硬塞一段固定说辞就等于替用户往其后续上下文里注入不可控内容。用户诉求：这段内容必须**完全可定制、可零包装**（配什么字节就注入什么字节，代理不加任何前缀/后缀/内联标记），并对称地开放 error 模式的 message/type。

## 目标

1. 把三处硬编码文本开放为 `anthropic.*` 配置键，硬编码常量降级为默认值（空配置逐字节不变、零回归）。
2. 支持占位符模板（`end_turn_text` 与 `error_message`），让注入文本可携上游上下文。
3. 「零包装」：配置值 = 最终注入字节，代理不加任何框架；空串 = 一个字都不注入。
4. **合成帧记录层打标（本轮并入，补齐 ADR §3 缺口）**：refusal 注入/改写的合成帧在 forwarded 轨打 `synthetic:"refusal-recovery"` 标记——本轮放大了合成物的可定制性（任意字节/可空使内容启发式失效），这是我们引入的问题、不留缺口。**只碰记录层元数据，不碰客户端可见字节**（与目标 3 不冲突）。

## 非目标

- 不改三模式门控逻辑（`isThinkingOnlyRefusal`、server_tool_use 排除、handler `ctx.fail` 归属）——见 docs/refusal-recovery.md，均不变。
- 不改 web_search 双跳旁路对 refusal 三模式无效的既有缺口（docs/refusal-recovery.md「已知缺口」）。
- 不动 history 保真（上游原始 `refusal` + `sseEvents` 始终记录真实上游，本 spec 只碰 forwarded/rendered 轨）。
- 不在客户端可见文本里加任何内联标记（打标只在记录层元数据，见目标 4）。

## 合成帧记录层打标（本轮并入）

**问题（reviewer MEDIUM-2，核实属实）**：ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md) §3 要求「合成物只进 forwarded 轨且打显式标记，所有注入点全打」。但核对 [client-sink.ts](../../src/lib/pipeline/client-sink.ts) 的 `write()`（`sampleForwarded(frame, wasFrameRewritten(frame) ? "hook-rewrite" : undefined)`）：refusal 合成帧经 rewrite `emit` → `next.push` → `sink.write()`（driver.ts:573/682 等，与 hook-rewrite 同路径），但 refusal 帧无 hook tag → **forwarded 轨 `SseEventRecord` 当前未打任何 `synthetic` 标记**。这是既有 ADR §3 违反，且本轮「零包装」加剧（凭内容判断「是否合成」彻底失效）。既然是我们放大的合成物，本轮补齐。

**打标范围（流式，refusal 的 rewrite `emit` 帧）**：
- **end_turn 模式**：合成 text 三元帧（start/delta/stop）——纯注入物，`synthetic:"refusal-recovery"`；被改写的 `message_delta`（refusal→end_turn 的 stop_reason 变更）——mutated 真帧、forwarded 轨已不反映上游 stop_reason，同样标 `refusal-recovery`（诚实标注「此终止帧被 refusal recovery 改写」）。
- **error 模式**：替换上游终止帧的 `event: error` 帧——纯注入物，标 `refusal-recovery`（被抑制的原 delta/message_stop 不进 forwarded 轨、无需标）。
- **空串 end_turn**：仅被改写的 `message_delta`（无 text 块），标之。

**机制（推荐泛化，避免两套并行 tag）**：hook-rewrite 现用单一布尔 Symbol `FRAME_HOOK_REWRITE`（[hooks/origin.ts](../../src/lib/pipeline/hooks/origin.ts) `tagFrameRewritten`/`wasFrameRewritten`）。推荐**泛化为携 kind 的 synthetic-origin tag**（一个 Symbol 存标记种类 `"hook-rewrite" | "refusal-recovery" | …`），hook-rewrite 迁到同机制，`write()` 读单一 tag → `sampleForwarded(frame, readSyntheticKind(frame))`。refusal 帧在 [recover-refusal.ts](../../src/lib/anthropic/recover-refusal.ts) 构造/改写处打 `tagFrameSynthetic(frame, "refusal-recovery")`。轻量替代（并行第二 Symbol）留 plan 定，但泛化更干净、单一读取点。

**类型**：`SseEventRecord.synthetic` 联合（[history/types.ts:171](../../src/lib/history/types.ts#L171)）+ 两个 sink 的 `sampleForwarded` 局部联合（[client-sink.ts:169](../../src/lib/pipeline/client-sink.ts#L169) 与 [client-sink.ts:446](../../src/lib/pipeline/client-sink.ts#L446)）加 `"refusal-recovery"`。

**非流式无此问题**：非流式无 `sseEvents`；forwarded body 经 `setForwardedResponse`（handler-v4）与上游原始 `outboundResponse` 分腿记录，合成 vs 真实已可辨。本节仅约束流式帧轨。

**下游展示（可选，本轮不强制）**：ui-v4 History 可据 `synthetic:"refusal-recovery"` 给这些帧加 badge/dim（对齐 keepalive「13 events · 11 keepalive」既有呈现），plan 视工作量决定是否捎带；后端标记是本轮硬目标、前端呈现可后续。

## 配置面（新增三键，`anthropic.*`）

| 键 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `refusal_end_turn_text` | string（模板） | `DEFAULT_REFUSAL_END_TURN_TEXT`（现 `REFUSAL_RECOVERY_TEXT` 那段中文） | `end_turn` 模式注入的 text 块内容——**会被客户端 baked 进下一轮请求** |
| `refusal_error_message` | string（模板） | `DEFAULT_REFUSAL_ERROR_MESSAGE`（现 `REFUSAL_ERROR_MESSAGE`） | `error` 模式合成 `event: error` 帧的 message（客户端 `APIError.message`） |
| `refusal_error_type` | string（纯字面，不做模板） | `api_error`（现 `REFUSAL_ERROR_TYPE`） | error 帧 `error.type`，客户端据此分支 |

- **命名消歧**：刻意避开旧布尔键 `refusal_recover_text`（已被 [compat.ts](../../src/lib/config/compat.ts) 迁走），用 mode-scoped 前缀（`end_turn` / `error`）。
- **默认值单一来源**：硬编码常量重命名为 `DEFAULT_*` 并 export，state 的 `CONFIG_MANAGED_DEFAULTS` 直接引用，不复制字符串。
- **配置哲学**：三键属新增、无迁移负担；加载遇类型不符默认警告并继续（对齐记忆 [config-philosophy](../memory/feedback-config-philosophy-separate-compat-and-warn-continue.md)），运行时热重载生效。

## 占位符集（`end_turn_text` 与 `error_message` 共用）

| 占位符 | 流式来源 / 时点 | 非流式来源 / 时点 |
|---|---|---|
| `{model}` | `env.body.model`（= 已解析上游 GHC 规范名，非客户端别名，`handler-v4.ts:213` `wireBody.model = resolvedName`）/ createState | `response.model` / transformWhole |
| `{request_id}` | `env.ctx` requestId / createState | `env.ctx` requestId（**transformWhole 须接 `env`**，见下）/ transformWhole |
| `{thinking_tokens}` | `message_delta` 的 `usage.output_tokens`（thinking-only 场景下 output_tokens 即全部 thinking token，故用此名；SDK `MessageDeltaUsage.output_tokens` 非空）/ **message_delta 到达时（工厂内部自取）** | `response.usage.output_tokens` / transformWhole |

**渲染时点铁律（订正 reviewer HIGH-2）**：流式两个工厂（`createRefusalRecoverer` / `createRefusalErrorEmitter`）在 `createState`（流开始、任何帧之前）构造，此刻 `output_tokens` 未知，且 refusal `message_delta` 的检测与合成帧生成**在工厂内部** `processEvent`。故工厂**不能**接收「已渲染好的文本」——它接收**模板 + 静态 vars（model/request_id）**，在处理 refusal `message_delta` 时从 `parsed.usage.output_tokens` 自取 thinking_tokens、`renderRefusalTemplate` 后再 `buildSyntheticTextFrames(index, renderedText)`。仅非流式 whole-response 路径（`recoverRefusalInResponse` / handler-v4 error body）可在渲染前拿齐全部 vars、预渲染。

渲染规则（纯函数 `renderRefusalTemplate(tmpl, vars)`）：
- 简单 `{name}` 字面替换。
- **未知占位符原样保留**（不报错、不清空——避免用户手滑丢文本）。
- 无占位符的纯静态文本走同一路径、零副作用、与手写常量逐字节等价。
- `{stop_reason}` 恒为 `refusal`、价值低，暂不列入（YAGNI 边界，需要再加，不预留）。
- `error_type` 不做模板渲染（type 是 wire 判别字段，模板化无意义）。

## 空串语义（零包装的极致）

- `refusal_end_turn_text == ""`：**不追加任何 text 块**，只把 `stop_reason: refusal → end_turn`（清 `stop_details`）。客户端拿到「thinking + 干净 end_turn、无可见文本」，绝无代理注入物混进下一轮上下文。**⚠️ 需实测确认（reviewer MEDIUM-1）**：原始 stall 事故根因（`recover-refusal.ts:7-9`）是「客户端拿到无可用内容的轮 → 后续每轮变『继续』」，而 end_turn 模式的修复**正是追加 text 块**。空串把 turn 变回「thinking-only、无可见文本」，只是 stop_reason 从 refusal 改成 end_turn。若 stall 根因是「无可见文本」而非 stop_reason 本身，空串**可能重新引入 stall**。本 spec **不预断「不 stall」**：这是用户明确要求的「零包装到一个字都不塞」能力，是否 stall 取决于客户端对 thinking-only end_turn 的行为，须以真实 Claude Code live oracle 验证（见验收标准 3）。流式与非流式路径的「不追加块」行为须一致。
- `refusal_error_message == ""`：error 帧带空 message（合法 wire）。
- `refusal_error_type == ""`：视为未配、回落默认 `api_error`（type 不该为空，空串按缺省处理而非发空 type）。

## 实现塑形（改动点，how 细节留给 plan）

**四个合成文本发射点（reviewer HIGH-1：勿漏 handler-v4.ts）**——三模式 × 流式/非流式，实际有四处读硬编码文本，plan 须逐处接线：

| # | 路径 | 位置 | 当前读什么 |
|---|---|---|---|
| ① | 流式 end_turn text 块 | `recover-refusal.ts` `buildSyntheticTextFrames`（经 `createRefusalRecoverer`） | `REFUSAL_RECOVERY_TEXT` |
| ② | 流式 error 帧 | `recover-refusal.ts` `buildRefusalErrorFrame`（经 `createRefusalErrorEmitter`） | `REFUSAL_ERROR_MESSAGE` + `REFUSAL_ERROR_TYPE` |
| ③ | 非流式 end_turn body | `recover-refusal.ts` `recoverRefusalInResponse` | `REFUSAL_RECOVERY_TEXT` |
| ④ | **非流式 error body** | **[handler-v4.ts:748](../../src/routes/messages/handler-v4.ts#L748)** 内联 `errorBody` | 内联常量 `REFUSAL_ERROR_MESSAGE` + **硬编码 `"api_error"`** |

- **config**：[schema.ts](../../src/lib/config/schema.ts) 加三键；[config.ts](../../src/lib/config/config.ts) `setAnthropicBehavior` 映射进 state；[state.ts](../../src/lib/state.ts) 加三字段 + `CONFIG_MANAGED_DEFAULTS`（引用 `DEFAULT_*` 常量；三处 clone/reset 镜像站点须同步，见 state.ts:1601/1686 等）。
- **recover-refusal.ts**（纯逻辑，不碰 config/state）：
  - 常量重命名 `REFUSAL_RECOVERY_TEXT → DEFAULT_REFUSAL_END_TURN_TEXT` / `REFUSAL_ERROR_MESSAGE → DEFAULT_REFUSAL_ERROR_MESSAGE` / `REFUSAL_ERROR_TYPE → DEFAULT_REFUSAL_ERROR_TYPE`，保留 export。
  - `buildSyntheticTextFrames(index)` → `buildSyntheticTextFrames(index, text)`；`text === ""` 时调用方跳过追加（或函数返回空数组，二选一在 plan 定）。
  - `createRefusalRecoverer` / `createRefusalErrorEmitter` 接收 **模板字符串 + 静态 vars（model/request_id）**（**不是**预渲染文本——见上「渲染时点铁律」）；工厂在 refusal `message_delta` 时自取 thinking_tokens、`renderRefusalTemplate` 后发帧。`recoverRefusalInResponse`（非流式、whole-response）可接收**已渲染好**的文本（渲染前 vars 齐全）。
  - 新增纯函数 `renderRefusalTemplate(tmpl, vars)`。
- **adapter**（[response-rewrite-adapters.ts](../../src/lib/codec/anthropic/response-rewrite-adapters.ts)）：
  - 流式 `createState`：从 `state.refusal*` 取模板 + 从 `env` 组装 model/request_id vars，传模板 + 静态 vars 给工厂（thinking_tokens 由工厂自取）。
  - 非流式 `transformWhole`：**签名须从 `(response)` 拓宽为 `(response, env)`**（reviewer LOW-1：request_id 不在 response 内、须从 `env.ctx` 取），组装全 vars 后预渲染 end_turn 文本再传 `recoverRefusalInResponse`。
- **handler-v4.ts（发射点 ④，reviewer HIGH-1）**：[handler-v4.ts:748](../../src/routes/messages/handler-v4.ts#L748) 非流式 error body 的 `message`/`type` 须经同一 `renderRefusalTemplate`（vars 从 `response.model`/`env.ctx` requestId/`response.usage.output_tokens` 组装）+ type 空串回落 `api_error`；此处 whole-response 在手，预渲染即可。

## 合成帧打标接线（实现塑形补充）

见上「合成帧记录层打标」节的机制/范围/类型。改动点：
- **tag 机制**：[hooks/origin.ts](../../src/lib/pipeline/hooks/origin.ts) 泛化 Symbol tag（或并行第二 Symbol，plan 定）；导出 `tagFrameSynthetic(frame, kind)` / `readSyntheticKind(frame)`。
- **打标点**：[recover-refusal.ts](../../src/lib/anthropic/recover-refusal.ts) 的 `buildSyntheticTextFrames` 各帧、`rewriteRefusalMessageDelta` 输出、`buildRefusalErrorFrame` 输出，构造后 `tagFrameSynthetic(_, "refusal-recovery")`。
- **读取点**：[client-sink.ts](../../src/lib/pipeline/client-sink.ts) 两个 `write()`（169/446 两 sink 变体）改读泛化 tag。
- **类型联合**：`SseEventRecord.synthetic` + 两 sink 局部联合加 `"refusal-recovery"`。

## 测试

- **单元**：`renderRefusalTemplate` 真值表（已知占位符替换 / 未知占位符原样保留 / 空串 / 无占位符恒等）；`buildSyntheticTextFrames` 带自定义文本；空串路径「不追加块」；流式工厂在 refusal `message_delta` 自取 `output_tokens` 渲染 `{thinking_tokens}`（证时点正确、非 createState 时的 0）。
- **golden 字节锁**（[response-rewrite-golden.http.test.ts](../../tests/anthropic/response-rewrite-golden.http.test.ts)）：现有 S6/S8 保持——**默认配置下与现状逐字节相同**（回归护栏）；新增 S8-custom（自定义模板渲染流式）+ S8-empty（空串不追加块）+ 非流式对应档（含 handler-v4 error body ④ 的 message/type 渲染）。
- **热重载**（[config-hot-reload.it.test.ts](../../tests/config/config-hot-reload.it.test.ts)）：加三键条目，验证运行时改配置即时生效。
- **合成帧打标**：单元证 `tagFrameSynthetic`/`readSyntheticKind` 往返 + hook-rewrite 迁移后仍读 `"hook-rewrite"`；集成/golden 证 refusal end_turn 的合成 text 帧 + 改写 delta、error 帧在 forwarded `sseEvents` 记录携 `synthetic:"refusal-recovery"`，而**上游轨 `sseEvents` 不含合成物**（沿用 ADR「上游轨绝不含合成物」可核对性）。
- **import 环校验（reviewer LOW-3）**：plan 落地时 typecheck 确认 `state.ts → lib/anthropic/recover-refusal`（取 `DEFAULT_*`）不成环；若成环则把 `DEFAULT_*` 抽到中立位置。

## 验收标准

1. 空配置下，四发射点（流式/非流式 × end_turn/error）输出与现状**客户端可见字节**逐字节相同（golden S6/S8 + 非流式档不变）；打标只加记录层元数据、不改 wire。
2. 配自定义 `refusal_end_turn_text`（含 `{model}`/`{request_id}`/`{thinking_tokens}`）后，`end_turn` 注入的 text 块 = 渲染后的字节，无代理附加前后缀/内联标记；`{thinking_tokens}` 取到真实 output_tokens（非 0）。
3. 配 `refusal_end_turn_text: ""` 时，`end_turn` 模式不追加任何 text 块（流式+非流式），仅 stop_reason → end_turn。**是否 stall 须以真实 Claude Code live oracle 验证**（reviewer MEDIUM-1：无法只靠 golden 字节测断言，见空串语义节的 ⚠️）。
4. 配自定义 `refusal_error_message` / `refusal_error_type` 后，**流式 error 帧②与非流式 error body④** 的 message/type 均 = 配置值（type 空串回落 `api_error`）——两条路径都须覆盖，勿只测流式。
5. 未知占位符原样保留、不致文本丢失或报错。
6. 三键支持运行时热重载。
7. **refusal 合成帧在 forwarded `sseEvents` 携 `synthetic:"refusal-recovery"`（end_turn text 三帧 + 改写 delta、error 帧全覆盖）；上游轨 `sseEvents` 不含任何合成物；hook-rewrite 打标迁移后行为不变。**

## 收尾附带项（非阻塞，plan 可捎带）

- **compat 指引（reviewer 建议）**：[compat.ts](../../src/lib/config/compat.ts) 旧键 `refusal_recover_text` 的弃用 message 或 bundled config.yaml 注释补一句「如需自定义 end_turn 文本见 `refusal_end_turn_text`」，降低老用户查找成本。
- **ui-v4 badge（可选）**：History 前端据 `synthetic:"refusal-recovery"` 加标注（对齐 keepalive 呈现），后端标记是硬目标、前端呈现可后续。

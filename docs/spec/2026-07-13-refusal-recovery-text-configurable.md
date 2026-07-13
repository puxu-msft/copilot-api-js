# Spec: refusal recovery / error 文本全可配 + 占位符模板

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

## 非目标

- 不改三模式门控逻辑（`isThinkingOnlyRefusal`、server_tool_use 排除、handler `ctx.fail` 归属）——见 docs/refusal-recovery.md，均不变。
- 不改 web_search 双跳旁路对 refusal 三模式无效的既有缺口（docs/refusal-recovery.md「已知缺口」）。
- 不动 history 保真（上游原始 `refusal` + `sseEvents` 始终记录真实上游，本 spec 只碰 forwarded/rendered 轨）。

## 与 ADR「合成物必打标记」的关系（无冲突）

ADR [richest-data-flow](../decisions/2026-07-05-richest-data-flow.md) §3 要求「往真实数据流注入的合成帧须可辨识」——约束的是**记录/元数据层**（`SseEventRecord.synthetic` 字段，history/UI 据此区分合成 vs 真实），**不要求**把标记塞进客户端可见文本。当前实现的 recovery 文本本就无内联标记。故「零包装」（客户端拿到的就是配置字节）与 ADR 不冲突。本 spec 不改动合成帧在记录层的 `synthetic` 标记（若已有则保留、缺失则属既有独立事项、不在本 spec 范围）。

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

| 占位符 | 值来源 | 可用时点 |
|---|---|---|
| `{model}` | `env.body.model`（非流式取 `response.model`） | createState（改写前已知） |
| `{request_id}` | `env.ctx` requestId | createState |
| `{thinking_tokens}` | `message_delta` usage.output_tokens（非流式取 `response.usage`） | message_delta 到达时 |

渲染规则（纯函数 `renderRefusalTemplate(tmpl, vars)`）：
- 简单 `{name}` 字面替换。
- **未知占位符原样保留**（不报错、不清空——避免用户手滑丢文本）。
- 无占位符的纯静态文本走同一路径、零副作用、与手写常量逐字节等价。
- `{stop_reason}` 恒为 `refusal`、价值低，暂不列入（YAGNI 边界，需要再加，不预留）。
- `error_type` 不做模板渲染（type 是 wire 判别字段，模板化无意义）。

## 空串语义（零包装的极致）

- `refusal_end_turn_text == ""`：**不追加任何 text 块**，只把 `stop_reason: refusal → end_turn`（清 `stop_details`）。客户端拿到「thinking + 干净 end_turn、无可见文本」——不 stall（end_turn 语义），且绝无代理注入物混进下一轮上下文。流式与非流式路径行为一致。
- `refusal_error_message == ""`：error 帧带空 message（合法 wire）。
- `refusal_error_type == ""`：视为未配、回落默认 `api_error`（type 不该为空，空串按缺省处理而非发空 type）。

## 实现塑形（改动点，how 细节留给 plan）

- **config**：[schema.ts](../../src/lib/config/schema.ts) 加三键；[config.ts](../../src/lib/config/config.ts) `setAnthropicBehavior` 映射进 state；[state.ts](../../src/lib/state.ts) 加三字段 + `CONFIG_MANAGED_DEFAULTS`（引用 `DEFAULT_*` 常量）。
- **recover-refusal.ts**（纯逻辑，不碰 config/state）：
  - 常量重命名 `REFUSAL_RECOVERY_TEXT → DEFAULT_REFUSAL_END_TURN_TEXT` 等，保留 export。
  - `buildSyntheticTextFrames(index)` → `buildSyntheticTextFrames(index, text)`；`text === ""` 时调用方跳过追加（或函数返回空数组，二选一在 plan 定）。
  - `createRefusalRecoverer` / `createRefusalErrorEmitter` / `recoverRefusalInResponse` 接收**已渲染好**的文本 + error type（渲染在 adapter 层做，纯逻辑模块保持无 config 依赖、可测边界不变）。
  - 新增纯函数 `renderRefusalTemplate(tmpl, vars)`。
- **adapter**（[response-rewrite-adapters.ts](../../src/lib/codec/anthropic/response-rewrite-adapters.ts)）：`createState` 从 `state.refusal*` 取模板 + 从 `env` 组装 model/request_id vars；thinking_tokens 在 message_delta 到达时补齐后渲染；非流式 `transformWhole` 同理从 response 组装 vars 后渲染。

## 测试

- **单元**：`renderRefusalTemplate` 真值表（已知占位符替换 / 未知占位符原样保留 / 空串 / 无占位符恒等）；`buildSyntheticTextFrames` 带自定义文本；空串路径「不追加块」。
- **golden 字节锁**（[response-rewrite-golden.http.test.ts](../../tests/anthropic/response-rewrite-golden.http.test.ts)）：现有 S6/S8 保持——**默认配置下与现状逐字节相同**（回归护栏）；新增 S8-custom（自定义模板渲染流式）+ S8-empty（空串不追加块）+ 非流式对应档。
- **热重载**（[config-hot-reload.it.test.ts](../../tests/config/config-hot-reload.it.test.ts)）：加三键条目，验证运行时改配置即时生效。

## 验收标准

1. 空配置下，三模式输出与现状逐字节相同（golden S6/S8 不变）。
2. 配自定义 `refusal_end_turn_text`（含 `{model}`/`{request_id}`/`{thinking_tokens}`）后，`end_turn` 注入的 text 块 = 渲染后的字节，无代理附加前后缀/标记。
3. 配 `refusal_end_turn_text: ""` 时，`end_turn` 模式不追加任何 text 块，仅 stop_reason → end_turn，客户端不 stall。
4. 配自定义 `refusal_error_message` / `refusal_error_type` 后，`error` 帧 message/type = 配置值（type 空串回落 `api_error`）。
5. 未知占位符原样保留、不致文本丢失或报错。
6. 三键支持运行时热重载。

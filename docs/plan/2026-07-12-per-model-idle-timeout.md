# 实施计划：per-model 流超时（stream idle + response header timeout override）

- **状态**：已按对抗评审意见修订（0 BLOCKER / 2 HIGH / 2 MEDIUM 已全部处理），待复审确认闭合后定稿
- **日期**：2026-07-12
- **权威 spec**：[docs/spec/2026-07-12-per-model-idle-timeout.md](../spec/2026-07-12-per-model-idle-timeout.md)（v2，已两轮对抗评审 + coordinator 亲手核验，附录 A 承重不变量 INV-1~INV-5）
- **配套 kick-off**：[docs/plan/2026-07-12-per-model-idle-timeout-kickoff.md](2026-07-12-per-model-idle-timeout-kickoff.md)
- **拟产出 ADR**：`docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md`（Phase 4 落地，若采纳）
- **重跑校验时间**：2026-07-12（本计划写作时对 spec 引用的全部行号/接口现状做了亲手核验，见各阶段「现状核实」小节；行号仍以实施时 grep 复核为准，代码在并发会话下会漂移）
- **修订记录**：2026-07-12 对抗评审（0 BLOCKER / 2 HIGH / 2 MEDIUM / 若干 LOW）后修订——HIGH-1（Phase 4a 调用点在 chat-completions/responses/gemini 3 端点不可达，`codec.getContext()` 在 `driver.runRequest()` 返回前恒为 `undefined`）改为定死 `result.env.ctx`（`runRequest` 返回后、`ok:true` 分支内，`RequestEnvelope.ctx` 是必填字段，恒非空）+ 5 处集成断言强制；HIGH-2（§7.4 反证守卫 grep 路径 `src/lib/transport/proxy.ts` 不存在，真实路径是 `src/lib/proxy.ts`）已改正；另修正 2 条 MEDIUM（INV-5 grep oracle 自相矛盾、补第 4 个 `_pipelineInfo` 读点）+ 若干 LOW（`anthropic/client.ts` 定死 `wire.model`、`fetch-utils.ts` 定义点排除、Phase 2/3 并行冲突文件提示、行号校准）。

## 0. 范围与不变量总览

范围 = spec §2.1 全部 5 条目标 + §10「不做」列表逐条落实为「不做」（无需代码，但需在 ADR / 计划中显式记录，防止被误当遗漏）。不新增、不删减 spec 已定范围。

INV 与阶段映射（每条都必须有对应测试，见下方各阶段「测试」小节）：

| 不变量 | 一句话 | 落在哪个阶段 |
|---|---|---|
| INV-1（H3） | 两个 override map 进 `.strict()` schema + `RECORD_MERGE_STRATEGIES` 注册 per-key；bundled+user per-key merge，非 replace/非值级 union | Phase 1 |
| INV-1'（非 union） | 键级覆盖，不会出现同键两个值 union | Phase 1（同一测试覆盖） |
| INV-2（threading 边界） | 深层流处理器（`streamWsEvents`/`processAnthropicStream`）只吃算好的 `idleTimeoutMs`，不认识 model | Phase 2 |
| INV-5（穷尽，含第 8 读点排除） | 全部 7+7 个具体读点/调用点逐一切到 resolver（**不是**全局 grep `state.streamIdleTimeout` 归零——该 scalar 在 `src/lib/proxy.ts` 有合法保留用途，见下方订正） | Phase 2 + Phase 3（各自收尾，逐点核对清单，非全局 grep 判据） |
| §7.4 反证守卫 | override（**不是标量**）读点不得出现在 `src/lib/proxy.ts`/`src/lib/transport/http2-client.ts`（transport 层） | Phase 4（随 ADR 落地，但 grep 断言可在 Phase 2/3 收尾时先跑） |
| LOW（键空间一致性） | 同一请求 `resolvedName`（stream_idle 侧）与 `wire.model`（response_header 侧，经 `send.ts` 的 `modelId`）归一化后应恒等 | Phase 3 |

**架构边界重申（不在本计划改动范围内，属 gating 但已由 spec 拍板、非待决）**：两个 knob 都是纯 app-guard，不碰 undici/transport dispatcher；不做 per-model 熔断；不改 buffered 重试；不做 `/api/status` 新端点。这些是 spec §2.2/§10 已定的非目标，本计划不重新提出，仅在 ADR 中固化成文。

---

## Phase 1 — Config schema + resolver（纯单元 TDD，无 handler 改动）

### 目标

两个新键 `timeouts.stream_idle_overrides` / `timeouts.response_header_overrides` 端到端可配置：YAML → schema 校验 → per-key merge → state → resolver 解析出 effective 值。此阶段完成后，`resolveStreamIdleTimeoutMs("gpt-5.5")` 已能返回正确值，但**尚未接入任何请求路径**（Phase 2/3 才接线）。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `src/lib/config/schema.ts` | 新增命名 const `StreamIdleOverridesSchema` / `ResponseHeaderOverridesSchema`（`z.record(z.string(), z.number().int().nonnegative())`），接入 `TimeoutsConfigSchema`（保持 `.strict()`）；`RECORD_MERGE_STRATEGIES.set(..., "per-key")` 各注册一次 |
| `src/lib/state.ts` | `MutableState` 新增 `streamIdleTimeoutOverrides: Record<string, number>` / `responseHeaderTimeoutOverrides: Record<string, number>`；`CONFIG_MANAGED_DEFAULTS` 两者初值 `{}`；新增 `setTimeoutOverridesConfig(patch)`（**replace 语义**，仿 `setModelOverrides`/`setDisabledModels` 单字段 setter，**不**触发 `transportTimeoutListeners`——这两个 map 与 undici dispatcher 无关，§7 已定） |
| `src/lib/models/timeout-resolver.ts`（新文件） | `resolveStreamIdleTimeoutSec/Ms`、`resolveResponseHeaderTimeoutSec/Ms`，复用 `findMostSpecific`（`~/lib/anthropic/per-model-config`）；0 统一判为禁用（spec §5.2） |
| `src/lib/config/config.ts` | `if (config.timeouts)` 装配块（现 config.ts:722-729）追加两行：`if (t.stream_idle_overrides !== undefined) setTimeoutOverridesConfig({ streamIdleTimeoutOverrides: normalizeModelKeyedRecord(t.stream_idle_overrides, "timeouts.stream_idle_overrides") })`，`response_header_overrides` 同理 |
| `config.yaml`（bundled，仓库根，**不要**碰 `.worktrees/*/config.yaml` 副本） | `timeouts:` 段（现 145-179 行）追加 `stream_idle_overrides:\n  gpt-5.5: 600` + 双语注释（对齐既有 `timeouts:` 段风格）；`response_header_overrides: {}` 留空占位 + 注释说明「bundled 不内置值」 |
| `docs/DESIGN.md` | 配置表（`responseHeaderTimeout`/`streamIdleTimeout` 现 374-375 行）追加两行 `streamIdleTimeoutOverrides`/`responseHeaderTimeoutOverrides` | 

> **现状核实**（写计划时亲手读过，非推断，2026-07-12 评审复核过一次行号）：`TimeoutsConfigSchema` 现在 schema.ts:685-698，`.strict()`；`RECORD_MERGE_STRATEGIES` 注册表 schema.ts:889-895（`RECORD_MERGE_STRATEGIES.set(ModelOverridesSchema, "per-key")` 在 :891），`ModelOverridesSchema` 是唯一现有 per-key 先例；`config.ts:722-729` 是 `timeouts` 装配块；`state.ts:625/634` 是标量 `responseHeaderTimeout`/`streamIdleTimeout` 定义处，`state.ts:1261-1277` 是 `setTimeoutConfig`（**会**触发 `transportTimeoutListeners`——新 setter 故意不复用它，避免误触发 undici dispatcher 重建）；`findMostSpecific` 在 `src/lib/anthropic/per-model-config.ts:33-46`，`normalizeModelKeyedRecord` 在 `src/lib/models/resolver.ts:73-86`。**实施时行号仍需再 grep 一次**——本计划两轮核实间隔数小时，代码在并发会话下继续会漂移，此处只保证"计划写作/评审时刻"的准确性，不是永久锁定。

### TDD 步骤（先写失败测试）

1. **INV-1 config 层测试**（新文件 `tests/config/timeout-overrides-config.unit.test.ts`，仿现有 `tests/config/config-merge.unit.test.ts` 的 `setBundledConfigForTests`/`writeUserConfig`/`loadConfig` harness）：
   - bundled `{gpt-5.5: 600}` + user 缺省 → merged `{gpt-5.5: 600}`（内置不丢）。
   - bundled `{gpt-5.5: 600}` + user `{}`  → merged `{gpt-5.5: 600}`（**关键回归**——H3 教训：显式空对象不能抹掉内置）。
   - bundled `{gpt-5.5: 600}` + user `{gpt-5.5: 900}` → merged `{gpt-5.5: 900}`（用户覆盖单键）。
   - bundled `{gpt-5.5: 600}` + user `{gpt-5.5: 0}` → merged `{gpt-5.5: 0}`（显式禁用，非删除）。
   - user 新增独立键 `{"gpt-5.6": 700}`（bundled 无此键）→ merged 两键并存（per-key 加法语义）。
   - `response_header_overrides` 对称重复上述（bundled 默认空 `{}`，无内置值这条单独测）。
   - 无效值（负数/非整数）→ zod 拒绝，走 warn-and-continue 路径（不 throw、不杀进程），参照 `config-validation.unit.test.ts` 的既有断言风格。
2. **INV-1 state 层测试**（同文件或 `tests/models/timeout-resolver.unit.test.ts` 内）：`normalizeModelKeyedRecord` 折叠后落 `state.streamIdleTimeoutOverrides`，`resolveStreamIdleTimeoutMs("gpt-5.5")===600000`，未命中模型 `=== state.streamIdleTimeout*1000`（scalar 回退）。用 `setStateForTests` 直接注入 override map，隔离 config 装配层。
3. **resolver 单元测试**（`tests/models/timeout-resolver.unit.test.ts`，仿 `tests/anthropic/per-model-config.unit.test.ts` 的用例结构）：
   - 最长子串胜（`gpt-5.5-codex` 命中 `gpt-5.5` 键，`findMostSpecific` 既有行为的直接复用验证——非新逻辑，但复用点需要单测锁定接口契约）。
   - **等长键 tie-break**（spec §3.2 边界测试）：两个等长子串键同时匹配同一模型名，取插入序中先声明者（对齐 `findMostSpecific` 现有 `key.length > bestKey.length`严格 `>` 语义——用一个专门构造的最小复现案例，不依赖内置 gpt-5.5）。
   - 0 值语义：override 命中值为 `0` → resolver 返回 `0`（ms），调用方据此判「已禁用」（与既有 `createResponseHeaderTimeoutSignal` 的 `>0?...:undefined` 约定对齐，此处先只测 `Sec`/`Ms` 两级函数本身）。
   - `model` 为 `undefined` → 直接回退 scalar，不查表。
   - 无 config.yaml（override map 为空对象场景）→ 全部回退 scalar 300（模拟"bundled 缺失"退化路径，用 `setStateForTests({ streamIdleTimeoutOverrides: {} })`）。
4. 实现：写 `timeout-resolver.ts` + schema/state/config.ts 改动，跑绿以上全部测试。
5. `bundled-config.unit.test.ts` 追加一条 `"bundled defaults declare gpt-5.5 stream-idle override (600s)"`，断言 `loadBundledDefaultConfig()` 返回的 `config.timeouts?.stream_idle_overrides?.["gpt-5.5"] === 600`（确保 §4.2 落地机制未来不因误改回退到 CONFIG_MANAGED_DEFAULTS 或代码常量）。
6. `config-schema-json-export.unit.test.ts` 现有 `for (const key of [...])` 存在性检查不必新增（它只测 section 级键，`timeouts` 已在列表里），但实施后应手工确认该测试仍绿（新增字段不影响 section 级存在性断言）。

### 验收判据

- 上述全部单元测试绿；`bun test tests/config tests/models`（或等效路径）全绿。
- `docs/DESIGN.md` 配置表新增两行，措辞与既有 `responseHeaderTimeout`/`streamIdleTimeout` 行对称。
- 无 handler/transport 文件改动（本阶段严格是 config+resolver 层，Phase 2/3 才碰请求路径——这是故意的小步提交边界，便于 `git commit` 按语义单元切分）。

### 风险

- `RECORD_MERGE_STRATEGIES` 是 `WeakMap<z.ZodType, ...>`，注册键必须是**具名 const 的稳定引用**（spec 已强调）——若不慎在 `TimeoutsConfigSchema` 内联 `z.record(...)` 而不提取成 const，`RECORD_MERGE_STRATEGIES.set` 拿不到同一个对象引用，per-key merge 会静默退化为 replace（H3 复发）。TDD 步骤 1 的「user `{}`」用例正是防这个回归的关键断言，**不可省略**。

---

## Phase 2 — stream_idle 读点 threading（7 处，承重）

### 目标

spec §5.3 全部 7 个 app-level 流式读点从 `state.streamIdleTimeout * 1000`（或 `>0?...:0` 变体）切到 `resolveStreamIdleTimeoutMs(resolvedName/resolvedModel/model)`。深层函数（`streamWsEvents`/`processAnthropicStream`）签名新增可选 `idleTimeoutMs` 透传参，**不透传 model 字符串**（INV-2）。

### 现状核实（写计划时逐点亲手读过，行号与 spec v2 一致，无漂移）

| # | 读点 | 文件:行 | 现状代码 | model 变量（已在场） |
|---|---|---|---|---|
| 1 | messages SSE | `routes/messages/handler-v4.ts:350` | `idleTimeoutMs: state.streamIdleTimeout * 1000` | `resolvedName`（函数参数） |
| 2 | chat-completions SSE | `routes/chat-completions/handler-v4.ts:145` | 同上 | `resolvedName` |
| 3 | responses SSE | `routes/responses/handler-v4.ts:135` | 同上 | `resolvedName` |
| 4 | gemini SSE | `routes/gemini/handler-v4.ts:110` | 同上 | `resolvedName`（`buildGeminiDriver` 参数） |
| 5 | responses WS | `routes/responses/ws.ts:229` | `idleTimeoutMs: state.streamIdleTimeout > 0 ? state.streamIdleTimeout * 1000 : 0` | `resolvedModel` |
| 6 | 上游 WS 帧-idle | `lib/openai/upstream-ws-attempt.ts:211`（`streamWsEvents` 内部）；caller `attemptUpstreamResponsesWs`（88 行 `const { wire } = prepared`，168 行 `generator: streamWsEvents({...})`） | `const idleTimeoutMs = state.streamIdleTimeout > 0 ? state.streamIdleTimeout * 1000 : 0`（209-210 行左右，函数内部计算） | `wire.model`（caller 已解构，第 88/99/112 行都用到） |
| 7 | Anthropic SSE | `lib/anthropic/stream.ts:64`（`processAnthropicStream` 内部）；caller `routes/messages/web-search-direct.ts:433` | `const idleTimeoutMs = state.streamIdleTimeout * 1000` | `anthropicPayload.model`（caller 已在场，129/369 行等多处引用） |

### 涉及文件与改法

1. **读点 1-4**（4 个 HTTP handler）：把 `idleTimeoutMs: state.streamIdleTimeout * 1000` 原地替换为 `idleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedName)`（gemini 是 `resolveStreamIdleTimeoutMs(resolvedName)`，注意 gemini 的变量名也是 `resolvedName`，非 `modelId`——确认过 `buildGeminiDriver(c, modelId, resolvedName, vendor?)` 两个都在场，用 `resolvedName` 与其余三处保持一致）。
2. **读点 5**（`ws.ts:229`）：同样替换为 `resolveStreamIdleTimeoutMs(resolvedModel)`，注意 resolver 内部已判 0（spec §5.2），故可以简化调用点为 `idleTimeoutMs: resolveStreamIdleTimeoutMs(resolvedModel)`（不再需要三元判断，resolver 统一处理 0 语义——**顺手清理**，属于本次改动的自然产物，非范围蔓延）。
3. **读点 6**（`upstream-ws-attempt.ts`）：
   - `StreamWsEventsOptions` 接口新增 `idleTimeoutMs: number`（必填，调用方总是能算）。
   - `streamWsEvents` 函数体删掉 `const idleTimeoutMs = state.streamIdleTimeout > 0 ? ... : 0` 这行，改用 `opts.idleTimeoutMs`。
   - 唯一 caller `attemptUpstreamResponsesWs`（返回 `{ kind: "ok", generator: streamWsEvents({...}) }` 处）新增一行 `const idleTimeoutMs = resolveStreamIdleTimeoutMs(wire.model)`，塞进 `streamWsEvents({ ..., idleTimeoutMs })`。
4. **读点 7**（`anthropic/stream.ts`）：
   - `processAnthropicStream` 签名新增可选第 5 参 `idleTimeoutMs?: number`（放在 `shutdownSignal` 之后或之前均可，注意**不要打乱既有位置参数顺序**——现有调用签名是 `(response, acc, clientAbortSignal?, shutdownSignal?)`，新参建议追加在最后 `idleTimeoutMs = resolveStreamIdleTimeoutMs(undefined)` 作默认值，保持向后兼容——spec 原文即此建议）。
   - 函数体 `const idleTimeoutMs = state.streamIdleTimeout * 1000` 改为读参数（若调用方未传则用默认值）。
   - 唯一生产调用点 `web-search-direct.ts:433`（`processAnthropicStream(response, acc, clientAbortSignal)`）改为传入第 4 参 `resolveStreamIdleTimeoutMs(anthropicPayload.model)`（注意会跳过 `shutdownSignal` 位——需要显式传 `undefined` 占位，或把 `idleTimeoutMs` 放在 `shutdownSignal` **之前**以避免调用点要传两个可选默认值；实施时选一种、写清注释，**这是本阶段唯一需要在编码前拍板的参数排布小分叉**，判据 = 让唯一生产调用点最简洁，不引入无谓 `undefined` 占位）。
   - 检查是否存在其他测试文件直接调用 `processAnthropicStream`（预期有，见下方测试小节），签名改动需要同步这些调用点。

### TDD 步骤

1. **resolver 集成先行**：Phase 1 已锁定 resolver 契约，本阶段不需要新增 resolver 测试，只需**读点级** threading 测试。
2. 为读点 1-5（4 handler + ws.ts）各写/扩展一条**单元级**测试：不需要真实网络请求或真等 idle timeout——用现有该 handler 的 transport-factory 测试（若已存在）注入 mock/spy `resolveStreamIdleTimeoutMs`，断言被以正确 model 参数调用；若该文件没有对应现有测试基础设施，改用**桩替代**（`spyOn` 目标模块的 resolver 导出）而非真实驱动整条 handler 集成测试（成本/信噪比更优，遵循 `tiered-review-by-risk` 精神——机械 threading 用最轻量测试锁定，非每处都要端到端）。
   - 具体做法：`spyOn(timeoutResolver, "resolveStreamIdleTimeoutMs")`（若模块允许 mock；Bun test 对 ESM named export mock 需要用 `mock.module` 或依赖注入包装——**实施前用 `grep -rn "mock.module" tests/`** 确认项目现有 mocking 手法，勿凭空发明新模式）。
   - 断言重点：① 被调用时传入的 model 参数与该 handler 的 `resolvedName`/`resolvedModel` 一致；② handler 最终构造的 transport/driver 收到的 `idleTimeoutMs` 数值与 resolver mock 返回值一致。
3. 读点 6（`streamWsEvents`）：新增/扩展 `tests/openai/upstream-ws-attempt` 相关单测（若存在，先 `find`/`grep` 确认现有测试文件名），断言 `attemptUpstreamResponsesWs` 传给 `streamWsEvents` 的 `idleTimeoutMs` 随 `wire.model` 变化（用 override 命中一个测试模型名，验证非 300s 默认值透传）。
4. 读点 7（`processAnthropicStream`）：现有测试文件（需先 `grep -rln "processAnthropicStream" tests/`）大概率已覆盖该函数的 idle-timeout 行为（既有 300s 默认场景）——签名改动后补一条：显式传入 override 值时函数体确实使用它（不再读 `state.streamIdleTimeout` 全局）。
5. **INV-2 回归测试**（新增，锁定「深层函数不认识 model」边界）：对 `streamWsEvents`/`processAnthropicStream` 直接调用（不经过 handler），只传数字 `idleTimeoutMs`，断言其行为完全由该数字决定、与 `state.streamIdleTimeoutOverrides`/model 名无关（即使传一个在 override 表里的假 model 字符串给 `wire.model`/`anthropicPayload.model`，只要 `idleTimeoutMs` 参数固定，函数内部计时器行为不变）——这条测试的价值是防止未来有人把 model 直接下沉进这两个函数、破坏 INV-2 的 threading 边界。
6. **INV-5 穷尽核对（订正——不是全局 grep 归零判据）**：`grep -rn "state.streamIdleTimeout\b" src/` **不会**只剩 2 处——`src/lib/proxy.ts` 有 3 处**合法保留**的标量读取（:105 `bodyTimeout: scaleTimeout(state.streamIdleTimeout)` 服务 undici/SearXNG 标量路径，spec §7.3 明确不动；:223/:247 是 debug 日志），加上 `state.ts` 定义处、`transport/http-transport.ts:45`/`transport/responses-transport.ts:56` 的 doc-comment、`timeout-resolver.ts` 内部读 scalar 回退——全局 grep 会命中一大批**都合法**的位置，**不能**用"归零"当验收判据（若实施者据此去改 `proxy.ts:105` 会破坏 SearXNG 标量路径，是真实回归风险）。正确判据 = **逐点核对上表 7 行读点清单**，每行确认已从 `state.streamIdleTimeout * 1000`（或三元变体）切到 `resolveStreamIdleTimeoutMs(...)`；辅助 grep 改为**只搜 override 侧**（`grep -rn "streamIdleTimeoutOverrides" src/lib/proxy.ts src/lib/transport/http2-client.ts` 应为空，这是 §7.4 反证守卫的前置抽查，真正落地在 Phase 4b）。

### 验收判据

- 7 个读点全部改为经 resolver 解析（逐点核对上表清单，**不用**全局 `grep state.streamIdleTimeout` 计数当判据——见 TDD 步骤 6 订正说明，`src/lib/proxy.ts` 有多处合法保留的标量读取）。
- `bun test`（涉及 handler-v4/ws/upstream-ws-attempt/anthropic-stream 的现有测试套件）全绿，无回归（既有默认 300s 行为在无 override 命中时必须逐字节不变——这是隐式的向后兼容承诺，即使项目整体奉行"无向后兼容负担"，这里的"不变"是**默认值语义不变**，不是"允许破坏现有测试"）。
- Phase 1 起的所有测试仍绿。

### 风险

- Bun test 对 named-export 函数的 mock/spy 支持有限（ESM 只读绑定），若 `mock.module` 用法不熟，实施者应先花 5 分钟 grep 项目里类似"mock 一个被多处 import 的纯函数"的先例（例如 `resolveEffort`/`findSupportedEfforts` 有没有被 mock 过），照抄现有手法，而不是发明新 mocking 机制——**不确定处交给实施 subagent 现场探查，本计划不代为决定测试双写具体 API**（避免计划层过度指定实现细节）。
- gemini handler 的两个变量名 `modelId`/`resolvedName` 容易搞混，实施时以 `resolveStreamIdleTimeoutMs(resolvedName)` 为准（已核实）。

---

## Phase 3 — response_header 读点 threading（7 处 + 键空间一致性断言）

> **并行提醒（LOW，评审补漏）**：Phase 2 与 Phase 3 共享 `src/lib/openai/upstream-ws-attempt.ts` 一个文件（Phase 2 读点 6 改 :211 附近的 `streamWsEvents`/`attemptUpstreamResponsesWs`；Phase 3 调用点改 :138 的 `createResponseHeaderTimeoutSignal()` 调用），且都会 `import` 同一个新文件 `timeout-resolver.ts`。若两阶段真的并行执行（不同会话/分支），须遵守 `git-preference:avoiding-shared-worktree-conflicts`（行级共存 + 显式 pathspec commit）或直接把该文件的两处改动串行化（谁先谁后不重要，但不要两边同时改同一文件不通气）。

### 目标

spec §5.4：`createResponseHeaderTimeoutSignal()` 增可选 `model?: string` 参，内部改用 `resolveResponseHeaderTimeoutMs(model)`；5 个调用点补传 model，2 个（catalog、SearXNG）显式保持 scalar。

### 现状核实

| 调用点 | 文件:行 | 现状 | model 变量 |
|---|---|---|---|
| `createResponseHeaderTimeoutSignal` 定义 | `fetch-utils.ts:23-25` | `state.responseHeaderTimeout > 0 ? AbortSignal.timeout(...) : undefined` | — |
| HTTP send 核心 | `transport/send.ts:113` | `combineAbortSignals(createResponseHeaderTimeoutSignal(), ...)`；`modelId` 已在 105 行解构（`SendUpstreamHttpParams`） | `modelId` |
| Anthropic direct | `anthropic/client.ts:120` | `combineAbortSignals(createResponseHeaderTimeoutSignal(), ...)`；`model = wire.model as string` 在 104 行（`payload.model` 是函数参数，即客户端原始未 prepare 的模型名；`wire.model` 是 `prepareAnthropicRequest` 处理后的 wire 值） | **定死用 `wire.model`**（非 spec §5.4 表原文的 `payload.model`——record-not-adopted：`wire.model` 与 `send.ts` 的 `modelId` 键空间一致，两者都是"实际发給上游的模型名"，便于 Phase 3 步骤 3 的 LOW 键空间一致性断言直接比较；`payload.model` 是客户端原始输入，可能在 prepare 阶段被改写，用它会让键空间断言产生虚假不一致） |
| 上游 WS 首字节 | `openai/upstream-ws-attempt.ts:138` | `const fetchSignal = createResponseHeaderTimeoutSignal()`；`wire.model` 在场（88 行起） | `wire.model` |
| count-tokens | `routes/messages/count-tokens.ts:68`（`signal: createResponseHeaderTimeoutSignal()`） | `model` 变量在 42 行定义（`payload.model.replaceAll(".", "-")`） | `model` |
| embeddings | `openai/embeddings.ts:28` | `combineAbortSignals(createResponseHeaderTimeoutSignal(), getShutdownSignal())` | `payload.model` |
| **models catalog**（保持 scalar） | `models/client.ts:49` | `signal: createResponseHeaderTimeoutSignal()` | 无 model 概念——**故意不传** |
| **SearXNG**（保持 scalar） | `web-search/backends.ts:316` | `createResponseHeaderTimeoutSignal() ?? AbortSignal.timeout(SEARXNG_TIMEOUT_MS)` | 本地 http，非 GHC——**故意不传** |

### 涉及文件与改法

1. `fetch-utils.ts`：`createResponseHeaderTimeoutSignal(model?: string): AbortSignal | undefined` → 内部 `const ms = resolveResponseHeaderTimeoutMs(model); return ms > 0 ? AbortSignal.timeout(ms) : undefined`。
2. `send.ts:113`：`createResponseHeaderTimeoutSignal(modelId)`。
3. `anthropic/client.ts:120`：`createResponseHeaderTimeoutSignal(model)`。
4. `upstream-ws-attempt.ts:138`：`createResponseHeaderTimeoutSignal(wire.model)`。
5. `count-tokens.ts:68`：`createResponseHeaderTimeoutSignal(model)`（低价值但对称，spec 已定要做）。
6. `embeddings.ts:28`：`createResponseHeaderTimeoutSignal(payload.model)`。
7. `models/client.ts:49` / `web-search/backends.ts:316`：**不改**，各自补一行注释说明"故意保持 scalar，见 spec §5.4 表"（防未来人补漏时误加）。

### TDD 步骤

1. `timeout-resolver.ts` 已有 `resolveResponseHeaderTimeoutSec/Ms`（Phase 1 已测），本阶段新增 `createResponseHeaderTimeoutSignal(model?)` 的单元测试（`tests/lib/fetch-utils.unit.test.ts` 或既有同名测试文件，先 `grep -rln "createResponseHeaderTimeoutSignal" tests/` 确认落点）：
   - 无参调用 → 等价于旧行为（回归断言，防止签名改动悄悄改变默认路径）。
   - 传入命中 override 的 model → 返回的 `AbortSignal` 超时值反映 override（用 `AbortSignal.timeout` 不易直接读出剩余 ms，测试策略二选一：① mock `AbortSignal.timeout` 断言被调用参数；② 用 fake timer 驱动，断言在 override 秒数而非 scalar 秒数触发 abort——**优先①**，成本更低、无需等待真实/fake 时间流逝）。
   - override 值为 `0` → 返回 `undefined`（禁用语义，对齐既有 `>0?...:undefined` 约定）。
2. 5 个调用点各补一条"以正确 model 参数调用 `createResponseHeaderTimeoutSignal`"的 spy 断言（同 Phase 2 的 mocking 策略选择）。
3. **LOW（键空间一致性）断言**（spec 评审尾巴，新增测试）：选一条已有 HTTP 端到端/集成测试（如 chat-completions 或 messages 的 driver 集成测试，走完整 codec→send 链路，能同时观测到 handler 的 `resolvedName` 与 `send.ts` 收到的 `modelId`），断言 `normalizeForMatching(resolvedName) === normalizeForMatching(wire.body.model)`。**若该断言在某条 reverse-translate leg（如 CC→Anthropic 翻译）下失败**（因为 wire body 的 model 字段可能被翻译层重写为目标格式的模型名），需要在测试里明确记录该 leg 被排除的理由（而非静默放宽断言）——这是本阶段**唯一需要实施时现场判断的分叉点**，判据：direct/fallback leg（未翻译）必须恒等，reverse-translate leg 若不等则是已知架构现实（不同格式对模型名的表示可能不同），记录而非强行拉齐。
4. `models/client.ts` / `web-search/backends.ts` 各加一条**反向**测试（或注释级 grep 断言）：确认这两处调用 `createResponseHeaderTimeoutSignal()` 时**不带参数**（防止未来 PR 误加）。
5. **INV-5 全量 grep oracle**（本阶段 + Phase 2 合并收尾）：`grep -rn "createResponseHeaderTimeoutSignal(" src/` 结果共 **8 处**——1 处是 `fetch-utils.ts:23-25` 的**函数定义本身**（`export function createResponseHeaderTimeoutSignal(model?: string)`，不是调用点，排除在外）+ 7 处调用点逐条核对：5 处带 model 参、2 处（catalog/SearXNG）不带参，无第 3 类。

### 验收判据

- 7 个调用点按上表落地；`grep -rn "createResponseHeaderTimeoutSignal(" src/` 结果共 8 处（1 定义 + 7 调用），与上表一一对应。
- LOW 键空间断言落地为一条可重复运行的测试（不是一次性人工核验）。
- Phase 1/2 测试仍绿。

### 风险

- `count-tokens.ts`/`embeddings.ts` 两处是"低价值但对称"（spec 原话），实施时间成本应压到最低（不需要像 send.ts 那样写专门集成测试，spy 级单测即可）——避免在低风险机械改动上过度投入评审/测试成本（`tiered-review-by-risk`）。

---

## Phase 4 — D2 history 诊断 + 拟 ADR 落地（可与 Phase 2/3 部分并行）

本阶段两个子任务彼此独立、无依赖，可并行执行（谁来执行由主会话编排决定，本计划只给出可并行性判断）：

### 4a — history `pipelineInfo.streamIdleTimeoutMs`（+ 可选 `responseHeaderTimeoutMs`）

#### 关键架构风险（本计划核实到的、spec 未展开的实现细节，写计划时亲手读过 `context/request.ts`）

`ctx.setPipelineInfo(info)` 是**全量替换**语义（`_pipelineInfo = info`，`context/request.ts:411-414` 注释明written"Direct assignment — caller assembles the complete PipelineInfo"）。生产代码里有 **4 个独立调用点**（`codec/anthropic/request-rewrite-adapter.ts:87`、`codec/openai-cc/reverse-anthropic-rewrite.ts:104`、`routes/messages/handler-v4.ts:702`、`routes/messages/web-search-direct.ts:247/274`），且**并非每个请求都会触发**任意一个（它们各自门控在"有 sanitization/preprocessing/truncation 变化时才调用"）。若直接在某个 handler 早期调用 `ctx.setPipelineInfo({ streamIdleTimeoutMs })`，后续任一个上述调用点触发时会把整个 `_pipelineInfo` 对象**整体覆盖**、静默丢失 `streamIdleTimeoutMs`（该请求若无 sanitization 变化则又完全不触发，字段从未落盘）。这不是 spec 遗漏，是"新增跨请求生命周期全程有效的标量字段"与"现有 per-attempt 增量式 full-replace 写入模型"的天然冲突，必须在实现层面解决，且需要**不改动**这 4 个既有调用点（改 4 个陌生模块的行为，风险/信噪比远差于开一个独立通道）。

还有一个额外的 `_pipelineInfo` 读点（评审补漏，MEDIUM）：`context/request.ts:825-826` 的 `if (_pipelineInfo?.preprocessing) { entry.preprocessing = _pipelineInfo.preprocessing }`——这是 entry-level 一次性 `preprocessing` 投影（RFC §4 hoist），**只读 `preprocessing` 子字段**，与本次新增的 `streamIdleTimeoutMs`/`responseHeaderTimeoutMs` 正交，**不需要**接入 `mergedPipelineInfo()`。记录在案防止合并态评审误判"只改了两处、漏了第三处"——它是故意排除，不是遗漏。

**HIGH-1（2026-07-12 对抗评审 + coordinator 亲手核验，已定死）——调用点可达性问题**：原设计把"Phase 2 改过的那一行紧邻处"当作 `setStreamTimeouts` 的调用点，标为"待实施时现场验证可达性"。评审证伪：`codec.getContext()` 在 chat-completions（`handler-v4.ts:145` 创建 transport 处）/ responses（`:135`）/ gemini（`:110`）这 3 个端点**在该行位置恒为 `undefined`**——三者的 codec `parse()` 都要等到 `driver.runRequest()` 内部调用（`pipeline/driver.ts:169` `deps.codec.parse(raw)`）才会把 `requestContext` 关联上（`codec/openai-cc/codec.ts:225-229`、`codec/openai-responses/codec.ts:237-242`、`codec/openai-gemini/codec.ts` 委托 cc 的 parse），而 Phase 2 的 threading 行（构造 `transport`/`buildGeminiDriver` 处）在 `runRequest` **之前**执行。若在那一行调 `codec.getContext()?.setStreamTimeouts(...)`，`?.` 会静默 no-op、`streamIdleTimeoutMs` 从未落盘——且**不会报错**，是纯静默失效。messages 端点因为有 eager `manager.create()` + `c.set("requestContext", reqCtx)`（`handler-v4.ts:293/302`，在 `runMessagesDriver` 之前的 `createWebSearchContext`-同构路径）侥幸能在早期就拿到 ctx，会诱导实施者误以为"照抄 messages 的位置"对其余 4 个端点也成立——**这正是评审抓到的诱导性陷阱，plan 必须显式排除**。

**改法（本次修订定死，不再留给实施者现场判断）**：调用点从"Phase 2 threading 行紧邻处"**移到 `driver.runRequest()` 返回之后、`result.ok === true` 分支内**，统一读 `result.env.ctx`（`RequestEnvelope.ctx` 是必填字段——`pipeline/envelope.ts:113` `readonly ctx: RequestContext`——只要 `result.ok===true`，`result.env.ctx` **恒非空**，不需要 `?.` 防御式访问，也不依赖任何端点特有的 eager-create 侥幸路径）：

| 端点 | 定死调用位置 | 说明 |
|---|---|---|
| chat-completions | `handler-v4.ts`，`result = await driver.runRequest({...})` 成功返回后（现 :202-211 附近，`catch` 块之后、`if (!result.ok)` 判断之前或之后均可，取 `result.ok` 为真的分支内） | `result.env.ctx.setStreamTimeouts({ streamIdleTimeoutMs })`，`streamIdleTimeoutMs` 复用 Phase 2 已在 :145 算好的同一个值（提前把该值存进一个局部变量，两处共用，不要重算） |
| responses（SSE） | `handler-v4.ts`，同构（现 :174-183 附近） | 同上 |
| gemini | `handler-v4.ts` 的 `buildGeminiDriver` 调用方（`runGeminiRequest` 类似函数，现 :169-178 附近，返回 `{ bundle, result }` 之前） | 同上；`buildGeminiDriver` 内部 `result` 类型是 `Extract<DriverRequestResult, { ok: true }>`（已缩窄），可直接 `result.env.ctx` |
| responses WS | `ws.ts`，`result = await driver.runRequest({...})` 成功后（现 :244-253 附近，`if (!result.ok)` 判断之后、`const { upstream, env } = result` 解构处天然可得 `env.ctx`） | `env.ctx.setStreamTimeouts({ streamIdleTimeoutMs })`；`ws.ts` 本身在 :229 直接算 `idleTimeoutMs`，同样提前存局部变量复用 |
| messages | `handler-v4.ts`，`runMessagesDriver` 内 `p = driver.runRequest({...})` 结算后的 `runUpstreamSettledPath`/POST-COMMIT 两条分支（现 :455/`commitCtx` 一带，或统一在 `result.ok` 为真处） | messages 有 eager ctx（`codec.getContext()` 提前可用）**不代表应该用它**——为了与其余 4 个端点保持同一模式（防未来读者误以为两种模式都可、造成设计漂移），**同样**改用 `result.env.ctx`（driver 结算后），不利用 messages 特有的早期可达性；若实施者认为 messages 用 `codec.getContext()` 更符合该文件既有风格，需在实施记录里说明理由，本计划推荐统一 `result.env.ctx` 以降低跨端点心智负担 |

anthropic direct（`anthropic/client.ts`）与 web-search-direct 路径不经过 `driver.runRequest`（走独立的 legacy ctx，见 §改法 4a 调用点表下方备注），改用其本已在场的 `reqCtx`/ctx 变量（这两处的 ctx 生命周期不同于 codec-driven 4 端点，本身不受 HIGH-1 影响——它们的 ctx 从函数开始就已创建好，`setStreamTimeouts` 随时可调用；具体调用行由实施者在改 Phase 2 读点 6/7 时顺手加一行，位置=紧邻 `resolveStreamIdleTimeoutMs(...)` 调用处即可，因为这两处的 ctx 从来不是"延迟关联"的）。

**强制要求（本次修订新增，替代原"开放点"表述）**：Phase 4a 收尾必须有 **5 条独立的集成测试**（chat-completions / responses SSE / responses WS / gemini / messages 各一条），各自发一条请求、走完整落盘路径，回读 history entry 断言 `pipelineInfo.streamIdleTimeoutMs` 非空且与该请求的 effective 值一致——**不是**"挑一个 handler 验证"（原表述），因为 messages 的侥幸可达性会让"只测 messages"这条捷径产生假阳性、掩盖其余 4 个端点的静默失效。

**设计（本计划的实现建议，未改变任何公开 API/wire 协议，纯 `context/request.ts` 内部机制，供实施者细化）**：
1. 在 `context/request.ts` 内新增一个与 `_pipelineInfo` 平行的私有变量 `_streamTimeouts: { streamIdleTimeoutMs?: number; responseHeaderTimeoutMs?: number } | null = null`（挨着 `_pipelineInfo` 声明，现 request.ts:252 附近）。
2. `RequestContext`（`context/types.ts:431` 附近）新增方法 `setStreamTimeouts(patch: { streamIdleTimeoutMs?: number; responseHeaderTimeoutMs?: number }): void`——语义是**合并**（`_streamTimeouts = { ..._streamTimeouts, ...patch }`），因为这两个字段之间没有互斥关系（Phase 4a 先只用 `streamIdleTimeoutMs`，`responseHeaderTimeoutMs` 若 Phase 3 已落地可选填）。调用后 publish 同一个 `field: "pipelineInfo"` 的 `context_updated` 事件（复用现有事件类型，不新增 event kind，降低下游 sink 改动面）。
3. 抽一个内部小函数（避免逻辑写两遍导致未来漂移——即"归一化键 bug 多比较点复发"同类教训）：`function mergedPipelineInfo(): PipelineInfo | null { if (!_pipelineInfo && !_streamTimeouts) return null; return { ...(_pipelineInfo ?? {}), ...(_streamTimeouts ?? {}) } }`。
4. `get pipelineInfo()` getter（`context/request.ts:369-370`）改为 `return mergedPipelineInfo()`。
5. 终态组装点（`context/request.ts:847-849`，`if (_pipelineInfo) { entry.pipelineInfo = _pipelineInfo }`）改为 `const merged = mergedPipelineInfo(); if (merged) entry.pipelineInfo = merged`（这是 **onTerminal 投影**，因为它直接读私有变量而非 getter——必须显式改，getter 改动不会自动覆盖它）。
6. `PipelineInfo` 接口（`~/lib/history/store` re-export，唯一定义处，SSOT）新增两个可选字段：`streamIdleTimeoutMs?: number`、`responseHeaderTimeoutMs?: number`。**不需要** `updateEntry` allowlist / `toHistoryEntry` 三点同步（那是给 `HistoryEntry` 新增顶层字段的先例，`pipelineInfo` 本身已在允许列表里——本次只是给已有 JSON blob 字段的 TS 接口加子字段，SQLite 侧无 schema 迁移）。
7. 调用点：**已在上方"改法"表格定死**——4 个 HTTP handler + ws.ts 均在 `driver.runRequest()` 结算、`result.ok===true` 分支内调用 `result.env.ctx.setStreamTimeouts({ streamIdleTimeoutMs })`（`env.ctx` 必填字段恒非空，无需 `?.` 防御）；anthropic direct / web-search-direct 用其本已在场的 `reqCtx`。**不再是**"待实施时现场判断可达性"的开放点——HIGH-1 评审已证伪原"codec 刚创建即可达"的假设，此处是唯一正确、经核实可达的调用时机。

#### TDD 步骤

1. **单元测试**（`tests/context/request-pipeline-info.unit.test.ts` 或类似，先 grep 是否已有 `context/request.ts` 的现有测试文件复用）：
   - 直接构造一个 `RequestContext`，调用顺序 `setStreamTimeouts({streamIdleTimeoutMs: 600000})` → 之后调用 `setPipelineInfo({preprocessing: ..., sanitization: [...]})`（模拟 codec 稍后触发）→ 断言 `ctx.pipelineInfo` 同时包含 `streamIdleTimeoutMs` **和** 新设的 preprocessing/sanitization（回归防线：证明 4 个既有调用点的 full-replace 行为不受影响，且新字段不被覆盖）。
   - 反过来顺序（先 `setPipelineInfo`，后 `setStreamTimeouts`）也要覆盖。
   - `setPipelineInfo` **从未被调用**的请求（无 sanitization 触发）→ `ctx.pipelineInfo` 仍应包含 `streamIdleTimeoutMs`（这是 D2 的核心诉求：每条请求都有该诊断字段，不依赖 sanitization 是否触发）。
   - 终态断言：调用 `ctx.complete(...)`（或对应终态方法）后产出的 `entry.pipelineInfo.streamIdleTimeoutMs` 与 live `ctx.pipelineInfo` 一致（覆盖 onTerminal 投影分支）。
2. **集成测试（HIGH-1 修订后强制 5 条，不是"挑一个"）**：chat-completions / responses SSE / responses WS / gemini / messages 各写一条独立集成测试，发一条请求（可用 override 命中的假 model 名，或直接断言默认 300000），走完整 history 落盘路径，读回 history entry 的 `pipelineInfo.streamIdleTimeoutMs` 与预期一致。**必须 5 条都写**——messages 因 eager ctx 侥幸可达，只测它会产生假阳性、掩盖其余 4 个端点在原设计下的静默失效（HIGH-1 已修正调用点，但集成测试仍要覆盖全部 5 个端点以防未来任何一个端点的 `driver.runRequest` 调用模式变化时悄悄脱钩）。
3. 先写以上测试（红），再实现 4a 的全部改动，跑绿。

#### 验收判据

- 5 个端点（chat-completions/responses SSE/responses WS/gemini/messages）+ anthropic-direct/web-search-direct 每条请求（无论是否触发 sanitization/truncation）落盘的 history entry 都带 `pipelineInfo.streamIdleTimeoutMs`；5 条集成测试全绿（缺一不可，见上方 TDD 步骤 2 说明）。
- 现有 4 个 `setPipelineInfo` 调用点 + 第 4 个只读 `preprocessing` 的读点（`request.ts:825-826`）**零改动**（本设计的核心优点，降低回归面）。
- 现有涉及 `pipelineInfo` 的测试套件（sanitization/truncation/cacheControlStripped 相关）全绿，无回归。

### 4b — 拟 ADR + 启动日志 + §7.4 反证守卫

1. 落 `docs/decisions/2026-07-12-per-model-idle-timeout-is-app-guard-only.md`，内容对齐 spec §7 全文（背景/假前提改正/核验事实/决策/反证守卫），格式参照 `docs/decisions/2026-07-05-richest-data-flow.md`（状态/日期/相关 links 头 + 背景/定夺/应用实例/备选方案未采纳 结构）。
2. 启动日志（spec §8.1 第 1 条）：仿 `proxy.ts:223` 的 `consola.debug("Undici timeouts: ...")` 风格，在 config apply 路径（`config.ts` 现有"Reloaded config.yaml"日志附近，722-729 行 timeouts 装配块之后）追加一行 `consola.debug(\`Stream-idle overrides: ${JSON.stringify(state.streamIdleTimeoutOverrides)} (scalar fallback ${state.streamIdleTimeout}s)\`)`（`response_header_overrides` 对称一行）。**不必**新增独立测试（debug 日志属于低风险可观测性输出，人工核验 + 现有 `timeout-guardrail.unit.test.ts` 的 warn 测试模式若想仿造也可以顺手加，非强制）。
3. **§7.4 反证守卫**（唯一必须的自动化测试，**路径已订正**——`src/lib/transport/proxy.ts` 不存在，真实文件是 `src/lib/proxy.ts`，评审核实到位）：新增 `tests/architecture/per-model-idle-transport-boundary.test.ts`（或归入现有架构守卫测试文件，先 grep `docs/DESIGN.md`"活的架构现状"提及的既有 L1 存在性守卫测试模式，对齐风格），断言：
   ```
   grep -rn "streamIdleTimeoutOverrides\|responseHeaderTimeoutOverrides" src/lib/proxy.ts src/lib/transport/http2-client.ts
   ```
   结果为空（用 Node/Bun 文件读取 + 正则替代 shell grep，跑在测试进程内，不依赖外部 `grep` 二进制）。**注意**：只 grep override 侧字段名，**不要** grep `state.streamIdleTimeout`（标量）——`proxy.ts:105` 合法读取该标量（服务 undici bodyTimeout，spec §7.3 明确保留不动），若守卫测试误把标量也纳入会对已知合法代码报假阳性。

#### 验收判据

- ADR 文件落地，被 `docs/DESIGN.md`「活的架构现状」新增一行引用（简述本特性，格式对齐既有行，如 Codex/Responses tier-1 那一行的密度可以更精简——本特性范围小很多，一两句话即可）。
- 反证守卫测试绿，且能在故意注入违规代码时能显式变红（实施时手工验证一次：临时在 `src/lib/proxy.ts` 或 `src/lib/transport/http2-client.ts` 任一文件加一行读 `state.streamIdleTimeoutOverrides` 的死代码，确认测试真的失败，再删掉——防止"测试自身从不失败"的自证陷阱）。

---

## 跨阶段收尾（session-closeout）

1. `docs/DESIGN.md`「活的架构现状」表新增一行（本特性一句话 + 关键不变量 + 涉及文件 + spec/ADR 链接，格式对齐既有行如 Codex/Responses tier-1 那行）。
2. `docs/memory/MEMORY.md` 更新：本特性从 `project-*` stub 转为 `[done]` 或删除（视收尾时状态而定），若有新教训（如 `setPipelineInfo` full-replace 语义与新增跨请求标量字段冲突的解法）沉淀一条 methodology 记忆或直接归入本 ADR。
3. 按 CLAUDE.md 纪律：细粒度、显式 pathspec、conventional commits，按 Phase 边界切分提交（至少 4 个语义单元：Phase1/Phase2/Phase3/Phase4a+4b 可再细分）。
4. 收尾前对 Phase 2+3+4 做一次**合并态**评审（`review-merged-state`）——重点看：7+7 个读点是否有遗漏（INV-5 grep oracle 是否两阶段都跑过、结果是否真的收敛到预期的"合法剩余位置"列表）、Phase 4a 的 `setStreamTimeouts` 设计是否真的不影响 4 个既有 `setPipelineInfo` 调用点的行为（集成测试是否覆盖了"先 setStreamTimeouts 后 setPipelineInfo"与反序两种时序）。

---

## 已知开放点（交主会话/实施者定夺，非本计划自行拍板）

1. **Phase 2/3 的 mocking 手法**：Bun test 对 ESM 具名导出函数的 spy/mock 支持需要实施时现场探查项目既有先例（`mock.module` 或依赖注入包装），本计划不代为指定 API，避免规定一个实际跑不通的测试写法。
2. **`processAnthropicStream` 新参数排布**（Phase 2 §改法 4）：放在 `shutdownSignal` 前还是后，判据是"让唯一生产调用点最简洁"，留给实施者现场决定，非架构级分叉。
3. **LOW 键空间断言的 reverse-translate leg 排除范围**（Phase 3）：若某些 leg 下 `resolvedName` 与 `wire.model` 确实合法不同（翻译层改写模型名表示），需要实施者现场跑一次集成测试确认具体是哪些 leg、记录理由，而非本计划预先枚举（枚举需要读通用翻译矩阵的当前落地状态，超出本计划的调研范围，且该矩阵本身仍在多阶段推进中）。

> 原「Phase 4a 的 `codec.getContext()` 可达性」开放点已在 2026-07-12 对抗评审（HIGH-1）中定案，不再是开放点——详见 Phase 4a「关键架构风险」小节：调用点定死为 `driver.runRequest()` 结算后的 `result.env.ctx`（`RequestEnvelope.ctx` 必填字段恒非空），5 端点统一模式 + 强制 5 条集成测试。

以上 3 点均为**实现细节层面**的现场判断，不改变 spec 已定的目标/范围/架构（app-guard-only、两个 map、per-key merge、INV-1~5），因此不构成需要打回 spec 阶段的硬分叉；如果实施中发现任何一点的答案会导致目标/验收标准改变，应停下来向主会话报告，而不是自行改变架构合同。

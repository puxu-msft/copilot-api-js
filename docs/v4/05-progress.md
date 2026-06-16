# 05 — 开发进度看板

跟踪 [04-migration-plan.md](./04-migration-plan.md) 的 commit 序列。每个 commit 完成后在此打勾并记录验证结果。

**图例**：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⚠️ 完成但有遗留

---

## 总体进度

| 阶段 | commits | 完成 | 状态 |
|---|---|---|---|
| 设计文档 | — | — | ✅ |
| P0 地基 | 4 | 4/4 | ✅ |
| P1 改写 registry 化 | 6 | 0/6 | ⬜ |
| P2 driver + 逐格式 | 6 | 0/6 | ⬜ |
| P3 统一收尾 | 4 | 0/4 | ⬜ |

---

## P0 — 地基

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P0.1 | pipeline/envelope.ts + types.ts 接口定义 | ✅ | typecheck 绿；无消费者（grep 确认）；subagent review 无 CRITICAL/HIGH | R1 已解决（transport 侧 `WireRequest`→`PreparedRequest`）；RouteDecision 采 codec.md 版（无 from） |
| P0.2 | transport/send.ts 提取，client 改调用 | ✅ | 字节等价（手工逐行 + subagent review + 复核 combineAbortSignals 过滤 undefined）；全 offline 套件 2480 pass/0 fail；typecheck+eslint 绿 | 范围限定 OpenAI 两 client（关键坑）；Anthropic 待 P0.4 |
| P0.3 | observability 双轨收敛为单 bus 通道 | ✅ | golden fixture（context-bus-stream，改前改后皆过 + 连跑 10×）守 bus 事件流字节等价；全 offline 套件 2480 pass/0 fail；subagent review（git diff 逐项对照）无 CRITICAL/HIGH | ctx 直接 publish 所有 request.*；删 handleContextEvent/listeners/on/off；activeContexts 经 onSettled 回调；snapshotWithSummary 抽入 activity-summary 共享 |
| P0.4 | Anthropic effort 内循环 → effort-learning strategy | ✅ | strategy 单测连跑 15× 确定性；全 offline 套件 2489 pass/0 fail；subagent review（git diff 对照）结果等价、client 单次收发字节不变、无 CRITICAL/HIGH | client 删 2-attempt 循环（纯 dedent）；strategy 用 DI 注入 learn 避免 cache 污染；挂 token-refresh 后/body-field 前，与其它 400 策略消息互斥 |

## P1 — 改写 registry 化

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P1.1 | rewrite-registry.ts 接口 + 装配器 | ✅ | 纯新增；8 unit pass/100% cov；typecheck+eslint 绿；subagent review 无 CRITICAL/HIGH（3 前瞻缺口已处置，见下） | 接口忠实 spec §1/§2；createState? + DI registry 参数两处刻意补充已文档化；M1/M3 钉进 JSDoc，M2 记入遗留 |
| P1.2 | Anthropic 请求改写注册（T*/A*） | ✅ | sanitize 输出 golden 逐字节（"装配==手写组合 oracle"自洽，10 scenario pass，5 带 didWork 反假绿）；全 offline 套件 2506 pass/0 fail；typecheck+eslint 绿；subagent review 无 CRITICAL/HIGH | 按**内聚函数边界**拆 3 模块（非 §4 sub-step）：sanitizeAnthropicMessages(A3-9) 被 web_search 复用 + stats 是整链残差，故不再细拆。模块在 MessagesPayload 层（P2 driver 用 env adapter 包成 RequestRewrite）。web_search 路径未动 |
| P1.3 | Anthropic prepare 子步骤注册（B*） | ✅ | wire+headers 字节等价由既有 prepare 套件守（anthropic-request-preparation.it + coerce-adaptive-thinking.it 共 46 scenario 全 pass）；新增 step-order + runner↔STEPS 耦合 4 unit pass；全 offline 2510 pass/0 fail；typecheck+eslint 绿；subagent review（逐行 diff 对照确认 buildAnthropicHeaders 逐字抽取）无 CRITICAL/HIGH | prepare 是**固定无过滤管线**→用数组声明序而非 P1.2 的 order-keys+appliesTo+sort（去 cargo-cult）。`PrepareStep`+`PrepareContext`；body B3-6 为 4 命名 step + buildWirePayload(B1-2) 作 ctx init + buildHeaders(B7-12) 内聚末 step（B8<B9<B10 留其内，同 A6<A8）。`steps` DI 参数（P2 prepareWire 复用 + rewrite_applied） |
| P1.4 | OpenAI CC/Responses 请求改写注册（O*） | ⬜ | wire golden | |
| P1.5 | 响应改写注册（A1-4/C1-2/P1-2） | ⬜ | forwarded SSE golden | |
| P1.6 | 错误帧 formatter → codec.formatError | ⬜ | 错误帧 golden | |

## P2 — driver + 逐格式迁移

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P2.1 | driver.ts + stages/* 骨架 | ⬜ | driver 单测（mock codec） | |
| P2.2 | codec/openai-cc.ts | ⬜ | codec 单测 | |
| P2.3 | **CC 切 driver**（flag 可回切） | ⬜ | CC e2e+golden 等价；CC 现也记上游 sseEvents | |
| P2.4 | codec/openai-responses.ts + Responses 切 driver | ⬜ | Responses 等价（含 ws/force-fallback/stream-id） | |
| P2.5 | codec/gemini.ts + Gemini 切 driver | ⬜ | Gemini 等价（dropped params/sidecar error） | |
| P2.6 | **codec/anthropic.ts + Anthropic 切 driver** | ⬜ | thinking signature 往返；web_search 双跳等价 | 最复杂 |

## P3 — 统一收尾

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P3.1 | 透传判断统一进 decideRoute | ⬜ | 表驱动 (格式×模型) 矩阵 | 3 非一致默认显式保留 |
| P3.2 | 数据采集全下沉 driver，删 handler 手动调用 | ⬜ | 所有格式双轨记录 | 补齐 sseEvents 缺口 |
| P3.3 | 删旧 handler + flag + 死代码 | ⬜ | knip 无悬空、全测试绿 | |
| P3.4 | 更新 docs/DESIGN.md 指向 v4 | ⬜ | 文档代码一致 | |

---

## 关键不变量检查清单（每 commit 必过）

- [ ] `bun run typecheck` 绿
- [ ] `bun run test:backend` 绿
- [ ] `eslint --fix` 无新增 warning
- [ ] `/history/api/entries/:id` 仍返回全量双轨 HistoryEntry
- [ ] `/api/logs` + `/api/status` 形状不变
- [ ] WS wire 协议不变
- [ ] 该 commit 可独立 revert（不依赖后续）
- [ ] golden fixture 无 diff（改写/wire/SSE/错误帧）

---

## 遗留与决策追踪

> 实现过程中发现的、需用户定夺或暂缓的项记录在此（参照"deferred items 完整文档化"原则：根因、当前行为、理想架构、为何暂缓、若做需改什么）。

### P2-MUSTFIX1 — sanitize 模块 `changed` 信号不完整（P2 消费 rewrite_applied 前必修）

- **发现于**：P1.2（subagent review MEDIUM-1）
- **根因**：`request-rewrites.ts` 的 `sanitize-messages` 模块用 stats 信号推 `changed`（`totalBlocksRemoved>0 || systemReminderRemovals>0 || fixedNameCount>0 || inlineSystemConverted>0`）。但**改 payload 却不增删 block、不计入这四项**的改写（如 `rewriteHistoryServerTools:"downgrade"` 把 server_tool_use→tool_use 并拆分 assistant turn——block 总数不变）会被误报为 `changed:false`。
- **当前行为**：无功能影响——`changed` 在 P1.2 **不被消费**（JSDoc 已标 best-effort；`request.rewrite_applied` 事件化是 P2/P3）。
- **理想架构**：P2 用 `changed` 喂 `request.rewrite_applied{name, changed, stats}` 前，sanitize 模块的 `changed` 须准确。两条路：① `sanitizeAnthropicMessages` 多透一个 `changed`/`mutated` 信号（在它内部已知是否改过 messages）；② runner 对 sanitize 模块做 `result.payload` vs 输入 payload 的结构比较。倾向 ①（避免每请求 deep-compare 成本）。
- **为何暂缓**：P1.2 不消费 `changed`，准确化无当前收益且需改 sanitize 返回契约或加 deep-compare 成本。
- **若做需改什么**：P2 driver 接 rewrite_applied 时，按 ① 给 `sanitizeAnthropicMessages` 返回加 `changed` 字段并在 sanitize 模块透传；tool 模块的 `next !== payload` 已准确（preprocessTools/applyToolName 在 no-op 时返回同引用）。

### P2-CHECKPOINT1 — env-adapter 落地验证（pre-env transform 模块的回收保险）

- **发现于**：P1.2（subagent review MEDIUM-2）
- **背景**：P1.2 的 Anthropic 请求改写在 **MessagesPayload 层**（pre-env 形态），注册表 + appliesTo + order 是为 P2 driver 的 env-based `RequestRewrite` 铺路（trivial adapter：`apply(env) => env.with({body: module.apply(env.body, ctx).payload})`）。
- **checkpoint**：P2 落地 driver 时必须真正用上这层（payload 模块 → env adapter），否则注册表/appliesTo/order 对 3 个静态模块（2 个 `appliesTo:()=>true`）是投机性泛化（YAGNI），需回收为直接函数组合。CC/Responses（P1.4）的同形模块同此约束。

### P1.5-OQ1 — heartbeat 定时器注入无法用 per-frame `transform` 表达（待 P1.5 裁决）

- **发现于**：P1.1（subagent review M2）
- **根因**：spec §4 把 `heartbeat(A4, order 999)` 列进 `ResponseRewrite` 表，但它由**独立定时器**触发——上游静默期（opus adaptive thinking 在 `content_block_start` 后停滞几十秒~数百秒）**没有上游帧到达**，而 heartbeat 恰恰要在静默期注入 `event: ping`。`ResponseRewrite.transform(frame, state)` 是严格「每来一个上游帧调用一次」模型，无法被定时器/idle 驱动。
- **当前行为**：现状 heartbeat 是 `messages/handler.ts` 用独立定时器 + 串行 Promise chain 注入 `forwardedSseEvents`（与逐帧 transform 是两套机制）。
- **理想架构 / 两个选项**：① heartbeat 保留 handler-side 旁路，spec §4 表里那行降级为「概念归类」而非「真走此接口」；② 扩 `ResponseRewrite` 接口加 idle/timer hook（如 `onIdle?(elapsedMs, state): FrameAction`），让 driver 在 race idle-timeout 时调用。
- **为何暂缓**：P1.1 只定义接口、registry 为空、无消费者；heartbeat 的接入机制是 P1.5 响应改写注册时才需裁决的。`truncation-marker(C2, order 000)` 是首帧触发，**可**用当前 transform 表达，不受影响。
- **若做需改什么**：选 ② 则改 `ResponseRewrite` 加 hook + driver S5 流式循环在 idle race 点调用；选 ① 则 P1.5 注册响应改写时跳过 heartbeat，保留 handler 定时器旁路并在 spec §4 标注。

### P1.2-INV1 — system-prompt override 须经 `env.body` 表达（注册 system-override 时钉成显式不变量）

- **发现于**：P1.1（subagent review L2）
- **背景**：spec §4 把 `system-override`（S1/S2/S3，order 000）列为 `RequestRewrite`。**注**：P1.2 只注册 T/A（tool + sanitize）；system-override 是独立 group，现在 handler 入口 `processAnthropicSystem`（messages/handler.ts:159）一次性跑（**非幂等**，prepend/append 每次都加），尚未注册化。待它注册时，能表达的前提是 **system prompt 在 `env.body` 内**——Anthropic 顶层 `system` / OpenAI `messages[0]` 均在 wire body JSON 内，故 `with({body})` 足够，**非 blocker**。
- **行动**：P1.2 落地 `system-override` 时用一条测试确证「system 改写经 `with({body})` 表达」，把这个隐式假设钉成显式不变量。S1-S3 **非幂等**（prepend/append 每次都加），只能 S3 入口跑一次，**绝不**进 S4 attempt 循环。

### R1 — `WireRequest` 同名两类型 ✅ 已解决（2026-06-16）

- **发现于**：P0.1（subagent review）
- **根因**：P0.1 按 retry-transport.md §3 新增 `src/lib/pipeline/types.ts` 的 transport 侧 `WireRequest`（`{ url, headers: Headers, body, stream }`，transport 实际发送字节）。`src/lib/context/types.ts:46` 已存在一个**不同形状**的 history 侧 `WireRequest`（`{ model, messages, payload, headers: Record<string,string>, format }`，per-attempt 记录快照，与 `EffectiveRequest`/`ResponseData` 构成 `Attempt` 对称三元组，被 `setAttemptWireRequest` 消费）。
- **决策**：改 **transport 侧**（新、零消费者、零风险）为 `PreparedRequest`，而非破坏 history 的对称三元组。理由：① transport 侧无消费者，改名零破坏（P0.2 的 `transport/send.ts` 尚未 adopt Transport 契约，无引用）；② history 侧 `WireRequest` 与 `EffectiveRequest` 在 attempt 记录语境对称、9+ 消费者、是合理既有设计；③ `PreparedRequest` 精确表达"`prepareWire` 产出的待发送 HTTP 请求"，与 `prepareWire` 呼应。
- **实施**：`pipeline/types.ts` 的 `WireRequest`→`PreparedRequest`（interface + `Transport.send` 签名 + JSDoc）；同步 `retry-transport.md`、`P0-foundation.md`。typecheck 绿，全 src 无残留引用（grep 确认）。
- **P2 派生方向（保留）**：transport 落地后，driver 从 `PreparedRequest` + env 派生 history 快照（model←env、messages/payload←body、format←env、headers←headers），消除 6 处 handler 手动 `setAttemptWireRequest` 构造（呼应 envelope-driver §4 自动采样 + 06-inherited-issues DI-3、原则7 统一数据源）。已写入 `PreparedRequest` 的 JSDoc。

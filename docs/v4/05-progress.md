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
| P1.2 | Anthropic 请求改写注册（T*/A*） | ⬜ | sanitize golden 逐字节 | |
| P1.3 | Anthropic prepare 子步骤注册（B*） | ⬜ | wire+headers golden 逐字节 | |
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

_（暂无）_

### P1.5-OQ1 — heartbeat 定时器注入无法用 per-frame `transform` 表达（待 P1.5 裁决）

- **发现于**：P1.1（subagent review M2）
- **根因**：spec §4 把 `heartbeat(A4, order 999)` 列进 `ResponseRewrite` 表，但它由**独立定时器**触发——上游静默期（opus adaptive thinking 在 `content_block_start` 后停滞几十秒~数百秒）**没有上游帧到达**，而 heartbeat 恰恰要在静默期注入 `event: ping`。`ResponseRewrite.transform(frame, state)` 是严格「每来一个上游帧调用一次」模型，无法被定时器/idle 驱动。
- **当前行为**：现状 heartbeat 是 `messages/handler.ts` 用独立定时器 + 串行 Promise chain 注入 `forwardedSseEvents`（与逐帧 transform 是两套机制）。
- **理想架构 / 两个选项**：① heartbeat 保留 handler-side 旁路，spec §4 表里那行降级为「概念归类」而非「真走此接口」；② 扩 `ResponseRewrite` 接口加 idle/timer hook（如 `onIdle?(elapsedMs, state): FrameAction`），让 driver 在 race idle-timeout 时调用。
- **为何暂缓**：P1.1 只定义接口、registry 为空、无消费者；heartbeat 的接入机制是 P1.5 响应改写注册时才需裁决的。`truncation-marker(C2, order 000)` 是首帧触发，**可**用当前 transform 表达，不受影响。
- **若做需改什么**：选 ② 则改 `ResponseRewrite` 加 hook + driver S5 流式循环在 idle race 点调用；选 ① 则 P1.5 注册响应改写时跳过 heartbeat，保留 handler 定时器旁路并在 spec §4 标注。

### P1.2-INV1 — system-prompt override 须经 `env.body` 表达（P1.2 落地时钉成显式不变量）

- **发现于**：P1.1（subagent review L2）
- **背景**：spec §4 把 `system-override`（S1/S2/S3，order 000）列为 `RequestRewrite`，而 `RewriteResult.apply` 返回新 env、`RequestEnvelope.with()` 只 patch `body/targetEndpoint/prepareHints`。能表达的前提是 **system prompt 在 `env.body` 内**——Anthropic Messages API 的 `system` 是顶层 body 参数、OpenAI 的 system 是 `messages[0]`，均在 wire body JSON 内，故 `with({body})` 足够，**非 blocker**。
- **行动**：P1.2 落地 `system-override` 时用一条测试确证「system 改写经 `with({body})` 表达」，把这个隐式假设钉成显式不变量。S1-S3 **非幂等**（prepend/append 每次都加），只能 S3 入口跑一次，**绝不**进 S4 attempt 循环。

### R1 — `WireRequest` 同名两类型 ✅ 已解决（2026-06-16）

- **发现于**：P0.1（subagent review）
- **根因**：P0.1 按 retry-transport.md §3 新增 `src/lib/pipeline/types.ts` 的 transport 侧 `WireRequest`（`{ url, headers: Headers, body, stream }`，transport 实际发送字节）。`src/lib/context/types.ts:46` 已存在一个**不同形状**的 history 侧 `WireRequest`（`{ model, messages, payload, headers: Record<string,string>, format }`，per-attempt 记录快照，与 `EffectiveRequest`/`ResponseData` 构成 `Attempt` 对称三元组，被 `setAttemptWireRequest` 消费）。
- **决策**：改 **transport 侧**（新、零消费者、零风险）为 `PreparedRequest`，而非破坏 history 的对称三元组。理由：① transport 侧无消费者，改名零破坏（P0.2 的 `transport/send.ts` 尚未 adopt Transport 契约，无引用）；② history 侧 `WireRequest` 与 `EffectiveRequest` 在 attempt 记录语境对称、9+ 消费者、是合理既有设计；③ `PreparedRequest` 精确表达"`prepareWire` 产出的待发送 HTTP 请求"，与 `prepareWire` 呼应。
- **实施**：`pipeline/types.ts` 的 `WireRequest`→`PreparedRequest`（interface + `Transport.send` 签名 + JSDoc）；同步 `retry-transport.md`、`P0-foundation.md`。typecheck 绿，全 src 无残留引用（grep 确认）。
- **P2 派生方向（保留）**：transport 落地后，driver 从 `PreparedRequest` + env 派生 history 快照（model←env、messages/payload←body、format←env、headers←headers），消除 6 处 handler 手动 `setAttemptWireRequest` 构造（呼应 envelope-driver §4 自动采样 + 06-inherited-issues DI-3、原则7 统一数据源）。已写入 `PreparedRequest` 的 JSDoc。

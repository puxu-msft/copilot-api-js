# 05 — 开发进度看板

跟踪 [04-migration-plan.md](./04-migration-plan.md) 的 commit 序列。每个 commit 完成后在此打勾并记录验证结果。

**图例**：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⚠️ 完成但有遗留

---

## 总体进度

| 阶段 | commits | 完成 | 状态 |
|---|---|---|---|
| 设计文档 | — | — | ✅ |
| P0 地基 | 4 | 0/4 | ⬜ |
| P1 改写 registry 化 | 6 | 0/6 | ⬜ |
| P2 driver + 逐格式 | 6 | 0/6 | ⬜ |
| P3 统一收尾 | 4 | 0/4 | ⬜ |

---

## P0 — 地基

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P0.1 | pipeline/envelope.ts + types.ts 接口定义 | ✅ | typecheck 绿；无消费者（grep 确认）；subagent review 无 CRITICAL/HIGH | R1 已解决（transport 侧 `WireRequest`→`PreparedRequest`）；RouteDecision 采 codec.md 版（无 from） |
| P0.2 | transport/send.ts 提取，client 改调用 | ✅ | 字节等价（手工逐行 + subagent review + 复核 combineAbortSignals 过滤 undefined）；全 offline 套件 2480 pass/0 fail；typecheck+eslint 绿 | 范围限定 OpenAI 两 client（关键坑）；Anthropic 待 P0.4 |
| P0.3 | observability 双轨收敛为单 bus 通道 | ⬜ | bus 事件集 + sink 输出不变 | |
| P0.4 | Anthropic effort 内循环 → effort-learning strategy | ⬜ | effort fixture 连跑等价 | |

## P1 — 改写 registry 化

| # | commit | 状态 | invariant 验证 | 备注 |
|---|---|---|---|---|
| P1.1 | rewrite-registry.ts 接口 + 装配器 | ⬜ | 纯新增 | |
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

### R1 — `WireRequest` 同名两类型 ✅ 已解决（2026-06-16）

- **发现于**：P0.1（subagent review）
- **根因**：P0.1 按 retry-transport.md §3 新增 `src/lib/pipeline/types.ts` 的 transport 侧 `WireRequest`（`{ url, headers: Headers, body, stream }`，transport 实际发送字节）。`src/lib/context/types.ts:46` 已存在一个**不同形状**的 history 侧 `WireRequest`（`{ model, messages, payload, headers: Record<string,string>, format }`，per-attempt 记录快照，与 `EffectiveRequest`/`ResponseData` 构成 `Attempt` 对称三元组，被 `setAttemptWireRequest` 消费）。
- **决策**：改 **transport 侧**（新、零消费者、零风险）为 `PreparedRequest`，而非破坏 history 的对称三元组。理由：① transport 侧无消费者，改名零破坏（P0.2 的 `transport/send.ts` 尚未 adopt Transport 契约，无引用）；② history 侧 `WireRequest` 与 `EffectiveRequest` 在 attempt 记录语境对称、9+ 消费者、是合理既有设计；③ `PreparedRequest` 精确表达"`prepareWire` 产出的待发送 HTTP 请求"，与 `prepareWire` 呼应。
- **实施**：`pipeline/types.ts` 的 `WireRequest`→`PreparedRequest`（interface + `Transport.send` 签名 + JSDoc）；同步 `retry-transport.md`、`P0-foundation.md`。typecheck 绿，全 src 无残留引用（grep 确认）。
- **P2 派生方向（保留）**：transport 落地后，driver 从 `PreparedRequest` + env 派生 history 快照（model←env、messages/payload←body、format←env、headers←headers），消除 6 处 handler 手动 `setAttemptWireRequest` 构造（呼应 envelope-driver §4 自动采样 + 06-inherited-issues DI-3、原则7 统一数据源）。已写入 `PreparedRequest` 的 JSDoc。

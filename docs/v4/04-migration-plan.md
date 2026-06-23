# 04 — 渐进迁移计划

> ✅ **已执行完毕**：P0-P3 全部落地（进度见 [05-progress.md](./05-progress.md)）；v4 之后的 Stage A/B 见 [docs/rfc/response-pipeline/](../rfc/response-pipeline/)。本文件是迁移期计划，作历史记录。

**核心纪律**：每个 commit 结束时系统必须 ① typecheck 绿 ② 全测试绿 ③ 三大能力（API/日志/原始记录）不破 ④ 所有格式可正常代理。渐进混合——逐模块选提升或重写，旧路径并存到切换完成。

> 方法论参照：每个 commit 编码"结束时处于状态 X"的 invariant，中间 commit 绝不留半破坏；过渡窗口内新旧并写同一输出时，用 flag/silent 防双写污染。

---

## 阶段总览

| 阶段 | 目标 | 行为变化 | 可独立发布 |
|---|---|---|---|
| **P0 地基** | 接口 + transport 提取 + observability 双轨收敛 | 无（纯重组） | 每 commit |
| **P1 改写 registry 化** | sanitize/prepare/响应改写 → 注册式 transform | 无（字节等价） | 每 commit |
| **P2 driver + 逐格式迁移** | 建 driver，逐格式从旧 handler 切到新管线 | 每格式切换点 | 每格式 |
| **P3 统一收尾** | 透传判断统一 + 删旧 handler + 单一事件通道 | 无（等价切换） | 每 commit |

---

## P0 — 地基（不改任何行为）

| commit | 内容 | invariant |
|---|---|---|
| P0.1 | 新增 `pipeline/envelope.ts`、`pipeline/types.ts`：`RequestEnvelope`/`Stage`/`RouteDecision`/`PrepareHints`/codec/registry **接口定义**（无消费者） | 纯新增类型，零运行时影响；typecheck 绿 |
| P0.2 | 提取 `transport/send.ts`：把三个 client 的"fetch(wire)→SSE\|JSON + captureHeaders + HTTPError"骨架提为格式无关纯收发；现有 client **改为调用它**（prepare 仍在 client 内） | 现有 client 行为字节不变；所有现有 client 测试绿 |
| P0.3 | 收敛 observability 双轨过渡期：RequestContext legacy `emit()` → 全量迁到 bus publish，`manager.handleContextEvent` 的双写收敛为单写 | bus 事件集不变；HistorySink/WsSink/Console/Telemetry 输出不变；history 测试绿 |
| P0.4 | Anthropic client 的 `invalid_reasoning_effort` 2-attempt 内循环**提升为 pipeline strategy**（`effort-learning-retry`），挂入 `buildAnthropicStrategies` | 重试行为等价（连跑 effort-learning fixture 验证）；client 退化为单次收发 |

**P0 出口状态**：transport 层成形、observability 单通道、所有重试都在 pipeline strategy 层（无 client 内循环）。旧 handler 仍在用，行为完全不变。

---

## P1 — 改写 registry 化（字节等价）

把现状已模块化的 40+ 改写（02 §2/§3 的 A/B/T/O/C/P/S）包装为 registry transform，**但先让旧 handler 调 registry**，用 fixture 验证输出与现状字节等价。

| commit | 内容 | invariant |
|---|---|---|
| P1.1 | `pipeline/rewrite-registry.ts`：`RequestRewrite`/`ResponseRewrite` 接口 + 装配器（按 format+config+order 过滤排序） | 纯新增；无消费者 |
| P1.2 | Anthropic 请求改写注册：把 preprocessTools(T1-T7)/sanitize(A1-A9) 包成 RequestRewrite，**显式声明顺序契约**（T<sanitize、A6<A8、A7<A8）。`messages/handler.ts` 改调 registry | sanitize 输出与现状**逐字节等价**（用现有 sanitize 测试 + 新增 golden fixture） |
| P1.3 | Anthropic prepare 子步骤（B1-B12）注册：把 `prepareAnthropicRequest` 的私有子步骤导出为有序 RequestRewrite（header/body 裁剪类），声明 B3<B4<B5、B8<B9<B10 | wire payload + headers 与现状逐字节等价（golden fixture：含 beta/effort/cache_control/context_mgmt 组合） |
| P1.4 | OpenAI CC/Responses 请求改写注册（O1-O15） | wire 等价 |
| P1.5 | 响应改写注册：Anthropic(A1-A4)/CC(C1-C2)/Responses(P1-P2) 包成 ResponseRewrite，handler 流式循环改调 registry 链 | forwarded 帧与现状逐字节等价（golden SSE fixture） |
| P1.6 | 错误帧 formatter 注册：三协议 `formatError` 收进 codec，共享 `classifyStreamError` | 错误帧等价 |

**P1 出口状态**：所有改写是注册式 transform，顺序契约从注释变 registry 声明。旧 handler 仍负责编排，但改写部分已走 registry。每个 commit 有 golden fixture 守等价。

---

## P2 — driver + 逐格式迁移（核心）

建 driver，逐格式从旧 handler 切到新七阶段管线。**新旧路径并存**，用路由级开关切换，旧路径保留到该格式验证完成后才删。

| commit | 内容 | invariant |
|---|---|---|
| P2.1 | `pipeline/driver.ts` + `pipeline/stages/*`：S1-S7 执行器骨架（格式无关），消费 codec+registry+transport+strategies。**无格式接入**（无路由用它） | 纯新增；driver 单测（mock codec）绿 |
| P2.2 | `codec/openai-cc.ts`：CC codec（parse/decideRoute/translateOut=identity/renderResponse=identity/formatError） | codec 单测绿；旧 CC handler 仍在用 |
| P2.3 | **CC 切到 driver**：`chat-completions/route.ts` 改走 `driver.runRequest/runResponse`；旧 `handleChatCompletion` 保留但不挂路由（feature flag 可回切） | CC 全行为等价（e2e + golden：透传/via-responses/truncate/工具名/流式+非流式）；三大能力对 CC 不破（sseEvents 现在**也记上游原始**=改进） |
| P2.4 | `codec/openai-responses.ts` + Responses 切 driver（含 CC↔Responses 翻译、上游 WS、客户端 WS、fallback） | Responses 全行为等价（含 ws:/responses、Google force-fallback、stream-id-sync） |
| P2.5 | `codec/gemini.ts` + Gemini 切 driver（Gemini↔CC 翻译，复用 CC codec 链） | Gemini 全行为等价（含有损翻译 dropped params、错误帧 sidecar） |
| P2.6 | `codec/anthropic.ts` + **Anthropic 切 driver**（最复杂：所有 Anthropic strategy、thinking 无损、sseEvents 双轨、`processAnthropicStream` 统一为 `guardSseIterable`、web_search 双跳） | Anthropic 全行为等价；**thinking signature 逐字回传**（golden：真实带签名 thinking fixture 往返）；web_search 双跳等价 |

**迁移顺序理由**：CC 先行（翻译中枢、strategy 最少、风险最低，最早跑通 driver 全链路）→ Responses/Gemini（依赖 CC 翻译边，CC 稳后再迁）→ Anthropic 最后（约束最严、逻辑最重，此时 driver 已成熟）。
**可选**：若优先验证最难约束，可把 Anthropic 提前到 P2.3；代价是 driver 未经简单格式打磨就直面最复杂路径。**此顺序是本计划唯一建议用户复核的点**。

**每格式切换的并存机制**：route.ts 内 `if (USE_V4_DRIVER[format]) driver... else legacyHandler...`，flag 保留旧路径一个发布周期，确认无回归后在 P3 删除。

> **排程重排（2026-06-17，architect subagent 验证；实测 P2.3 flag 落地为 OFF）**：原 P3.2「数据采集全下沉」整体放在所有格式迁完后过度保守——driver 加采样是**共享机件**（4 格式都缺 per-attempt 双轨 + queueWaitMs），只依赖 driver+ctx。故 **P3.2 拆两半**：
> - **P3.2a（driver 加采样）提前**到每格式迁移点之后立即做（CC 即 **P2.3-S**，见 05-progress「P2.3 收尾排程」），后续格式 codec 只提供 `createResponseAccumulator` 复用 driver 采样、不再手写消费侧。
> - **P3.2b（删各 handler 手动 setter）锚定各格式**——只能删已在 driver 上的格式的 setter，留在 P3。
> - **P3.1（透传统一）不提前**（需 4 codec 齐）。
> - **翻 flag ON 的硬 gate（逐格式）= L1 行为等价 ∧ L2 记录等价**；CC 早翻 ON 作 canary（现有全套件自动经 v4 = 宽 oracle 压实 driver），是 P2.3 收尾、不拖到 P3。
> - 无双写风险：进程级互斥 flag（route.ts），单请求单路径，P2.3-S 同 commit 加 driver 采样 + 删 handler-v4 setter，无并写窗口。

---

## P3 — 统一收尾（等价切换）

> 注：原 P3.2 的「driver 加采样」半（P3.2a）已按上述重排提前到各格式迁移点（CC=P2.3-S）。P3 的 P3.2 只剩 **P3.2b（删剩余格式的 handler 手动 setter）**。

| commit | 内容 | invariant |
|---|---|---|
| P3.1 | 透传判断统一：4 处散点（messages/cc/responses/ws）+ Gemini 收进各 codec 的 `decideRoute`，**显式保留 3 个非一致默认**（isEndpointSupported 缺=true、isWsResponsesSupported 缺=false、Gemini 无 gate、Responses force-list 绕过） | 路由决策对所有 (格式×模型) 组合等价（表驱动测试覆盖矩阵） |
| P3.2b | 删除各 handler 残留的 setSseEvents/setForwardedResponse/setAttemptWireRequest 等手动调用（driver 采样已在各格式 P2.x-S 提前落地）；收束至 driver stage 边界自动采样 | 所有格式都记**上游原始 sseEvents + 客户端 forwarded + per-attempt 双轨**；history entry 字段集不变 |
| P3.3 | 删除旧 handler + feature flag + 死代码（`refactor-cleaner`/knip 验证无引用） | 全测试绿；无悬空导出 |
| P3.4 | 更新 `docs/DESIGN.md` 架构章节指向 v4 管线 | 文档与代码一致 |

**P3 出口状态**：单一 driver 管线、单一事件通道、透传判断统一、双轨记录全覆盖、旧 handler 删除。

---

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 改写 registry 化引入字节差异 → 上游 400 | P1 每 commit golden fixture 守逐字节等价；diff 即 fail |
| Anthropic thinking 无损被破坏 | P2.6 用真实带签名 thinking fixture 往返测试；并保留旧路径可回切 |
| 格式切换引入回归 | 路由级 feature flag，旧路径保留一个周期；e2e 对比新旧输出 |
| observability 双轨收敛丢事件 | P0.3 前后对比 bus 事件集 + sink 输出 fixture |
| 重试 env 模型与现状 wire 模型语义偏移 | P0.4/P2 用现有重试 fixture（beta 裁剪/truncate/effort-learning）连跑验证等价 |

每个 commit 失败可独立 revert（不依赖后续 commit）。feature flag 让 P2 任意格式可运行时回切旧路径。

---

## 验证策略（贯穿全程）

- **golden fixture**：请求改写输出、wire payload+headers、forwarded SSE 帧、错误帧——逐字节快照，diff 即 fail。
- **表驱动透传矩阵**：(接入格式 × 模型 supported_endpoints) → RouteDecision 全覆盖。
- **真实往返**：从 `/history/api/entries/:id` 拉真实请求（含合法 thinking signature）splice 最小用例，POST 验证 200（参照现有 empirical-probe 手法）。
- **flaky/时序**：流式 idle-timeout/abort/shutdown 用 fake timers，连跑 10-25 次确认确定性。
- **三大能力守卫**：每阶段后断言 `/history/api/entries/:id` 返回全量双轨字段、`/api/logs`+`/api/status` 形状不变、WS wire 协议不变。

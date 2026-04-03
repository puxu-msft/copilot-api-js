# WebSocket 设计审阅回应

三轮审阅的统一回应。Codex 审阅文档见 [review-260330-1.md](review-260330-1.md)（多次更新）。

---

## 第一轮：初始审阅（7 条 Finding）

### 总体评价

审阅指出原文档在两个关键前提上有概念问题。经代码验证后，7 条中 5 条直接接受，2 条部分接受（审阅论点有误但建议方向有价值）。

### F1 — `ws:/responses` 能力建模 ⚠️ 部分接受

**审阅论点**：`ws:/responses` 是 client↔proxy transport 标识，不应用于上游能力判断。

**重新验证**：GHC `chatEndpoint.ts:244-245` 明确用 `supported_endpoints.includes('ws:/responses')` 判断上游 WS 能力。`endpoint.ts:11` 的 `client↔proxy only` 注释是历史描述，不是设计约束。

**结论**：`ws:/responses` **就是**上游 API 声明的 WebSocket 能力。恢复 `isWsResponsesSupported()` 设计。

### F2 — 客户端 WS 生命周期 ⚠️ 部分接受

**审阅论点**：当前客户端↔代理是 one-request-per-connection，所以代理↔上游也应该如此。

**重新验证**：两层连接是独立的。GHC 的上游 WS 就是 multi-request（`chatWebSocketManager.ts:29-30`）。代理内部维护持久上游 WS 对客户端透明。复用 key = `previous_response_id`。

**有道理的部分**：需要定义并发模型和清理策略 → 保持。

### F3 — intent 动态规则 ✅ 接受

固定 `conversation-agent` 不对。改为复用 `prepareResponsesRequest()` 的动态规则。

### F4 — ping 处理 ✅ 接受

不实现应用层心跳。依赖协议级 ping/pong。

### F5 — fallback 状态机 ✅ 接受

新增四状态机：`CONNECTING → FIRST_EVENT_PENDING → FIRST_EVENT_RECEIVED → FORWARDING`。yield 之前可 fallback。

### F6 — 并发模型 ✅ 接受

Phase 2（端到端路径）前提条件。上游连接串行即可。

### F7 — 可观测性 ✅ 接受

transport 为 attempt 维度字段，三个值：`"http"` / `"upstream-ws"` / `"upstream-ws-fallback"`。

---

## 第二轮：内部一致性审阅（6 条 Finding）

### 总体评价

4 条高优先级问题都是**文档内部不一致**——修正核心设计后未全文 grep 同步旧内容。

### F1 — README vs architecture 矛盾 ✅ 接受

README 仍写"不使用 `ws:/responses`"，architecture.md 已改为"是上游能力信号"。**根因**：忘了同步 README。已修正。

### F2 — Phase 1 三套矛盾模型 ✅ 接受

三个位置互相矛盾：implementation.md "每请求独占 key=requestId"、伪代码用 requestId、protocol.md "Phase 1 终结后关闭"。**根因**：更新 connection-management.md 为复用模型后未清理旧内容。已统一为 `findByMarker()` + 连接保持打开。

### F3 — 动态 headers 兼容性 ✅ 接受

"headers 差异仅为 `x-request-id`" 被 intent 动态变化直接反驳。GHC 的做法是不检查兼容性。已新增 headers 变化矩阵 + 两种策略（宽松/保守），推荐宽松 + 差异日志。

### F4 — shutdown Phase 2 vs Phase 3 ✅ 接受

文档写 Phase 2 `closeAll()`，实际 Phase 2 是等待自然完成。已改为三阶段对齐。

### F5 — transport 字段 ✅ 接受

落实到 attempt 维度 + 具体值。

### F6 — 测试条件 ✅ 接受

改为 `ws:/responses` 判断 + 组合测试。

---

## 第三轮：接口与语义收敛审阅（4 条 Finding）

### 总体评价

精准指出文档内仍存在的 API 签名不一致、headers 断言错误、shutdown 残留描述。全部接受。

### F1 — manager API 不一致 ✅ 接受

接口定义 `getOrCreate(key, headers)` 但调用方用 `manager.create(headers)` + `findByMarker()`。`statefulMarker` 注释仍写"Phase 2 才有意义"。

**修正**：接口统一为 `findReusable` / `create` / `stopNew` / `closeAll`。删除 `getOrCreate` 和 `close(key)`。

### F2 — headers 兼容性断言错误 ✅ 接受

删除"差异仅为 x-request-id"断言。新增 headers 变化矩阵（intent/vision/initiator 等），定义宽松/保守两种策略。

### F3 — shutdown 残留 + Phase 3/4 写糊 ✅ 接受

四阶段精确对齐：Phase 1 stopNew → Phase 2 自然完成 → Phase 3 abort（不关连接）→ Phase 4 force-close。

### F4 — 变更文件清单不完整 ✅ 接受

拆为 "Phase 1 变更文件" 和 "Phase 3 额外变更文件" 两个表。

---

## 总结

| 轮次 | 核心问题类型 | 结果 |
|------|------------|------|
| 第一轮 | 设计方向（`ws:/responses` 定义、连接生命周期） | 5/7 接受，2/7 审阅论点有误但建议有价值 |
| 第二轮 | 内部一致性（修正后未全文同步） | 6/6 接受 |
| 第三轮 | 接口与语义收敛（API 签名、headers 断言、shutdown 残留） | 4/4 接受 |
| 第四轮 | 实现边界（abort signal、串行约束、模型变化、文件 owner） | 3/3 接受 |
| 第五轮 | 全文同步（`findReusable` 签名、implementation.md 残留） | 2/2 接受 |

---

## 第五轮：最终同步审阅（2 条 Finding）

### 总体评价

审阅确认文档已接近可实施。剩余 2 条都是 implementation.md 未同步最新接口的残留。

### F1 — `findReusable()` 签名缺 model identity ✅ 接受

签名 `findReusable(previousResponseId: string)` 无法表达"模型一致"的复用条件。

**修正**：签名改为 `findReusable(opts: { previousResponseId: string; model: string })`。全文同步。

### F2 — implementation.md 接口摘要/管理器/伪代码残留 ✅ 接受

三处残留：1.3 接口摘要无 signal、1.4 管理器只写 marker 查找、1.5 伪代码无 signal/model。

**修正**：
- 1.3 同步 `connect({ signal })` / `sendRequest(payload, { abortSignal })` / `isBusy`
- 1.4 同步为"marker + model + !busy"
- 1.5 伪代码同步 `findReusable({ previousResponseId, model })`、`combineAbortSignals()`、`connect({ signal })`、`sendRequest(payload, { abortSignal })`

---

**反复出现的根因**：修正核心设计后未全文 grep 清理旧内容。
**教训**：每次修改核心决策后必须扫描所有文件中的相关描述并同步更新。对审阅意见需回溯到 GHC 源码验证推导链条，不能仅凭当前代码注释接受。

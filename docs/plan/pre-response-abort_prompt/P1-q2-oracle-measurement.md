# P1 — Q2 oracle 实测（③ 的硬门）

> 开场先读 [README.md](./README.md) 的通用红线 + 必读。**这是实测任务、非代码任务**——用真实客户端 + 运行中代理，不进自动化套件。**P2（③ 实现）的硬门**：本任务不出结论，P2 不能落地。

## 背景 + 为什么

③（pre-response 保活，RFC §4）让 opus 长思考期间提前回 200 SSE 流打 ping，防客户端超时断开。它有一个**与真实 Anthropic 的发散**：一旦 commit 回 200，POST-COMMIT 的上游错误（4xx/5xx）只能降级成 SSE `error` 帧，而真实 Anthropic 在校验阶段仍回 HTTP 4xx（RFC §4.1 / §4.2.7 双 oracle 已证）。

RFC §4.2.5 用**双 oracle 静态分析**已证：对 Anthropic SDK，流内 `event: error` 帧走 `core/streaming.js:99` 的裸 `new APIError(...)` → `.status===undefined`、非 `RateLimitError`/`BadRequestError` 子类、自动重试 `shouldRetry` 永不触发。即 **200+SSE-error ≠ HTTP-4xx**。延迟-commit（§4.2.2）+ 富错误帧（§4.2.5，`mapHttpErrorToEnvelope` 已落地 `3e4b3cd`，保 `error.type`/`retry_after`）已把发散面缩到"长 stall 之后才报错"的极少数——**但残余须真实客户端实测裁决**，且 grace 默认值依赖实测客户端超时。这是 self-consistent-needs-independent-oracle：不能用自家 encode↔decode 判等价，须真实对端。

## 目标：实测两件事

### (a) Claude Code 的真实请求超时类型 + 阈值（定 grace 默认值）

RFC §4.2.3 的 grace 约束链是 `grace < 客户端超时`，但"~258–292s"是从 incident 日志单方推断、**未从源码 pin**。需实测：
- **超时是 idle 型（每收一帧重置）还是 total 型（从请求开始计死）**？这决定 ping 是否有效 + grace 上界。Anthropic SDK 默认 600s 是 time-to-headers（headers 到即清，见 `client.js:562`），但 Claude Code CLI 封装层可能叠了自己的总/idle 超时。
- 纯静默多少秒断开 vs 带 ping（间隔 N 秒）多少秒断开。

### (b) Claude Code/SDK 对"200 流首个语义事件即 error 帧"的分支行为（③ 是否安全的 make-or-break）

对 **429 / 401 / 400** 三类各测：客户端收到 `200 + event:error{type, retry_after}`（富错误帧形态）vs 收到 HTTP 4xx——
- 是否静默放弃重试（429 该退避重试，却因 `.status===undefined` 不重试）？
- 是否正确显示错误给用户？
- 与 HTTP-4xx 路径行为差多少？

## 怎么测（探针 harness 须代表生产，methodology-probe-harness-must-match-prod）

1. **真实 Claude Code → 本地代理（4141）→ 受控上游**。用户启动代理（你**不自动启服务器**）。
2. 受控上游：用一个能 (i) 在 pre-response 静默 N 秒、(ii) 在 pre-response 后返回 429/401/400、(iii) commit 后才返回错误 的 mock 上游 / 或 config 指 `ghc_api_base_url` 到一个本地 stub。**或**用 `/api/debug/dry-run-pipeline` 的响应侧能力构造（如可行）。
3. 实测客户端断开时刻（用 `/history/api/entries/:id` 拉真实 entry 看 durationMs + 客户端何时断，empirical-probe-via-history-api）+ 带 ping vs 不带 ping 的对比。
4. 错误帧等价：让上游在 commit 后回 429（带 retry_after），观察 Claude Code 是否退避重试。

## 验收（出结论，写回 RFC §6 Q2）

- [ ] **grace 默认值**有实测依据（客户端超时类型 + 阈值 + margin），写进 RFC §4.2.3 替换"待 Q2 实测"。
- [ ] **错误帧等价裁决**：200+富SSE-error 对 429/401/400 是否被 Claude Code 等价处理？**go**（可接受残余）/ **no-go**（须改 ③ 方案，如缩小 commit 面 / 不降级特定 error.type）。写进 RFC §6 Q2 + §4.2.5。
- [ ] 实测过程 + 数据放 `exp/q2-oracle/`（feedback-experiments-in-repo-exp-dir，不放 /tmp）。
- [ ] 据结论更新 RFC §4 + §5 C3b 行（解除或细化 Q2 阻塞），并明确 P2 是否可启动。

## 注意

- 这是**纯主观偏好不算、真实缺陷才算**：若实测证明 Claude Code 对富 SSE-error 帧等价处理（含 429 退避），③ 的发散是可接受残余 → P2 放行。若证明 429 静默不重试是真问题 → ③ 方案需调整（RFC §4.2.5 已预留"协议层无法弥补"的诚实标注，可能要求 grace 取大到几乎只剩生成-成功路径，或对特定 error.type 不降级）。
- 别让探针自洽冒充实测（pass-null 盲点）：mock 上游回 429 但客户端没真退避，要能从 history/网络抓证实，引不出的"等价"不算数。

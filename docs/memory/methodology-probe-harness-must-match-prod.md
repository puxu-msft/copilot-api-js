---
name: methodology-probe-harness-must-match-prod
description: 实测探针所在的 harness 必须代表生产路径——否则探针自身会误判（缺一段中间件/接线就给出与生产相反的结论）
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7d1b1f2b-11bd-4ac5-b1bf-4bfe01b9fdbb
---

实测裁决（[[empirical-probe-via-history-api]]）只在探针环境**忠实复制生产接线**时才可信；缺一段 middleware/wiring 的测试 harness 会让探针给出与生产相反的结论。

**Why**：P2.4 review，subagent 报 CRITICAL「reject 留悬挂 pending history entry」。我用 `createFullTestApp` 跑探针，确认 entry 终态 = `pending`，一度采信。但 `createFullTestApp`（tests/helpers/test-app.ts）**不注册** `observabilityMiddleware`——它只在 `src/server.ts:73` 注册。生产中该中间件 POST 分支 `completeFromHttpStatus(4xx)→fail()` 把 reject entry 收尾为 `failed`，**非悬挂**。用「带中间件的 app」重跑探针 → 终态 `failed`，CRITICAL 是假阳性。

**How to apply**：
- 写探针前，先确认 harness 包含被测行为依赖的**全部生产接线**（中间件、onError、route 注册顺序）。`createFullTestApp` 只装 `registerHttpRoutes`，缺 server.ts 的 `server.use(...)` 链（observability/cors/trim）——涉及「请求生命周期终态/ctx 收尾/4xx 处理」的探针必须自建带中间件的 app。
- 这是 [[feedback-pass-null-clean-not-self-validating]] 的镜像：那条管「通过/空不自证」（假阴性），本条管「探针的肯定性发现也不自证」（假阳性）——两者根因同：先证明检查/探针真正触达了它声称测的那条**生产**路径。
- 仍遵 [[feedback_reviewer_verify_critically]]：subagent 的 CRITICAL 要亲自实测裁决；但裁决工具本身（探针/harness）也要批判——别用一个不代表生产的 harness 去"实测"。

# Phase 7 — 收尾 + 重走 OQ1（Stage A 闭环）

> Stage A 的 Task 7。开场先读 [README.md](./README.md) 的通用红线 + 通用必读。**前置**：Phase 0-6 全部完成。本 phase 做 whole-domain audit、文档同步、并**重新评估 Stage B 的入口条件 OQ1**。

## 背景

Phase 1-6 把请求改写（A0）、Anthropic 流式响应改写集（A1）、非流式（A.B）、Responses+WS（A.C）全部迁进 `rewrite-registry`。Stage A 的终态：**"新增一条拦截/修复 = 注册一个 RequestRewrite/ResponseRewrite 条目"** 在所有格式 × 流式/非流式 × HTTP/WS 路径成立。本 phase 收口并决定是否进 Stage B。

**Stage B = driver-owned-writeout**（设计稿 §3.2/§3.3）：把 `runResponse` 从 `AsyncIterable<ClientFrame>`（generator，handler 写出）翻为 `runResponse(upstream, env, sink: ClientSink): Promise<ResponseOutcome>`（driver 拥有 sink），从而把 forwarded 采样 + heartbeat 写也收进 driver。这推翻 P3.2b-D1（forwarded 必须 handler-side）+ 解 P1.5-OQ1（heartbeat 抗逐帧）。**用户决定 Stage B 在 Stage A 成功后重新评估，非自动启动。**

## 任务

### 1. whole-domain audit（subagent 多视角，全量工具）
派 subagent 全面审计迁移后的 `rewrite-registry`/`driver`/各 handler，重点：
- **死代码清理**：`streaming-pump.ts` 的旧嵌套、`runAnthropicRequestRewrites` 空壳、`renderNonStreamingV4` 内联序列、handler 内已迁的内联调用——grep 全仓确认无消费者后用 `git rm`/Edit 删（**绝不 rm 工作区未提交文件**）。knip 报 0 不等于无死代码（P3 踩过 knip false-negative：测试有同名 local 函数掩盖 src 死导出）——**亲自 grep 跨 src/tests 验证**。
- **三 home 边界清晰**（用户的反过度抽象修正）：codec=格式翻译、registry=跨切面改写、transport/driver=heartbeat/keepalive。确认无改写漏在 handler、无翻译混进 registry。
- **order 常量单一来源**：四条响应改写 + 请求改写的 order 是否都从 Phase 3 固化的常量表取，无散落 magic number。

### 2. 文档同步（completion-includes-doc-sync，硬要求）
- **DESIGN.md**：更新"核心模块"的 `pipeline/` 描述——registry 现已激活、承载请求+响应改写；S3/S5 阶段说明从"空注册表"改为实际改写集 + order 表。各被迁改写（recover/decode/filter/thinking/responses-fix）的配置字段表项若提及实现位置，更新到 registry。
- **RFC `design.md`**：把 Stage A 各 phase 标记为已完成（保留设计推理）；§8 deferred 关系更新（P3.2b-D1/P1.5-OQ1 状态）。
- **`stage-a-plan.md`**：勾掉 Task 0-7。
- **docs/v4/05-progress.md**：登记 Stage A 完成 + 受影响的 deferred items 现状。
- **memory**：删已落地的 pending 记忆条目、把"registry 激活 = 新增拦截的标准做法"这类可复用机制回填进活文档（而非记忆，因已项目特定且完成）；维护既有库（陈旧→修/近义→互链/冗余→删，deep-read 正文比对非仅索引钩子）。

### 3. 重走 OQ1 → 给用户决策数据
按 give-user-decision-data 摆出 Stage B 的 go/no-go：
- Stage A 后 driver-owned-writeout 的**新增收益**（heartbeat/forwarded 收进 driver 消除 P3.2b-D1/P1.5-OQ1 的量化影响：涉及文件、LOC、风险）。
- 不做的代价（forwarded/heartbeat 永久 handler-side 的债项是否真实）。
- 推荐 + 理由。**不自动开做 Stage B**——交用户拍板。

## 验收

- 全套 golden（Phase 0 + 各 phase 自捕）逐字节绿 + 连跑确定。
- `bun run test:backend` 绿（仅 2 个预存 FileSink 失败正交，须明示）；`bun run typecheck` 绿；`bunx eslint --fix` 全仓干净。
- 三大能力守卫过：`/history/api/entries/:id` 双轨、`/api/logs`+`/api/status` 形状、WS wire 不变。
- 文档同步完成（DESIGN/RFC/plan/progress/memory），无"代码改完文档没同步"。
- 死代码清零（grep 实证，非仅 knip）。

## 提交

分阶段细粒度提交（audit 修复、死代码删除、文档同步各自成 commit）：
```bash
git add -- <精确路径>
git commit -m "refactor(pipeline): Stage A 收尾 删迁移后死代码"
git add -- docs/DESIGN.md docs/rfc/response-pipeline/ docs/v4/05-progress.md
git commit -m "docs(pipeline): Stage A 完成 同步 DESIGN/RFC/progress"
# memory 改动单独 commit(注意不裹入用户未相关的工作区改动)
```

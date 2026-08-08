# 超长驻留 operation 生命周期收敛规格

> **状态：设计已获用户批准；独立首轮评审 0 blocker／5 major，已全部采纳修订，待复评与实施计划。**
>
> **基线：** 当前本地 `master@cfe78b6425fbbaa05fd3d11df1582611c76c0f1f`；待整合的 direct-live pre-content recovery 来源为 `agent-ace4e48572710c13a@b7319c78e41e3059ad2269a8c1014640b016e848`。实施前必须重新读取实际 refs，不得把本段快照当执行期 HEAD。
>
> **用户裁决：** 不在 shutdown 层过滤逻辑状态为 `failed` 的条目，不按年龄自动删除 operation registry，不用 timeout 掩盖资源未收敛。完整整合 direct-live pre-content recovery，并从 candidate、dispatch、delivery、request operation owner 修复根因。本轮只实现 lifecycle blocker 诊断；A4 H2 canonical transport diagnostics 保持独立阶段。

## 1．问题陈述

2026-08-07 退出现场显示三个 `/v1/messages` 请求已经处于 `failed`，却在创建约 4.5 小时后仍被 shutdown 列为待 drain 对象：

```text
Waiting for 3 active request(s):
  POST /v1/messages gpt-5.6-sol (failed, 17620s)
  POST /v1/messages gpt-5.6-sol (failed, 16686s)
  POST /v1/messages gpt-5.6-sol (failed, 16194s)
```

`failed` 只表示逻辑终态。Shutdown 实际等待 `RequestContextManager.getTrackedOperations()`，其对象必须继续覆盖尚未退出的 operation child、delivery finalization 与 canonical terminal publish。按 `failed` 过滤会让 shutdown 在资源仍在运行时 false-green，破坏 lossless drain。

现场调查按日志 age 反推创建时刻，并与同一进程的 request ID 序列对账，定位到三个未进入 History V3 canonical terminal 的序号缺口；遗失 operation 没有可直接读取的最终 History entry。事故进程运行身份为 `ccb645f5-dirty`，因此不能把运行字节精确还原为某个 commit。该 dirty WIP 属于 direct-live pre-content recovery 开发期；后续分支连续修复 candidate consume／dispose、quiescence、publication 与 request finalization 顺序。现有证据能确认 operation lifecycle 未收敛，但 A4 尚未提供区分 peer CANCEL 与 local abort 的 canonical H2 归因，故本规格不把特定 transport 发起方写成已证根因。

## 2．目标

1. 把完整 direct-live pre-content recovery 最终分支整合到当前 master，不挑选其演进中的局部中间补丁。
2. 让每个 primary／recovery candidate 在成功、失败、丢弃、取消与 cleanup reject 路径上均释放所有权并到达明确 settlement。
3. 让每个 physical dispatch 的取消、iterator cleanup 与 `quiesced` 保持同一 lifecycle owner。
4. 让 request 只有一个永久 delivery-finalization authority，并保证所有错误出口进入该 owner 的 `finally`。
5. 让 operation registry 的保留与删除条件只有一个定义源；逻辑终态不能提前删除，finalization 失败不能永久驻留。
6. 提供只读 lifecycle snapshot，机械说明一个 tracked operation 当前被哪一阶段阻塞。
7. 让 shutdown 与 `/api/status` 正确区分 active request 和 tracked operation。
8. 用真实 handler／manager 接线稳定复现并防止“逻辑已 failed，但 operation 永不收敛”的回归。

## 3．非目标

1. 不按 `failed`、age 或 model 从 shutdown drain 中过滤 operation。
2. 不调整 `shutdown.graceful_wait`、`shutdown.abort_wait` 或请求 timeout 数值。
3. 不添加 generic `NGHTTP2_CANCEL` retry。
4. 不用临时 H2 日志替代 A4 canonical transport diagnostics。
5. 不实现 buffered B2 或 translated B2；两者继续以 `docs/todo/deferred-backlog.md` 为单一 deferred 入口。
6. 不声称离线 recovery 测试证明真实 GHC 大上下文 fresh retry 必然成功。
7. 不改变 `/api/status.activeRequests` 的既有含义。

## 4．架构边界

### 4.1 Recovery owner

Recovery owner 决定 candidate 的 consume、discard、dispose 与 publication disposition。它不能永久关闭 downstream delivery，也不能把 cleanup 错误吞掉。

### 4.2 Dispatch lifecycle owner

Dispatch lifecycle owner 持有 cancel signal、response iterator cleanup 与 `quiesced`。取消只发信号；只有 iterator cleanup 已完成或已尝试完毕，lifecycle 才能收敛。Cleanup reject 可以让 settlement 失败，但不能让 active dispatch slot 永久保留。

### 4.3 Delivery owner

Attempt-local `close()`／`finalize()` 不能决定跨 recovery attempt 的 client stream 生命周期。`RecoverySinkSupervisor` 抑制局部终结；两个 request streaming owner 的外层 `finally` 调用唯一真实 `settleFinal()`。

### 4.4 Request operation scope

Operation scope 聚合 request 拥有的 settle 前异步 child。它只回答 child 是否退出，不决定业务成功或失败。Scope 仅在 `sealed && childCount === 0` 时 quiesce。

### 4.5 RequestContextManager

Manager 同时维护两个语义不同的 registry：

- `activeContexts`：用户可见、尚无逻辑终态的请求；
- `trackedOperations`：尚未完成 operation、delivery 或 canonical finalization 的请求。

Manager 负责 registry 生命周期与只读 blocker 聚合，不猜测 transport 根因。

### 4.6 Shutdown

Shutdown 消费 tracked operation snapshot 并执行有界 Phase 2／3 drain。它不修复资源泄漏，不按逻辑状态删对象，也不把 canonical finalization failure 伪装成成功退出。

## 5．生命周期事实模型

单一 `RequestState` 不能再同时表示业务结果、资源退出与持久化状态。每个 `RequestContext` 必须暴露以下独立事实。

### 5.1 Logical terminal

沿用 `pending/executing/streaming/completed/failed/aborted`。它回答客户端请求的业务结果，不蕴含 quiescence。

### 5.2 Operation scope

```ts
interface OperationScopeSnapshot {
  sealed: boolean
  childCount: number
  quiesced: boolean
}
```

`quiesced` 必须机械等于 `sealed && childCount === 0`。

### 5.3 Delivery state

```ts
type DeliveryLifecycleState =
  | { state: "open" }
  | { state: "finalizing" }
  | { state: "finalized" }
  | { state: "failed"; error: unknown; failureRegistered: boolean }
```

- `open`：永久 owner 尚未开始 `settleFinal()`；
- `finalizing`：owner 已进入 `settleFinal()`，异步 finalizer 尚未完成；
- `finalized`：raw delivery finalizer 已完成；
- `failed`：`close()`／`finalize()` reject，原始错误已保留；`failureRegistered` 表示该错误是否已进入 shutdown lifecycle failure barrier。

`finalized` 与 `failed && failureRegistered` 都是可 join 的 delivery terminal。Delivery failure 不能永久停在 `finalizing`，也不能伪装成成功 `finalized`。Owner 必须在进入、成功和失败的真实边界更新状态；现有 completion callback 不能同时冒充“开始”与“结束”。Delivery failure 必须仍然唤醒 canonical finalizer，使其记录 client delivery failure 后生成 terminal record；shutdown barrier 另行保留失败 verdict。

### 5.4 Canonical finalization state

```ts
type CanonicalFinalizationState = "waiting" | "running" | "completed" | "failed"
```

- `waiting`：尚缺 logical terminal、delivery finalization 或 operation quiescence；
- `running`：正在构造、seal 或 publish immutable terminal record；
- `completed`：terminal record 已发布；
- `failed`：finalizer reject，错误已登记到 shutdown barrier。

### 5.5 Operation lifecycle snapshot

```ts
interface OperationLifecycleSnapshot {
  logicalState: RequestState
  settled: boolean
  operationScope: OperationScopeSnapshot
  delivery: DeliveryLifecycleState
  canonical: CanonicalFinalizationState
  blocker: "request-running" | "operation-body" | "delivery-finalization" | "canonical-finalization" | "none"
}
```

Snapshot 只读且无 setter。Blocker 由单一 primitive 按以下优先级推导：

1. `!settled` → `request-running`；
2. `!operationScope.quiesced`，即 `!sealed || childCount > 0` → `operation-body`；
3. delivery 尚未到达 `finalized` 或 `failed && failureRegistered` → `delivery-finalization`；
4. canonical 为 `waiting` 或 `running` → `canonical-finalization`；
5. canonical 为 `completed` 或错误已登记的 `failed` → `none`。

此优先级用于展示当前首个阻塞阶段，不抹去 snapshot 中其他事实。

## 6．合法终止偏序

正常完成、失败、客户端中止和 recovery 失败必须满足以下偏序，而不是人为串行化所有独立事实：

1. Candidate owner 对每个 primary／recovery candidate 执行 commit、discard、dispose 或 cancel；dispatch iterator cleanup 完成或明确失败后，candidate ownership 才算闭合。
2. Candidate／dispatch ownership 闭合后，handler 才能记录 logical terminal；logical terminal 同步 seal operation scope。
3. Logical terminal 后，两条独立分支可以并行收敛：
   - operation scope 等所有已登记 child 退出，达到 `sealed && childCount === 0`；
   - 最外层 request delivery owner 进入且仅进入一次 `settleFinal()`，最终到达 `finalized` 或错误已登记的 `failed`。
4. Canonical finalizer 必须 join operation quiescence 与 delivery terminal，随后 seal 并发布 terminal record；delivery failure 作为 terminal record 的诊断事实保留，而不是阻止 canonical join 永久完成。
5. Canonical completed，或 canonical failure 已登记到 shutdown barrier 后，manager 才从 tracked operation registry 删除 context。

Operation quiescence 与 delivery finalization 没有固定先后关系。正确实现不得为了满足规格而延迟 quiescence，也不得把 delivery finalizer登记为 operation child 造成 self-join。Candidate cleanup 与 recovery settlement 必须先于 logical terminal；现有 recovery 分支的 `298b48fc` 是该方向的已有实现锚，整合后仍须用 registry 收敛 oracle 重新验证。

## 7．错误处理

### 7.1 Cleanup 失败仍释放所有权

Candidate、dispatch 和 reservation cleanup 采用 `try/catch/finally`：catch 保存原始错误，finally settlement、释放 reservation 并清除 active slot，随后重新抛出原始错误。禁止 catch-and-ignore，也禁止因 throw 跳过 release。

### 7.2 Dispatch quiescence reject

若 iterator cleanup／`quiesced` reject：

1. 在 `finally` 删除 active dispatch；
2. 记录 failed dispatch settlement；
3. 把原始错误抛给 candidate owner；
4. candidate owner 在自身 `finally` 释放 candidate 与预算；
5. 外层 request delivery owner 仍执行 `settleFinal()`。

### 7.3 Delivery finalization reject

Delivery `close()`／`finalize()` reject 时：

1. delivery 状态原子发布为 `failed` 并保留原始错误；
2. 同一临界步骤把错误登记到 lifecycle failure barrier，再将 `failureRegistered` 置为 true；
3. delivery terminal 唤醒 canonical join，terminal record 记录该 failure；
4. 外层 owner 继续传播原始错误，但不得让状态永久停在 `finalizing`；
5. manager 在 canonical 收口后释放 registry；shutdown 因 lifecycle failure barrier 进入失败 verdict。

### 7.4 Canonical finalization reject

Canonical finalizer reject 时：

1. 状态变为 `failed`；
2. manager 释放 tracked operation，避免永久内存驻留；
3. 错误进入 `modelOperationFinalizationFailures`；
4. `drainModelOperationFinalizations()` 抛 `AggregateError`；
5. shutdown 最终进入 `failed` 并以失败退出，不能打印成功完成。

资源 registry 收敛与 durability verdict 是两个独立不变量；前者不能靠永久保留对象表达后者。

## 8．Manager 删除条件单一来源

Manager 必须把散落的删除逻辑收成单一私有 primitive，例如 `releaseTrackedOperationIfFinalized(id)`。它只依据 lifecycle snapshot 决定是否删除，并由所有相关状态迁移调用。

要求：

1. Logical settle 只删除 `activeContexts`，不提前删除 tracked operation。
2. Canonical completed 或 finalization failure 已登记后，tracked operation 只删除一次。
3. Resolve 与 reject 分支不得复制两份不同强度的删除条件。
4. 多请求并行时，每个 id 独立收敛。
5. 已删除对象的后续幂等通知不重建 registry。

## 9．可观测性

### 9.1 Shutdown 日志

把误导性的：

```text
Waiting for 3 active request(s)
```

改为：

```text
Waiting for 3 tracked operation(s) to quiesce/finalize:
  POST /v1/messages gpt-5.6-sol logical=failed blocker=operation-body age=17620s children=1
```

日志至少包含 method、path、model、logical state、blocker、age，以及 blocker 对应的核心字段。不得把 `failed` 隐藏；“逻辑已经结束但资源仍未收敛”本身是关键诊断事实。

### 9.2 `/api/status`

保留：

```json
{"activeRequests":{"count":8}}
```

新增独立聚合：

```json
{
  "trackedOperations": {
    "count": 3,
    "byBlocker": {
      "request-running": 0,
      "operation-body": 2,
      "delivery-finalization": 1,
      "canonical-finalization": 0
    },
    "oldestAgeMs": 17620000
  }
}
```

Status 只提供聚合，避免复制 request 明细真相源。聚合直接从 manager registry 与 lifecycle snapshot 计算，不维护第二份可变计数。

### 9.3 A4 边界

本轮 blocker 只回答生命周期卡在哪一层，不回答 H2 CANCEL 由 peer、session teardown 还是 local abort 发起。完整 transport 归因仍由 A4 canonical diagnostics 独立实施；不得新增平行临时协议。

## 10．整合策略

1. 从实施时最新本地 master 创建隔离 worktree。
2. 用 Git 三方合并完整 recovery 分支，保留其演进历史和最终语义；不挑选三条中间 fix，也不重写较小 recovery。
3. 按语义解决当前 master 与 recovery 分支冲突。
4. 先运行 recovery 原有 focused、SDK、History 双读与 architecture 验证，确认合并未改变既有合同。
5. 再按 TDD 实现 lifecycle snapshot、manager 单一删除 primitive、status 聚合、shutdown 文案与僵尸回归。
6. 每个语义单元独立提交；不得 force-push 或发布远端。

历史评审只能作为线索。此前已有 cross-model plan review、阶段 coverage review 和局部 verifier，但 recovery 最终报告明确写明 final merged-state、code、verifier 与 doc reviews 尚未收口。本轮整合和新增修改必须重新完成最终评审。

## 11．测试规格

### 11.1 核心 handler／manager 回归

通过真实 handler／manager 接线构造：primary failure → recovery 启动 → recovery consume、publication 或 cleanup 失败。消费客户端 Response 后必须同时断言：

1. logical state 为 `failed`；
2. `manager.activeCount === 0`；
3. candidate／dispatch active slot 与 reservation 已释放；
4. `manager.trackedOperationCount === 0`；
5. `drainActiveRequests()` 返回 `"drained"`；
6. canonical terminal 成功发布，或 finalization failure 明确进入 shutdown barrier；不得永久 pending。

至少覆盖：

- consumed recovery settlement reject；
- unconsumed recovery disposal reject；
- C9 前 publication failure；
- C9 后 wire-torn；
- recovery clean EOF；
- recovery publication 中 client abort；
- H2 body iterator `return()` reject；
- operation child Promise reject。

### 11.2 Lifecycle 单元测试

Operation scope：

- 未 seal 时即使 `childCount=0` 也不提前 quiesce；
- child resolve／reject 均递减计数；
- `settled=true、sealed=false、childCount=0` 仍显示 `operation-body`，不能提前跳到 delivery／canonical blocker；
- seal 后登记 child 抛错；
- 多 waiter 全部 resolve；
- snapshot 无 setter。

Blocker：

- 未逻辑终态 → `request-running`；
- 已终态且 child 尚在 → `operation-body`；
- child 已退出但 delivery 未完成 → `delivery-finalization`；
- delivery 已完成但 canonical 正在运行 → `canonical-finalization`；
- canonical completed／失败已登记 → `none`。

Manager：

- logical settle 不提前删除 tracked operation；
- 正常 finalization 只删除一次；
- canonical reject 释放 registry 且 shutdown barrier 失败；
- cleanup reject 不留 candidate、dispatch 或 operation slot；
- 多请求互不误删。

### 11.3 Shutdown 与 status 测试

- `failed` operation 仍被 drain 等待；
- 日志使用 `tracked operation(s)` 并显示正确 blocker；
- 正常短暂 cleanup 可自然 drain，不产生 false-red；
- Phase 2／3 deadline 后仍进入 force-close；
- canonical reject 不打印 success；
- `activeRequests.count` 语义不变；
- `trackedOperations` 聚合与 registry snapshot 一致。

### 11.4 Delivery producer 接线矩阵

Lifecycle 收敛是共享基座，不得只由 direct Anthropic recovery 承重。必须枚举每个生产 `onDeliveryFinalized`／等价 terminal notification 的活路径，并至少覆盖以下四类真实接线：

| 类别 | 正确样本 | 目标缺陷 |
|---|---|---|
| 非 recovery SSE | 任一 Chat Completions／Gemini／Responses HTTP streaming handler 完成后 registry 归零 | 删除该 handler 的 delivery notification 后，测试必须停在 `delivery-finalization` |
| Recovery SSE | direct Anthropic primary→recovery 成功与失败均归零 | 删除 outer `settleFinal()` 或 recovery terminal notification 后转红 |
| Responses WS | `response.create` 正常 terminal 后 registry 归零 | 删除 WS sink finalization callback 后转红 |
| 非流式 JSON | middleware／handler delivery boundary 后 registry 归零 | 删除 non-streaming `finalizeModelOperationDelivery()` 接线后转红 |

实施计划必须先用 AST 或 TypeScript resolver 枚举实际生产者，再冻结矩阵；不得靠手写清单假装完备。矩阵既验证错误状态会红，也验证所有合法 producer 不会被 lifecycle gate 误拒。

### 11.5 Recovery 原有验证

整合态重新运行：

- direct handler recovery matrix；
- `@anthropic-ai/sdk` 离线 E2E；
- History 与 canonical operation 双读；
- three keepalive modes；
- abort provenance；
- clean EOF；
- hedge／candidate budget；
- recovery batch publication；
- architecture guards；
- `bun run typecheck`；
- `bun run test:backend`。

时序相关用例连续运行 10～25 次。

## 12．Mutation 双控

关键 gate 必须同时在正确样本上为绿，并在目标缺陷注入后为红。使用只描述目标变换的 exact patch，恢复时反向应用同一冻结 patch。

1. 删除 outer `finally` 的 `settleFinal()` → 回归必须停在 `delivery-finalization` 或稳定超时。
2. 让 `settleFinal()` reject 后永久保留 `finalizing`，或错误标成成功 `finalized` → delivery failure oracle 必须分别识别僵尸与隐藏失败。
3. 删除 candidate cleanup `finally` 的 active-slot release → 必须观察到未收敛 candidate／`operation-body`。
4. 删除 logical terminal 的 `operationScope.seal()`，制造 `settled=true、sealed=false、childCount=0` → blocker 与 drain 测试必须停在 `operation-body`。
5. 让 manager 在 logical `failed` 时直接删除 registry → shutdown 回归必须识别提前 drain 的 false-green。
6. 让 canonical reject 不释放 registry → 必须稳定复现 tracked operation 僵尸。
7. 删除非 recovery SSE、Responses WS 或非流式 JSON 中任一 delivery notification → 对应 producer matrix 用例必须转红。
8. 改错 blocker 映射 → 日志／status 测试必须转红。

Mutation 红必须来自目标机制，不能由另一条异常路径代打。

## 13．最终评审与验收命题

最终整合态必须分别接受独立 code review、verifier、merged-state review 与 doc review。评审同时检查错误状态能否通过和正确状态能否通过。

必须逐条取证的当前状态命题：

1. 所有 direct-live recovery terminal 经过唯一 outer `settleFinal()`。
2. Candidate cleanup reject 不遗留 active slot 或 reservation。
3. Dispatch iterator cleanup 完成或明确失败后才结束 quiescence join。
4. `failed` 不等于 quiesced。
5. Registry 删除条件只有一个定义源。
6. Canonical reject 释放 registry，但使 shutdown durability barrier 失败。
7. `/api/status.activeRequests` 语义未改变。
8. `trackedOperations` 聚合与 registry 实值一致。
9. Shutdown 不再把 tracked operation 误称 active request。
10. Buffered／translated B2 仍未启用。
11. A4 H2 canonical diagnostics 仍属独立阶段。
12. Recovery 最终分支此前只有阶段性评审，没有被误写成已完成最终 merged-state review。

所有 blocker／major 必须逐条处置并复评至无未决项。

## 14．结构怪味处置

| 位置 | 怪味 | 本轮处置 |
|---|---|---|
| `src/lib/shutdown.ts` | operation registry 被称为 active request，状态名实不符 | 改为 tracked operation 文案并显示 blocker |
| `src/lib/context/manager.ts` | Resolve／reject 两条 callback 复制删除逻辑，删除条件无单一入口 | 抽单一 release primitive，并以 snapshot 驱动 |
| `src/lib/context/request.ts` | Delivery／canonical 阶段藏在闭包布尔与 Promise 中，外部无法区分卡点 | 暴露只读 lifecycle snapshot |
| Recovery candidate／dispatch cleanup | Cleanup reject 可在 release 前打断控制流 | 所有权释放放 `finally`，错误继续传播 |
| `/api/status` | 只有 active request count，看不到逻辑终态后的 operation 驻留 | 新增 tracked operation 聚合，不改变旧字段 |
| Recovery handler tests | 强 wire／History 测试未直接断言 manager registry 归零 | 增加真实 handler／manager 收敛 oracle 与 mutation |

## 15．替代方案与未采用理由

### 15.1 在当前 master 重写较小 recovery

技术上可行，但会重走既有分支已经修复的 publication ordering、terminal attribution、abort boundary、wire ownership 与 clean EOF 缺陷。较小 diff 不提供等价的行为闭合，故不采用。

### 15.2 只移植 candidate settlement primitive

技术上可行，但当前 master 没有事故中的 recovery 活路径。孤立 primitive 测试无法证明用户遇到的路径已修，属于覆盖不足，故不采用。

### 15.3 Shutdown 按 `failed` 过滤或按 age 删除

会让错误状态在 operation child、delivery 或 canonical finalization 尚未完成时 false-green，直接违反 lossless drain，故禁止。

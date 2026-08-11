> **原始 reviewer 输出，逐字保存。** 本文是 subagent 的未编辑输出；仓库里另有蒸馏后的策展版（spec 评审见 `docs/spec/2026-08-08-long-resident-operation-lifecycle-review.md`，plan 评审见 `docs/plan/2026-08-08-long-resident-operation-lifecycle-review.md`）。策展版是权威，本文用于回溯「当时还挑战过什么、哪些没升级成 major」——那部分策展版没有收。

## 评审概览

- **评审范围**：冻结 commit `bcd1fbda8196ce14404c2f0f178051dce2b94a11` 的 `docs/spec/2026-08-08-long-resident-operation-lifecycle.md`，并只读对账相关实现、测试、recovery 分支历史、实施报告、plan 与 deferred backlog。
- **总体 verdict**：**修复 major 后可进入实施计划**。
- **Blocker 数**：0。
- **Major 数**：5。

### 双视角覆盖证据

- **机械核对**：逐项核验 C1～C8；对账 `RequestContextManager` 双 registry、`OperationScope` quiescence 条件、delivery callback、canonical finalizer、shutdown drain、status producer、recovery 分支 lineage、实施报告以及 B2／A4 的正式文档归属；扫描旧术语、重复删除逻辑、SSOT 声明和 mutation 清单。
- **第一人称执行模拟**：走查正常完成、logical failure 后仍有 child、零 child 但 scope 未 seal、delivery finalization reject、canonical reject、shutdown Phase 2／3／4、status 查询、direct-live recovery，以及非 recovery SSE／WS 路径；同时构造错误状态通过的 false-green 与正确并发顺序被拒绝的 false-red。

## C1～C8 命题表

| 命题 | 结论 | 证据 |
|---|---|---|
| C1 | 通过 | `src/lib/shutdown.ts` 的默认 `ShutdownDrainSource` 调用 `getRequestContextManager().getTrackedOperations()`，未读取 `activeContexts`。 |
| C2 | 通过 | `src/lib/context/manager.ts:375-398` 在 logical settle 时只立即删除 `activeContexts`；`operationScopes` 等待 model finalizer resolve／reject 后才删除。 |
| C3 | 通过 | `RequestContext.startGenerationFinalizerIfReady()` 同时要求 logical terminal 与 delivery-finalization request；finalizer 在 canonical publish 前等待 `whenOperationQuiesced()`。 |
| C4 | 通过 | `task-4.3b-implementation-report.md` 明确写明“final merged-state、code、verifier 与 doc reviews 进行中”，且声明报告不构成整体完成声明。 |
| C5 | 通过 | `b7319c78` 的历史包含 `298b48fc275117c86031a176fa046b1246d8d4a5 fix(messages): settle recovery before request finalization`。 |
| C6 | **部分不成立** | `docs/todo/deferred-backlog.md:5-12` 有 buffered B2；A4 有正式 plan；但未找到规格所声称的 translated B2 backlog 单一入口。 |
| C7 | 通过 | `src/routes/status/route.ts` 从 `getRequestContextManager().activeCount` 生成 `/api/status.activeRequests.count`。 |
| C8 | 通过 | Shutdown 消费 tracked operations，但 `formatActiveRequestsSummary`、Step 2 日志等仍称其为 `active request(s)`。 |

## 事实性发现

[major] `docs/spec/2026-08-08-long-resident-operation-lifecycle.md:99-118,294-305` — Delivery 模型没有可表示的失败终态 — 模型只有 `open／finalizing／finalized`，但 `RecoverySinkSupervisor.settleFinal()` 会传播 `close()`／`finalize()` rejection；发生 rejection 时只能永久停在 `finalizing`，或错误标成 `finalized`，分别导致 tracked-operation 僵尸或隐藏失败，也与“cleanup reject 不留 operation slot”的验收冲突 — 增加 `failed` 且规定错误登记位置、canonical publish 条件、manager release 与 shutdown barrier；或者明确定义一个同时携带成功／失败 outcome 的 terminal delivery 状态。

[major] `docs/spec/2026-08-08-long-resident-operation-lifecycle.md:61,132-138,335-345` — Blocker primitive 漏掉 `sealed`，且 mutation 无法咬中该缺陷 — `OperationScope` 的真实 quiescence 是 `sealed && childCount === 0`（`src/lib/context/operation-scope.ts:21-24,32-35,62-66`），规格却只以 `childCount > 0` 判定 `operation-body`；`settled=true、sealed=false、childCount=0` 会被误报为后续阶段，删除 `seal()` 的回归也不在 mutation 清单中 — 直接按 `!operationScope.quiesced`，或 `!sealed || childCount > 0` 推导，并加入删除／漏接 `seal()` 的正负双控。

[major] `docs/spec/2026-08-08-long-resident-operation-lifecycle.md:142-153` — “唯一合法终止顺序”把独立事实错误收紧为全局总序，产生 false-red — Logical settle 会在 `src/lib/context/manager.ts:375-385` 立即 seal scope；零 child 时 scope 可当场 quiesce，而 delivery owner 的异步 `settleFinal()` 可以随后完成，因此正确状态允许 operation quiescence 与 delivery finalization 以任一顺序到达；规格强制第 4 步先于第 5 步会迫使实现人为延迟 quiescence或把 delivery 错算成 operation child — 改成偏序不变量：candidate／dispatch ownership 闭合后才能 logical settle；delivery terminal 与 operation quiescence 可并行；canonical publish 必须 join 两者；manager 最后 release。

[major] `docs/spec/2026-08-08-long-resident-operation-lifecycle.md:41` — translated B2 的 deferred SSOT 声明与冻结仓库不符 — 规格称 buffered／translated B2 均以 `docs/todo/deferred-backlog.md` 为单一入口，但该文件只有 buffered B2 条目（`docs/todo/deferred-backlog.md:5-12`）；translated B2 仅在阶段 plan／report 中被称为 deferred，后续清理阶段文档时可能无声丢失 — 在正式 backlog 增加 translated B2 的根因、当前行为、理想架构、暂缓理由和触发条件，或修改规格指向其真实且稳定的 SSOT。

[major] `docs/spec/2026-08-08-long-resident-operation-lifecycle.md:317-324,347-364` — 全局 lifecycle 验收集中在 direct Anthropic recovery，未覆盖其他真实 producer 接缝 — Delivery-finalized callback 同时存在 SSE 与 WS 路径（`src/lib/pipeline/client-sink.ts:141-142,381-385,554-555,687-691`），但整合态清单只明确要求 direct handler recovery matrix；删除 Responses WS、非 recovery SSE 或某 vendor handler 的 callback 接线，现有规格 gate 仍可能全绿，而 manager registry 永不释放 — 增加按 transport／handler producer 列出的真实接线矩阵，至少让 SSE、WS、recovery 与非 recovery 各有正确样本，并对每类注入“漏 delivery notification”缺陷验证转红机制。

## 已挑战但未形成 major 的结论

- `canonical: "failed"` 后 `blocker: "none"` **可以成立**，因为规格已把 `failed` 定义为“finalizer reject 且错误已登记到 shutdown barrier”；关键是实施时把登记、状态发布与 registry release 收进同一不可分割的 manager primitive。
- Status 的 SSOT 方向正确：`activeRequests.count` 继续读取 `activeCount`，新增 `trackedOperations` 从 registry snapshot 即时聚合，没有引入第二份可变计数。
- Manager 的 resolve／reject 两条现有触发接缝均存在；缺口主要在 delivery settlement rejection 没有闭合的事实模型，而非 promise outcome 没有监听。

## 主观建议

未提出。本轮仅保留 blocker／major。

## 方法反思

1. **更好的内部替代方案**：以偏序 join 和显式 terminal outcome 取代单一总序，更贴合现有 `OperationScope`、delivery 与 canonical finalizer 的独立职责。
2. **判据判别力**：当前 mutation 能覆盖部分提前删除和永久保留，但漏掉 unsealed-zero-child 与非 direct handler 接线；这两类都是错误实现仍可全绿的 false-green。总序要求则会把正确并发实现判红。
3. **第三方方案**：该生命周期由项目特有的 request、delivery、History canonical publish 与 shutdown 契约组成，没有适合直接替代的成熟第三方库；应复用现有 `OperationScope`、delivery session 和 manager registry，而非另造通用状态机框架。

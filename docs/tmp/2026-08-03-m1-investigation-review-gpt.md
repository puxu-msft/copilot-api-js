# M1 调查结论对抗性核验报告

## 评审范围

评审对象为 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md` 的“#### M1 调查结论（2026-08-03 回填）”①–⑧，以及同文件被其改动的四处：M1 供给缝裁决、逐站点表行号警告、迁移期状态表 post-commit 行、`legacy 字段 allowlist 写者` 守卫。

## 已读取／执行的证据

- 被审计划：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/plan-3-remap-sites.md:94-278`。
- 冻结契约：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/docs/plan/2026-07-27-inter-block-anchor-allocator/README.md:49-63`，尤其 C9/C10/C11。
- 生产代码：`src/lib/anthropic/{keepalive-anchor.ts,live-reconcile.ts}`、`src/lib/pipeline/{types.ts,driver.ts,client-sink.ts,delivery/session.ts}`、`src/routes/messages/handler-v4.ts`、`src/lib/{context/request.ts,observability/events.ts,observability/sinks/ws.ts,tui/active-request-store.ts}`。
- 全仓 `rg`：anchor stop、`closeAnchorIfOpen`、legacy 字段赋值、`ownerFailure`、`beginLeg`、`recordFeature`、`request.feature_applied` 消费者。
- 在被审树、固定 HEAD `5b748b2d1b7dc769cb0a45bb9f82047ad8b0d9a2` 运行：
  - `bun test tests/architecture/circular-deps-ratchet.unit.test.ts`：`2 pass, 0 fail`。
  - `bun test tests/architecture/package-boundaries.unit.test.ts --test-name-pattern "stream-error outcomes are minted in exactly one place"`：`1 pass, 0 fail`。
- 在独立 scratch worktree `/tmp/copilot-api-js-ownerresult-review`、固定同一 HEAD 修改 `OwnerResult` 后运行 `bun run typecheck`。首次因 scratch 无 `node_modules` 得到 `tsc: command not found`；随后只在 scratch 建立指向主树依赖的 symlink 并重跑，得到真实 TS2322。再按计划候选的 overload 适配构造器，得到真实 TS2769。详见 Major-3。
- 在同一 scratch 新建只有 type import 的 `src/lib/pipeline/delivery/owner-failure.ts` 后运行 circular-deps ratchet：`2 pass, 0 fail`。

## 总体 verdict

**存在 blocker。** 当前回填不能作为后续每个迁移站点的冻结实施依据。

- Blocker：1
- Major：6
- Minor：3
- Nit：0

## 事实性发现

### Major-1：M4 后 allowlist 缩到 owner 一处，与本节自己的供给裁决直接矛盾

- **断言原文**：④及守卫条目称“`keepalive-anchor.ts` 的 injector 开侧必须保留”，同时又称“**M4 后 allowlist 缩到 owner 一处，M5 后归零**”。
- **裁决**：**不成立**。
- **证据**：
  - `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/keepalive-anchor.ts:319-335` 在 owner operation 入队前同步写 `injected`、`messageStartForwarded`、`anchorBlockOpen`，pre-commit 拒绝时由 `:327-332` 恢复。
  - 被审结论自己在 `plan-3-remap-sites.md:146` 与 `:161` 判定该开侧同步发布“必须留在原处”；③又明确 owner 只写 `anchorClosed`（`:149-156`）。
  - M4 迁走的是 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/anthropic/live-reconcile.ts:138` 的关侧赋值，不会迁走 injector 开侧。legacy 字段直到 M5 才删除。因此 M4 后合法写者仍至少是 owner + injector 两处。
- **失败场景**：实施者照“缩到 owner 一处”写守卫时，要么 M4 立即被合法 injector 写红，要么为了让守卫绿而提前删除 B1 镜像发布，重开本计划声称要防的撕裂窗口。
- **建议改法**：把④、状态表后的守卫条目和 M1/M4 验收清单统一改成：M1–M3 为 owner + injector + live-reconcile 三处；M4 后为 owner + injector 两处；M5 删除 legacy 字段后归零。不要写“owner 一处”。

### Major-2：③的关键事实只成立一半；“owner 不可能在意图产生时发布”把 C9 误读成禁止同步镜像发布

- **断言原文**：“driver 的快照在 serializer 之外发生……而 C9 禁止 owner 在 enqueue 时预留索引，所以 owner 在‘意图产生’那一刻不可能发布它。开侧交给 owner 会重新打开 B1 撕裂窗口。”
- **裁决**：**部分成立，作为排除方案 (a) 的机制性证明不成立**。
- **证据**：
  - 快照确实在 serializer 外：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:1222-1224` 先 `sink.freezeHeartbeat?.()`，随后直接读取 `anchorState.injected` / `anchorState.anchorBlockOpen`；owner serializer 在 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts:97` 创建，allocation operation 在 `:338-356` 才入队执行。
  - 当前 wrapper 的同步预发布确实承重：`keepalive-anchor.ts:319-335` 在第一次 `await` 前写镜像，`driver.ts:1223-1224` 可在 operation 排队期间读到它。
  - 但 C9（README `:58`）禁止的是**enqueue 时预留／消费 wire index**；它没有禁止 owner 的公开方法在调用当下、进入 `serializer.enqueue(...)` 之前同步发布一个 migration-only mirror，并在 pre-commit refusal 时恢复。当前 wrapper 本身正是在不预留 index 的情况下这样做（`keepalive-anchor.ts:319-335`）。把同一同步代码移到 owner API 外壳在机制上可行。
- **影响**：这不自动推翻“开侧留 wrapper、关侧窄 mirror”这个选择；format-agnostic delivery 不应依赖完整 Anthropic `AnchorState`（`plan-3:148`）仍是有效架构理由。但文档把“选择”写成“唯一可行”，且用错误的 C9 证明排除了纯 (a)。后续若 wrapper 接缝变化，实施者会误以为 owner 绝无能力承接同步镜像。
- **建议改法**：将事实一改为：“同步预发布必须发生在 serializer enqueue 之前；当前最窄、最少格式耦合的归属是 injector wrapper。owner 也可通过 enqueue 前的 migration-only mirror hook 实现，并不违反 C9，但会扩大 delivery 层的 legacy/format 耦合，故不采纳。”这样保留裁决而不伪造不可能性。

### Major-3：⑥的 `OwnerResult` 收紧不是可直接落地的类型改动；真实 typecheck 已红，且“构造器写法留给实施者”不足以保证每步可编译

- **断言原文**：把 `OwnerResult` 拆成三支后，“两个不可达组合构造不出来”，而⑧把 `ownerFailure` 内部构造方式留给实施者。
- **裁决**：**部分成立；类型形状与 C9 一致，但计划低估了现有 producer 的爆炸半径，不能声称该改动可直接编译。**
- **证据**：
  - 冻结 C9 要求 `session-terminating` / `wire-torn` preflight 均为 `committed:false`，所以三支 discriminated union 的长期形状正确（README `:58`；当前 preflight 在 `session.ts:289-292`）。
  - scratch 第一次只改 `src/lib/pipeline/types.ts:296` 为计划原文三支后，`bun run typecheck` 真输出：

    ```text
    src/lib/pipeline/delivery/session.ts(269,5): error TS2322: Type 'Readonly<{ ok: false; reason: "client-gone" | "session-terminating" | "wire-torn"; committed: boolean; }>' is not assignable to type 'OwnerResult<T>'.
    ```

    根因是当前 `ownerFailure(reason union, committed boolean)`（`session.ts:268-269`）抹掉了 reason 与 committed 的相关性。
  - scratch 再把构造器改为两条 overload 后，`bun run typecheck` 真输出：

    ```text
    src/lib/pipeline/delivery/session.ts(294,50): error TS2769: No overload matches this call.
    Argument of type '"client-gone" | "session-terminating"' is not assignable to parameter of type '"client-gone"' ...
    ```

    根因是 `ownerUnavailable()` 的 `finishReason ?? "session-terminating"` 在 `session.ts:291` 仍是 union，需显式判别后构造，不能只改 helper 签名。
  - 这正是用户要求核验的“会不会打红现有构造点”：会，且至少打红 helper 本身与 `ownerUnavailable`；尚未到任何测试，typecheck 已失败。
- **建议改法**：⑧不能只写“重载 vs 对象字面量留给实施者”。现在冻结一个保持相关性的构造 API，例如 `ownerClientGone(committed)` 与 `ownerUnavailableFailure(reason: "session-terminating" | "wire-torn")` 两个命名构造器，或参数对象的 discriminated union；同时明确 `ownerUnavailable` 必须按 `wireTorn`／`finishReason === "client-gone"`／其余 terminating 三臂返回。把真实 typecheck 爆点写入 M1 步骤与验收。此修复方应是 `gpt-souls:planner`（计划文本），实施时由 `gpt-souls:implementer` 落代码。

### Major-4：⑦声称 FeatureKind“已随 request.feature_applied 进 History”是错误事实；当前只进实时 observability／TUI 投影，不进持久 HistoryEntry

- **断言原文**：“它已随 `request.feature_applied` 进 History 与 observability 事件（`events.ts:231`），满足‘落到持久载体’。”
- **裁决**：**不成立**。
- **证据**：
  - `recordFeature` 只 publish 事件：`/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/context/request.ts:2109-2115`，没有写 request context 的持久字段。
  - `events.ts:231` 只是 `ObservabilityEvent` union 的实时事件类型，不是 History schema。
  - 全仓生产消费者只有实时层：WS sink 在 `src/lib/observability/sinks/ws.ts:129-136` 广播；TUI active store 在 `src/lib/tui/active-request-store.ts:110-112,169-186` 投影到在途 `tags`。`rg -n -C3 'request.feature_applied' src` 未发现 History sink／entry producer 消费者。
  - 持久结构 `HistoryEntryData` 在 `src/lib/context/types.ts:312-378` 没有 `features`／`tags` 字段；`toHistoryEntry()` 在 `src/lib/context/request.ts:1867-2064` 也没有把 feature 事件或 TUI `tags` 写入 entry。对 `src/lib/history` 与 `src/lib/context` 的 `rg -n 'tags'` 仅命中注释，无持久投影。
- **失败场景**：post-commit partial delivery 发生时，运行中的 WS/TUI 可能短暂看到 badge，但请求 settle／进程重启后 History 无任何证据；这直接违反性质 7 的“request-scoped diagnostic／History 投影字段”和项目 richest-data-flow。
- **建议改法**：现在冻结并计划一个真正持久的 request-scoped 字段。推荐不要复活无结构 `tags`：在 RequestContext 内累积结构化 `features: Array<{feature: FeatureKind; detail?: Record<string, unknown>}>`，在 `HistoryEntryData` 与 `toHistoryEntry()` 投影，V3 snapshot／持久 schema 按项目三点同步纪律更新；或若只为本特性，新增明确的 `delivery` 诊断结构。必须补 History round-trip oracle，证明 settle 后可从 History API／entry 读回 `operation`、`reason`，而不是只测事件 publish。

## 已确认但不构成发现的关键断言

- ①列出的 8 个 handler close 调用点均存在：`handler-v4.ts:693,1416,1526,1553,1607,1716,1754,1798`；其 enclosing 函数分别为 `writeTerminalThenSettle(...): Promise<void>`（`:691`）、`pumpAnthropicStreamingV4(...): Promise<void>`（`:1292`）、`pumpTranslateLegStreamingV4(...): Promise<void>`（`:1660`）。
- driver 站点 `:1438`、`:1609` 均位于 `runResponseBufferedSink(...): Promise<ResponseOutcome>`（`driver.ts:1090-1097`）；站点 11 是该函数内部 flush 判定／写出点。
- 1–8 共用 `keepalive-anchor.ts:259-265`，9–10 共用 driver 私有闭包 `driver.ts:1181-1193`；站点 12 是 `live-reconcile.ts:129-140` 的判定／帧生成与 `:164-174` 的实际写出组合。
- `legacyAnchorMirror` 沿 `SseSinkOptions` 透传在类型和构造链上可行：现有 `wireState` 从 `handler-v4.ts:1152-1154` → `client-sink.ts:485-492` → `delivery/session.ts:41-47,93`；同形新增字段即可。`makeAnchoredSseSink` 是生产源码中唯一构造 `AnchorState` 的 composition root（`handler-v4.ts:1086-1175`）。
- 派生式 `anchorsOpened() > 0 && openAnchorIndex === undefined` 与当前迁移状态表各行在值上等价；但它不能替代 M1–M3 的可写字段，因为 `live-reconcile.ts:138` 到 M4 才迁走。详见最终逐条裁决表。
- 新建 type-only `src/lib/pipeline/delivery/owner-failure.ts` 的 scratch cycle probe 通过：circular ratchet `2 pass, 0 fail`。driver 与 handler-v4 当前分别在 `driver.ts:33`、`handler-v4.ts:153` import delivery/session。
- master 守卫确实存在并通过：`tests/architecture/package-boundaries.unit.test.ts:590-624`，只允许 `streamErrorOutcome` 内 mint `{kind:"stream-error"}`；直接在新翻译模块返回 `ResponseOutcome` 的 stream-error literal 会成为 offender。守卫自身有 helper 正样本（`:620-623`）。

### 补充裁决 9：driver 适配器忠实继承现行 unsettled 判据

- **断言原文**：现有 `ownerFailureOutcome` 攓为消费 decision 后，`session-terminating` 仍按 `ctx.settled ? delivery-finished : stream-error` 分类。
- **裁决**：**成立**。
- **证据**：现行 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/driver.ts:937-941` 明确先判 `reason === "session-terminating" && !env.ctx.settled`，命中时走 `streamErrorOutcome`；否则工厂在 `:931-935` 把 `session-terminating` 映为 `delivery-finished`。被审结论 `plan-3-remap-sites.md:189` 精确保留同一真值表，只把 `env.ctx.settled` 抽成 `OwnerFailureContext.settled`。五个现有 `beginLeg` 失败调用点也确为 `driver.ts:878,1022,1109,1523,1581`。
- **建议改法**：无需改分类；实施时必须给 `session-terminating × settled=false/true` 各一条 oracle，且 driver adapter 必须把当前 `env.ctx` 本身或其 live `settled` view 交给 classifier，不能在 request 早期缓存 boolean。

逐条裁决表第 9 条最终改为：**成立**——五个调用点与 unsettled loud-error 判据均被忠实继承。

### 补充裁决 10：`session.ts:328` 的 `committed` 当前生产路径实践上为 true，但类型不应收窄

- **断言原文**：`ownerFailure(...)` 构造点恰好五处；`:328` 是 client-gone + variable committed。
- **裁决**：**构造点计数成立；`:328` 控制流变量理论可为 false，但当前生产机制下未证实 false 可达，实践上应视为 true。**
- **证据**：`session.ts:305` 初始化 false，`:310-314` 在首次外部 write 前同步置 true。build callback 的 throw 已在 `:345-349/:365-369` 外层处理；anchor/keepalive spec 的 `frameForSpec` 不要求 source，而 real block 在 `:361-362` 已验证 active leg。因此进入 `:324-332` catch 且被判 client-abort 的当前生产错误来自 `writeToSink`，此时 committed 已是 true。恶意 getter／未来新增的 pre-write materialization seam 才可能保留 false。
- **建议改法**：写成“`:328` 当前 production path 实践上为 true，但 helper 保留 boolean 以覆盖未来 pre-write throw；不要据此把整个 `client-gone,false` 组合判不可达，因为 `ownerUnavailable()` 的 preflight `:291` 已真实产出它。”不要为这条实践事实把 client-gone variant 收成 committed:true。

逐条裁决表第 10 条最终改为：**部分成立**——五处计数与两个不可达 reason 证明成立；`:328` 当前实践上为 true，但尚无 mutation probe，不应写成类型不变量。

### Major-5：⑧把 `OwnerOperation` 字面量集合留给实施者，会让持久诊断契约在各层各自发明

- **断言原文**：“`OwnerOperation` 字符串字面量集合的确切拼写”留给实施者，且称“不影响上面的性质”。
- **裁决**：**不成立；必须现在冻结。**
- **证据**：
  - ⑤已经把 `OwnerOperation` 放进公共 classifier 签名（`plan-3-remap-sites.md:184`）；⑦又把它承诺为持久 detail 的字段（`:221-226`）。一旦落入 History，它就是可查询／聚合的持久值域，不是局部命名。
  - 现有 owner 公共操作共有五类：`allocateAndWriteAnchor`、`withAllocatedRealBlock`、`beginLeg`、`closeOpenAnchor`、`writeBlockFrame`，见 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/types.ts:309-321`。`closeOpenAnchor` 还带 `mode: "before-real" | "terminal"`（`:317-320`），这是诊断上需要保留的子操作差异。
  - driver 的 5 个失败站点目前都是 `beginLeg`；handler 8 个 M1 站点都是 `closeOpenAnchor(...,"terminal")`；M2 的站点 11 是 `closeOpenAnchor(...,"before-real")`；未来 real block 写失败则来自另两个 API。若不冻结，适配器很容易分别记录 `"close"`、`"terminal"`、`"close-anchor"`，或把 mode 当 operation，导致同一失败无法聚合。
- **建议改法**：现在定义并写入计划：

  ```ts
  export type OwnerOperation =
    | "allocate-anchor"
    | "allocate-real-block"
    | "begin-leg"
    | "close-anchor-before-real"
    | "close-anchor-terminal"
    | "write-block-frame"
  ```

  如果希望只覆盖 M1 当前翻译站点，也至少冻结 `"begin-leg" | "close-anchor-terminal"`，并明确 M2 扩展必须修改同一 union；但长期完整形状以上述六值更好。`detail.operation` 必须直接使用 union，不接受任意 string。补 `satisfies Record<OwnerOperation,...>` 或构造映射穷尽测试，防新增 owner API 后诊断静默缺项。

逐条裁决表第 13 条最终改为：**不成立**——`OwnerOperation` 是公共签名与持久 detail 的值域，不能留给实施者临场命名；只可把 handler helper 的文件内摆放位置留给实施者。

### 对 Major-2 追问：纯 (a) 在 M1 技术上可落地，但不是更优形状

- **可落地位置**：若把开侧交给 owner，镜像发布必须放在 `/home/xp/src/copilot-api-js/.worktrees/anchor-alloc/src/lib/pipeline/delivery/session.ts` 当前 `allocateAndWriteAnchor` 方法的**同步外壳**里，即当前 `:338` 方法进入后、`:339 serializer.enqueue(...)` 调用之前：

  ```ts
  allocateAndWriteAnchor: (build) => {
    const previous = snapshotLegacyOpenMirror()
    publishLegacyOpenIntent() // 同步；必须早于 serializer.enqueue
    return serializer.enqueue(async () => { ... }).then(restoreOnUncommittedFailure, restoreOnPrecommitThrow)
  }
  ```

  放在 `serializer.enqueue(async () => { ... })` 的 callback 内（当前 `:340` 以后）太晚：operation 排队时 `driver.ts:1223-1224` 可先在 serializer 外读镜像。放在 `writeAllocationFrames` 的 `onCommit`（当前 `session.ts:351-353`）同样太晚，因为该回调只在 operation 已执行、首次 write 前才运行。
- **与 `restoreMirror()` 共存**：owner 外壳在同步发布前保存 previous；queued callback 若 `ownerUnavailable()` 返回 `committed:false`（`:340-341`）则恢复；build callback 抛错（`:345-349`）的 rejected promise 在外壳 catch 中恢复；`DeliveryOwnerError.committed === false` 时恢复；`OwnerResult.committed === true` 或 `DeliveryOwnerError.committed === true` 不恢复。逻辑与现有 `keepalive-anchor.ts:322-353` 一致，只是所有权搬进 owner。
- **但纯 (a) 不更优**：现有同步镜像不只含 `anchorBlockOpen`，还处理 `injected`、`messageStartForwarded`、`contentAnchorInjected` 与 `independentContentLatch`（`keepalive-anchor.ts:306-335`）。把**整个** `AnchorState` 和这些 Anthropic prelude 语义交给 format-agnostic delivery owner，会让 owner 知道 message envelope/content-latch 细节；它们不是 wire allocation 的一般语义。要避免耦合，只能传一个“同步 publish/restore callback port”，但那实际上是 (b) 的一种 callback 变体，而不再是纯 (a)。
- **最终判断**：纯 (a) **可行**，所以原文“owner 不可能发布”必须删除；但现有混合裁决仍是更健康的长期形状：format-specific 开侧留 injector，owner 只接迁移期窄关侧 mirror。选择理由应写成“保持 delivery 层 format-agnostic／避免 AnchorState 与 prelude latch 耦合”，而不是错误援引 C9 的不可能性。

### Major-6：⑦的记录点漏掉非 client 的 post-commit partial delivery，字段名与注释承诺大于实际覆盖面

- **断言原文**：`wire-partial-delivery` 表示“an owner wire operation failed AFTER its commit point”，并“由 `classifyOwnerFailure` 在 `failure.committed === true` 时唯一记录一次”。
- **裁决**：**不成立／不完整**。
- **证据**：
  - client-abort 写失败返回 `OwnerResult`，会到 classifier：`session.ts:324-328,410-413,437-440`。
  - 非 client post-commit 写失败不返回 `OwnerFailure`；它置 `wireTorn` 后 **throw `DeliveryOwnerError(error, committed)`**：`session.ts:330-332,415-417,442-444`。这些错误绕过 `classifyOwnerFailure`，所以不会记录 `wire-partial-delivery`。
  - C9 明确 post-commit 非 client 撕裂同样永久消费 index、字节可能已上线（README `:58`）。它比 client-gone 更需要持久证据，不能因控制流是 throw 就消失。
  - 被审注释 `plan-3:221-223` 用的是泛化的“owner wire operation failed AFTER commit point”，而 `:226` 的实现承诺只覆盖 `OwnerFailure.committed`；两者自相矛盾。
- **建议改法**：把诊断记录下沉到 owner 的 commit-aware catch，或抽一个同时被 returned client-gone 与 thrown `DeliveryOwnerError` 调用的 exactly-once recorder。持久 detail 至少冻结 `{operation, cause: "client-gone" | "wire-error", committed: true}`；不要把 throw 硬塞进 `OwnerFailureReason`。若坚持只记录 client-gone，则必须把 feature 重命名为 client-specific，并明确另增 wire-torn partial 诊断；长期正确形状是统一覆盖所有 post-commit 失败。

### Minor-1：`classifyOwnerFailure`“唯一记录一次”只是调用拓扑约定，不是 exactly-once 保证

- **断言原文**：两个适配器都调用 classifier，因此“唯一记录一次”。
- **裁决**：**部分成立**。当前 driver beginLeg failure 与 handler close failure 的消费路径互斥，正常接线确实各调用一次；但 proposed `OwnerFailure` 没有 operation/failure identity，也无 consumed latch，classifier 被误调用两次会 publish 两次。
- **证据**：`recordFeature` 每次调用无条件 publish（`context/request.ts:2109-2115`）；拟议 classifier 签名 `plan-3:184` 没有去重 token。当前“只一次”来自站点模板纪律而非 API 性质。
- **建议改法**：将措辞降为“每个 adapter 对一个 failure 只调用一次，由站点接线 oracle 证明”；若业务真的要求 exactly-once 事件，则在 owner 产生点记录，避免翻译层重复消费。结合 Major-6，推荐 owner 产生点统一记录。

### Minor-2：`owner-failure.ts`“只 import type”与模块无环已验证，但计划应禁止它 import driver 的 `ResponseOutcome`／`RequestEnvelope`

- **断言原文**：新模块是叶子，只 `import type`，不新增环。
- **裁决**：**成立，但约束不够机器化**。
- **证据**：scratch 新建仅 `import type { OwnerResult } from "../types"` 的模块后 circular ratchet 真跑 `2 pass, 0 fail`。但一旦实施者为方便从 driver import `ResponseOutcome` 或 `RequestEnvelope`，就违背“不返回 outcome”的分层意图；现有 cycle ratchet只拒新增 SCC，不一定拒一条仍不成环的逆向边。
- **建议改法**：M1 加 package-boundary／AST 守卫：`owner-failure.ts` 只允许 type-import `../types` 与 observability `FeatureKind` 所在的类型拥有方，不得 import `driver.ts`、handler、context concrete implementation。此项不影响当前裁决，故为 Minor。

## Blocker-1：①漏掉真实第 13 个 anchor-stop 写出点，且使④修订后的 M1 allowlist 仍然不可满足

- **断言原文**：①称生产 anchor-stop 站点共 12 个、没有第 13 个；④称 M1–M4 赋值只允许 owner、injector、live-reconcile 三处。
- **裁决**：**不成立，且阻断 M1。**
- **证据**：全生产源码精确搜索 `(?:anchor|anchorHooks|hooks)\.stopFrame\(` 得到五个构造／写出 primitive：
  - shared handler primitive：`keepalive-anchor.ts:263`，由 8 个 handler 站点调用；
  - driver terminal 私有 closure：`driver.ts:1188`，由 `:1438/:1609` 两站点调用；
  - driver flush close-before-real：`driver.ts:1242`（表中站点 11）；
  - **driver retreat 后 live write-through close-before-real：`driver.ts:1317-1321`（表中遗漏）**；
  - live reconcile：`live-reconcile.ts:129-140,172-174`（表中站点 12）。
- **为什么不是站点 11 的同一行**：`:1239-1244` 的 `closeAnchorBeforeReal` 只在一次 `flushBufferedFrames` operation 内执行；`:1317-1321` 位于 `if (retreated)` 的后续 live write-through，每来一个真实 start 都独立判定。特别是 retreat 之后 heartbeat resume，而 anchor 可在后续 live gap 被注入时，这个分支负责在下一个真实 block 前关闭；它不是 flush 调用点的别名。所在 enclosing function 是 `runResponseBufferedSink(...): Promise<ResponseOutcome>`（`driver.ts:1090-1097`），应归 M2。
- **allowlist 直接失败**：遗漏站点在 `driver.ts:1318` 写 `anchorState.anchorClosed = true`；表中站点 11 也在 `driver.ts:1241` 写同字段。两者按计划都到 M2 才迁，而 M1 结束时仍合法存在。因此 M1 若立刻启用“只允许 owner、injector、live-reconcile”三处的守卫，一定把这两个尚未迁移的 M2 写点判 offender。当前全仓赋值搜索也明确命中 `driver.ts:1241,1318`。
- **建议改法**：①改为 13 站点，新增“driver retreat live write-through 的 first-real close，`driver.ts:1317-1321`，`Promise<ResponseOutcome>`，归 M2”。④改为按 commit 收缩的 allowlist：M1 后允许 owner + injector + driver 的两个 M2 close-before-real 实现 + live-reconcile；M2 后移除两个 driver legacy 写点；M4 后仍是 owner + injector；M5 后归零。守卫最好按具名函数／AST owner 匹配，不要只按文件，因为 `driver.ts` 宽文件 allowlist 会放过新写者。


### Minor-3：“无 owner 时 no-op 与今天 inert 行为一致”只在 wire 字节层成立，不是状态行为等价

- **断言原文**：`closeAnchorViaOwner` 在无 delivery owner／数组 sink 时 no-op，“与今天 `closeAnchorIfOpen` 的 inert 行为逐字节一致”。
- **裁决**：**部分成立**。
- **证据**：今天 shared primitive 在 `keepalive-anchor.ts:259-264` 即使 `sink.writeAnchor` 缺失，也会先 `anchorState.anchorClosed = true` 并调用可选 `sink.close`；拟议无 owner no-op 不改 state。wire 上都不写 anchor stop，故“逐字节”成立；但重复调用、state 断言和 close side effect 不等价。
- **建议改法**：明确只承诺 client wire byte-equivalence；测试数组 sink 若观察 legacy state，应改成通过 fake delivery owner 测 owner close，而不是依赖无 owner fallback。若仍要求完整行为等价，无 owner helper 必须复刻 legacy state/close side effect，但这会延长双轨，不推荐。

## 最终逐条裁决表（本表取代前文阶段性表）

| # | 独立裁决 | 证据与结论 |
|---|---|---|
| 1 | **部分成立** | 表中 1–12 的位置／函数返回类型正确：handler 8 处在 `handler-v4.ts:691,1292,1660` 所声明的 `Promise<void>` 函数内；driver 9/10 在 `driver.ts:1090-1097` 的 `Promise<ResponseOutcome>` 内；11/12 的“flush 内部”“纯函数+装饰器”描述正确。但清单不完整，漏 `driver.ts:1317-1321`，见 Blocker-1。 |
| 2 | **不成立** | 1–8 共用 `keepalive-anchor.ts:259-265`、9–10 用 `driver.ts:1181-1193` 私有 closure 均正确；但确有第 13 个 anchor stop 判定／写出点 `driver.ts:1317-1321`。精确 stopFrame 搜索有已知正样本并命中该点。 |
| 3 | **部分成立** | `driver.ts:1223-1224` 快照确在 owner serializer 外；同步预发布确为 B1 承重点。但 C9 只禁 enqueue 时预留 index，不禁 owner API 在 `serializer.enqueue` 前同步写 migration mirror；“owner 不可能发布”错误。纯 (a) 的具体可落地形状见 Major-2 追问答复。 |
| 4 | **成立** | `legacyAnchorMirror` 可按现有 `wireState` 链透传：`handler-v4.ts:1152-1154` → `client-sink.ts:485-492` → `delivery/session.ts:41-47,93`。生产源码中 `makeAnchoredSseSink` 是唯一同时创建 `AnchorState`（`:1122-1129`）并调用 delivery sink（`:1152-1173`）的 composition root。 |
| 5 | **成立** | 派生式逐格等价：初始／preflight／build-fail 为 false；open success 与 post-commit fail 因 `openAnchorIndex` 有值为 false；close success 因 anchors>0 + open undefined 为 true；client-gone close 因 index 保留为 false；none／非-client 保持原值。不能改 getter 的理由是 `live-reconcile.ts:138` 在 M4 前仍需赋值，属于每步可编译约束。 |
| 6 | **不成立** | injector 开侧 `keepalive-anchor.ts:322-335` 到 M5 前须保留；live-reconcile `:138` 到 M4 前须保留；此外计划漏掉 M2 前仍须保留的 driver 两处 close-before-real 写者 `driver.ts:1241,1318`。原三处 allowlist 在 M1 即不可满足，M4 后“owner 一处”也错误。 |
| 7 | **成立** | scratch 新建 type-only `delivery/owner-failure.ts` 后 cycle ratchet真跑 `2 pass, 0 fail`。driver／handler 已分别在 `driver.ts:33`、`handler-v4.ts:153` import delivery/session；按该方向新增 type-only sibling import 不新增 SCC。仍建议加边界守卫，见 Minor-2。 |
| 8 | **成立** | `tests/architecture/package-boundaries.unit.test.ts:590-624` 确有守卫，真跑 `1 pass, 0 fail`。它 AST 扫描 src，除 `streamErrorOutcome` 外任何 `{kind:"stream-error"}` literal 都记 offender，并用 helper 自身 `helperLiterals===1` 作正样本。翻译层直接返回 stream-error outcome 会踩守卫。 |
| 9 | **成立** | 现有适配器在 `driver.ts:937-941` 对 `session-terminating && !env.ctx.settled` loud mint stream-error；被审 `plan-3:189` 精确保留 `ctx.settled ? delivery-finished : stream-error`。五个 beginLeg 失败点确为 `:878/:1022/:1109/:1523/:1581`。 |
| 10 | **部分成立** | `ownerFailure` 调用点按源码调用表达式恰好五处：`session.ts:290,291,328,413,440`。`session-terminating,true` 与 `wire-torn,true` 不从 OwnerResult 产出：`ownerUnavailable` 固定 false，非-client post-commit throw `DeliveryOwnerError`。`:328` 的 committed 是变量，但当前生产 specs／source 前置条件下未证实 false 可达，实践上应视为 true；client-gone,false 已由 `:291` preflight 独立可达。类型仍应保留 client-gone boolean。 |
| 11 | **部分成立** | 三支类型与 README C9 一致，但不是单改 type 就绿。scratch 真改后 typecheck 先 TS2322 于 `session.ts:269`；加 overload 后再 TS2769 于 `session.ts:294`。必须同时重构 helper 与 `ownerUnavailable` 的 union 分支；真实输出见 Major-3。 |
| 12 | **不成立** | 新 FeatureKind 会进入实时 observability event 与 WS/TUI（`events.ts:231`、`ws.ts:129-136`、`active-request-store.ts:110-112`），但不会进入持久 History：`recordFeature` 只 publish（`request.ts:2109-2115`），`HistoryEntryData:312-378` 与 `toHistoryEntry:1867-2064` 无 feature 投影。此外 classifier 漏非-client post-commit throw，且“唯一一次”无 API 去重保证，见 Major-4/Major-6/Minor-1。 |
| 13 | **不成立** | `OwnerOperation` 已进入公共 classifier 签名与拟持久 detail，必须现在冻结值域；否则 beginLeg、terminal close、before-real close、real write 会各自发明不可聚合字符串。建议六值 union 见 Major-5。只有 helper 摆放位置与内部构造实现可留给实施者。 |

## 最终严重度汇总与修复路由

- Blocker：1
- Major：6
- Minor：3
- Nit：0
- Verdict：**存在 blocker**。修复 Blocker-1、Major-1 至 Major-6 并重新独立评审前，不得把回填 plan 合主线或启动 M1 迁移。
- 建议修复方：本产物是实施计划／架构指令文本，主会话宜派 `gpt-souls:planner` 修正文档；History 持久载体的结构选择若需要重新定边界，派 `gpt-souls:architect-advisor`；修订后由原 reviewer 复审事实，再由未卷入者处理争议项。

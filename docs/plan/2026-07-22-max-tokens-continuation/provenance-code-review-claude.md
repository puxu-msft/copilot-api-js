# Provenance 实现代码评审（Claude reviewer，异模型交叉）

> 评审者：Claude 驱动 reviewer（实现由 GPT implementer 完成，异模型交叉审）
> 日期：2026-07-27
> 落盘说明：reviewer 的 Write 工具在其上下文被禁用，报告由主会话代为原样落盘。

**评审范围**：`/home/xp/src/copilot-api-js/.worktrees/mt-provenance`，分支 `feat/max-tokens-provenance`，`git diff db1cb775..d89d92f8`（5 commit，源码 6 文件 + 测试 2 + 文档 2）。

**总体 verdict**：**可合并入 master**——未发现 blocker，未发现 major 功能缺陷；标记打在真实生产路径上、richest-data-flow 铁律未被破坏、无 scope creep。建议同批补 2 个 MEDIUM（测试负控 + 文档同步），均为小改、不阻断合并。

**blocker 数：0；major 数：0；medium：4；low：4；nit：2。**

## 双视角覆盖证据

**机械核对**
- 逐 commit 读全 diff；`OperationSyntheticKind` / `CandidateRole` / `upstreamRequest` / `extensions` 全仓 grep 找必改站点与消费端。
- 多站点对账：`OperationTrack`→V3 CAS 序列化（`v3/store.ts:447,1259`）→`recordToHistoryEntry`→`getHistory` 读面；另一条 producer `toHistoryEntry`/`legFromUpstreamRequest`（`request.ts:143,1981`）逐字段核。
- 环境证据：`bun run typecheck` 0 错；对 8 个改动文件跑 ESLint 0 错；`bun scripts/parallel-test.ts unit it http` = **6368 pass / 0 fail**（`bun run test:backend` 本机跑不了：`build:history-search` 需 cargo/rustup，环境缺，**与本分支无关**）。
- `typecheck:ui-v4` 在**基线 master 上同样红**（`~/lib/sqlite/compression` 等模块解析失败），故不能用作本分支证据；改以 grep 核实 `ui-v4/src` 完全不引用 `OperationSyntheticKind`/`UpstreamRequestLeg`/`upstreamRequest` → 新增 union 值不会打爆前端穷尽 Record。
- 需求权威对账：backlog `docs/todo/2026-07-22-continuation-synthetic-provenance.md` 的「理想架构 / 若做需改什么」四项与实现逐项吻合；spec `2026-07-22-continuation-retry-and-sequential-anchor.md:166` 的要求被满足；`plan-1-anthropic-continuation.md:19,114` 确认 success-path 复用 `coordinator.runContinuation`。
- 分支位置：落后 master 6 commit，但 master 这 6 个只动 docs/exp/skills，**无源码重叠**，合并语义风险低。

**第一人称执行视角**
- 走「真实 SDK 请求 → 上游中途 cut → 续写腿」全链路：真跑 `tests/e2e-client/continuation-sdk.it.test.ts`（6 pass）。
- **两次删除式 mutation 控制**：① 删 driver 打标行 → 在 `continuation-sdk.it.test.ts:137`（canonical readback）咬住失败；② 删 projection 投影行 → 在 `:140`（公共 `getHistory()`）咬住失败。→ 双 readback oracle 真有牙，非 same-source-blind。
- **一次反向 mutation**：把打标改成**无条件对每个 dispatch 打标** → 全后端 tier **6368 pass / 0 fail 全绿**（见 M-1）。
- **自建临时探针**（跑完已删除，worktree 已恢复干净）实测三条路径：chained 三腿续写 → `ext=[null,{synthetic:"continuation"},{synthetic:"continuation"}]`、`roles=["primary","continuation","continuation"]`、`projected=[null,"continuation","continuation"]`、`bodyHasSynthetic=[false,false,false]`；pre-commit cut 的 transparent retry（role `recovery`）→ `projected=[null,null]`（无误标）。
- 走「`explicit=false` 兼容路径」「`parent` 绑定缺失 → `runPrimary()` 回退」「recorder `sealed` 竞态」三条分支，判定其在生产可达性（详见 L-2）。
- 走「读 History 的人」视角：从 `getHistory()`/`getEntry` 读面回溯到底谁生产 `attempts[].upstreamRequest`，发现第二个 producer（M-2）。

## 事实性发现

**[MEDIUM] M-1 · `tests/e2e-client/continuation-sdk.it.test.ts:136-147` — oracle 缺「非 continuation dispatch 不得被打标」的负向对照，false-positive 回归可全绿通过**

证据（实测，非推理）：把 `driver.ts:621` 的 `if (candidateRoles.get(candidate) === "continuation")` 判据删掉、改成对**每个** dispatch 无条件 `markGenerationDispatchSynthetic(handle,"continuation")`，全后端 tier 仍 6368 pass / 0 fail。也就是说：主腿、transparent-retry 腿、hedge 腿被全部错标成「合成续写请求」这种直接违反 richest-data-flow「可辨识」目的的回归，现有测试一个都抓不到。当前行为本身是**正确**的（探针实测 primary/recovery 腿均未被标记），缺的是把它钉住的断言。

建议：① 在既有 CHAINED 三腿用例补 `expect(canonical?.dispatches.map(d => d.upstreamRequest?.extensions?.synthetic)).toEqual([undefined,"continuation","continuation"])`（顺带补上目前完全没覆盖的**多腿续写**标记覆盖）；② 在「positive control: a clean single-exchange turn」用例补 `expect(entry?.attempts?.[0]?.upstreamRequest).not.toHaveProperty("synthetic")`；③ 理想再加一条 pre-commit cut（transparent retry）用例断言两腿都无标记。

**[MEDIUM] M-2 · `src/lib/context/request.ts:143-156`（legFromUpstreamRequest）+ `:1684/:1765/:1802` — 同一个客户端可见字段有两个 producer，只有 V3 那条带 provenance**

证据：`markGenerationDispatchSynthetic`（request.ts:1319-1323）只写 canonical recorder；而 legacy 串行腿仍由 `setAttemptWireRequest`（:1438-1460）→ `legFromUpstreamRequest` 生成 `attempts[].upstreamRequest`，字段清单里没有 synthetic。ctx.complete/fail/abort 用它构造 `entry` 发到 observability 总线（telemetry / calibration / TUI 等 sink 消费），这些消费者看到的续写腿**没有** provenance。持久化读面（History REST/WS 走 `queries.ts` → `recordToHistoryEntry`）不受影响，故当前**无实际消费者受损**——但这正是项目记忆 `full-primitive-not-partial-else-silent-field-drop` /「新顶层字段三处必改」的复发形状：字段在一条腿静默缺席，等到第一个总线消费者想读时才炸。

建议：二选一并落文档——① `markGenerationDispatchSynthetic` 同时在 Attempt 上落一份（`legFromUpstreamRequest` 随行输出），两 producer 对齐；② 明确判定 transient 快照不承载 provenance，在 `legFromUpstreamRequest` 的 TSDoc 或 backlog 里写清「provenance 只在 V3 durable 腿」。

**[MEDIUM] M-3 · `src/lib/history/types.ts:176-209` — 共用 union 的权威文档说「Meaningful only on the FORWARDED track」，与新字段所在的上游请求腿语义直接矛盾**

证据：`OperationSyntheticKind` 的唯一散文说明挂在 `SseEventRecord.synthetic`（:210）上，开宗明义「Meaningful only on the FORWARDED track (`clientResponse.sseEvents`)」，并逐条枚举 keepalive/anchor/hook-*/error-shaping-* 等值。本次把同一 union 复用到 `UpstreamRequestLeg.synthetic`（:433，**upstream 请求轨**，不是 forwarded 帧轨），且新值 `"continuation"` 未进该枚举表。读者按这段文档理解会得出「上游请求腿不该有这个字段」的错误结论。（另注：`"buffered-terminal-repair"` 早已缺席该表，是**先于本分支**的存量漂移。）

建议：把该 doc block 提为 union 自身的文档（挂到 `model-operation-record.ts:28` 的 `OperationSyntheticKind` 上），把「forwarded-only」限定语降为**每个值**的适用轨说明，并补 `"continuation"`（适用轨：upstream-request 腿）与 `"buffered-terminal-repair"` 两行。

**[MEDIUM] M-4 · `docs/history.md:54` + `docs/memory/project-continuation-retry-sequential-anchor.md` — 文档未随代码同步（doc-vs-code 漂移）**

证据：① `docs/history.md:54` 是 History 数据模型的活文档，`upstreamRequest` 字段清单写死为 `{ format, model, messages, system, headers, body }`，新增的客户端可见字段 `synthetic` 未加；② 项目记忆仍写「剩余: … synthetic:continuation provenance marker（纯可观测缺口）」，而该缺口已在本分支闭合。backlog 本体已正确改为「已解决」并引用四个 commit——这部分做得干净。

建议：`docs/history.md:54` 补 `synthetic?`（一句话：续写等合成上游请求的 provenance，只在合成腿出现，wire 字节不含）；更新该记忆条目的「剩余」清单。

**[LOW] L-1 · `model-operation-record.ts:1055-1065` + `v3/projection.ts:306-307` — canonical 侧用无类型 extensions 裸键，偏离仓库命名惯例并逼出 unchecked cast**

证据：仓库现存所有 extensions 生产点都用**命名空间点号键**（`v3/recovery.ts` 的 `"history-v3.recovery"`、`lightweight-model-operation.ts:285` 的 `"history-v3.lightweight"`），本次写入的是裸键 `synthetic`；投影处因 `OperationExtensions` 是 `Record<string, unknown>`，被迫写无校验断言（任何未来往同名裸键写别的东西的生产者都会被原样投影成 provenance）。不对称点：plan Task P.2 为 History 侧选了**一等字段**，canonical 侧却退回开放 bag。

建议（长远正确形状）：给 `OperationTrack` / `OperationTrackInput` 加一等 `readonly synthetic?: OperationSyntheticKind`——同文件 `OperationFrameObservation.synthetic`（:177）已是先例——则类型安全、投影免 cast、免键冲突。

**[LOW] L-2 · `request.ts:1319-1323` + `model-operation-record.ts:1055-1058` — 新端口是同族里唯一「记录失败就抛」的 setter**

证据：`setDispatchUpstreamRequestExtensions` 先 `assertWritable()`（sealed 时抛），再在 `upstreamRequest === undefined` 时抛；而所有同族 setter（request.ts:1422/1443/1467/1480）遇 `sealed || settled` 一律**静默 no-op**。若该抛出发生在 `beginDispatch` 内，会沿 `runContinuation` 冒泡到 `driver.ts:1456` 的 catch，被降级成 `continuation-exhausted`——即「一个可观测性标记把功能腿弄丢」。

可达性（已核，诚实标注）：**当前不可达**——`beginGenerationDispatch` 在 sealed 时已先抛，且 begin→mark 是同步块无 await 缝。故是健壮性/一致性问题，非现行缺陷。

建议：对齐同族 no-op 语义，或在 TSDoc 写明前置条件。

**[LOW] L-3 · `driver.ts:586-591` — `explicit` 能力探测未包含新方法**

证据：探测只检查四个方法；`markGenerationDispatchSynthetic` 是新增的 `RequestContext` 必需方法，但测试里大量 `as unknown as RequestContext` 的部分 mock 绕开类型检查。现存 mock 都不提供那四个方法（走 fallback 分支），**当前无触发者**。

建议：把新方法加入 `explicit` 探测的合取式（一行）。

**[LOW] L-4 · `tests/e2e-client/continuation-sdk.it.test.ts` —「marker 绝不进真实 wire 字节」没有直接 oracle**

证据：现有断言经 `upstreamRequest.messages` 投影间接覆盖，但顶层多一个 `synthetic` 键不会体现在 `messages` 上。探针查了持久化 wire payload（`bodyHasSynthetic=[false,false,false]`）并读码确认打标只写 recorder，故 invariant 成立——但套件没钉住。

建议：harness 侧捕获实际收到的 request body，断言 `JSON.parse(body)` 无 `synthetic` 顶层键。

**[NIT] N-1** · `markGenerationDispatchSynthetic` 标记的其实是该 dispatch 的 **upstreamRequest 腿**，`markGenerationDispatchRequestSynthetic` 更贴职责（命名精度）。

**[NIT] N-2** · `candidateRoles` 在 `settleCandidate` 时不清理（与既有 `fallbackCandidates` 同款）。每请求候选数有界，无实际影响。

## 主观建议

**[建议] `driver.ts:621` 附近 — 把「CandidateRole 判据」的不变量写成注释**：现判据的隐含前提是「continuation 角色候选下的**所有** dispatch（含其内部 retry）发的都是合成 body」。今天成立；将来若 continuation 候选内部会重放非合成 body，判据就失真。建议一行注释写明该不变量 +「success-path max_tokens 续写复用 `coordinator.runContinuation`（plan-1 Task 1.2）故自动继承」——后半句已核实为真。

**[建议] 记录「帧级 continuation tag 本次未做」的取舍（record-not-adopted）**：`client-sink.ts` 有两处手抄的 synthetic 字面量 union、`frame-origin.ts:29` 有 `SyntheticOriginKind`。本次**故意**不加（本次标的是请求腿、不是帧），判定为正确取舍；但 max_tokens spec:72 提到未来「合成结构帧打 `synthetic:"continuation"`」。建议留一句「若将来要做帧级 tag，须同步改 client-sink 两处内联 union + `SyntheticOriginKind`」。

**[建议] 合并前先把 master 的 commit 合进来跑一次 tier**：机械冲突风险为零，但项目记忆里「语义合并冲突两边各绿合并却坏」的教训成本很高，一次 34s 的 tier 换确定性划算。

## 针对 5 个对抗方向的结论

1. **标记真实性**：真打在生产路径上——测试走真实 `@anthropic-ai/sdk` + `serveInProcess` 全 handler 链路，标记来自 driver 而非测试构造；探针实测**链式三腿**两条续写腿全部命中、primary 与 transparent-retry(role `recovery`) 腿零误标。未来 max_tokens success-path 复用 `coordinator.runContinuation`（plan-1:19,114）→ implementer「自动覆盖」的声称**核实为真**。唯一软肋是没有断言锁住（M-1）。
2. **richest-data-flow 铁律**：通过。marker 只经 recorder 侧信道 → CAS track extensions → projection，**从不触碰 `continuation.buildRequest` 产出的 body**；实测持久化 wire payload 无 `synthetic` 串；合成三轮消息忠实保留；上游 original 响应轨零污染。
3. **测试真实性**：双 oracle 为真——`getV3Operation` 走 sqlite `manifest_gz` 水合，是**持久化读回**；`getHistory()` 走 V3 投影，非内存对象自证。两次删除式 mutation 分别咬在该咬的断言上。**唯一 same-source 风险已实测暴露**：false-positive 方向完全无控（M-1）。
4. **新字段多站点**：类型定义 ✅、canonical 记录端口 ✅、V3 逐字段投影 ✅（显式 allowlist，漏了就静默丢——做对了）、ui-v4 无耦合 ✅。**漏的两处**：第二个 producer `legFromUpstreamRequest`（M-2）与 union 的权威 doc block（M-3）。
5. **scope creep / 命名 / swallow error**：无 scope creep；命名基本反映职责（N-1 是精度问题）；新代码不吞错误，但它**会抛**且抛出会落进既有的静默降级 catch（L-2，当前不可达）。

## 补充事实（供决策，非缺陷）

- `bun run test:backend` 在评审机**跑不起来**（前置 `build:history-search` 需 cargo/rustup），故用 `bun scripts/parallel-test.ts unit it http` 复现，数字一致（6368/0）。
- `bun run typecheck:ui-v4` 在**基线 master 上也红**（`~/lib/sqlite/compression`、`~/lib/error/transport-reason` 等解析失败）——先于本分支存在，属仓库既有问题，但意味着前端类型门当前失效，任何「ui-v4 绿」的声称都不成立（改用 grep 取证）。**值得单独进 backlog**。

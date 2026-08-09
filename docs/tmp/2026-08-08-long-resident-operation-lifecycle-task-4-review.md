# Task 4 独立评审（commit 3e418cdb）

范围：仅 Task 4（manager registry release / blocker 聚合 / drain 改名）。实施树只读，全部实测在 /tmp/t4rev（git archive 3e418cdb + node_modules 软链）。

## 事实性发现

### [blocker] src/lib/context/manager.ts:545-553 —— 已登记的 delivery failure 永不进入 drain，shutdown lifecycle barrier 不会失败
证据（探针 /tmp/t4rev/tests/context/zz-probe.unit.test.ts，P1）：settle 后 `failModelOperationDelivery(new Error("delivery-boom"))` →
`delivery={state:failed,failureRegistered:true}`、canonical=completed、blocker=none、registry 释放（count 0）→ `await drainLifecycleFailures()` 输出 `NOTHING`。
错误只写进 write-only 的 `lifecycleFailureBarrier`（manager.ts:272，全文件仅 460/462 两处写、零处读），ctx 已从 registry 删除，failure verdict 在进程层彻底消失。
违反：plan Global Constraints「失败保留原始 error，并使 shutdown lifecycle barrier 失败」；Task 4 Step 1 明列的用例「delivery／canonical failure 都删除 registry 但 drainLifecycleFailures() 抛含原始错误的 AggregateError」；以及 manager.ts:109 自己的 JSDoc「surface any registered delivery/canonical lifecycle failure」。
该用例未被写出（tests/context/manager-dual-registry.unit.test.ts 只有 canonical 分支），所以套件全绿属 false-green。Task 6 也接不住（plan Task 6 Step 3 明写「Drain 行为不变」，Step 5 只改名）。
修复：drain 在等完 pending finalizer 后，把 barrier 中未被 finalizer rejection 覆盖的 error 一并并入 AggregateError（并在此清空），补 delivery-failure→drain 抛原始 error 的用例 + mutation。

### [major] src/lib/context/manager.ts:272 —— `lifecycleFailureBarrier` 无任何驱逐，按 requestId 单调增长
证据：`grep -n lifecycleFailureBarrier src/lib/context/manager.ts` 只有 272(decl)/460(get)/462(set)，全仓无 delete/clear；manager 是进程级单例。
每个失败的 `(requestId, phase)` 永久保留一条 `{error}`，而 error 常是携带 stack 与上游 payload 引用的对象；客户端中断导致的 delivery failure 在本代理里属常态。
后果：本计划意在消灭「长驻留」，却在同一子系统新增一条进程生命周期的单调保留；数小时/数天运行后是可观测的内存增长，且无任何接口能看到它（见上一条，它同时也读不出来）。
Task 5-8 都不覆盖（Task 6 仅改名与渲染）。
修复：与上一条同解——drain 消费即清空；并在 `releaseTrackedOperationIfTerminal` 成功删除该 id 后驱逐 `${id}:delivery` / `${id}:canonical`（前提是 error 已被 drain 通道接管），使 barrier 的生存期与 tracked operation 对齐。

## 命题逐条核验（C1/C2/C3/C4/C6）

- **C1 成立。** `operationScopes.delete` 全文件唯一出现在 manager.ts:395（`releaseTrackedOperationIfTerminal` 内）；两条回调 manager.ts:436-446 均只调该 primitive，无 inline delete（`grep -n operationScopes src/lib/context/manager.ts` 输出仅 264/383-395/421/469/509/513/524/539）。
- **C2 成立。** manager.ts:393-395 读 `ctx.operationLifecycle.blocker !== "none"` 即 return，未看 outcome；reject 分支同样走它（实测：canonical 拒绝且已登记 → canonicalState=failed → blocker=none → 释放，tests/context/manager-dual-registry.unit.test.ts 第 5 例绿）。未登记 failure 的 blocker 确实不为 none（request.ts:911-913、886），故不会误删——但该 false 分支在生产上不可达（request.ts:910 的 `isDeliveryOutcomeLocked` 在登记前就 return，canonical catch 每 ctx 只跑一次），因此这条保护只有推理、没有可执行的正/负样本。
- **C3 成立。** manager.ts:516-543 每次调用现场初始化 `byBlocker` 并遍历 `operationScopes`，无平行计数器；`count` 取 `operationScopes.size`，每个 ctx 恰计一次且 `none` 直接抛错，故求和恒等于 count；`oldestStartTime===undefined → oldestAgeMs 0`（实测零元素形态 `{count:0, byBlocker 全 0, oldestAgeMs:0}` 通过）；`blocker==="none"` 抛 invariant error 在 manager.ts:532-534。补充观察：从 canonical 置终态到 release 全程是 microtask 链（request.ts:920-935 → manager.ts:436），I/O 回调插不进去，故 `/api/status` 不会撞上这个 throw——但这只对当前实现成立，Task 6 接线时若在其间引入 await 就会变成 500。
- **C4 成立（与 plan 一致）。** manager.ts:458-464：`key=${requestId}:${phase}`，已存在则 `existing.error === failure.error`（同 error 幂等 true、异 error false），否则写入返回 true；request.ts:884-890 把 throw 也折成 false。它确实是 presence gate、单 error/phase。注意 C4 描述的「已同步持有该错误」在写入层面成立，但**持有之后没有任何读者**——见上面的 blocker。
- **C6 未发现 false-red。** `bun test tests/context/manager-dual-registry.unit.test.ts`（/tmp/t4rev）6 pass / 0 fail；探针 P2：两请求只对 a 走完 terminal，registry 剩余恰为 b（count=1）；P3：delivery 已 finalize、canonical 未完时快照为 `{count:1, canonical-finalization:1}`，正常在途态不误报；P1/P4 正常失败路径也未被误判为红。
  但 plan Task 4 Step 1 列的用例有三条未写：canonical-finalization blocker 断言、多请求只删对应 id、delivery failure→drain 抛原始 error（第三条正是 blocker 的暴露口）。前两条我用探针补测通过，属测试覆盖缺口而非行为缺陷。

## 范围问题：只改 shutdown.ts:439 的调用目标，字段名留给 Task 6

**处置恰当，是这几种切法里最好的一种。** 理由：plan Task 4 Step 4 明确禁止「保留旧方法」（会形成双真相），所以保留 `drainModelOperationFinalizations` 作为 deprecated 别名是被冻结决策排除的；只改调用目标是让 typecheck 独立通过的最小且唯一无双真相的切法。跨 Task 边界的一行改动配了接缝注释（shutdown.ts:432-437），并在 commit message 与进度文件里登记，符合项目「不留双轨包袱」。

**不会给 Task 6 留半成品。** Task 6 Step 5 的机械门是 `rg drainModelOperationFinalizations|formatActiveRequestsSummary|getActive: src tests`；实测残留恰好是 Task 6 拥有的 7 处（shutdown.ts:306/438/560/586/631/637/656 与 tests/shutdown/shutdown.unit.test.ts:76/256/280），门仍能咬住、且不会因 Task 4 提前动了调用点而误判归零。中间态代价只有一处名实不符（局部变量仍叫旧名、目标已是新名），有注释兜住。

两处 nit（不阻断）：commit message 写「its only production caller (src/lib/shutdown.ts:433)」，实际调用在 439，433 是注释首行；`Files` 清单未含 `src/lib/shutdown.ts`，Step 6 的 `git add` pathspec 也没有它，实际提交扩了范围——处置本身对，但 plan 的 Files/pathspec 应在 Task 6 之前同步一次。

## 结论

**存在 blocker：在「已登记的 delivery failure 进不了 drain / barrier 只写不读」修好之前，Task 4 不可通过、不应进入 Task 5。** 其余命题（C1/C2/C3/C4/C6）与范围处置均成立，无 false-red。

---

# 复评（commit a8eeaf4c，父 297f2663）

实测树：/tmp/t4rev2（`git archive a8eeaf4c`），探针 tests/context/zz-probe2.unit.test.ts。

- **R1 关闭（原 blocker）。** 上轮 P1 原样复跑：settle 后仅 `failModelOperationDelivery(err)`、canonical 成功、finalizer 从不 reject →
  `drainLifecycleFailures()` 抛 `AggregateError`、`errors.length===1`、`errors[0] === err` **按 identity 相等**（不是同 message 的替身）。registry count 0、barrier 0。
- **R2 关闭（原 major）。** 25 次「失败→释放」且全程不 drain 后 `_lifecycleFailureBarrierSize()===0`、tracked 0。
  evict 时机无丢失窗口：delivery 侧 `registerLifecycleFailure` 在 `deliveryState` 置 failed **之前**同步完成（request.ts:911-913），而 finalizer 要 `isDeliveryTerminal` 才启动；canonical 侧在 catch 内先登记再 throw（request.ts:929-931）。两者都严格早于 release，且 release 是唯一删除点，故「登记后才释放」恒成立。
  界限（非缺陷、但要写明）：有界性**只与 release 等价**。实测 R2b——失败先于 settle 登记而 ctx 从不 settle 时，blocker 停在 `request-running`，ctx 与 barrier 条目各留 1（reaper 不动 `operationScopes`）。这与「暴露而非丢弃」的设计一致，但 Task 5 接线 delivery owner 后若出现「失败已登记却永不 settle」的 producer，泄漏会同时体现在 registry 与 barrier 上——建议 Task 7 的僵尸矩阵显式覆盖这一形态。
- **R3 无双计；但反方向发现一条「一个都不推」的路径（minor）。** 正向：canonical 失败 → drain `errors.length===1` 且 identity 匹配 reject 值（reject 分支已删 push，manager.ts:489）；delivery+canonical 双失败 → `length===2` 且是两个**不同**的 error，非同一个重复；barrier 事后均为 0。
  反方向（我注入 `onLifecycleFailure` 恒 false 后实测）：未登记的 canonical 拒绝现在**一个都不推**——drain 静默返回（`len: undefined`），仅 `consola.error` + ctx 永久留在 registry；而父提交 3e418cdb 的 reject 分支还会 push 它。该路径生产不可达（C2），故判 minor，但它是本次修复引入的**行为回退**，且正是「evict 取代 push」这一改法的天然缺口。
  建议（不改可达行为、闭合缺口）：reject 分支在调用 release 后，若 `${id}:canonical` 在 barrier 中**不存在条目**（即登记失败），再 push 该 error——恰好只覆盖未登记态，不会与 evict 双计。
- **R4 可接受，无生产泄漏。** `_lifecycleFailureBarrierSize()` 仅在 manager.ts:120-128（接口）与 602（实现）出现，全仓无生产读者；与既有 `_runReaperOnce()` 同惯例、同下划线前缀与 TEST-ONLY 注释。
  唯一契约负担：它在**导出的 interface** 上，故任何被标注为 `RequestContextManager` 的测试替身都必须实现它。实测当前无替身受影响——`ShutdownDeps.contextManager` 的类型是结构化窄口 `{ stopReaper: () => void }`（shutdown.ts:304），全部 fixture 走这个窄口。判断：保持现状即可；若将来出现完整 manager 替身，再考虑把两个 `_` 方法收进一个 `RequestContextManagerTestHooks` 交叉类型。
- **R5 无 false-red。** 正常成功 + 多请求：只释放对应 id（剩余恰为 b）、barrier 0、`drainLifecycleFailures()` 抛 NOTHING；单纯 canonical failure 与 delivery-only failure 均按预期抛且只抛一次。
  仓库自带焦点集（plan Task 4 Step 5 的三个文件）在我的副本实跑 **30 pass / 0 fail / 74 expect**，与实施侧自报一致（该数字我独立复现，不是转述）。

## 复评结论

原 blocker（R1）与原 major（R2）**均已关闭**，机制单一且两条 finalizer 分支统一覆盖；新引入的双计风险经实测不存在。剩余一条 minor（未登记 canonical 拒绝不再进 drain 队列，生产不可达）+ 一条 Task 7 覆盖建议。

**Task 4 可通过，可进入 Task 5。**

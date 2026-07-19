# Kick-off Prompt——上游生成运行时重构执行

复制本文件全文作为实施会话首条消息。你是执行 orchestrator，在隔离 worktree 内按 TDD 计划逐 task 执行；主会话负责编排，复杂 task 派 fresh implementer，所有评审派独立 reviewer。

## 你要做什么

把当前“串行 S4 exchange + handler response pump + transport 隐藏重试”重构为统一上游生成运行时，并实现 fast-retry：primary 真正发出后 300s 尚无非 synthetic 的完整 client block时启动secondary；primary继续；首个完整block获胜，取消loser。

更重要的架构裁决是三个正交engine：

1. 上游连接保活只属于physical transport/session：TCP keepalive、H2 PING、WS control liveness。
2. 上游重试只属于generation/candidate/dispatch scheduler：reactive retry、429 replay、WS fallback、buffered recovery、hedging。
3. 下游保活只属于一个跨全部attempt存活的 `DownstreamDeliverySession`：只读已经实际发往客户端的block ledger；上游仍可重试时持续heartbeat；重试用尽、generation-global nonretryable、request cancel或client abort时正确平衡协议、停止timer、写至多一个terminal并close sink。

## 环境

- **worktree**：`/home/xp/src/copilot-api-js/.worktrees/upstream-exchange-manager`
- **branch**：`refactor/upstream-exchange-manager`
- **冻结 RFC**：`docs/rfc/2026-07-16-upstream-generation-runtime.md`
- **权威计划**：`docs/plan/2026-07-16-upstream-generation-runtime/plan.md`
- **主树并发工作**：`feat/history-v3` 仍在进行。禁止在旧History模型上抢先实现Phase 2+。

所有工作只在此 worktree 内进行。绝不改主树未提交文件，绝不 kill 4141 主服务器。

## 启动前 gate

1. 读 RFC 全文与 plan §0～§3。
2. 检查本分支状态与当前base：`git status --short --branch`、`git log --oneline -5`。
3. 确认是否已包含 History V3 canonical `ModelOperationRecord`、arena frame capture和terminal bus。
4. 若 History V3 **尚未合并**：只执行 Phase 0；Phase 1仅可执行完全inert、不触碰production producer的类型task；不得开始ResponseProcessor／client-sink／RequestContext改造。
5. 建 tracked 进度ledger `docs/plan/2026-07-16-upstream-generation-runtime/progress.md`，每task review清零后追加一行；提交时显式包含它，不创建仓库约定外的 `.superpowers/` 目录。
6. 建完整todo，以plan中的P0-T1到P10-T3为序；同一时间只标一个in-progress。

## 第一工作单元：Phase 0 Oracle

从 P0-T1 开始：

1. 为四client format的direct/translation流建立frame顺序golden，覆盖handler post-loop flush与terminal。
2. 建立下游heartbeat/anchor/terminal exact-wire golden，尤其锁定open block的index/type与terminal后零heartbeat。
3. 建立transport cancel/fallback/cleanup fault oracle，正样本证明测试能抓WS旧帧污染新queue、pending iterator泄漏、rate-limit queued loser。
4. 此阶段不得改生产代码；oracle在旧路径上绿色才可信。
5. 独立 reviewer确认测试触达live path且不是同源encode/decode假绿。

## 承重约束

每个implementer与reviewer prompt都必须带上：

- `Generation → Candidate → Dispatch` 是canonical runtime层级。Reactive/429/WS fallback是同candidate新dispatch；buffered recovery是新recovery candidate；hedge是并发candidate。
- 判胜前candidate无sink capability，禁止live retreat写半截帧。
- 所有client-shaped改写/drop在candidate `postRenderTransform`；之后才classification。`client.outbound`是observe-only wire hook。
- `DownstreamDeliverySession`是generation-owned，不读取upstream attempt/candidate/retrybudget，不因重试重建或清ledger。
- Heartbeat只根据post-reconcile、实际wire block ledger选帧；上游control ping不是semantic progress。
- Delivery `terminate()`走单写者queue/fence；真实与synthetic open structures由`terminateFromLedger()`处理；terminal后迟到tick/frame不能写。
- 单candidate nonretryable且仍有可行sibling/recovery时不结束delivery。
- `cancel()`是协作取消；`dispose()`是强制barrier。HTTP/2只dispose自有stream；WS loser连接标unusable并由pool owner关闭，绝不提前回池。
- History V3只在dispatch quiesce或force-dispose barrier后immutable seal；cleanup grace到期本身不seal。
- Server-executed tools默认不hedge；unknown typed tool保守禁用。
- Synthetic keepalive scaffold经用户批准，不算真实语义block，300s仍可启动fast-retry。

## TDD与提交纪律

每个task：

1. 记录BASE。
2. 手动提取完整task brief。
3. 先红测，保存明确红因；正样本／mutation证测试有牙。
4. 实现到绿，再重构。
5. 跑目标测试、typecheck、diff-check；byte-critical跑golden；时序连续跑。
6. 显式pathspec conventional commit，不带模型署名。
7. 生成review package，派独立reviewer做spec compliance + code quality双判定。
8. Critical/Important清零后更新ledger并连续下一task。

不要在task间询问是否继续。只有真实产品分叉、破坏性操作、无法解决的blocker，或全计划完成时才停。

## History V3 barrier后的接续

当History V3已合并：

1. merge/rebase master到本分支；处理冲突时以V3 canonical recorder/arena/terminal bus为事实源。
2. 重新跑Phase 0全部oracle和V3测试。
3. 独立审计 `driver.ts` 与 `client-sink.ts` 的V3 capture位置，再开始P2；提取processor／delivery时capture随真实producer boundary迁移，wrapper不双采样。
4. 不在投影后的 `HistoryEntry` 造平行generation SSOT；直接扩`ModelOperationRecord`为branded candidate/dispatch handles。

## 最终验收

完成全部task后：

- verifier从冻结RFC独立推导黑盒oracle；
- whole-branch reviewer 0 blocker/major；
- mock client-proxy E2E验证真实SDK反应；
- 非4141隔离server做少量真实GHC靶向验证；
- 同步DESIGN、streaming、lifecycle、config、README与memory；
- 默认开启hedge前确认真实cancel与成本可观测性；
- 走session-closeout后再合并。

现在先读RFC与plan，建立todo和ledger，然后执行P0-T1。

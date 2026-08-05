# Kick-off：Commit -1 —— Entry test-discovery oracle 基础设施

<!-- prompt-task-ids: T0.0a T0.0b T0.0c T0.0e -->

## 背景 + 为什么

这是 cutover 前的**独立前置基础设施 commit**，不是 Commit 0～8 的任一个，也不得把它夹进 cutover 语义链。现有 `scripts/parallel-test.ts` 的 JUnit 仅在 `refreshTimings()` 的独立 `--update` run 中产生，真实 shard 运行没有 file identity；因此「一次 refresh JUnit」不能证明 `balance()`/spawn 后的 15 次实际门没有静默漏文件。

本 phase 必须先交付并版本化两件基础设施：真实 shard file identity oracle，以及 entry-evidence validator。之后该 commit **先合 master**；合入后的 master SHA 才是 entry A。此前任何 15-run 批次作废。

## 必读

1. `docs/rfc/2026-08-03-generation-emission-command-algebra/design.md`：RFC §7.1 entry 前稳定基线、§10.1 双向判别。
2. `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md`：§0.2、§0.3、§0.4b、§0.4e、§0.4f、Commit -1（T0.0a/b/c/e）及其门表。
3. `docs/rfc/2026-08-03-generation-emission-command-algebra/traceability.md`：§6 的 T0.0a/b/c/e 反向出处。
4. `docs/tmp/2026-08-05-command-algebra-progress-prompts.md`：第三层文档进度；执行时新建本 phase 独有 progress 文件。
5. `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`：DAG、集中红线、prompt population checker 契约。

## 前置与停止条件

- 在**第二隔离 worktree**实现并验证，不在将成为 entry 的 `$TREE` 上做 mutation。
- 本 phase 收口后必须先合 master；合入后的 master SHA=A，才能进入 `post-merge-preflight.md`。
- 不跑真实 A/P/15 logs 的消费门：那是 post-merge preflight 的 T0.0d。此处只用合成 fixtures。
- 不新增 command algebra 签名。遇到 plan 未冻结的接口/契约，记录具体 seam 后停止并交回。

## 改动锚点

| 对象 | master `file:line` | 用途 |
|---|---|---|
| `refreshTimings()` 的 JUnit | `scripts/parallel-test.ts:61-70` | 现状：只在独立 refresh run 产生 JUnit，不能作为门运行 evidence |
| 真实 shard spawn | `scripts/parallel-test.ts:120` | file identity 必须来自这条实际运行链 |
| shard pass/fail 汇总 | `scripts/parallel-test.ts:157-167` | 现状不含 skipped/file identity；须扩充为明确 artifact |
| `baseline-runs.sh` structured fields | `exp/inter-block-anchor-allocator/baseline-runs.sh:134-148` | 真实 evidence 的格式消费契约，validator 合成 fixture 应镜像它 |
| `byte-equivalence.sh` structured fields | `exp/inter-block-anchor-allocator/byte-equivalence.sh:148-150` | 同上；本 phase 不需要真 O-6 请求 |

完整锚点与 mutation protocol 的唯一事实源是 `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md` Commit -1、§0.4e。

## 本 phase task 集合（唯一归属）

<!-- prompt-task-ids: T0.0a T0.0b T0.0c T0.0e -->

| Task | TDD 施工顺序（不重写 RFC 判据） |
|---|---|
| `T0.0a` | 先写 post-`balance()`/pre-spawn 静默删文件的失败正控，预期 rc 非零且点名缺失文件；再让每个真实 shard 产出 JUnit file identity，逐次与独立磁盘 manifest 双向集合对账，正确真实 run 转绿。 |
| `T0.0b` | 先写 runnable→skip 的失败 mutation，预期点名 `file+classname+name+ordinal`；再输出 executed/skipped 与 skipped multiset，覆盖整文件 skip、native skip、todo 的合法形态。 |
| `T0.0c` | 先让 reporter 只留在 `refreshTimings()`、或让合并器漏一个 shard，预期 file identity 门因目标机制红；再接通实际 shard JUnit 收集，正确 full run 转绿。**同时按 plan §0.4f 冻结接口实现/版本化 `scripts/capture-entry-evidence.ts` 与 `tests/infra/entry-test-discovery-baseline.json` v1**；合成 fixture 验树外 OUT、独立 `minimum_executed`、15-run/JUnit 对账、失败无 manifest、成功原子写入。不得另选 producer CLI/schema。 |
| `T0.0e` | **实现 plan §0.4f 已冻结的唯一接口**：`scripts/validate-entry-evidence.ts`、完整 CLI flags、pointer block v1、evidence-manifest v1 与稳定 exit/`FAIL C<n>:` contract；不得另选 env/flags/schema。先以合成 git 图、A/P、唯一 pointer block、树外 manifest、15 logs/JUnit 跑完整正样本；按 `EV-01`…`EV-25` 每次只篡改一个合成输入，预期唯一稳定 fail code/message。不得引用未来真实 A/P。 |

所有 mutation 按 plan §0.4e：基线含真实实现、第二隔离树/`/tmp` 或 exact patch、先证 hunk 真变、读目标 FAIL、reverse check/恢复后 diff。只看 rc 不算。

## 验收 gate

1. Commit -1 门表全部通过：T0.0a/b/c 的 runner 正控各因目标机制红；T0.0e 合成正样本绿且 `EV-01`…`EV-25` 一动作一唯一 FAIL。
2. `bun run typecheck` 绿，基础设施自身测试绿。
3. Commit -1 不得用未来 T0.0f 的 15 次自洽运行替代自身验证。
4. 按 `docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md` §0.4a/§0.4b 重跑适用共同门；不要声称真实 O-6 PASS，除非真实请求实际通过。
5. 独立 review 后，**先合 master**。合入后重取 A；此前 15-run evidence 全部作废。

## 提交指引

- 使用独立 worktree 分支；显式 pathspec：`git add -- <精确路径>`、`git commit -F <msgfile> -- <精确路径>`。
- Conventional Commit；建议 message 点名 `Commit -1`；不加模型署名；绝不 push。
- 进度文件一 agent 一份、随每个语义 commit 提交；记录尚未提交的 mutation 意图/失败输出来源/作废路径。
- 合 master 是已裁 Git 图的一部分，合入前确认 Commit -1 门表/独立 review 记录完整。

## 红线

集中红线见 `docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/README.md`。特别注意：不要在本 phase 消费真实 A/P/15 artifacts；不要从不含真实实现的基线恢复 mutation；不要整文件覆盖共享树；不要碰 4141。

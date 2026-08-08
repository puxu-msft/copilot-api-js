# History Worker Batch 1b 终态报告

> 状态：**已集成主线**（`master@d1011fe7`，2026-08-08 由用户在共享 checkout 执行 `git merge --ff-only` 落地）；本报告与临时证据清单的最后一笔闭环提交待终审后补入。
> 核验基线：`master@d1011fe7eb1f26c0c646b667164ddb0e4dd80bf0`；日期 2026-08-08。
> 分支／worktree：`worktree-history-worker-batch-1b-resume`，`/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume`。

## 交付内容

- Batch 1b 已在 `d3b4ac77` 落地主线：所有生产模型 operation 在 parse／dispatch 前经有界 History admission；terminal publication由单一owner发布；pending／acknowledged-recent／DB overlay覆盖list／stats／sessions／status；shutdown在首次operation registry快照前stop admission并drain pre-context handoff。
- 最新主线的History V3四字段持久化重试契约已同步到Worker wire：`src/lib/history/persist-retry-config.ts`是`maxAttempts/backoffMs/maxBackoffMs/maxTotalMs`唯一类型owner，V3 store与Worker protocol复用它；initialize protocol拒绝缺失或负值cap。
- Task 2a正式计划与kickoff已同步：真实semantic backend必须用非默认`maxBackoffMs`和injectable delay证明每次等待上限被消费，删除字段传递的mutation必须变红；当前没有把尚不存在的backend消费测试冒充已实现。
- 活文档：`docs/DESIGN.md`的History架构行；执行权威：`docs/plan/2026-08-07-history-persistence-worker.md`；下一批入口：`docs/plan/2026-08-07-history-persistence-worker-kickoff.md`；评审处置：`docs/tmp/2026-08-08-history-worker-batch-1b-review-dispositions.md`；完成历史：`docs/tmp/2026-08-08-history-worker-progress-impl-1b.md`。

## 验收证据

- Batch 1b最终实现候选`94205e89`：精确计划门44 pass／0 fail；完整backend为16 shards、7255 executed、30 skipped、0 fail、52.45s；build成功。证据摘要及口径在评审处置文档。
- 合入`master@d59a622c`后的范围化复验：typecheck通过；Batch 1b计划门44 pass／0 fail；History retry相关目标集415 pass／0 fail。
- M2四字段契约TDD：旧protocol缺失`maxBackoffMs`时15 pass／1 fail；补第一项后缺失`maxTotalMs`仍15 pass／1 fail；共享类型owner与完整validator落地后联合回归68 pass／0 fail，typecheck与精确lint通过。
- 原合并态reviewer在`22c8e08b`独立复跑79 pass／0 fail，核验共享类型owner、protocol双向判别、fixtures及Task 2a执行期正控，结论为0 blocker／major；`64e40640` review-gate闭环终审同为0 blocker／major。
- 接手方第一人称视角reviewer对`560b427a`复审：0 blocker／major，逐条核验H1（禁止在本分支继续Task 2a，与kickoff `:20-22`一致）、H2（第4步命令块可执行、11个selector在该commit均存在、步骤5／6闭环）、H3（清单冻结边界与56项一致）、H4（状态行未把未完成写成已完成）。两条minor已在本轮采纳：临时清单字节漂移改为路径集合门＋来源说明，第4步WIP检查补false-red防线。
- `master@82c0664e`只新增三份协议中立推理文档，与本轮代码／plan／kickoff／测试零路径交集；候选无冲突合入为`926b2478`，按moving-HEAD规则未重复全量验证。
- `master@bea1dfa3`（nghttp2 header-deadline线13笔）确实触及Batch 1b相关路径——`tests/history/worker/admission-shutdown.unit.test.ts`、`tests/history/worker/overlay-read-surfaces.it.test.ts`、`tests/infra/entry-test-discovery-baseline.json`及五个History源文件，故按升级信号做了范围化复验，未按moving-HEAD规则免验。该合并未触及`src/lib/history/worker/protocol.ts`与`src/lib/history/v3/store.ts`，四字段重试契约不受影响。合入为`8f9a7214`（ort，145文件／+2377／−839）后：typecheck通过；Worker目标集9文件68 pass／0 fail；retry契约目标集3文件23 pass／0 fail。`git diff --check`报的两处EOF空行经`git diff --check master`确认源自master自身，非本轮引入。
- `master@d47492a6`只在`docs/spec/2026-08-06-http2-cancel-provenance-and-header-deadline.md`一份文件上追加落地记录，与本轮零路径交集，合入为`0ecbca65`，按moving-HEAD规则未复验。

## Git、发布与工作树状态

- **fast-forward 已由用户执行并落地**：`master` 现为 `d1011fe7eb1f26c0c646b667164ddb0e4dd80bf0`，与候选分支 HEAD `d1011fe7` **完全相同**（无额外提交、无 merge commit）；`git merge-base --is-ancestor d1011fe7 master` 成立，`22c8e08b` 亦在 `master` 祖先中。
- 本报告与临时清单的最后一笔闭环提交将在 `d1011fe7` 之上另增一笔，需再次 fast-forward。
- **安装位置复验（从共享 checkout `/home/xp/src/copilot-api-js` 实跑，`pwd -P` 已确认）**：
  - reviewed-plan blob 门：`22c8e08b` 与 `master` 两侧 `docs/plan/2026-08-07-history-persistence-worker.md` 的 blob 同为 `fe26b74feae99b7e72ef67f3cfadbe993a89122c`，PASS。
  - `bun run typecheck`：通过。
  - 11 文件目标集：**89 pass／0 fail**、287 expect、3.57s。
  - 候选 13 条净路径：共享检出工作区文件与 `master` 同路径内容逐条 md5 相等 → 无未提交残留。
  - 三处无关 WIP（`config.yaml`、`start.bat`、`docs/plan/2026-07-28-session-closeout-skill-review-claude.md`）与 `master` 版本均不相同 → WIP 完整保留，fast-forward 未触及。
- 本会话的 worktree 隔离护栏拒绝对共享检出执行 git 写操作与 `git status`，故 fast-forward 由用户执行；工作区洁净度改用「工作区文件内容 vs `master` blob 内容」逐条 md5 比对取证。**该替代方法的诚实边界**：它覆盖内容差异与文件缺失，但**不覆盖** file mode 变化、regular file↔symlink 类型变化、以及「已 staged 但工作区内容又被改回」这类只在 index 层可见的状态；也**不枚举**候选路径以外的未追踪文件。因此它回答的是「这13条路径的内容是否与 `master` 一致」，不是 `git status` 的全部语义。上表最后一条复验命令保留了真正的 `git status`，供在共享检出直接复跑。
- 未推送、未创建PR、未发布任何ref或artifact。
- 本会话不删除worktree或分支；`worktree-history-worker-batch-1b-resume`及其worktree仅保留作短期取证与本收尾的恢复源。**Task 2a 不得在该分支或该worktree继续**：按`docs/plan/2026-08-07-history-persistence-worker-kickoff.md`必须从最终`master`新建独立branch／worktree，并新建`docs/tmp/2026-08-08-history-worker-progress-impl-2a.md`；Batch 1b progress已停止更新，不得复用其写入权或旧基线。取证需求结束且收尾提交确认在`master`祖先后，可由用户决定清理本分支／worktree。
- 碰撞集在 fast-forward 前于 `0ecbca65` 基线重算为 0：候选净路径13条，其中10条在共享检出中存在且与 `master` 内容 md5 相等，另3条（`src/lib/history/persist-retry-config.ts`、本报告、临时清单）在共享检出中不存在且无未追踪文件占位；三处无关 WIP 均不在这13条内。fast-forward 后的实测结果与该预测一致。

## 临时证据

- 清单：`docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md`。
- `$CLAUDE_JOB_DIR/tmp`在最终closeout review前重新冻结为56项路径；逐项记录绝对路径、类型、用途、持久接收者、最终动作和清理前置。初版54项清单在生成后又新增提交消息与共享index快照，事实视角reviewer据此判major；本版已纳入两项并禁止再创建新路径。
- 本会话未手工删除任何临时文件。56项全部保留至Claude job目录自动清理；前置是本报告、清单及其接收者已提交且最终主线ancestry验证通过。**冻结门是路径集合而非字节总数**：新增未分类路径才破坏「清理前每条路径都有disposition」这一不变量，已列入清单的路径被重写不产生未分类产物。初次冻结 6,568,459 bytes → 终审前重枚举 6,568,699 bytes，240 bytes 差异全部来自 `shared-main-index.terminal-review.snapshot` 按最新共享 index 重新快照；**fast-forward 落地后再次重枚举仍为 56 项、6,568,699 bytes，无漂移**。该口径是对初版「人口或大小任一变化即重新生成」的放宽，**须由终审reviewer裁决**，未获裁决前不得据此放行清理。

## 结构怪味与处置

- `src/lib/history/v3/store.ts`与`src/lib/history/worker/protocol.ts`曾平行维护同一重试类型，后者弱一档且漏`maxBackoffMs`；已在`src/lib/history/persist-retry-config.ts`修成唯一类型owner，store只保留兼容别名，protocol只import／re-export。
- kickoff的reviewed-plan blob门与“每批回填plan状态”形成两阶段时序：回填后旧门应红，复审后由单独提交更新anchor。已按`22c8e08b`→`64e40640`闭环，不移除或放宽门。
- Batch 1b progress的15个first-parent提交中有5个后半程提交未同步更新progress；自验日志已诚实记录V12证伪。完成文档虽最终补齐，但不把结果补齐冒充过程合规。

## 可复用资产

- **已实现，项目代码／测试：** `HistoryPersistRetryConfig`共享类型owner；触发是主线程store与Worker wire共用配置字段，关闭“平行类型一侧漏字段”的缺口。现有architecture／protocol测试体系足以承载，无需新增agent soul。
- **已实现，执行oracle：** initialize四字段合法逐值保留＋缺失／负值拒绝；Task 2a保留真实backend消费mutation。无需另建skill，因为这是History领域契约，应留在plan与测试。
- **不新增rule／skill：** master移动后的范围化复验、共享worktree碰撞集、instruction文本复审均已有always-on规则和现成skills覆盖；新增同义资产会制造双源。

## 尚待动作

1. ~~重新冻结共享index并确认碰撞集为0~~ **已完成**（`0ecbca65` 基线，13条净路径、碰撞0）。
2. ~~在共享checkout执行 `git merge --ff-only`~~ **已由用户完成**，`master@d1011fe7`。
3. ~~从共享checkout复验安装位置~~ **已完成**，逐条结果见「Git、发布与工作树状态」：blob 门 PASS、typecheck 通过、目标集 89 pass／0 fail、13条净路径无残留、三处无关 WIP 保留。
4. ~~重新冻结临时证据清单人口~~ **已完成**：fast-forward 后重枚举仍为 56 项路径、6,568,699 bytes，与冻结值一致，无漂移。
5. **本报告与临时清单交独立reviewer终审到0 blocker／major**（进行中；须裁决临时清单冻结判据由「人口或字节任一变化」放宽为「路径集合是门」是否成立）。
6. 终审通过后，用精确pathspec提交更新后的报告与清单，并确认该提交已在`master`祖先中；此前不得允许临时证据被清理，也不得宣告会话完成。

复验命令（可复跑，均从共享 checkout 执行）：

```bash
cd /home/xp/src/copilot-api-js && git rev-parse master
cd /home/xp/src/copilot-api-js && git merge-base --is-ancestor 22c8e08b master
cd /home/xp/src/copilot-api-js && git rev-parse master:docs/plan/2026-08-07-history-persistence-worker.md 22c8e08b:docs/plan/2026-08-07-history-persistence-worker.md
cd /home/xp/src/copilot-api-js && bun run typecheck
cd /home/xp/src/copilot-api-js && bun test tests/history/worker/protocol.unit.test.ts tests/history/worker/runtime.it.test.ts tests/history/worker/source-registry.it.test.ts tests/history/worker/admission-wiring.http.test.ts tests/history/worker/admission-ws.it.test.ts tests/history/worker/admission-shutdown.unit.test.ts tests/history/worker/pending-overlay.it.test.ts tests/architecture/history-worker-boundaries.unit.test.ts tests/config/history-persist-retry-config.unit.test.ts tests/history/v3/transient-retry.unit.test.ts tests/history/v3/transient-retry.it.test.ts
cd /home/xp/src/copilot-api-js && git --no-optional-locks status --short
```

最后一条 `status` 的判读：不得出现本轮13条净路径的未提交残留；三处无关 WIP（`config.yaml`、`start.bat`、`docs/plan/2026-07-28-session-closeout-skill-review-claude.md`）**预期仍在，但“不在”本身不是失败**——peer 合法提交或自行处理其中任一份都会让它消失。差异必须先查因（`git log` 该路径），**在任何情况下都不得据此恢复、回写或撤销他人的改动**；只有确认是本轮操作造成的丢失才算 blocker。

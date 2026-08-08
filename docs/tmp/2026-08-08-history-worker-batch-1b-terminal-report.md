# History Worker Batch 1b 终态报告

> 状态：**已集成主线**（Batch 1b 实现于 `master@d3b4ac77`，收尾证据首次 fast-forward 至 `master@d1011fe7`）。终审两轮闭环：首轮 0 blocker／2 major，整改后复审 **0 blocker／0 major、可定稿**。此后共享 `master` 前进至 `475bed45`，已合入并范围化复验通过；本报告与教训沉淀的剩余提交待再次 fast-forward。
> 核验基线：候选 `bc8af51f`（含 `master@475bed45`）；日期 2026-08-08。
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
- `master@475bed45`（28笔，含 History search tail-cursor 修复、entries 查询参数校验、state/success 过滤交集、以及另一会话的收尾文档）**触及 History 源码与测试**（`queries.ts`／`stats.ts`／`v3/projection.ts`／`v3/summary-store.ts`／`routes/history/handler.ts`／`history-api.it.test.ts` 等），故按升级信号做范围化复验、未按moving-HEAD规则免验。合入为`bc8af51f`后：typecheck通过；Worker＋retry 目标集12文件**91 pass／0 fail**、296 expect。
  合并冲突仅 `.claude/skills/session-closeout/verification-log.md` 一处，成因是两个会话在同一位置各自追加了一节收尾自验记录；按行级共存**两节全保留**（本轮「Batch 1b 收尾证据终审」＋对方「HTTP/2 header deadline 阶段 1 收尾」），未做整文件退让。`docs/memory/MEMORY.md` 自动合并，四条钩子共存。
  **一处取证陷阱记录在案**：首次复验以 exit 1 结束，实为 bun 写覆盖率报告的 `WriteFailed` 内部错误，且命令里的 `| tail -8` 截掉了计数行；重跑完整命令为 exit 0、91 pass／0 fail。**按退出码就会把它误判成回归**。

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
- 未推送、未创建PR、未发布任何ref或artifact。**该结论的取证范围限于本仓库与 GitHub 可观测表面**（终审 reviewer 独立复核：`git branch -r --contains HEAD`、`git tag --points-at HEAD`、联网 `git ls-remote --heads --tags origin` 对 `922b741b` 与分支名筛选均零命中；`gh pr list --state all --head worktree-history-worker-batch-1b-resume` 返回 `[]`）。Git 无法穷尽所有外部系统，故不宣称超出该范围的绝对否定。
- 本会话不删除worktree或分支；`worktree-history-worker-batch-1b-resume`及其worktree仅保留作短期取证与本收尾的恢复源。**Task 2a 不得在该分支或该worktree继续**：按`docs/plan/2026-08-07-history-persistence-worker-kickoff.md`必须从最终`master`新建独立branch／worktree，并新建`docs/tmp/2026-08-08-history-worker-progress-impl-2a.md`；Batch 1b progress已停止更新，不得复用其写入权或旧基线。取证需求结束且收尾提交确认在`master`祖先后，可由用户决定清理本分支／worktree。
- 碰撞集在 fast-forward 前于 `0ecbca65` 基线重算为 0：候选净路径13条，其中10条在共享检出中存在且与 `master` 内容 md5 相等，另3条（`src/lib/history/persist-retry-config.ts`、本报告、临时清单）在共享检出中不存在且无未追踪文件占位；三处无关 WIP 均不在这13条内。fast-forward 后的实测结果与该预测一致。

## 临时证据

- 清单：`docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md`。终审报告：`docs/tmp/2026-08-08-history-worker-batch-1b-closeout-review-final.md`。
- `$CLAUDE_JOB_DIR/tmp`在最终closeout review前重新冻结为56项路径；逐项记录绝对路径、类型、用途、持久接收者、最终动作和清理前置。初版54项清单在生成后又新增提交消息与共享index快照，事实视角reviewer据此判major；本版已纳入两项并禁止再创建新路径。
- **临时证据的安全性不依赖清理时机，而依赖「长期价值已先行落进已提交的持久接收者」。** 56项每一项的接收者见清单逐行：测试／构建／mutation 原始输出 → 已提交的 `docs/tmp/2026-08-08-history-worker-progress-impl-1b.md` 与 `docs/tmp/2026-08-08-history-worker-batch-1b-review-dispositions.md` 证据摘要；提交消息输入 → 对应的本地 Git commit；三方对账副本 → 已提交的 `tests/infra/entry-test-discovery-baseline.json` 与 B3/B4 处置记录；本轮评审结论 → 本报告与终审报告本身。**因此 Claude job 目录的自动清理在任何时刻发生都不会删除唯一副本。**
- **诚实边界（终审 reviewer 判 major 并修正）**：harness 的 job 自动清理是**本会话不可控的生命周期事件**，它不读取 Git ancestry，因此**任何「清理必须晚于某个 Git 门」的说法都没有执行接缝、不成立**。此前本报告把「确认收尾提交在 `master` 祖先」写成清理前置，是把不可控事件写成受控门——已改正。`master` ancestry 的正确职责只有一个：作为「可宣告集成完成、可清理本 branch／worktree」的门。若将来确需强制 temp cleanup 晚于某事件，需要一个可显式 hold job 生命周期并经过验证的外部机制，本轮产物没有这种机制。
- 本会话未手工删除任何临时文件（避免通配符误删与跨会话误伤），56项全部保留。冻结门与逐路径复核条件见清单头部，已按终审 D1 裁决补齐附加条件。初次冻结 6,568,459 bytes → 终审前重枚举 6,568,699 bytes → fast-forward 落地后重枚举仍为 56 项、6,568,699 bytes；240 bytes 差异全部来自 `shared-main-index.terminal-review.snapshot` 按最新共享 index 重新快照，已逐路径复核其类型、用途、receiver 与最终动作均未变。
- **归档价值逐类审计（2026-08-08 收尾时应用户要求执行，结论：无一项需归档）**。不依据清单自述，逐类实际打开核验：entry baseline 三方副本 3 项（接收者=已提交 baseline＋B3/B4 处置）；测试／构建／lint／mutation 日志 10 项（摘要在已提交 progress 与 dispositions）；提交消息输入 20 项（消息已在 `master` 提交内）；路径／提交清单 4 项（可由 git 再生）；mutation patches 2 项（dispositions 已记变异内容与变红观测）；WIP／恢复 patches 4 项（**实测已全部落进 `master`**，一份为空）；perf 转录大纲 1 项（源 jsonl 31MB 完好在盘，可再生）；ws 探针日志 4 项（结果由 `17c05e59`／`db16510e` 承接）；共享 index 快照 7 项（已被 `master` 取代）。
  - `check-junit-executed.py` **判为冗余不归档**：仓库已有 `scripts/parallel-test-artifacts.ts`，是更完整的 TS 实现（含 skipped identity 追踪），一次性 python 脚本无独立价值。
  - **一处险些漏掉的检查**：`old-without-activity.patch` 含 `history_admission_wait_ms` 直方图与 `historyAdmissionWaitMs` 字段，不属 Batch 1b 主体。逐个 grep `master` 确认直方图、字段、`src/lib/context/activity-summary.ts` 与 `src/lib/context/request.ts` 接线全部在位，无遗漏。
  - **一处险些写下的伪证据**：文件名 `ws-shutdown-x10.log` 诱导推断「连跑 10 次确认非 flaky」，实测 `rg -c 'Ran [0-9]+ tests'` 只有 **1** 处——它是「一个文件 10 个用例」的**单次**运行，不存在确定性连跑证据。**按文件名下结论会在文档里留下一条永远复现不出的断言。**

## 结构怪味与处置

- `src/lib/history/v3/store.ts`与`src/lib/history/worker/protocol.ts`曾平行维护同一重试类型，后者弱一档且漏`maxBackoffMs`；已在`src/lib/history/persist-retry-config.ts`修成唯一类型owner，store只保留兼容别名，protocol只import／re-export。
- kickoff的reviewed-plan blob门与“每批回填plan状态”形成两阶段时序：回填后旧门应红，复审后由单独提交更新anchor。已按`22c8e08b`→`64e40640`闭环，不移除或放宽门。
- Batch 1b progress的15个first-parent提交中有5个后半程提交未同步更新progress；自验日志已诚实记录V12证伪。完成文档虽最终补齐，但不把结果补齐冒充过程合规。

## 可复用资产

- **已实现，项目代码／测试：** `HistoryPersistRetryConfig`共享类型owner；触发是主线程store与Worker wire共用配置字段，关闭“平行类型一侧漏字段”的缺口。现有architecture／protocol测试体系足以承载，无需新增agent soul。
- **已实现，执行oracle：** initialize四字段合法逐值保留＋缺失／负值拒绝；Task 2a保留真实backend消费mutation。无需另建skill，因为这是History领域契约，应留在plan与测试。
- **不新增rule／skill：** master移动后的范围化复验、共享worktree碰撞集、instruction文本复审均已有always-on规则和现成skills覆盖；新增同义资产会制造双源。
- **已实现，`session-closeout` skill 条款（归属见下）：** 本轮为该 skill 新增了返工轴候选发现（§4 六类候选来源 + provisional + 可达评审门）、`fd` 枚举陷阱（`fd -H` 遵守 `.gitignore`，实测同目录 `find`=56 / `fd -H`=42 / `fd -H -I`=56）、删除门的两条机械化判据（manifest fingerprint 驱动回流；reviewer 的显式 positive receipt 才放行删除）。经独立 reviewer 八轮评审（2 blocker + 十余 major，无一轮重复同错）。
- ⚠️ **该 skill 的归属正在迁移，本轮条款须由后合并方接管。** 用户 2026-08-08 裁决把项目 skill `session-closeout` 并入 user-level `closing-a-development-session`、不保留两个收尾入口；执行件为 `2a4898e8`（其「零未映射」门当时未通过）。该目标是**生成产物**，只能改 `source.json` 再渲染。**用户同日裁决「谁后合并谁负责」**：本会话先合，故上述新增条款作为源文件的一部分，由 batch-6 会话在做映射时一并处置——**若映射表未收录它们，这批条款会随源文件一起消失**（正是本轮反复防的「产物没有接收者」形态）。
- **已实现，新记忆条目：** `docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md` —— 从本轮 D2（把不可控的 harness 清理写成受控 Git 门）提炼。触发是「写下任何 X 必须晚于 Y 的顺序前置」，动作内核是先分型（状态门／因果·capability 门）再按该型判，两型共用隔离目标门的双控。**该条目经独立 reviewer 连打五轮**（前四轮各判 1–2 major、方向互不相同：收在直接执行者上→误杀因果门；放松成「有谁读过 Y」→放行旁路日志与 fail-open；四条全局合取→又误杀 capability 门；双控未隔离目标门→兄弟门代咬；「权威」按物理载体定义→误杀线性一致副本），第五轮 0 blocker／0 major 定稿。正文保留完整翻车史与两条可迁移判据。相关评审记录：`docs/tmp/2026-08-08-ordering-gate-lesson-review.md`。
- **未升为 skill 正文条目：** 上述形态在 `session-closeout/verification-log.md` 2026-08-08 节标为「新增负样本、建议入表」，**未自行改写 SKILL.md 正文**——按 `instruction-text-must-be-reviewed`，是否升为正式自验条目须另经评审裁决。

## 尚待动作

1. ~~重新冻结共享index并确认碰撞集为0~~ **已完成**（`0ecbca65` 基线，13条净路径、碰撞0）。
2. ~~在共享checkout执行 `git merge --ff-only`~~ **已由用户完成**，`master@d1011fe7`。
3. ~~从共享checkout复验安装位置~~ **已完成**，逐条结果见「Git、发布与工作树状态」：blob 门 PASS、typecheck 通过、目标集 89 pass／0 fail、13条净路径无残留、三处无关 WIP 保留。
4. ~~重新冻结临时证据清单人口~~ **已完成**：fast-forward 后重枚举仍为 56 项路径、6,568,699 bytes，与冻结值一致，无漂移。
5. ~~本报告与临时清单交独立reviewer终审~~ **已完成，两轮闭环**：未卷入的跨模型 reviewer 首轮在候选 `922b741b` 上判 **0 blocker／2 major**；两条均全额采纳整改后（`43ffac97`），同一 reviewer 复审判 **0 blocker／0 major、可定稿**，并独立复核了整改本身没有引入新缺陷（清单整改前后均 56 行、路径集合一致、每行 7 列、无静默删除；20 份提交消息 receiver 均精确命中 `master@d1011fe7` 祖先提交）。报告落盘于 `docs/tmp/2026-08-08-history-worker-batch-1b-closeout-review-final.md`（首轮 + 复审轮两节）。
6. 提交整改后的报告、清单与终审报告，并 fast-forward 进 `master`。**这是「可宣告集成完成、可清理本 branch／worktree」的门，不是临时证据清理的门**——后者不可控且已被设计成何时发生都无害。

## 终审处置

- **[major] D1 冻结门放宽（裁决：成立但需附加条件）** —— **已采纳**。原文只要求「说明字节来源」，守不住真正的不变量。reviewer 构造的 false-green 反例成立：`history-worker-batch-1b-wip.patch` 路径不变却被覆写为含未提交新修复时，旧措辞会放行，而 job cleanup 会删掉唯一 WIP 副本。已在清单头部改为两层判据：路径人口／路径名变化 → 整表重生成；路径集合不变而内容变化 → **逐条变化路径做语义复核**（type／用途／长期价值／receiver／最终动作），patch、原始证据、恢复副本、报告草稿不得凭同路径放行。同时保留 reviewer 认定的 false-red 事实：本轮 240 bytes 同路径重拍语义未变，旧门要求整表重审确属过严。
- **[major] D2 清理前置链存在断口（裁决：成立）** —— **已采纳**。Git 顺序门约束不了 harness 的 job 自动清理：终审通过后、收尾提交进入 `master` 祖先前，session 正常结束／崩溃／平台回收都会触发清理，而「不得允许」没有执行接缝。已把可控门与不可控事件分开：所有长期价值在冻结时即已进入**已提交**的持久接收者，故清理何时发生都不删唯一副本；`master` ancestry 只保留为集成完成门。**不再声称 Git 门能禁止 harness 清理。**

## 复验命令

均从共享 checkout 执行，可复跑：

```bash
cd /home/xp/src/copilot-api-js && git rev-parse master
cd /home/xp/src/copilot-api-js && git merge-base --is-ancestor 22c8e08b master
cd /home/xp/src/copilot-api-js && git rev-parse master:docs/plan/2026-08-07-history-persistence-worker.md 22c8e08b:docs/plan/2026-08-07-history-persistence-worker.md
cd /home/xp/src/copilot-api-js && bun run typecheck
cd /home/xp/src/copilot-api-js && bun test tests/history/worker/protocol.unit.test.ts tests/history/worker/runtime.it.test.ts tests/history/worker/source-registry.it.test.ts tests/history/worker/admission-wiring.http.test.ts tests/history/worker/admission-ws.it.test.ts tests/history/worker/admission-shutdown.unit.test.ts tests/history/worker/pending-overlay.it.test.ts tests/architecture/history-worker-boundaries.unit.test.ts tests/config/history-persist-retry-config.unit.test.ts tests/history/v3/transient-retry.unit.test.ts tests/history/v3/transient-retry.it.test.ts
cd /home/xp/src/copilot-api-js && git --no-optional-locks status --short
```

最后一条 `status` 的判读：不得出现本轮13条净路径的未提交残留；三处无关 WIP（`config.yaml`、`start.bat`、`docs/plan/2026-07-28-session-closeout-skill-review-claude.md`）**预期仍在，但“不在”本身不是失败**——peer 合法提交或自行处理其中任一份都会让它消失。差异必须先查因（`git log` 该路径），**在任何情况下都不得据此恢复、回写或撤销他人的改动**；只有确认是本轮操作造成的丢失才算 blocker。

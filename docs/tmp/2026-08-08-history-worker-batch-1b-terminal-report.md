# History Worker Batch 1b 终态报告

> 状态：**交付内容已集成主线；收尾流程尚未闭环**（草稿·待复审）。
> - 交付内容：Batch 1b 实现于 `master@d3b4ac77`，收尾证据经五次 fast-forward 落地，合并点 `4c30e6eb` 在 `master@58f4c45d` 祖先中。
> - 收尾流程：契约 17 stage 中有**两个根阻断点**——`freeze_truth`（共享主树未查）与 `review_temp_manifest`（清单修订后未重审）；按 `requires` 传播，**stage 2–17 全部受阻**，`review_closeout_final`／`report_terminal` 另各自未达成。逐项见「收尾纪律执行情况」表。**本文件不是终态交付件。**
> ⚠️ **本报告自身的合并状态不写死数字**——它每次被修订都会重新领先 `master`。判定命令：`git -C <repo> merge-base --is-ancestor <本文件最后一次修订的 commit> master`；成立即全部落地。
> 核验基线：`4c30e6eb`（在 `master@58f4c45d` 祖先中）；日期 2026-08-08。
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

- **全部 fast-forward 均已由用户执行并落地**（共五次，随共享 `master` 前进逐次进行）：交付内容的最后一个合并点 `4c30e6eb` 在 `master@58f4c45d` 祖先中，`22c8e08b`（reviewed-plan anchor）亦然。**本报告与临时清单自身的修订提交每次都会再次领先 `master`**，按上方状态行的判定命令核，不写死待合数字。
- **安装位置复验（从共享 checkout `/home/xp/src/copilot-api-js` 实跑，`pwd -P` 已确认）**：
  - reviewed-plan blob 门：`22c8e08b` 与 `master` 两侧 `docs/plan/2026-08-07-history-persistence-worker.md` 的 blob 同为 `fe26b74feae99b7e72ef67f3cfadbe993a89122c`，PASS。
  - `bun run typecheck`：通过。
  - 11 文件目标集：**89 pass／0 fail**、287 expect、3.57s。
  - 候选 13 条净路径：共享检出工作区文件与 `master` 同路径内容逐条 md5 相等 → 无未提交残留。
  - 三处无关 WIP（`config.yaml`、`start.bat`、`docs/plan/2026-07-28-session-closeout-skill-review-claude.md`）与 `master` 版本均不相同 → WIP 完整保留，fast-forward 未触及。
- 本会话的 worktree 隔离护栏拒绝对共享检出执行 git 写操作与 `git status`，故 fast-forward 由用户执行；工作区洁净度改用「工作区文件内容 vs `master` blob 内容」逐条 md5 比对取证。**该替代方法的诚实边界**：它覆盖内容差异与文件缺失，但**不覆盖** file mode 变化、regular file↔symlink 类型变化、以及「已 staged 但工作区内容又被改回」这类只在 index 层可见的状态；也**不枚举**候选路径以外的未追踪文件。因此它回答的是「这13条路径的内容是否与 `master` 一致」，不是 `git status` 的全部语义。上表最后一条复验命令保留了真正的 `git status`，供在共享检出直接复跑。
- 未推送、未创建PR、未发布任何ref或artifact。**该结论的取证范围限于本仓库与 GitHub 可观测表面**（终审 reviewer 独立复核：`git branch -r --contains HEAD`、`git tag --points-at HEAD`、联网 `git ls-remote --heads --tags origin` 对 `922b741b` 与分支名筛选均零命中；`gh pr list --state all --head worktree-history-worker-batch-1b-resume` 返回 `[]`）。Git 无法穷尽所有外部系统，故不宣称超出该范围的绝对否定。
- 本会话不删除worktree或分支；`worktree-history-worker-batch-1b-resume`及其worktree仅保留作短期取证与本收尾的恢复源。**Task 2a 不得在该分支或该worktree继续**：按`docs/plan/2026-08-07-history-persistence-worker-kickoff.md`必须从最终`master`新建独立branch／worktree，并新建`docs/tmp/2026-08-08-history-worker-progress-impl-2a.md`；Batch 1b progress已停止更新，不得复用其写入权或旧基线。**清理条件按 branch／worktree 分开，不共用一个门**——完整裁决见「分支与 worktree 归宿」节：branch 等 `master` ancestry；worktree 只受 clean／current-HEAD reachable／owned 三条约束，与 `master` ancestry 无关。
- 碰撞集在 fast-forward 前于 `0ecbca65` 基线重算为 0：候选净路径13条，其中10条在共享检出中存在且与 `master` 内容 md5 相等，另3条（`src/lib/history/persist-retry-config.ts`、本报告、临时清单）在共享检出中不存在且无未追踪文件占位；三处无关 WIP 均不在这13条内。fast-forward 后的实测结果与该预测一致。

## 临时证据

- 清单：`docs/tmp/2026-08-08-history-worker-batch-1b-temp-manifest.md`。**评审链（按时间，当前 verdict 以最后一份为准）**：`docs/tmp/2026-08-08-history-worker-batch-1b-closeout-review-final.md`（**第 1–2 轮，历史件**，其「0 major、可定稿」结论已被第 3 轮推翻，**不得当作当前终审**）→ `docs/tmp/2026-08-08-batch-1b-closeout-final-review.md`（第 3 轮，4 major）→ `docs/tmp/2026-08-08-batch-1b-closeout-review-round4.md`（第 4 轮，3 major，**当前未闭环**）。
- `$CLAUDE_JOB_DIR/tmp`在最终closeout review前重新冻结为56项路径；逐项记录绝对路径、类型、用途、持久接收者、最终动作和清理前置。初版54项清单在生成后又新增提交消息与共享index快照，事实视角reviewer据此判major；本版已纳入两项并禁止再创建新路径。
- **临时证据的安全性不依赖清理时机，而依赖「长期价值已先行落进已提交的持久接收者」。** 56项每一项的接收者见清单逐行：测试／构建／mutation 原始输出 → 已提交的 `docs/tmp/2026-08-08-history-worker-progress-impl-1b.md` 与 `docs/tmp/2026-08-08-history-worker-batch-1b-review-dispositions.md` 证据摘要；提交消息输入 → 对应的本地 Git commit；三方对账副本 → 已提交的 `tests/infra/entry-test-discovery-baseline.json` 与 B3/B4 处置记录；本轮评审结论 → 本报告与上方评审链的各轮报告本身。**因此 Claude job 目录的自动清理在任何时刻发生都不会删除唯一副本。**
- **诚实边界（终审 reviewer 判 major 并修正）**：harness 的 job 自动清理是**本会话不可控的生命周期事件**，它不读取 Git ancestry，因此**任何「清理必须晚于某个 Git 门」的说法都没有执行接缝、不成立**。此前本报告把「确认收尾提交在 `master` 祖先」写成清理前置，是把不可控事件写成受控门——已改正。`master` ancestry 的正确职责只有一个：作为**分支**「可宣告集成完成、可删 branch」的门。**它不是 worktree 的清理门**（Round 4 判 major：worktree 只受 clean／current-HEAD reachable／owned 约束，见「分支与 worktree 归宿」节），也不是临时证据的清理门。若将来确需强制 temp cleanup 晚于某事件，需要一个可显式 hold job 生命周期并经过验证的外部机制，本轮产物没有这种机制。
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
- ✅ **该 skill 的归属迁移已完成，本轮条款已亲自迁入新宿主。** 用户 2026-08-08 裁决把项目 skill `session-closeout` 并入 user-level `closing-a-development-session`、不保留两个收尾入口；peer 会话先合并并删除了项目 skill（本分支按用户裁决「接受删除」解冲突）。**用户同日追加裁决「谁后合并谁负责」，本会话后合，故由本会话把条款迁入新宿主**：改 `~/.claude/skills/closing-a-development-session/source.json`（该 skill 是生成产物，直接改 `SKILL.md` 会被覆盖并撞守卫），再 `render_skill.py` 渲染。落位：非文件候选发现独立成 `discover_nonfile_candidates` stage 并被 `review_temp_manifest` 依赖（使「删除必须晚于发现」由契约图**结构性**保证）、`fd` 枚举陷阱进 §2、删除放行的 reviewer positive receipt 进 §5。守卫 8/8 通过、`render_skill.py --check` 一致；新增依赖边配了专属守卫 `test_manifest_review_requires_nonfile_candidate_discovery` 并做变异对照（删掉该边→变红，精确逆转后复绿）。**该目录不在本仓库、未提交**，按用户指示交其复查者复核。
- **已实现，新记忆条目：** `docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md` —— 从本轮 D2（把不可控的 harness 清理写成受控 Git 门）提炼。触发是「写下任何 X 必须晚于 Y 的顺序前置」，动作内核是先分型（状态门／因果·capability 门）再按该型判，两型共用隔离目标门的双控。**该条目经独立 reviewer 连打五轮**（前四轮各判 1–2 major、方向互不相同：收在直接执行者上→误杀因果门；放松成「有谁读过 Y」→放行旁路日志与 fail-open；四条全局合取→又误杀 capability 门；双控未隔离目标门→兄弟门代咬；「权威」按物理载体定义→误杀线性一致副本），第五轮 0 blocker／0 major 定稿。正文保留完整翻车史与两条可迁移判据。相关评审记录：`docs/tmp/2026-08-08-ordering-gate-lesson-review.md`。
- **未升为 skill 正文条目：** 上述形态在 `session-closeout/verification-log.md` 2026-08-08 节标为「新增负样本、建议入表」，**未自行改写 SKILL.md 正文**——按 `instruction-text-must-be-reviewed`，是否升为正式自验条目须另经评审裁决。

## 尚待动作

**分开两个层面说，别混成一句「无」**——这两句此前互相打架，本轮统一如下：

- **交付内容（Batch 1b 实现、plan、kickoff、测试）：已全部集成主线，无尚待动作。** 权威判据是 `git merge-base --is-ancestor 4c30e6eb master`。
- **收尾流程本身：未闭环。** 契约 17 stage 有**两个根阻断点**，按 `requires` 传播使 2–17 全部受阻（详见阶段表）：
  1. **`freeze_truth` 未达成** —— 契约要求逐个 repository／worktree 跑 `git status --short --branch`，**共享主树因隔离护栏本会话查不了**。解阻动作：在共享检出直接跑 `cd /home/xp/src/copilot-api-js && git --no-optional-locks status --short --branch`。**这一项本会话无法自行关闭。**
  2. **`review_temp_manifest` 未达成** —— 清单在上一轮评审后又被修订，须重审。
  3. `review_closeout_final` 未闭环 —— 第 3 轮判 4 major、第 4 轮判 3 major，本轮整改后须再复审。
  4. 本报告与清单、各轮评审报告的最后一笔修订需由用户执行一次 fast-forward（判定命令见状态行）。

⚠️ **「尚待动作：无」曾是本报告最危险的一句话**：它与同一文档里的阶段表、「评审处置」节、复验清单第 6 条同时存在且互相否定，读者按哪一句行动都有理有据。**紧接着的第二版又犯了同型错误**——只列 8／16／17「三项」，把 `requires` 传播漏掉了，Round 4 判 major。教训已记在 `docs/memory/methodology-closeout-doc-goes-stale-the-moment-the-merge-lands.md` 与 `docs/memory/methodology-ordering-gate-needs-a-trigger-that-reads-it.md` 的射程内。

## 分支与 worktree 归宿（`resolve_branch`）

- **分支 `worktree-history-worker-batch-1b-resume`：裁决＝保留（keep），不删。** 依据：收尾产物的最后修订提交尚未进入 `master`（判定命令见状态行），该分支是它们唯一的持久来源；`finishing-a-development-branch` 三选一里 merge 对交付内容已完成、discard 需用户显式授权且会丢这些提交，故取 keep。
- **worktree `/home/xp/src/copilot-api-js/.claude/worktrees/history-worker-batch-1b-resume`：三条移除前置已具备，是否移除由用户决定。**
  - `worktree_clean`：本轮各次提交后 `git status --short` 为空（评审报告落盘等新增文件另行提交）。
  - `head_reachable`：**成立**——判定命令 `git -C <worktree> branch --contains HEAD`，输出非空即成立。**不写死 commit**：HEAD 每次提交都前移，写死的锚点只能证明某个旧候选可达。实测 `HEAD=b98fe5bb` 时输出 `* worktree-history-worker-batch-1b-resume`（`9a6226b6` 同样命中）。HEAD 可由持久 branch ref 到达，**删除 worktree 不会删除该 branch，也不会丢这些提交**。
  - `worktree_owned`：本会话创建并独占。
  - ⚠️ **此处我此前判错并已改正**：初版写成「`a5ee292b` 未进 `master`，此刻删 worktree 会丢提交」，把**分支的集成状态**当成了**worktree 的可达性前置**。`master` ancestry 是「可宣告集成完成、可删 branch」的门，**不是** `head_reachable` 的唯一实现——branch ref 本身就是持久 ref。保留 worktree 现在是可选，不是安全必需。
- **未推送、未创建 PR、未发布任何 ref 或 artifact**；取证范围限于本仓库与 GitHub 可观测表面。
- ⚠️ **共享主树状态本会话无法自查**：worktree 隔离护栏拒绝 `git -C <共享检出>` 与切目录的 git 调用，因此「共享主树是否干净、是否仍有那三处无关 WIP」**未由本会话核实**，不得据本报告认为已核。需要时请在共享检出直接跑 `git --no-optional-locks status --short`。

## 收尾纪律执行情况（诚实记录）

按 `closing-a-development-session` 的 stage 列表逐项对照，**本轮有跳步，据实登记**：

**契约共 17 个 stage，下表逐个列出，不省略。**

⚠️ **两列不是一回事，Round 4 判 major 的正是把它们混为一谈**：「动作／证据」记这一步实际做没做，「契约达成」按 `requires` 图判——**前置未满足时，即便动作做了，该 stage 也不算达成**。这不是形式主义：`requires` 图的全部意义就是「顺序错了做出来的结果无效」（例如在 `discover_nonfile_candidates` 之前评审清单，评的是一份漏项的清单）。

**本轮有两个根阻断点**：stage 1（共享主树未查，护栏所致）与 stage 8（清单修订后未重审）。按 `requires` 传播，**2–17 全部受阻**。解阻路径：先补 stage 1 的共享主树 `git status`（需在共享检出执行，本会话做不到），再重审清单，其余动作证据已在，可依序重新宣告。

| # | stage | 动作／证据 | 契约达成 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `freeze_truth` | ⚠️ 部分 | ❌ **未达成** | **根阻断点 A**。只冻结了本 worktree 与 `master`；契约要求「在每个 repository 与 worktree 分别跑 `git status --short --branch`」，**共享主树因隔离护栏未查** |
| 2 | `inventory_job_tmp` | ✅ | ⛔ 受阻（1） | 56 项／6,568,699 bytes，`find` 与 `fd -H -I` 两法交叉一致 |
| 3 | `persist_evidence` | ✅ | ⛔ 受阻（1） | 长期价值逐项落进已提交接收者，见「临时证据」节逐类审计 |
| 4 | `verify_persisted_evidence` | ✅ | ⛔ 受阻（1） | 四份接收者以 `git cat-file -e master:<path>` 逐一验证可达 |
| 5 | `archive_docs` | ✅ | ⛔ 受阻（1） | 本轮无待归档 plan／实验产物；已删项目 skill 的自验日志由 peer 归档至 `docs/archive/` |
| 6 | `reconcile_live_docs` | ✅ | ⛔ 受阻（1） | 三处指向已删项目 skill 的陈旧指针已修（含一处**活指针**） |
| 7 | `discover_nonfile_candidates` | ✅ | ⛔ 受阻（1） | 首轮列 2 条，reviewer 独立枚举补出整批；三轮双向对账后 diff 为空，共 12 条 |
| 8 | `review_temp_manifest` | ❌ 未做 | ❌ **未达成** | **根阻断点 B**。清单在评审后又被修订（行 73 字节数 431277→431517）→ 按 skill 自己的规则先前结论作废 |
| 9 | `clean_temp` | — 未执行 | ⛔ 受阻（1,8） | **零删除**，56 项全留交 harness 回收；动作根本没发生，故不宣告达成 |
| 10 | `resolve_branch` | ✅ | ⛔ 受阻（1,8） | 见上节：branch keep；worktree 三条前置齐备、去留交用户 |
| 11 | `draft_terminal_report` | ✅ | ⛔ 受阻（1,8） | 即本文件 |
| 12 | `review_closeout_draft` | ✅ | ⛔ 受阻（1,8） | 跨模型 reviewer 在 `922b741b` 判 0 blocker／2 major，全额整改于 `43ffac97` |
| 13 | `verify_installed_location` | ✅ | ⛔ 受阻（1,8） | 从共享 checkout 实跑（`pwd -P` 已确认）：blob 门 PASS、typecheck 通过、目标集 89 pass／0 fail |
| 14 | `recommend_assets` | ✅ | ⛔ 受阻（1,8） | 见「可复用资产」节五条 |
| 15 | `update_terminal_report` | ✅ | ⛔ 受阻（1,8） | 按第 3、4 轮 major 整改 |
| 16 | `review_closeout_final` | ❌ 未闭环 | ❌ **未达成** | 已跑第 3 轮（4 major）与第 4 轮（3 major），**均未 0 major** |
| 17 | `report_terminal` | ❌ | ❌ **未达成** | `requires: [review_closeout_final]`；**本文件不是终态交付件** |

**最终验证证据（每项标注新跑／复用，锚到 commit）**：

| 项 | 结果 | 来源 |
| --- | --- | --- |
| `bun run typecheck` | 通过 | **新跑** @ `4c30e6eb`（合入 `master@5720855` 后） |
| Batch 1b 目标集（17 文件） | **115 pass／0 fail**、374 expect | **新跑** @ `4c30e6eb` |
| 完整 backend（16 shards、7255 executed、30 skipped） | 0 fail、52.45s | **复用** @ `94205e89`——按项目 `moving-shared-head-is-not-failure` 与「同一交付合并后不因刚合并主动重跑全量」，该交付的合并前证据继续有效 |
| user-level skill 守卫 | 8/8 通过、`render_skill.py --check` 一致 | **新跑**（`~/.claude/skills/closing-a-development-session/`，未提交） |
| 新依赖边变异对照 | 删除该边 → 目标守卫变红；精确逆转后复绿 | **新跑** |

⚠️ 上表两次「测试档 exit 1」均**非回归**：一次是 bun 写覆盖率的 `WriteFailed` 叠加 `| tail -8` 截掉汇总行，一次是 `| rg` 无匹配返回 1 并吞掉输出。去掉过滤重跑均为 exit 0。教训已落 `docs/memory/methodology-output-filter-fakes-a-failure.md`。

1. ~~重新冻结共享index并确认碰撞集为0~~ **已完成**（`0ecbca65` 基线，13条净路径、碰撞0）。
2. ~~在共享checkout执行 `git merge --ff-only`~~ **已由用户完成**，`master@d1011fe7`。
3. ~~从共享checkout复验安装位置~~ **已完成**，逐条结果见「Git、发布与工作树状态」：blob 门 PASS、typecheck 通过、目标集 89 pass／0 fail、13条净路径无残留、三处无关 WIP 保留。
4. ~~重新冻结临时证据清单人口~~ **已完成**：fast-forward 后重枚举仍为 56 项路径、6,568,699 bytes，与冻结值一致，无漂移。
5. 本报告与临时清单交独立reviewer评审——**已跑四轮，尚未闭环**。第 1 轮在候选 `922b741b` 上判 **0 blocker／2 major**；两条全额采纳整改后（`43ffac97`），同一 reviewer 第 2 轮判 **0 blocker／0 major、可定稿**，并独立复核了整改本身没有引入新缺陷（清单整改前后均 56 行、路径集合一致、每行 7 列、无静默删除；20 份提交消息 receiver 均精确命中 `master@d1011fe7` 祖先提交）。**第 3 轮（收尾纪律）判 4 major**、**第 4 轮（整改复审）判 3 major**——两轮的逐条 disposition 见「评审处置」节。**第 2 轮的「可定稿」已被推翻，不得再引用为当前 verdict。** 报告落盘见「临时证据」节的评审链。
6. 提交整改后的报告、清单与各轮评审报告，交复审闭环，再 fast-forward 进 `master`。**这只是「可宣告集成完成、可删本 branch」的门**——它**不是** worktree 的清理门（worktree 只受 clean／current-HEAD reachable／owned 约束），也不是临时证据的清理门（后者不可控且已被设计成何时发生都无害）。

## 评审处置

**第 1–2 轮（清单冻结门）**

- **[major] D1 冻结门放宽（裁决：成立但需附加条件）** —— **已采纳**。原文只要求「说明字节来源」，守不住真正的不变量。reviewer 构造的 false-green 反例成立：`history-worker-batch-1b-wip.patch` 路径不变却被覆写为含未提交新修复时，旧措辞会放行，而 job cleanup 会删掉唯一 WIP 副本。已在清单头部改为两层判据：路径人口／路径名变化 → 整表重生成；路径集合不变而内容变化 → **逐条变化路径做语义复核**（type／用途／长期价值／receiver／最终动作），patch、原始证据、恢复副本、报告草稿不得凭同路径放行。同时保留 reviewer 认定的 false-red 事实：本轮 240 bytes 同路径重拍语义未变，旧门要求整表重审确属过严。
- **[major] D2 清理前置链存在断口（裁决：成立）** —— **已采纳**。Git 顺序门约束不了 harness 的 job 自动清理：评审通过后、收尾提交进入 `master` 祖先前，session 正常结束／崩溃／平台回收都会触发清理，而「不得允许」没有执行接缝。已把可控门与不可控事件分开：所有长期价值在冻结时即已进入**已提交**的持久接收者，故清理何时发生都不删唯一副本；`master` ancestry 只保留为**分支**集成完成门。**不再声称 Git 门能禁止 harness 清理。**

**第 3 轮（收尾纪律，4 major，全部采纳）** —— 报告 `docs/tmp/2026-08-08-batch-1b-closeout-final-review.md`

- **[major] 阶段表不完整** —— **已采纳**：原表只列 9 行且合并了若干项，漏 `draft_terminal_report`／`verify_installed_location`／`recommend_assets`／`update_terminal_report`／`report_terminal` 五个 stage。现按契约逐个列 17 行。
- **[major] `resolve_branch` 裁决理由不成立** —— **已采纳**：`git branch --contains` 证明 HEAD 由持久 branch ref 可达，删 worktree 不删 branch。我把「branch 未进 `master`」当成了「worktree HEAD 不可达」。现 branch 与 worktree 分开裁决。
- **[major] 终态断言互相矛盾** —— **已采纳**：「尚待动作：无」与阶段表三个 ❌、复验清单第 6 条互相否定。现拆成交付内容／收尾流程两层。
- **[major] 清单行 73 字节数陈旧** —— **已采纳**：431277 → 431517，56 行求和 6,568,699，与磁盘一致（第 4 轮独立复算确认）。

**第 4 轮（整改复审，3 major，全部采纳）** —— 报告 `docs/tmp/2026-08-08-batch-1b-closeout-review-round4.md`

- **[major] `requires` 传播仍错** —— **已采纳**。我把「动作发生」当成「契约达成」：stage 1 部分、stage 8 未达成，按 `requires` 图应连带阻断 2–17，而表里 2–7、9–15 全标 ✅。**这正是第 3 轮同一条 major 的残留形态**——补全了 stage 集合，却没补依赖语义。现改为「动作／证据」+「契约达成」双列，并显式标出两个根阻断点与解阻路径。
- **[major] worktree 清理门跨章节残留矛盾 + 可达锚点陈旧** —— **已采纳**。`resolve_branch` 节改对了，但「Git、发布与工作树状态」「临时证据」「复验清单第 6 条」三处仍把 `master` ancestry 当 worktree 清理门，三处均已改；`head_reachable` 的写死锚点 `9a6226b6` 改为动态命令 `git branch --contains HEAD`（实测 `b98fe5bb` 命中）。
- **[major] 旧评审仍被称「终审报告」、未闭合却写「全额整改」** —— **已采纳**。「临时证据」节的单一「终审报告」指针改为按时间排序的**评审链**并标注第 1–2 轮为历史件、其「可定稿」已被推翻；复验清单第 5 条改为四轮口径；本节补齐第 3、4 轮逐条 disposition（此前只有 D1／D2）。

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

# Task 37 收尾终态报告

- **状态**：**定稿**。两道评审门均已过——`review_temp_manifest`（第六轮 positive receipt，双向 diff 为空）与 `review_closeout_final`（两个正交视角，各自复核自己上一轮的发现是否闭合）。最终一轮的账：判据视角 BLOCKER 0 / MAJOR 1 / MINOR 4，接手方视角 BLOCKER 0 / MAJOR 1；两条 MAJOR 与四条 MINOR 均已在本文修掉，逐条记在第 5 节。
- **交付锚点（不是「当前 master」）**：本轮交付的两个 commit 是 `fe8977c0`（代码）与 `d2f66fa9`（收尾产物）。**master 是一条持续前进的共享引用，本文不把它的某个值写成当前状态**——起草时是 `d2f66fa9`，两轮评审期间被 peer 推进了 59 个以上提交。判断交付是否在线上，用 `git merge-base --is-ancestor d2f66fa9 master`，别比对 SHA 相等。
- **本会话工作树**：`.claude/worktrees/task37-closeout`（分支 `worktree-task37-closeout`，已并入 master，目录保留）；本报告在 `.claude/worktrees/encapsulated-kindling-forest` 写就（后台隔离护栏不允许直接写共享检出），已随其分支并入 master。
- **发布状态**：**全部提交都是本地的、未推送**。本仓与 `~/.claude` 仓都没有推送动作；是否发布是用户的决定。

---

## 1. 这轮做了什么

用户指令是「先补那道合并态复审门」——Task 37（Task 1b × Task 3 语义合并）的合并态复审门未闭合，它挡着 Task 4。门补上了，并且在补的过程中撞出并修掉了一个真实的生产缺陷。

**门的闭合**：四个 agent、六轮评审——两个正交视角的 reviewer（`gpt-souls:reviewer` 走 drift/consumer-walk、`verifier` 走不变量证伪）、一个未卷入的 `gpt-souls:arbiter` 裁一条争议发现、一个新的 `reviewer` 审一处窄改动。收敛于 **0 blocker / 0 major**。不变量 I1–I11 全部成立。

**撞出的缺陷（两个视角独立收敛到同一条）**：上游终态 `event: error`（H2）被当成「流被切断」重试四次，客户端为同一次失败收到两个终止符。经真实 HTTP 入口端到端复现。

**根因不在接缝上**：全仓有七处以上各自独立判断「这一帧是不是 Anthropic `error`」，其中五处只读 payload 的 `type`——而原始上游错误帧只在 SSE 的 `event:` 行上写出自己的名字，`type` 是**用户可开关**的 canonical error rewrite（`errorShapingEnabled`）后来补上的。所以第一版修复寄生在一个开关上，开关一关就失效。

**用户裁决（2026-08-09）**：抽共享原语、四处一起修，而不是打补丁。落地为 `src/lib/anthropic/wire-frame-type.ts`；`payload-first` 的优先级使每一处采纳都是严格增量的。采纳面**不写死数字、给能重算它的命令**：`rg -c 'anthropicWireFrameType\(|isAnthropicErrorFrame\(|nameAnthropicEventFromWire\(' src/ --glob '!src/lib/anthropic/wire-frame-type.ts'`，于 `d2f66fa9` 得 **13 处调用、12 个文件**。

⚠️ 账本原先写的是「six accumulator feeds and two translators」（=8）。派评审前自我证伪时实跑上面那条命令，发现它**在任一 selector 下都偏小、且没写明数的是什么**——已在本轮把账本那句替换成同一条命令（见第 2 节 C13）。这是本报告自己撞上的第二个「数字没带 selector」实例。

**一次被撤回的修复**：让 grammar 在块中途发出 failed 终态，确实止住了重试，但**泄漏半个块并多出一个终止符**——是我自己的 A/B 测出我引入了回归，已回滚。那个形状仍是缺陷，真正的修法需要 Task 4 的 owner cutover。它的探针以 `[GATED — requires Task 4 owner cutover]` 的显式 skip 断言期望行为，并登记进 backlog。

---

## 2. 当前状态断言（逐条带证据）

| # | 断言 | 证据 | 取值方式 |
|---|---|---|---|
| C1 | Task 37 合并态复审门已关闭，0 blocker | `.superpowers/sdd/progress.md` 第 22 行；评审报告 `docs/tmp/2026-08-09-task37-seam-review-{claims,drift,invariants,dispositions}.md`、`docs/tmp/2026-08-09-task37-{d1-arbitration,grammar-terminal-review}.md` | 复用（2026-08-09 闭合时的证据） |
| C2 | Task 4 已解除阻塞 | 同上，账本第 21/23 行 | 复用 |
| C3 | 代码交付 `fe8977c0` 已在 master 内 | `git merge-base --is-ancestor fe8977c0 master` → 0 | **新鲜**（2026-08-10 实跑） |
| C4 | 收尾产物已进入 master，整合结果 commit 为 `d2f66fa9` | `git merge-base --is-ancestor d2f66fa9 master` → 0。**两侧的操作不是一回事**：`d2f66fa9` 本身是「把 master 合进我的分支」的**合并提交**（父序 `b5acce8f` / `71dcfb91`），共享树那一侧做的则是 `git merge --ff-only`、**只快进不产生新提交**——这样共享树永远不碰 peer 的 WIP | **新鲜** |
| C5 | 该合并给 master 带去的恰好是 5 个文档文件、零代码改动 | `git diff --name-status d2f66fa9^2 d2f66fa9` → 恰好 `docs/memory/feedback-fix-all-comparison-sites.md`、`docs/todo/deferred-backlog.md` 两处修改 + 三个 `docs/tmp/` 新增，共 5 行 | **新鲜**。⚠️ **`^2` 不是笔误**：`d2f66fa9` 的第一父是我的分支、第二父才是 master 侧，所以「master 得到了什么」要从 `^2` 出发。草稿里给的 `^1` 与 `fe8977c0 master` 两种写法都算成了别的量，见第 5 节第 11 条 |
| C6 | 合并位置测试绿 | `bun run test:fast`（= `parallel-test unit http`）于 `d2f66fa9`：`16 shards · 5471 tests · 5471 pass · 0 fail · 5471 executed · 3 skipped`，exit 0 | **新鲜**。⚠️ **原始日志写在 job 临时目录里，会随 job 过期消失，不要去找它**——上面这行汇总就是本报告保存的全部，要更强的证据请按第 6 节配方重跑 |
| C7 | 闭门时的全量门禁 | `16 shards · 7651 tests · 7651 pass · 0 fail · 11 skipped`，exit 0，无 crashed shard；typecheck 与 `lint:all` clean | 复用（2026-08-09，账本第 22 行）。**注意口径不同**：C6 是 fast 档（unit+http），C7 是闭门时的全后端档，两个数字不可比 |
| C8 | `deferred-backlog.md` 上我与 master 的改动行级共存 | `git diff d2f66fa9^2 d2f66fa9 -- docs/todo/deferred-backlog.md`（我新增的两条基线维护坑）与 `git show c38baa6a -- docs/todo/deferred-backlog.md`（master 侧那条划除闭合，在 `d2f66fa9` 的树里仍在），合并无冲突 | **新鲜**。草稿里给的是 `git diff master HEAD -- …`，那条**在合并落地后恒返回空**——同一份文档里第二条会随自身合并而失效的配方 |
| C9 | 共享主树的 peer WIP 未受影响 | 合并前后 `git status --porcelain -uall` 均为同样 10 项（2 改 + 8 未追踪），全部与我的 5 个文件不相交 | **新鲜** |
| C10 | skill 改动已安装并已提交 | `~/.claude` 仓 `eb3ea6f`；正文见 `skills/positive-control-your-tests/SKILL.md:43`；提交后该仓脏项 14 → 13，只有我那一个离开 | **新鲜** |
| C11 | 两棵审查用 worktree 已移除 | 移除前四项取证：`status -uall` 全空、HEAD `638f6f3c` 已在 master、无 `index.lock`、6 小时内无文件改动、无对应会话目录 | **新鲜** |
| C12 | 所有提交均未推送 | 本会话未执行任何 `git push`／PR／release 动作 | **新鲜** |
| C13 | 原语采纳面 = 13 处调用 / 12 个文件 | `rg -c 'anthropicWireFrameType\(|isAnthropicErrorFrame\(|nameAnthropicEventFromWire\(' src/ --glob '!src/lib/anthropic/wire-frame-type.ts'`，于 `d2f66fa9` | **新鲜**；同时据此修正了账本第 22 行原先的 "six … and two …"（=8，偏小且无 selector） |

**C6 的边界**：fast 档只跑 unit+http，**不覆盖** it/pty/e2e/perf。它证明的是「合并没有打破快速档」，不是「全后端仍绿」。全后端的绿是 C7 的复用证据，锚在 2026-08-09 闭门那一刻。按项目规则（CLAUDE.md「同一交付合并后不因『刚合并』主动重跑全量测试」）与 user-rule `moving-shared-head-is-not-failure`，本次不触发全量复跑；升级信号（真实失败／矛盾证据／相关路径变化）一个都没出现。

---

## 3. 收尾各阶段的处置

| 阶段 | 处置 |
|---|---|
| `freeze_truth` | 冻结 `git status`／HEAD／分支清单 |
| `inventory_job_tmp` | 冻结逐路径清单 **427 行**，落 `docs/tmp/2026-08-09-task37-closeout-tmp-inventory.md`（原用 `.txt`，被 gitignore 挡住，改名 `.md` 并以 `git cat-file -e` 复验入库） |
| `persist_evidence` / `verify_persisted_evidence` | 证据清单 `docs/tmp/2026-08-09-task37-closeout-evidence-manifest.md` |
| `archive_docs` / `reconcile_live_docs` | backlog 新增 3 条；记忆 `feedback-fix-all-comparison-sites` 追加第二个实例；账本 `.superpowers/sdd/progress.md` 关门并修正 3 条陈旧断言 |
| `discover_nonfile_candidates` | **六轮才收敛**，见下节 |
| `review_temp_manifest` | 第六轮拿到 positive receipt：事件源 `…/a7c2cc1a-….jsonl`、范围 12000–15108 行、独立枚举、**两方向 diff 均空** |
| `clean_temp` | **不删除**。收到 receipt 后删除已被释放——所以这是一个**选择**，不再是失败关闭。理由：skill 允许「每个对象均有 disposition」时交由 harness 回收 job 目录，而冻结的 427 行逐类覆盖满足该前提；删除不可逆，保留不损失任何东西 |
| `resolve_branch` | 隔离树内先合 master（28 个 peer commit，零冲突）→ 共享树 `--ff-only`，共享树只做快进不碰 peer WIP |
| worktree | 移除 2 棵审查树；`task37-closeout` 保留（分支已并入 master，`worktree-branches-are-for-merging` 已满足）；仓库里另有约 200 棵既有 worktree，**不属本轮清理范围，未触碰** |

### `discover_nonfile_candidates` 为什么走了六轮

前三轮反向对账**发散**：6 条 → 5 条 → 17+ 条，而第三轮自己写的是「至少」。诊断是**范围错了，不是力气不够**——在「每一次修正、标定、变异、探针」的粒度上，一个横跨两个阶段、15108 行的 job 等于一次全量审计，而 skill 明确把那称作本阶段的退化形态。

经用户批准把枚举范围缩到 **Task 37 相位**（Task 9 那一半在本 job 内已有自己的收尾，若干条目已有承载者），随后收敛：6 条有界 → 6 条有界且不带「至少」→ 空。

**诚实边界**：范围是缩过的，结论只对 Task 37 相位成立，不对整个 job 成立。这一点写在清单里并标为可反驳。

---

## 4. 遗留与未做

- **H2 块中途终态**仍是缺陷：正确修法要等 Task 4 的 owner cutover。已登记 backlog，探针以 gated skip 断言期望行为。
- **接手 Task 4 的入口**（报告草稿只说了「已解除阻塞」而没给路径，评审判为 MAJOR，补齐如下）：
    - 计划正文：`docs/plan/2026-08-07-mandatory-block-delivery-h2-observability/plan-1-sse-and-delivery-foundation.md:72`（「把现有 `DownstreamDeliverySession` 升级为 `BlockDeliveryOwner`」）。
    - **同 commit 硬约束**：同文件 `:67`——切换 driver 直接消费 grammar outcome 的**那一个** commit 里才能删 compatibility projection，不允许出现「旧 projection 已删、新 owner 尚未接管」的中间提交。
    - **已写好的验收探针**：`tests/pipeline/i9-followup-midblock-error.http.test.ts:64`，现为 `describe.skip`，skip 理由里写着解除条件。**别重写一个更弱的**——它断言的就是 Task 4 要建立的能力。
    - ⚠️ **最贵的一条警告**，在 backlog 条目 **`## 上游终态错误发生在块中途时，仍被当截断重试四次；直接修会泄漏半块`** 里（**故意不给行号**：`docs/todo/deferred-backlog.md` 是高频并发追加的文件，草稿里写的 `:1417` 在两轮评审期间就被 peer 推到了 1456，漂了 39 行；用 `rg -n '^## 上游终态错误发生在块中途时' docs/todo/deferred-backlog.md` 定位）。内容是：做 Task 4 时必须把 `incomplete` 与 `failed` **并列**处理——`src/lib/pipeline/delivery/adapters/responses.ts:76-78` 的 `case "response.incomplete"` → `semantic = "incomplete"` 显示它同样是上游的终态决定；**只修 `failed` 会在同一位置再犯一次**。（backlog 原文还引了同文件 `:17`，那一处**不支持**该论断，是它自己的笔误，别跟着找。）
    - **别重走的路**：本轮已试过「让 grammar 在块中途发出 failed 终态」，实测泄漏半块 + 多一个终止符，已撤回（见第 1 节与 `docs/tmp/2026-08-09-task37-grammar-terminal-review.md`）。
- **backlog 新增 3 条**。其中一条是 entry-evidence 基线的**手工维护**条目，它自己带两个子项（`allowed_skipped` 须按 `skipSortKey` 逐字节全序、一个 `describe.skip` 套件产出两条 skip identity）——**是「3 条里的 1 条含 2 个子项」，不是「3 条里有 2 条是它们」**。
- **`tests/history/search/` 的 14 条失败**是环境性的：gitignored 的 native 产物过期（构建于 2026-08-06，源码新 5 个提交）。正控：重新构建 → 28 pass / 0 fail。已登记，不是代码缺陷。
- **`verification-log.md` 欠账已还**（起草时尚未写，草稿评审期间补上，故两份评审报告对此说法不一）：`~/.claude` `e525ba1` —— `skills/closing-a-development-session/verification-log.md` 七条、`skills/proving-where-a-command-ran/verification-log.md` 两条。含两条对我自己的证伪：收尾触发链没自己响（是用户点名的）、以及「引用权威的数字不继承它的正确性」。后者还给 provenance 那份带去第一张 V2 反对票——gate 模板被仓库护栏整条拒收，被迫拆成多次调用后 `&&` 短路与证据打印不再同处一个 shell。
- **一条未定的建议**：把 N9 教训（「给一个结构上本就不具鉴别力的形状加参数化，得到的是两个绿格子，不是更强的判据」）补进 skill `catching-false-green-tests`——**已确认该 skill 目前不含此条**（`rg 'parameteris|two green cells|non-discriminating'` 无命中）。目前只是建议，未实施，等用户裁决。
- **另一条同类建议**：把「反向对账跨轮次**发散**（6 → 5 → 17+）是范围信号、不是力气信号」补进 `closing-a-development-session` 的 `discover_nonfile_candidates`——**已确认该 skill 目前不含此条**。同样只是建议，未实施。两条都属指令类文本，安装前须独立评审。

### 本轮收尾产生的、已在 master 上的产物

`docs/tmp/2026-08-09-task37-closeout-evidence-manifest.md`（证据清单）、`…-tmp-inventory.md`（427 行冻结清单）、`…-closeout-review.md`（**收尾产物自身的评审记录，已跑完、0 blocker / 0 major，不要重派**）。本报告与其两份草稿评审（`…-draft-review-claims.md`、`…-draft-review-successor.md`）随最后一次合并进入 master。

---

## 5. 这轮我自己犯的错（都已修，留形态）

1. **修复寄生在用户可开关的行为上**——第一版只读 payload `type`，`errorShapingEnabled` 一关就失效。
2. **我的 grammar 修复本身是回归**——止住重试却泄漏半块 + 多一个终止符；是我自己的 A/B 证伪的。
3. **我的一条测试是假绿**——`h2-committed-block-delivery` 的形状结构上不具鉴别力；处置是**改正断言的措辞**而不是把它伪装成强判据，并把变异对照挪到真正有鉴别力的形状上。
4. **站点枚举漏了 5 处**——grep 枚举的是**拼写**，不是**错误**。已作为第二个实例追加进记忆 `feedback-fix-all-comparison-sites`。
5. **注释引用了一条不存在的 backlog 条目**——假的追踪指针，已补建条目。
6. **污染了一个评审的独立性**——在它裁决前把我自己的 D1 结论告诉了视角 A。已向 arbiter 披露。
7. **从工作区 diff 导出恢复补丁**——对未追踪文件得到空补丁，变异没被恢复。失败是**关闭式**的（`git apply --reverse --check` 拒绝空输入 + `&&` 短路），已把这个形态写进 skill。
8. **清单计数曾陈旧且混口径**（424）；首次冻结漏了 2 个指向目录的符号链接（`os.walk` 把它们归在 `dirnames`），425 vs 427。
9. **对账脚本的自检是同源恒等式**（`sum(c) == len(members)` 按构造恒真），换成 header 声明数 vs 实际行数的比较。
10. **把账本里的一个数字原样复述进终报**——「六处 feed 与两个 translator」，我没问它数的是什么就抄了。派评审前的自我证伪跑了一次命令才发现它在任一 selector 下都偏小。**这是本报告在写作过程中撞上的、而不是评审抓到的**，形态与第 4 条同源：数字的载体换了，selector 仍然没人写。
11. **我给的复验命令算的不是我声称的那个量，而且连错两版**——先写 `git diff fe8977c0 master -- docs/`（跨 138 个提交、返回 19 个文件），被两个视角独立指出后改成 `d2f66fa9^1`，一跑发现它列的是**master 带进来的东西**，方向正好反了（合并提交的第一父是我的分支）。第三版 `d2f66fa9^2` 才是 5。**结论 C5 从头到尾是对的，错的一直是我用来证明它的那条命令**——这是「跑过命令、拿到输出、结论仍然错」在同一份文档里的第三次。
12. **在 reviewer 读同一份文件时改掉了它正在审的内容**——我在「判据证伪」视角审阅期间补写了 verification-log，导致它把报告里那句「欠账未还」判为 false-red。它判得对，而这个假红是我制造的。两个视角的报告对同一件事说法不一，就是这么来的；已在第 4 节写明时序。
13. **把一个取自合并前的树的行号，写进了合并后才存在的文档**——`deferred-backlog.md:1417` 取自隔离树合 master **之前**，合并后 peer 的新条目把它推到 1456。两轮评审给出的答案还互相矛盾（1418 / 1456），最后按内容判定才定下来。**处置不是把数字改对，而是撤掉行号**：那是个高频并发追加的文件，改对的行号几小时后照样漂。改用 `rg` 锚小节标题。**这条恰好是我自己在第 5 节写下的那条纪律的反例**——写的时候 grep 过不够，`file:line` 要按最终文件复验。
14. **写了「A2 的唯一载体是本报告」这个绝对断言而没核**——证据清单第 87 行就记着同一条教训。评审指出后一查就见。绝对断言（唯一/无/全部）不核就写，本轮第三次。

---

## 6. 可复用资产（Step 8）

先搜既有资产、优先更新而非造同义词——**本轮不新建任何 skill / rule / agent**，四条全部落在既有资产上。

| # | 落点 | 类型 | 触发形态 | 它补上的缺口 | 与既有资产的重叠 | 状态 |
|---|---|---|---|---|---|---|
| A1 | `positive-control-your-tests` | skill 更新 | 要把注入的变异恢复回去 | 原文只禁「变异**前**快照 `git diff`」，没说**变异后**从工作区导出补丁同样不成立；实测未追踪文件导出的补丁为空、什么都没恢复 | 就是该 skill 第 1 步的另一半，不是新概念 | **已实施并已评审**（`~/.claude` `eb3ea6f`，评审判 INFO／闭合） |
| A2 | `catching-false-green-tests` | skill 更新 | 想靠「多加几组参数」让一条判据变强 | 给一个**结构上本就不具鉴别力**的形状加参数化，得到的是两个绿格子，不是更强的判据；本轮实例 `h2-committed-block-delivery` | 已确认该 skill 现无此条（`rg 'parameteris\|two green cells\|non-discriminating'` 无命中） | **仅建议**，等用户裁决 |
| A3 | `closing-a-development-session` 的 `discover_nonfile_candidates` | skill 更新 | 反向对账连做几轮、条数不收敛 | 跨轮次**发散**（6 → 5 → 17+，第三轮还写「至少」）是**范围**信号不是力气信号；正确动作是缩范围，不是再审一遍 | 该 skill 已把「全量审计」列为退化形态，但没给「怎么认出自己正在滑进去」的症状 | **仅建议** |
| ~~A4~~ | ~~user-rule `every-number-carries-scope`~~ | — | — | ~~「引用来的数字」未被覆盖~~ | **缺口不存在，已撤回** | **撤回**（见下） |

A2/A3 都是**指令类文本**，按 `instruction-text-must-be-reviewed` 安装前须独立评审。

**A4 撤回，理由值得写下来**：我原本提议给 `every-number-carries-scope` 补一句「引用来的数字也要重算」。评审去读了规则原文——它的 `[hard]` 门写的是「**任何写进交付物的数字**必须①带口径②经不同原理交叉验证」，引用来的数字当然也是写进交付物的。**缺口不存在，规则一直在那儿，是我没照做。** 这个区分很重要：往一条已经覆盖了该情形的规则上再加一句，不会让人更照做，只会让规则更长——`best-practices-over-omission` 提醒过，删改规则文本都不是中性动作。

**承载者核实**（第一版这里写错了，留作实例）：我先写下「A2 的唯一载体是本报告」，评审指出证据清单也记着它——去核，`docs/tmp/2026-08-09-task37-closeout-evidence-manifest.md` 第 87 行的 N9 条目正是这条教训，且已在 master。A3 的形态另记在 `~/.claude/skills/closing-a-development-session/verification-log.md`（`e525ba1`）。**两条都不止一个载体**；我那句「唯一载体」是没核就写的绝对断言，与本轮反复在抓的形态同类。

---

## 7. 复验配方

**下面每条都实跑过、并核对了它算的确实是它声称的那个量。**（草稿里的前两版配方没做这一步，见第 5 节第 11 条。）

```bash
# C3/C4：交付是否在线上。注意是祖先判定，不是 SHA 相等——master 一直在前进
git merge-base --is-ancestor fe8977c0 master && echo "code delivery in master"
git merge-base --is-ancestor d2f66fa9 master && echo "closeout merge in master"

# C5：这次合并给 master 带去了什么。`^2` 是 master 侧的父，别写成 `^1`
git diff --name-status d2f66fa9^2 d2f66fa9        # 期望恰好 5 行，全在 docs/ 下

# C13：原语采纳面（不写死数字，重算它）
rg -c 'anthropicWireFrameType\(|isAnthropicErrorFrame\(|nameAnthropicEventFromWire\(' src/ \
  --glob '!src/lib/anthropic/wire-frame-type.ts'   # 期望 12 个文件、合计 13 处

# C6：合并位置快速档。RUN_PERF_TESTS 必须为空，否则 skip 多重集会变、entry 证据门会报 multiset mismatch
env | grep -c RUN_PERF_TESTS                       # 期望 0
bun run test:fast

# C10 与 verification-log：都在 ~/.claude 仓
git -C ~/.claude log --oneline -1 -- skills/positive-control-your-tests/SKILL.md
git -C ~/.claude log --oneline -1 -- skills/closing-a-development-session/verification-log.md
```

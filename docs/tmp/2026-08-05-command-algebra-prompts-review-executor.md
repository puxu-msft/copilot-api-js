# Command algebra 第三层 prompts 执行者走查

## 评审范围与 verdict

- 评审范围：`/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/` 的 README、Commit -1、post-merge preflight、Commit 0～8；深走 Commit -1、preflight、C0、C4、C5、C8，其余逐份核 task／前后继／门／停点。
- 总体 verdict：**存在 blocker**。
- blocker 数：4。
- 机械核对覆盖证据：在主树 HEAD `3b9e066d1356c13ac7be7f7713cf5aad9433dad0` 上运行 `prompt-task-check.py` 与 `traceability-check.py`，均 rc=0；核了 83 个 task 的唯一归属、12 份 prompt 文件、引用文件存在性、plan/design 标题与 task reverse trace、Q1/Q5/ADR D2 停点，以及 worktree／mutation／push／4141／progress 红线。
- 第一人称执行覆盖证据：从 README 模拟 Commit -1→合 master 得 A→从 A 建树→15-run／pointer P→preflight→C0→…→C8；并分别按独立新会话进入 Commit -1、preflight、C0、C4、C5、C8，检查“我下一步实际运行什么、在哪里运行、缺输入时是否能停”。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:21-23,41` 与 `commit-0.md:19-20,43` — 真实 15-run batch 同时被设为 preflight 的既有输入和 preflight 之后的 `T0.1` 动作，形成不可执行的循环 — plan 也同时写 `cutover-plan.md:481-487`“先 15 runs→T0.0d→才允许 T0.1”，以及 `:564,576-579`“T0.0d 通过前 T0.1 不能开工／T0.1 然后才是 15 次”。作为执行者，我在 preflight 前没有获准执行 `T0.1`，因而造不出 validator 必需的 artifacts；若提前跑则违反 task phase，若等 preflight 后跑则 preflight 永远缺输入；即使自行猜测跑两批，也会让 P 指向哪批 evidence、哪批算 T0.1 无权威答案 — 把“生成 entry 15-run evidence”明确归入 preflight 前的独立 task／step（并从 C0 T0.1 删除），或明确 T0.1 就在 P 前执行并调整 DAG、prompt ownership 与“不得开始 T0.1”门；只能保留一套因果顺序。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md:13-17`（同型遍及全部 phase；README `:9-13`）— 必读路径混用“相对 prompt 文件”和“相对仓库根”两套基准，却未声明解析根 — 从仓库根照字面执行时，`../design.md` 会解析到不存在的 `/home/xp/src/design.md`，`README.md` 会静默打开用户向 `/home/xp/src/copilot-api-js/README.md` 而非 prompts 红线；与此同时 `docs/tmp/...` 又只能按仓库根解析。作为只拿到 prompt 的新会话，我会漏读冻结 design/plan/traceability 与集中红线，随后可能错开 phase、碰错误 mutation 树或现场补签名 — 所有引用统一写仓库根相对全路径，或在每份 prompt 开头固定 `PROMPT_DIR=.../prompts` 并明确全部相对路径以它解析；不要混用。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md:14,36`、`post-merge-preflight.md:14,33`、`commit-0.md:12` — prompts 把 `cutover-plan.md §0.4f` 宣称为 validator／post-merge 条件的唯一事实源，但 plan 没有 `0.4f` 标题 — 主树标题扫描只存在 §0.4a、§0.4b、§0.4e；真实内容位于 `cutover-plan.md:479-564` 的无编号“Post-merge entry-evidence preflight”。作为执行者，我按引用无法定位十项条件与 EV mapping，最可能改为只照 prompt 摘要实现 validator，漏掉原始 artifact 独立重算或 Git 图条件，或者现场自行定义 `0.4f` — 给该段正式编号 `0.4f`，或把三份 prompt 改成稳定的实际标题锚点，并由 checker 验证 heading 存在。

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-4.md:16-19,43-44` — Q5 diff 被同时设为进入 Commit 4 phase 前必须已审的前置和 Commit 4 内 `T4.1` 才产出的 task，导致停门不可达 — `commit-3.md:36-42` 的 `T3.5` 只产逐点映射，未归属 diff；plan 同样在 `cutover-plan.md:804` 要求 kickoff 前 diff 已复核，却在 `:819` 才让 T4.1 产出并复核。作为执行者，我没有现成 diff 时必须按前置停止，无法进入 T4.1 生成它；若无视前置进入，则违背 Q5 必经停门；若另开未归属工作生成，则 task／提交／progress 无归属 — 把 T4.1 明确搬成 Commit 3 后、Commit 4 前的独立 preflight task／prompt，或把 Commit 4 前置改为“完成 T4.0a-d 后先执行 T4.1，T4.2 前必须审完”，并同步 README DAG、plan 与 traceability。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-8.md:17-21,31,51,55` — 把 Q2 的 richest-data-flow ADR 与上游明确命名的“ADR D2”混成同一停点，并只锚了错误 ADR — 实际 ADR D2 第 3 点在 `/home/xp/src/copilot-api-js/docs/decisions/2026-07-22-continuation-retry-sequential-anchor.md:25-35`，其“写文件前只出 replacement、获用户同意才改”见 `docs/plan/2026-07-27-inter-block-anchor-allocator/plan-8-acceptance-and-docs.md:50-63` 与 HANDOVER `:198`；`2026-07-05-richest-data-flow.md` 没有 D2 编号。作为 C8 执行者，我会把“默认不改 richest ADR”误当作已经守住 ADR D2 停点，进而在 T8.5 disposition／旧 plan supersede 时漏掉真正 D2 replacement 审批，或错误修改另一份 ADR；还可能错误宣称文档收口 — 分拆并具名两道门：Q2 只对应 `2026-07-05-richest-data-flow.md`；ADR D2 只对应 `2026-07-22-continuation-retry-sequential-anchor.md` 第 3 点与 P8.4，明确本 RFC 是仅审计／保留停点还是执行 replacement 草案，并写清未获批时不得声称 docs closeout。

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:46` — preflight 用不存在的 Git path `HANDOVER` 验 pointer，正确状态也必定 false-red — 仓库根不存在 `HANDOVER` 或 `HANDOVER.md`；权威文件是 `/home/xp/src/copilot-api-js/docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`。plan `cutover-plan.md:492` 一度写对完整 path，却在条件表 `:504-505` 又退化为 `git show "$POINTER_SHA":HANDOVER`，prompt 复制了错误命令。作为执行者，我即使正确提交 P，验收仍会报 `path HANDOVER does not exist`；我可能误判 pointer 坏了、重写 P／HANDOVER 格式，或绕过 fail-closed 门继续 — 全部改用唯一完整 repo path，并给 validator 正确样本与“错误短路径必红”的回归。

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-minus-1.md:42-49` 与 `post-merge-preflight.md:35-49` — 执行者被要求实现并随后调用 versioned entry-evidence validator，但产物路径、CLI／函数签名、调用命令和 pointer/manifest schema 的具体字段语法未冻结 — 全仓搜索只有 prose 中的“validator”，当前无实现；plan 只列抽象输入 `ENTRY_SHA`／`POINTER_SHA`／artifacts 与 marker 名，没有决定例如脚本路径、参数是 env 还是 flags、`$TREE` 如何传入、manifest JSON schema；preflight 甚至没有一条可粘贴的 validator 命令。作为只拿 prompt 的执行者，我必须现场发明接口；下个 phase／另一个执行者可能按不同接口消费，导致 T0.0d 无法运行，或 validator 自测与真实 preflight 接线分叉 — 在 plan/design 先冻结 validator 的文件路径、导出／CLI 签名、完整调用示例、pointer block 与 manifest versioned schema、退出码契约；prompt 只实现该已冻结接口，不让实现者选形状。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:45` — 唯一给出的 HEAD“命令”不是可运行 shell，而是把断言伪装进 argv：`git -C "$TREE" rev-parse HEAD == ENTRY_SHA` — 实跑得到 `fatal: ambiguous argument '=='`，rc=128；它既不展开 `$ENTRY_SHA` 也不比较输出。作为执行者，我会在正确 A tree 上被假红阻断；若把它当伪代码自行修，又与 prompt 要求“命令能运行”的自包含性冲突 — 改成可执行的 `test "$(git -C "$TREE" rev-parse HEAD)" = "$ENTRY_SHA"`，并在 prompt 中给整套 preflight command。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-5.md:18` — Q1 唯一显式 gate 命令省略真实脚本路径，按字面不可运行 — 实跑 `PHASE=post q1-locations.sh` 得 rc=127 `command not found`；实际脚本在 `/home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/q1-locations.sh`，plan `cutover-plan.md:959` 给的是完整仓库根命令。作为执行者，我可能在完成 Q1 裁决后被假红阻断，或因找不到命令跳过 PHASE=post，漏掉 §4.8 冲突和 carrier 同步 — 复制 plan 的可执行完整命令：`cd /home/xp/src/copilot-api-js && PHASE=post exp/inter-block-anchor-allocator/q1-locations.sh`，并保留 rc 判定。

## 机械通过项与结构怪味

- `prompt-task-check.py`：`plan tasks: 83`、`prompt tasks: 83`、duplicates/orphans/unassigned 均 none，rc=0。
- `traceability-check.py`：14 R rows、9 O rows、5 deferred，rc=0。
- checker 树向证明：调用时 shell cwd 为隔离评审树，但脚本绝对路径是 `/home/xp/src/copilot-api-js/exp/inter-block-anchor-allocator/*.py`，两者均由 `__file__.resolve().parents[2]` 解析到主树；打印 `checker-root=/home/xp/src/copilot-api-js`、top-level 同值、HEAD=`3b9e066d1356c13ac7be7f7713cf5aad9433dad0`。
- Commit 1～3、6～7 的 task ID／前后继／基本停门与 README 一致；所有 prompt 均有两份一致 task marker；未发现旧 82 task、旧双树或并行 implementation 建议残留。
- 安全与工作树红线覆盖充分：README 明确绝不 push、不碰 4141、mutation 只在第二隔离树或 exact patch、共享树不得整文件恢复；各高风险 phase 有局部复述。
- 结构怪味：`cutover-plan.md` 与 prompts 重复维护命令／phase 前置，且副本弱一档，已实际产生三种漂移：不存在的 §0.4f、错误 HANDOVER path、不可运行 Q1 命令。处置：本轮应修；理由是这些不是风格重复，而是当前 blocker／major 的共同根因。位置：`cutover-plan.md:479-564`、`prompts/post-merge-preflight.md:33,45-46`、`prompts/commit-5.md:18`。

## 主观建议

[建议] prompts checker — 当前 checker 只判 task 集合，无法发现本报告全部执行缺陷 — 预期影响：后续 plan 重写时仍可能“83/83 全绿但流程不可走” — 推荐增加 heading-reference checker、repo-path/command smoke checker、phase dependency DAG 的 producer-before-consumer 检查；这些是机械辅助，仍保留第一人称走查。

## 最终计数

- blocker：4
- major：5
- minor：0
- nit：0
- verdict：**存在 blocker，不可进入执行阶段。**


# 第二轮执行方复评（整改后 HEAD `51cd3e784f69b1367fd7b8685b737e0445e0cf46`）

## 评审范围与 verdict

- 评审范围：整改 plan/trace `0eb76f26`、`f0c799a5` 与 prompts `51cd3e78`；从 README 重走 Commit -1→A→T0.0f→P→T0.0d→C0/T0.1→C4/Q5→C5/Q1→C8/Q2/D2。
- 总体 verdict：**存在 blocker**；本轮新增／残留 blocker 3、major 2、minor 1。
- 机械核对覆盖证据：三个整改 commit 均为主树 HEAD 祖先；`prompt-task-check.py` 输出 84/84、无 duplicate/orphan/unassigned；另用历史散文注入 `T9.99` 证明 definition 集不变；`traceability-check.py` rc=0；Q1 `PHASE=pre` 当前正确绿，`PHASE=post` 当前按未裁状态正确红；root-relative 必读路径与完整 HANDOVER git path 均可达；HEAD equality 真 shell 实跑绿。
- 第一人称执行覆盖证据：按 README 严格串行模拟每个产物的 producer/consumer；在每一步只使用该时点已有变量与 prompt/plan 提供的命令，首个真卡点出现在 T0.0f。

## 首轮 finding 逐条 disposition

1. 15-run 因果环：**主体已修**。T0.0f 是唯一生产者，T0.0d 只消费，T0.1 明令不跑第二批；但 T0.0f 本身仍不可直接执行，见本轮 blocker 1，且 plan 有旧 T0.1 复述，见 major 1。
2. 相对路径基准混乱：**已修**。README 明示全路径从 repo root 解析，全部必读与红线指针改为 root-relative。
3. 缺失 §0.4f：**已修**。`cutover-plan.md:481` 有正式 heading。
4. Q5 kickoff 环：**prompt/plan 已修、design/trace 未闭合**。T4.1 已放在 T4.2 publish 前，但冻结 design 仍写“进入 Commit 4 前”，见本轮 blocker 3。
5. Q2 与 ADR D2 混写：**prompt 已修、plan 未同步**，见本轮 major 2。
6. 错误 `:HANDOVER` git path：**已修**。prompt/plan 均使用完整 repo path，实跑 `git show HEAD:docs/plan/.../HANDOVER.md` 成功。
7. validator CLI/schema 未冻结：**主体已修**。路径、flags、pointer block v1、manifest v1、exit code/FAIL 前缀已冻结；但成功 receipt 协议仍缺，见 blocker 2。
8. HEAD 比较伪 shell：**已修**。`test "$(git -C "$TREE" rev-parse HEAD)" = "$ENTRY_SHA"` 实跑绿。
9. Q1 命令不可运行：**已修**。完整 repo-root 命令已给出；当前 pre 相位实跑绿，post 相位因尚未首次裁决而按预期红。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:39-42`；`cutover-plan.md:134-142,508-545` — **执行者第一个真卡点**：T0.0f 没有一条可运行的 evidence 生产命令，也没有冻结 `MIN_TESTS` 的独立来源或 manifest 生成器接口 — `baseline-runs.sh` 实际强制 `MIN_TESTS`，缺失即 rc=2，且脚本自身明确禁止从被测命令派生；prompt 只说“跑 15 次并生成 manifest”，plan 只冻结最终 JSON schema，没有给 `OUT/RUNS/MIN_TESTS` 命令、floor oracle、runner artifact 输出位置或由谁组装 manifest。作为执行者，我到 T0.0f 无法填 `MIN_TESTS`，也不知道用哪个版本化命令把 15 份 JUnit/identity artifacts 组装成 manifest；自行写脚本/接口即现场发明未冻结执行协议 — 在 §0.4f 冻结 T0.0f producer 的脚本路径/CLI、完整可粘命令、`MIN_TESTS` 的独立 oracle、artifact→manifest 生成规则与失败退出码，再让 prompt 原样调用。

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:483-536,545,634`；`prompts/post-merge-preflight.md:42,49`；`prompts/commit-0.md:19,43` — validator 的失败协议已冻结，但“versioned verdict/receipt”没有 schema、输出路径、stdout 格式或 CLI flag — 现有 CLI 只有四个输入 flag；§0.4f 只定义 rc/stderr 和 evidence manifest，不定义成功时如何产出 receipt。作为执行者，即使 T0.0d rc=0，也无法产生 T0.1 要读取和 mutation 的持久 receipt，更无法证明它来自哪次 P/A/manifest；T0.1 因缺 receipt 必须 fail-closed — 冻结 receipt v1 的路径/载体、字段（至少 entry/pointer/manifest hash/validator version/verdict）、原子写入时机与 CLI 输出 flag，并给 T0.1 的唯一读取命令。

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:623-625,715,734` 与 `prompts/commit-4.md:18-22`、`cutover-plan.md:853-860` — Q5 相位在冻结 design 与执行 prompt 之间仍相反 — prompt/plan 允许进入 C4 后先做 T4.0a-d/T4.1，只禁止进入 T4.2；design 仍说 Q5 已复核是 Commit 4“前置停门”且“缺材料不得进入该 commit”。作为执行者按必读顺序先读冻结 design，会在没有 diff 时停在 C4 外，永远到不了 T4.1；若按 prompt 进入则违反冻结 contract — 把 design §7.7/§9.2/§9.4 及 traceability Q5 行统一改为“可进入 C4 pre-publish tasks，T4.2 authority publish 前必须完成”，不要只修 plan/prompt。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:134-142,155,311-318` 与 `:634` — plan 仍在活的共同门章节写“T0.1 会撞上 baseline-runs”“禁止用 ALLOW_DIRTY 通过 T0.1”“T0.1/T0.11 要求 junit 枚举”，而新 T0.1 明令不再跑 15 次 — 作为执行者顺序读 plan 时会先把 baseline/JUnit 工作归给 T0.1，之后再遇到相反 task；可能重跑第二批 evidence，恢复首轮已修的双源问题 — 将这些活跃复述全部改成 T0.0f；历史事故说明可保留，但必须明确标注旧归属已作废。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/commit-8.md:17-33,53` 与 `cutover-plan.md:1150-1180` — prompt 已把 Q2 richest ADR 与 continuation ADR D2 分成两门，但 plan 的 Commit 8 SSOT 仍只列 Q2，逐 task/commit invariant 没有 ADR D2 replacement 草案与“未批不得 docs closeout” — 作为执行者回 plan 取详细 T8 task 时会认为只需处理 Q2，并可在未处理 D2 审批时满足 plan invariant；prompt 与 plan 对完成条件冲突 — 把 ADR D2 独立停门、草案 task 归属和未批状态同步进 plan/traceability，而非只写在第三层 prompt。

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:1,7-9,21` — 标题仍称“P 后”，但同一 prompt 的第一个 task T0.0f 正是生成 P — 执行者若只按标题判断前置会去找尚不存在的 P；正文已明确纠正，故有绕行 — 标题改为“A 后、P 生成与验证、Commit 0 前”。

## 机械通过项与结构怪味

- README DAG 只列即时后继；无并行 implementation 建议；首次裁决/禁止重裁在 prompts 内已明确区分。
- checker 已结构化解析 Markdown task definition，历史 mention 注入不改变 84 项人口，首轮 checker 假绿已闭合。
- 结构怪味：同一 phase gate 在 design/plan/trace/prompt 四层重复维护且没有跨层相位 checker，Q5 与 ADR D2 再次出现“只修下层”的漂移。处置：本轮修；位置如 blocker 3/major 2。建议增加具名 gate 的跨文档状态表机械对账，但不能替代执行者走查。

## 第二轮最终计数

- blocker：3
- major：2
- minor：1
- verdict：**存在 blocker，不可进入执行阶段。**


# 第三轮执行方复评（稳定态 HEAD `78480cde9d57fa2d8d292834ae1e8f3503dffa7d`）

## 评审范围与 verdict

- 评审范围：从 README 完整走 Commit -1→A→T0.0f→P→T0.0d receipt→C0/T0.1→C4/Q5→C5/Q1→C8，并复核第三轮指定的 checker 历史区正控与全部 repo-root/命令/DAG。
- 总体 verdict：**存在 blocker**；本轮 blocker 2、major 1、minor 2。
- 机械核对覆盖证据：主树 HEAD 如上；task checker 84/84、traceability rc=0；把 live `T0.0f` 定义行移入非“逐 task”历史表后 checker 正确降为 83 并报 `orphan prompt tasks: ['T0.0f']`；Q1 `PHASE=pre` 当前绿；root-relative 既存路径全可达；完整 HANDOVER git path与 HEAD equality 真 shell 实跑绿；README DAG 全是即时边。
- 第一人称执行覆盖证据：只使用各 phase 到达时已有变量和 prompt/plan 给出的命令逐步执行；第一个真卡点仍是 T0.0f，第二个是 T0.0d 的 prompt 命令无法生成后继必需 receipt。

## 第二轮 finding 逐条 disposition

1. T0.0f producer／`MIN_TESTS`／manifest 规则：**未修，仍为 blocker 1**。
2. receipt 协议：**plan 已完整冻结，prompt 调用未同步必填 flag，仍为 blocker 2**。
3. Q5：**主体已统一到 T4.2 前**，design/trace 仍有两句较早的旧摘要，降为 major 1。
4. 旧 T0.1 evidence 复述：大部分已修；剩两处历史／越界说明仍写 T0.1，降为 minor 1。
5. C8 Q2／P8 D2：**已修**。Q2 是本 RFC C8 停门；continuation ADR D2 明确留给 P8，本轮只核待办未被删，不产草案、不改 ADR、不阻塞本次 closeout。
6. preflight 标题“P 后”：**未修**，仍为 minor 2。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:39-42`；`cutover-plan.md:134-142,528-566` — T0.0f 仍无版本化 producer 接口／可执行命令、`MIN_TESTS` 独立来源和 artifact→manifest 组装规则 — 当前唯一命令线索仍是 `baseline-runs.sh`，它缺 `MIN_TESTS` 必定 rc=2，且严禁从待测命令自取；§0.4f 只冻结最终 manifest schema和 validator，不冻结 producer 路径、flags、floor oracle、JUnit/identity artifact 命名或 manifest 原子生成。作为执行者，我在 A tree 到达 T0.0f 后无法运行第一条合法命令；自行编 producer 或手组 JSON 正是现场发明未冻结协议 — 冻结 producer 脚本/CLI、完整命令、独立 floor 来源、artifact 命名与 manifest 原子写入/退出码，并在 prompt 原样调用。

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:42,49` 与 `cutover-plan.md:483-515` — plan 已把 `--receipt-out "$RECEIPT"` 设为 validator 必填接口，并规定 rc=0 必须原子写 receipt，但 prompt 的实际 T0.0d 命令仍少 `--receipt-out` — 作为执行者照 prompt 运行会以 CLI/schema rc=2 失败，或即便实现者擅自容忍省略，也不会产生 T0.1 的唯一输入；链停在 T0.0d — prompt 定义绝对树外 `RECEIPT` 并逐字复制完整五-flag CLI；验收同时核 stdout 的 path/hash。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:494`、`:759` 与 `traceability.md:42` — Q5 的承重段已正确改成“T4.2 publish 前”，但更早摘要仍写“Commit 4前/C4前先过”，与 phase 内 T4.1 producer 顺序冲突 — 新执行者按 README 必读顺序先读 design，可能在进入 C4 前因没有 diff 停下，永远到不了 T4.1；后文虽可纠正，但同一权威文档先给相反动作 — 全部旧摘要明确改为“Commit 4 内 T4.2 前”，避免把 commit phase 与 authority publish 混称。

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:207,1355` — 两处残留仍把 JUnit 枚举／`ALLOW_DIRTY` evidence 动作写给 T0.1；新 T0.1 只读 receipt — 执行者可能误以为 C0 仍需跑 evidence，但主 task 已明确否定，存在绕行 — 改为 T0.0f，历史形态则标“旧归属已作废”。

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/prompts/post-merge-preflight.md:1` 与 `cutover-plan.md:479` — phase 标题仍称“P 后”，而首 task T0.0f 正是生成 P — 标题会让执行者先寻找不存在的 P；正文能纠正 — 改为“A 后：P 生成与验证，Commit 0 前”。

## 机械通过项与结构怪味

- validator CLI/pointer/manifest/receipt schema与 T0.1 唯一读取链在 plan 内已闭合；缺陷是 prompt 少传必填 receipt flag，不再是 schema 未冻结。
- Q5 详细 design/plan/prompt/trace 停门均为 T4.2 前；C8 Q2/P8 D2 边界一致；repo-root 路径、真实 shell、DAG即时后继均通过。
- 结构怪味：prompt 继续手抄 plan CLI，第三轮即出现漏掉新增必填 flag。处置：本轮修；推荐 checker 从 fenced canonical CLI 与 prompt 命令结构化比对，避免接口扩展只改 SSOT。

## 第三轮最终计数

- blocker：2
- major：1
- minor：2
- verdict：**存在 blocker，不可进入执行阶段。**


# 第四轮执行方复评（稳定态 HEAD `ad87cf007c44c91155f31578d8232be24e070b5d`）

## 评审范围与 verdict

- 评审范围：完整走 Commit -1 实现 producer+validator→A→T0.0f capture CLI→P→T0.0d validator receipt→C0/T0.1→C4/Q5→C8；实跑关键只读命令与整表移入历史区正控。
- 总体 verdict：**存在 blocker**；本轮 blocker 1、major 1、minor 2。
- 机械核对覆盖证据：主树 HEAD 如上；task checker 84/84、traceability rc=0；把 Commit 1 整张 live `逐 task` 表搬到非定义历史 heading 后，checker 降为 77 并精确报 T1.1～T1.7 七个 orphan；Q1 pre gate 绿；完整 HANDOVER git path与 HEAD equality shell 绿；既存 repo-root 路径全可达；README DAG 仅即时后继。
- 第一人称执行覆盖证据：逐步检查 producer/validator/receipt 的实现归属、CLI flags、stdout、schema与后继读取；T0.0f 实际调用已可拼出，但 Commit -1 实现 versioned discovery baseline 时仍遇到首个未冻结接口。

## 第三轮 finding 逐条 disposition

1. T0.0f producer CLI/MIN_TESTS/manifest：**主体已修**。`capture-entry-evidence.ts` CLI、独立 baseline、15 runs、树外 OUT、manifest 原子写入/退出码均冻结；但 baseline v1 自身只给“至少含”，见本轮 blocker。
2. validator receipt flag：**已修**。prompt 已传 `--receipt-out "$RECEIPT"`；receipt v1、stdout path/hash、T0.1 唯一读取链闭合。
3. Q5：**承重段均已修为 T4.2 前**；design 仍有一处相反旧摘要，见 major。
4. 旧 T0.1 evidence 复述：仍有两处，见 minor。
5. preflight prompt 标题：**已修**为“A 后生成 P、验证后进入 Commit 0”；plan 上层标题仍旧，见 minor。
6. Q2/P8 D2：**已修**。C8 只处理 Q2；continuation ADR D2 仍归 P8，本 RFC 只核待办可达，不执行 replacement。

## 事实性发现

[blocker] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:483-497` 与 `prompts/commit-minus-1.md:46` — `entry-test-discovery-baseline.json` 被声明为 versioned schema v1、且 prompt 明令“不得另选 producer CLI/schema”，但 plan 只说“schema v1 **至少含** disk file identity、allowed skipped multiset、`minimum_executed`、runner blob”，没有完整 JSON 字段名/类型、额外字段策略、生成命令与原子写入契约 — 作为 Commit -1 执行者，我必须现场决定 versioned 跨 phase 文件协议；T0.0f producer 与后续 mutation fixture 都依赖该选择，而 prompt 又禁止我选择。两个实现者可交付语义相同但字节/字段不兼容的 baseline，capture CLI 到 T0.0f 才失败 — 像 pointer/manifest/receipt 一样冻结 baseline v1 的完整 JSON、生成入口、严格/宽松字段策略、runner blob算法与成功/失败写入规则；Commit -1 只实现，不设计协议。

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/design.md:494` — 同一冻结 design 的详细 §7.7/§9.2/§9.4 已统一为“Commit 4 内 T4.2 前”，但 §6.2 前导摘要仍说“保留 Commit 4 前的逐帧 diff 停门” — 执行者按 README 顺序先读到此句会在 phase 外停，无法执行 T4.1；后文相反说明才纠正 — 改为“保留 Commit 4 内 T4.2 authority publish 前停门”。

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:207,1372` — JUnit 枚举与 `ALLOW_DIRTY` 两处仍写旧 T0.1 归属；现 T0.1 只读 receipt — 主 task 可纠正，故有限影响 — 改 T0.0f或标注历史旧归属。

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:479` — 上层标题仍写“P 后”，其下 phase 首 task T0.0f 才生成 P；prompt 标题已修 — 改成“A 后生成 P并验证、Commit 0 前”。

## 机械通过项与结构怪味

- capture CLI、独立 `minimum_executed` baseline、manifest生成、validator pointer/manifest/receipt、T0.1读取链除 baseline v1 字段协议外均无需现场发明；命令参数在 plan/prompt 对齐。
- Q5 承重 sections/plan/prompt/trace 均是 T4.2 前；checker 整表历史迁移正控有效；D2/P8、路径、shell、DAG 通过。
- 结构怪味：四个 versioned evidence artifact 中 pointer/manifest/receipt 已完整冻结，baseline 仍用开放式“至少含”，同一协议链抽象强度不一致。处置：本轮修；无需第三方库。

## 第四轮最终计数

- blocker：1
- major：1
- minor：2
- verdict：**存在 blocker，不可进入执行阶段。**


# 第五轮执行方复评（稳定态 HEAD `a7840d412cdc26c6874cd2cf2f4b7e0f768578b8`）

## 评审范围与 verdict

- 评审范围：完整走 Commit -1 实现 producer+validator→A→T0.0f 冻结 CLI→P→T0.0d receipt→T0.1，并复核 Q5、preflight 标题、旧 T0.1 归属、P8 D2 与 checker 整表迁移。
- 总体 verdict：**修复 minor 后可进入下一阶段；未发现 blocker/major**。本轮 blocker 0、major 0、minor 1。
- 机械核对覆盖证据：主树 HEAD 如上；task checker 84/84、traceability rc=0；Commit 1 整张 task 表移入非定义历史区时正确报 T1.1～T1.7 七个 orphan；Q1 pre gate 绿；完整 HANDOVER path、repo-root 路径、即时后继 DAG 与 shell 形状通过。
- 第一人称执行覆盖证据：从 Commit -1 按完整 baseline v1 schema实现 producer/validator，模拟生成 A、运行 capture CLI、写 P、运行带 `--receipt-out` validator、读取 receipt v1 进入 T0.1；每个跨 phase 产物均有单一 producer、严格 schema和唯一 consumer。

## 第四轮 finding 逐条 disposition

1. discovery baseline v1 未冻结：**已修**。完整 JSON 字段/类型、排序、reason enum、canonical encoding、额外/缺失字段 fail-closed、runner blob 与 `minimum_executed` 来源均冻结。
2. Q5 旧摘要：**已修**。design/plan/trace/prompt 全部明确为 Commit 4 内 T4.2 authority publish 前。
3. 旧 T0.1 evidence 复述：一处活跃说明仍残留，见 minor；另一处只在“未采纳”历史否定表，保留不会误导执行。
4. plan preflight 标题：**已修**为“A 后生成 P、验证后进入 Commit 0”。

## 事实性发现

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:207` — production 变更判据的活跃说明仍写“若 T0.1／T0.11 的 junit 枚举要动 `parallel-test.ts`”，但 JUnit evidence 基础设施现归 Commit -1 的 T0.0a～c，T0.1 只读 receipt — 作为执行者可能误以为 C0/T0.1 仍可修改 runner；不过 Commit -1、T0.0f、T0.1 主 task 都明确相反，故影响有限 — 改成“T0.0a～c／T0.11”；`cutover-plan.md:1397` 的 T0.1 只在未采纳反例表，建议顺手标注“旧归属”但不构成执行缺陷。

## 机械通过项与结构怪味

- capture CLI、baseline v1、独立 `minimum_executed`、artifact→manifest/失败契约、validator receipt与 T0.1 唯一读取链均完整，无需现场发明。
- Q5 全层 T4.2 前；preflight 标题 A 后；D2 保持 P8 且 C8 只核待办；checker 整表迁移正控有效。
- 结构怪味：无新增承重结构怪味；仅 line 207 是旧 task 名残留，修正文案即可。

## 第五轮最终计数

- blocker：0
- major：0
- minor：1
- verdict：**修复 minor 后可进入下一阶段；未发现阻断性问题。**


# 第六轮执行方复评（稳定态 HEAD `92cacf6556aed97f04fdd6deddcdaf62b17824d9`）

## 评审范围与 verdict

- 评审范围：完整走 Commit -1→A→T0.0f producer+baseline→P→T0.0d validator receipt→T0.1；重点核 baseline provenance、C11/EV26–28、phase owner 与前轮收口项。
- 总体 verdict：**修复 major 后可进入下一阶段**；本轮 blocker 0、major 1、minor 1。
- 机械核对覆盖证据：新增 `92cacf65` 为 HEAD；task checker 84/84 且 `wrong-phase: none`，traceability rc=0；把 T2.8 定义移入 Commit 3 live table 后人口仍 84，但 checker 正确报 `T2.8: plan=commit-3.md, prompt=commit-2.md`；Q5/D2/preflight title 保持闭合。
- 第一人称执行覆盖证据：逐字段追踪 entry 中 baseline 原始 bytes/runner blob→capture manifest→validator C11→receipt v1→T0.1；机制链已可执行，但 C11 的汇总契约仍有三处旧 C1～C10 口径。

## 第五轮 finding 逐条 disposition

1. line 207 旧 T0.1 归属：**未修，仍为 minor**；另发现 entry 段 line 59 同型。
2. baseline path/hash/runner blob provenance：**机制已增强并闭合**。manifest 与 receipt 均携三字段；validator 从 `ENTRY_SHA` Git object 独立读取并重算，不接受调用方宽 baseline。
3. checker phase owner：**已修并经正控**，人口不变但 phase 错位会红。
4. Q5、P8 D2、preflight A 后标题：保持闭合。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:538,615,642-675` 与 `prompts/post-merge-preflight.md:33` — 新增 C11/EV26–28 后，validator 汇总契约没有同步：稳定退出码只定义 C1～C10；T0.0d 成功描述仍说“C1～C10 全绿”；prompt 仍称“完整十行 validator 条件” — Commit -1 实现者必须自行决定 C11 失败用哪个稳定退出码，T0.0d 执行者又会从摘要理解为只需 C1～C10。实际 C11 表与 EV 已存在，故不是机制缺失，但同一跨 phase public CLI 对成功/失败人口自相矛盾；执行者可能把 C11 当附加测试而非 receipt 生成硬门 — 把稳定退出码扩到 C11（明确 code）、T0.0d 改为 C1～C11 全绿、prompt 改“十一项”，并让 receipt 只在 C11 后写入。

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:59,207` — 两处活跃说明仍把 dirty/JUnit evidence 行为归给 T0.1；现 T0.1 只消费 receipt，真实脚本/runner 改造归 T0.0a～c/T0.0f — 主 task 足以纠正，影响有限 — 分别改为 T0.0f 与 T0.0a～c/T0.11；未采纳表里的旧 T0.1 仅是历史反例，可保留但建议标“旧归属”。

## 机械通过项与结构怪味

- baseline v1 path/hash/runner blob 均由 `ENTRY_SHA` Git object 独立验证，进入 manifest/receipt；C11 与 EV26–28 的目标机制清晰。
- producer/validator/receipt CLI 无需现场发明；checker 能判 phase owner；Q5、D2 P8、preflight title 保持通过。
- 结构怪味：新增 acceptance condition 后，condition 表、退出码、成功人口、prompt 摘要四处需同步，目前后三处弱一档。处置：本轮修；建议给 validator condition 人口加机械对账，类似 EV 表 checker。

## 第六轮最终计数

- blocker：0
- major：1
- minor：1
- verdict：**修复 major 后可进入下一阶段；未发现 blocker。**


# 第七轮执行方复评（稳定态 HEAD `0f5dc40c06a47961babad97b6ca078aa017fb618`）

## 评审范围与 verdict

- 评审范围：producer→manifest（含 baseline provenance）→validator C11→receipt（含 baseline provenance）→T0.1，并核 baseline 替换/放宽、C11 receipt 时序、phase checker owner 与前轮 CLI/Q5/D2。
- 总体 verdict：**修复 major 后可进入下一阶段**；本轮 blocker 0、major 1、minor 1。
- 机械核对覆盖证据：新增 `0f5dc40c` 为 HEAD；task checker 84/84、`wrong-phase: none`，traceability rc=0，Q1 pre gate 绿；phase checker 现同时对照父 heading、prompt owner 与 task-id grammar owner。
- 第一人称执行覆盖证据：从 A 的 Git object 读取固定 baseline path/bytes/runner blob，模拟 manifest 替换 path、旧 hash、另一 runner blob 三种放宽；均落入 C11/EV26–28，且 receipt 原子写入明确晚于 C11。

## 第六轮 finding 逐条 disposition

1. C11 退出码/receipt 写入时机：**主体已修**。exit 7 明确覆盖 C9～C11，rc=0 与 receipt 原子写入明确要求 C1～C11 全绿，C11 失败不得留下 receipt。
2. T0.0d/prompt 人口摘要：**未修**，仍为 major。
3. T0.1 旧归属：**未修**，仍为 minor。
4. Phase owner checker：**增强并通过**。新增 task-id grammar 独立 owner 轴，整表搬错 phase 也不能靠同时改 prompt 骗绿。

## 事实性发现

[major] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:615` 与 `prompts/post-merge-preflight.md:33` — C11 硬门的底层时序已修，但执行摘要仍写“validator C1～C10 全绿后写 receipt”和“完整十行 validator 条件” — 独立执行者按 T0.0d task 表可在 C10 后写 receipt，正面违反同文件 `:538-539` 的 C1～C11 契约；prompt 也把 C11 从人口中漏掉。baseline 放宽虽有 C11 oracle，却可能因摘要顺序被绕过 — 两处分别改为“C1～C11”与“十一项”，并建议 checker 对 condition population、成功人口、prompt 摘要做机械一致性检查。

[minor] `/home/xp/src/copilot-api-js/docs/rfc/2026-08-03-generation-emission-command-algebra/cutover-plan.md:59,207` — 活跃说明仍把 dirty/JUnit evidence 行为归给只读 receipt 的 T0.1 — 主 task 可纠正，故影响有限 — 改为 T0.0f 与 T0.0a～c/T0.11；历史反例中的旧名可保留但应标旧归属。

## 机械通过项与结构怪味

- C11 可抓：manifest baseline path 替换、entry baseline bytes/hash 漂移、runner blob 替换；validator 不接受调用方另给宽 baseline。
- receipt 只在 C1～C11 全绿后原子写，C11 失败不留旧/半份；receipt 携 baseline path/hash/blob，T0.1 通过 receipt hash与 validator blob获得传递完整性。
- producer/receipt CLI、Q5 T4.2、P8 D2、preflight title 均保持闭合。
- 结构怪味：承重规则已修，摘要副本继续弱一档；这是连续第二轮同一同步缝，处置应是加 condition-population checker，不再只手工改数字。

## 第七轮最终计数

- blocker：0
- major：1
- minor：1
- verdict：**修复 major 后可进入下一阶段；未发现 blocker。**


# 第八轮最终执行方复评（稳定态 HEAD `ff3a0ae0ef2089da5a63b1da801c6c5c2ca7e04c`）

## 评审范围与 verdict

- 评审范围：完整走 producer→baseline trust→manifest→validator C11→receipt→T0.1，并复核 receipt C1～C11 硬门、same-Commit 历史表正控、phase owner 与前轮全部 findings。
- 总体 verdict：**可进入下一阶段**；本轮 blocker 0、major 0、minor 0。
- 机械核对覆盖证据：新增 `ff3a0ae0` 为 HEAD；task checker 84/84、duplicates/orphans/unassigned/wrong-phase 均 none；traceability rc=0；Q1 pre gate 绿；把 T1.4 从同一 Commit 的 exact `### 逐 task` 表移入 `### 历史逐 task 表（已作废）` 后，checker 正确降为 83 并报 `orphan prompt tasks: ['T1.4']`。
- 第一人称执行覆盖证据：从 Commit -1 严格 baseline v1 与 capture CLI 出发，沿固定 entry path/hash/runner blob 进入 manifest；validator 从 `ENTRY_SHA` Git object 独立重算 C11，C1～C11 全绿后才原子写 receipt；T0.1 只消费该 receipt，不产生第二份 evidence。

## 第七轮 finding 逐条 disposition

1. C11 汇总仍写 C1～C10／十行：**已修**。稳定 exit、receipt 写入、T0.0d task 均是 C1～C11；post prompt 明确“十一行”。
2. 旧 T0.1 evidence 归属：**已修**。活跃段落零残留；唯一 `ALLOW_DIRTY + T0.1` 命中位于“未采纳”历史反例，不指挥执行。
3. Baseline 替换／放宽：保持闭合。固定 entry path、entry bytes hash、runner blob 分别由 C11/EV26–28 检测。
4. Phase checker：保持闭合。exact live heading、父 phase、prompt owner、task-id grammar owner 四轴均参与判定；same-Commit 历史近似 heading 不算定义源。
5. CLI/Q5/P8 D2/preflight title：均保持闭合。

## 事实性发现

未发现问题。

## 机械通过项与结构怪味

- Producer/manifest/validator/receipt/T0.1 的单一 producer、严格 schema、原子写入和 fail-closed 顺序一致；正确状态可通过，baseline path/hash/blob 三类错误状态均被拒绝。
- C11 失败时 receipt 不存在；receipt 携 baseline path/hash/blob，且 validator/receipt hash 使 T0.1 可核来源。
- Q5 全层统一 T4.2 前；continuation ADR D2 仍归 P8；preflight 标题为 A 后；repo-root 路径、真实 shell、DAG 即时后继均通过。
- 结构怪味扫描：此前“承重 SSOT 已扩、摘要弱一档”的重复维护问题已由本轮同步闭合；未发现新的承重结构怪味。

## 第八轮最终计数

- blocker：0
- major：0
- minor：0
- nit：0
- verdict：**可进入下一阶段。**

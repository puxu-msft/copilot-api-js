# HANDOVER/KICKOFF 评审报告

评审范围：`docs/plan/2026-08-08-long-resident-operation-lifecycle/{HANDOVER.md,KICKOFF.md}`（仓库只读评审，未修改任何文件）。
核验环境：worktree `/home/xp/src/copilot-api-js/.worktree/fix-long-resident-operations`，当前 HEAD `9fd1ae45`（比文档记录的核验基线 `3e418cdb` 多一个纯文档提交，无代码变动）。

---

## C2：`git diff --stat` 数字核验

- **287 个提交**：`git log --oneline 92858d08..9fad0bdf | wc -l` = **287**。✅ 与文档一致（`9fad0bdf` 是 master 上时间戳最接近核验时刻 2026-08-08 22:25:19 的提交，早于该时刻的下一个提交）。
- **11 个改过 `src/lib/shutdown.ts`**：`git log --oneline 92858d08..master -- src/lib/shutdown.ts | wc -l` = **11**。✅ 一致。
- **403 行变动**：`git diff --numstat 92858d08 master -- src/lib/shutdown.ts` = `102 insertions, 301 deletions`，102+301=403。✅ 一致。
- **“净减 258 行”**：实测 301−102=**199**，且 `git show 92858d08:src/lib/shutdown.ts | wc -l` = 849、`git show master:src/lib/shutdown.ts | wc -l` = 650，849−650=**199**。

**[major] HANDOVER.md:22 — 数字错误：净减行数写成 258，实际应为 199。** 证据：`git diff --numstat 92858d08 master -- src/lib/shutdown.ts` 给出 `102\t301`，净减 = 301−102 = 199；文件行数差 849→650 = 199，两种独立算法互相印证 199，均不支持 258。
**接手方会做出的错误动作**：若照抄这个数字去估算改动规模或写进后续文档/commit message，会引入一个可核查却错误的数字，且该数字后续可能被当作「已核实」再传播（违反本项目自身的 `every-number-carries-scope` / `cross-check-with-two-methods` 纪律）。
**修复建议**：把 HANDOVER.md:22 的「净减 258 行」改为「净减 199 行」（或直接删掉这个衍生数字，只保留可复现的 `git diff --stat` 原始输出，避免二次算错）。


---

## C5（补充）：Task 4 自身门禁数字核验——发现新的严重矛盾

**[major] HANDOVER.md:8 — 「Task 4 自身门禁在 `3e418cdb`：`26 pass / 0 fail / 62 expect`」这组数字与任何可追溯来源都对不上，疑似跨话题串号。**

证据链：
1. 按 plan（`docs/plan/2026-08-08-long-resident-operation-lifecycle.md` Task 4 Step 5）指定的确切命令独立复现：`bun test tests/context/manager-dual-registry.unit.test.ts tests/context/context-manager.it.test.ts tests/shutdown/drain-waits-operation.unit.test.ts` → 实测 **30 pass / 0 fail / 74 expect**（在当前 HEAD `9fd1ae45`；另在 commit `3e418cdb` 通过 `git archive` 检出隔离目录尝试复现遇 `undici` 模块解析问题，属环境问题非测试问题，故以当前 HEAD 复现为准——两者之间只有 manager.ts 的 minor 修复 `a8eeaf4c`，不影响该焦点集测试数）。
2. 该数字与 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-task-4-review.md:60` 里 reviewer 独立复现的原话完全一致：「仓库自带焦点集……在我的副本实跑 **30 pass / 0 fail / 74 expect**，与实施侧自报一致（该数字我独立复现，不是转述）」。
3. 全仓 `grep -rn "26 pass\|62 expect"` 唯一命中的另一处是 `docs/tmp/2026-08-07-history-worker-progress-impl-1.md:19`——**完全不相关的另一个话题**（history-worker protocol/runtime 测试，日期还是 08-07），原文写的是「protocol/runtime **26 pass／0 fail**」（无 62 expect 字样，expect 数字来源不明）。

**接手方会因此做出的错误动作**：接手方若照 HANDOVER.md:8 的说法去核对「Task 4 自身门禁」，会拿 26/62 这两个错误数字与自己实测的 30/74 对比，误判为「回归」或「环境不一致」，从而浪费时间去排查一个并不存在的差异；更坏的情况是，若接手方不复验直接采信文档数字写进后续交接文档，会把一个跨话题串号的错误数字继续传播下去。

**修复建议**：把 HANDOVER.md:8 的「Task 4 自身门禁在 `3e418cdb`：`26 pass / 0 fail / 62 expect`」改为与 `docs/tmp/*-task-4-review.md:60` 一致的「30 pass / 0 fail / 74 expect」，并建议之后新增门禁数字前先 `grep` 一次全仓避免误引到其他话题的进度文件。


---

## 重要更新：C2 的净减行数错误已被同伴/后续提交修正，但 KICKOFF.md 未同步——这正是 C6 要抓的矛盾

评审过程中仓库发生了并发变化：commit `7889c5de`（"docs: correct a wrong derived number and record backend tier flakiness"）已经把 HANDOVER.md 的「净减 258」改成了「净减 199」（与我上面 C2 的独立复算完全一致，说明该数字错误已被他人/后续轮次发现并修正）。

**[major] KICKOFF.md:14 — 仍然写着「403 行变动、净减 258」，与已修正的 HANDOVER.md:30（净减 199）互相矛盾。**
证据：`HANDOVER.md:30` 现文本为「合计 403 行变动、净减 **199** 行……两法互证」；`KICKOFF.md:14` 原文为「403 行变动、净减 258」，两份文档现在给出的净减行数不一致（199 vs 258），且 258 已被证实是错误数字。
**接手方会做出的错误动作**：KICKOFF.md 是接手方第一条消息、大概率先看到它而非去逐字核对 HANDOVER 的证据小节，会把 258 当作事实记住或转述，与之后读到 HANDOVER 的 199 产生confusion，甚至可能因为「两份文档不一致」而怀疑其他数字（如 287、11）是否也不可靠，浪费额外核查成本。
**修复建议**：把 KICKOFF.md:14 的「净减 258」同步改为「净减 199」，或直接删除这个衍生数字、改为引用 HANDOVER「必须最先做的事」小节（KICKOFF 本身已经这样写「详见 HANDOVER」，只是数字重复处未删干净）。

**注**：由于评审期间仓库发生了作者侧的并发编辑（原 C2 发现的 HANDOVER.md 侧错误已被修正），下文仍保留原 C2 记录作为核验过程留痕，但**当前状态下 HANDOVER.md:30 的净减行数是正确的（199）**，需要修的只剩 KICKOFF.md:14。


---

## 归因修正（采纳协调方意见）

协调方指出 `26 pass / 62 expect` 不是跨话题串号，而是 `3e418cdb`（blocker 整改前）的真实读数；`a8eeaf4c` 整改新增了用例，数字才变为 30/74。**已核实并采纳**：`git diff --stat 3e418cdb a8eeaf4c -- tests/context/manager-dual-registry.unit.test.ts` 显示该文件在这两个 commit 间新增 115 行（+115/-1），足以解释 pass/expect 数从 26/62 涨到 30/74。撤回我原先「疑似跨话题串号」的推测——结论（该数字在 HANDOVER.md 中会误导接手方）不变，但根因是「陈旧数」而非「串号」。现 `96fe5282` 已修复并附带正确归因说明，此项已闭合。


---

## 剩余命题核验（当前 HEAD `96fe5282`）

**C1（Tasks 1–4 落地 commit 是否存在且相符）**：✅ 通过。`62f572c1/8c9c85d5/0af6850b/f05db881/4de3cd6e/cf8f4380/3e418cdb/a8eeaf4c` 全部存在且均为当前 HEAD 的祖先（`git merge-base --is-ancestor` 逐一验证）；抽查 `62f572c1` 内容确实是「feat(context): model operation lifecycle blockers」，改动 `operation-lifecycle.ts`/`operation-scope.ts` 及对应测试，与 Task 1 描述相符。

**C3（`master:src/lib/shutdown.ts:246-256` 仍打印 `request.state`）**：✅ 通过。实测 `git show master:src/lib/shutdown.ts` 第 254 行为 `return \`  ${request.method} ${request.path} ${model} (${request.state}, ${age}s)\`\`；`formatActiveRequestsSummary` 定义于第 246 行，落在文档引用的 246-256 行区间内，字段名与用途均对得上。

**C4（Task 4 blocker/major 是否真已关闭）**：✅ 通过。`grep -n lifecycleFailureBarrier src/lib/context/manager.ts` 现有 281 行声明、509 行写入（`.set`）、427/429 行读取与驱逐（`.get`/`.delete`），且 401-415 行注释明确记录这是修复 review 提出的两个发现（write-only 与单调增长）的同一处改动，与 `a8eeaf4c` 的 commit message「drain registered lifecycle failures at release time」吻合。

**C6（HANDOVER/KICKOFF 之间是否还有其他矛盾）**：在 `96fe5282` 修复之后，逐项复查 gate 编号（KICKOFF 两道 gate 与 HANDOVER「必须最先做的事」/「与既有裁决的对账」一一对应）、Task 状态表（HANDOVER 行 54-62 与 KICKOFF「已闭合」表述一致）、批准状态（KICKOFF「已批准/需用户定/已闭合」三段与 HANDOVER 待办 1-3 及「与既有裁决的对账」节口径一致）、待办条数（HANDOVER「待办」1-3 三条，KICKOFF「批准状态」段落引用「待办 1」，行文没有第 4 条待办被遗漏或多计）——**未发现除已修复项外的新矛盾**。plan 正文 Task 1-8 标题行号（55/160/240/323/384/454/510/557）与 HANDOVER 引用的 384/454/510/557 全部核对一致。

## 接手方第一人称走查

**走查①：照文档做「合并 master」这一步，会不会立刻撞冲突？**
✅ 实测确认会撞冲突，且比文档预告的范围更广。`git merge-tree --write-tree HEAD master` 产生 **3 处冲突**：`src/lib/context/manager.ts`（HANDOVER 已预告）、`src/lib/shutdown.ts`（HANDOVER 已预告，且冲突恰好命中文档所指的 `drainModelOperationFinalizations` 重命名那几行，与 HANDOVER 描述完全吻合）、以及**`docs/memory/MEMORY.md`**（**文档未提及的第三处冲突**）。
**[minor] 接手方会做出的错误动作**：文档只说「合并后必须重跑三道门禁」和「取 master 结构、重放我们的 delta」，未提示 `MEMORY.md` 也会冲突。接手方解冲突时可能因为文档只字未提这个文件而误判为「自己操作有误引入了额外冲突」，浪费时间自我怀疑；实际上这是两边都各自往 MEMORY.md 索引追加了条目导致的正常文本冲突，风险很低，按内容合并即可。**建议**：HANDOVER「必须最先做的事」小节补一句「`docs/memory/MEMORY.md` 也会冲突（双方各自新增了索引条目），按内容合并即可，不影响代码」，省得接手方多想。

**走查②：「Task 6 会撞上一处接缝，代码里已有注释标出」——注释是否真实存在？**
✅ 确认存在。`src/lib/shutdown.ts:431-436`（当前 HEAD）有明确注释：「NOTE (Task 4 / Task 6 seam): the manager method this calls was renamed `drainModelOperationFinalizations` → `drainLifecycleFailures` in Task 4 ... Task 6's responsibility ... only the call target is updated so `bun run typecheck` passes for Task 4.」与 HANDOVER 待办 3 的描述完全吻合，且该注释在 merge-tree 试合并中确实保留在冲突块上方（未被冲突标记吞掉），接手方合并后仍能看到它。

---

## 总体结论

评审范围：`HANDOVER.md` + `KICKOFF.md`，当前 HEAD `96fe5282`。核验环境：worktree 内实测 git 历史、`bun test` 门禁复现、`git merge-tree` 试合并。

**verdict：修复 major 后可进入下一阶段**——本轮我提出的两条 major（净减行数 258→199、Task 4 门禁数字 26/62 陈旧）均已在 `7889c5de`/`96fe5282` 修复，且协调方对第二条给出的「陈旧数非错数」归因经核实成立，已采纳。剩余只有 1 条 minor（MEMORY.md 合并冲突未被提及）。

**blocker 数：0**。

### 事实性发现（当前仍存在，未修复）

[minor] HANDOVER.md「必须最先做的事」小节 — 合并 master 会撞 3 处冲突而非文档暗示的 2 处（`src/lib/context/manager.ts`、`src/lib/shutdown.ts`、**`docs/memory/MEMORY.md`**，后者文档未提及）— 证据：`git merge-tree --write-tree HEAD master` 实测输出 — 接手方会因文档未提示而对这处冲突产生不必要的自我怀疑 — 建议补一句说明该文件冲突是双方各自追加索引条目导致、按内容合并即可。

### 已修复项（存档，供追溯）

- [major，已修复于 `7889c5de`] HANDOVER.md 曾将 `src/lib/shutdown.ts` 净减行数误写为 258（正确为 199，两种独立算法互证）。
- [major，已修复于 `96fe5282`，归因已修正] HANDOVER.md 曾引用 Task 4 门禁「26 pass / 62 expect」，该数字是 `3e418cdb`（blocker 整改前）的真实读数、非跨话题串号（已用 `git diff --stat 3e418cdb a8eeaf4c` 核实 `manager-dual-registry.unit.test.ts` 在两 commit 间新增 115 行测试代码，可解释 26→30、62→74 的变化），现文档已更新为 30/74 并注明陈旧数警告。
- [已修复] KICKOFF.md 曾复述「净减 258」与 HANDOVER 的 199 矛盾，现已改为「不复述衍生数字，以 HANDOVER 的 numstat 为准」。

**可以定稿，把头部的「草稿·未评审」改掉**（在补上 MEMORY.md 冲突提示这条 minor 之后，或直接定稿、把这条 minor 记入待办皆可，不阻断定稿）。


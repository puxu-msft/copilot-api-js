# 交接刷新（commit `62ef4e61`）独立评审

**对象**：`docs/plan/2026-08-08-header-deadline-stage2-3/{HANDOVER,KICKOFF}.md` 在 `62ef4e61` 的改动。
**评审树**：`/home/xp/src/copilot-api-js/.claude/worktrees/nghttp2-header-deadline`；实际 HEAD = `4a37b914`（冻结点 `62ef4e61` 之后又有 `83696acf` / `4a37b914` 两个提交，`git log --name-only` 确认**未触及**这两份文档）。
**视角**：接手方第一人称走查 + 机械核对。**裁判轴**：长远正确 + 完整。

## H1 — 数字（按派活要求不复跑，沿用上一轮实测）

**判定：MAJOR（`0 fail` 不可复现）**

上一轮在 `62ef4e61` 上实跑 `bun run test:backend`：

```
[parallel-test] 16 shards · 6259 tests · 6258 pass · 1 fail · 7297 executed · 35 skipped · 92.63s
error: script "test:backend" exited with code 1
```

- `7297 executed / 35 skipped` 逐字复现，可信。
- `0 fail` **没有复现**：失败项 `tests/history/v3/store-performance.it.test.ts > CAS live physical bytes are at least 10x smaller than the real compressed V2 write shape`，形态是 `this test timed out after 15000ms`（实测 16760.84ms），不是断言不成立。
- 单文件复跑 `bun test tests/history/v3/store-performance.it.test.ts` → `3 pass / 0 fail`（9.33s）：16 分片并行下负载敏感的 flaky timeout，不是回归，但会让 `test:backend` 退出码为 1。

**接手方的错误动作**：KICKOFF 把 `test:backend` 定为必跑门禁，接手方见 `1 fail` 而交接写 `0 fail`，于是①误判自己引入回归、去 debug 一条与 transport 无关的 History 性能测试；或②被同段「你现在跑会得到不同的数字，那不是回归」带着，把**红**也归入「不是回归」挥手放过。

**建议**：把「数字会变」与「绿/红判定」分开写，点名这条已知 flaky 及判别方式（单文件复跑即绿）。

---

## H3 — 「`test:backend` 不读 baseline，只有 `capture-entry-evidence.ts` 的 exact multiset 门会红」

**判定：MAJOR**（后半句对、前半句**错**；错的那半句会在阶段 2 第一次跑门禁时直接坑到接手方）

### 谁读 `tests/infra/entry-test-discovery-baseline.json`（`rg -n "entry-test-discovery-baseline" tests/ scripts/`）

| 位置 | 读的是哪份 | 在 `test:backend` 里吗 |
|---|---|---|
| `scripts/capture-entry-evidence.ts:259-265` 读、`:300` 传入、`:177-197 assertSkippedMultiset` 比较 | 真实仓库文件 | 否（producer 脚本） |
| `scripts/validate-entry-evidence.ts:679,806` | `git show <entrySha>:tests/infra/...json` | 否（validator 脚本） |
| `tests/infra/entry-evidence-schema.unit.test.ts:13,17,25` | **真实仓库文件**（`REPO_ROOT` 拼路径） | **是**（`.unit.test.ts`，`test:backend` = `bun scripts/parallel-test.ts unit it http`） |
| `tests/infra/capture-entry-evidence.unit.test.ts:53,107`、`tests/infra/validate-entry-evidence.unit.test.ts:34` | `mkdtempSync` 造的临时 git fixture 树 | 是，但读的不是真 baseline |

### 逐句核

1. **「`bun run test:backend` 不读它」→ 假。** `tests/infra/entry-evidence-schema.unit.test.ts:17` 的 `parseDiscoveryBaseline(readFileSync(BASELINE_PATH, "utf8"))` 读的就是仓库真文件，而该文件是 unit 档位成员。
2. **「31 vs 35 的 `allowed_skipped` 差异不会让 `test:backend` 红」→ 真。** 该 unit 测试只断言 `expect(baseline.files).toEqual(files)`（第 25 行），**不碰 `allowed_skipped`**；exact multiset 只在 `capture-entry-evidence.ts` 的 `assertSkippedMultiset` 里比较，报错文本正是文档引用的 `skipped identity multiset mismatch`。**结论对，理由错。**
3. **代价不在措辞，在于这句话替接手方否掉了整个文件。** 该 unit 测试断言 baseline 的 `files` 数组与 `tests/**/*.{unit,it,http}.test.ts` 的实时 glob **精确相等**（`toEqual`）。阶段 2 的 T1/T2/T3 必然新增 backend 测试文件（foundation 类型、`http2-client` evidence、`classifyError` 消费），**只要新增一个文件而不同步 baseline 的 `files`，`test:backend` 就红在这条上**。
   **有本仓实例，不是推理**：`b1a0f6e6 refactor: separate header and lifecycle abort scopes` 新增了 `tests/architecture/response-header-timeout-scope.unit.test.ts` 而没动 baseline；该路径直到后面的 `a0ad0f1a fix: close repository lint gates` 才被补进 `files`（`git log -S'tests/architecture/response-header-timeout-scope.unit.test.ts' -- tests/infra/entry-test-discovery-baseline.json` 唯一命中 `a0ad0f1a`）。**阶段 1 自己踩过这个坑，且是分两次提交才补上的。**

### 接手方会因此做出什么错误动作

阶段 2 第一次 `bun run test:backend` 红在 `tests/infra/entry-evidence-schema.unit.test.ts`，而交接刚说「这个文件 `test:backend` 不读它、也不归你修」。于是他会：① 先怀疑是 peer 在飞改动或环境问题（因为交接说这文件与他无关），浪费一轮排查；或 ② 更糟——拿「不归你修」当授权，把这条红判为「与我无关的既有失败」跳过。而它守的正是「entry evidence 的发现面 == 真实测试集合」这个不变量，跳过等于让后续 entry evidence 建立在过期文件清单上。

### 修复建议

拆成两句并补正向指引：
- 「`allowed_skipped` 的 31 vs 35 **只**会让 `scripts/capture-entry-evidence.ts` 的 exact multiset 门红，不会让 `test:backend` 红。」
- 「但 baseline 的 `files` 数组由 `tests/infra/entry-evidence-schema.unit.test.ts` **在 `test:backend` 内精确校验**：阶段 2 每新增一个 `tests/**/*.{unit,it,http}.test.ts`，都要把该路径按 canonical 序补进 `files`（并按 KICKOFF 第 19 行重取 `minimum_executed`），否则 `test:backend` 会红——阶段 1 的 `b1a0f6e6`→`a0ad0f1a` 就是这么补的。」

---

## H2 — 「skipped 30→35 来自 peer 给 history-search 加的 `describe.skipIf(!NATIVE)` 测试」

**判定：归因的「性质」PASS，归因的「出处 commit」BLOCKER-adjacent MAJOR（写错了 commit，且写错的那个恰好早已在基线里）**

### 增量确实全是 native-gated，没有混进 todo / whole-suite-skip

- 运行时 35 条 skip 全部 `"kind": "testcase"`（`grep -o '"kind": "[^"]*"' /tmp/parallel-test-*/skipped-multiset.json | sort | uniq -c` → `35 testcase`，0 条 suite）。
- baseline 31 条的 reason 分布：`23 native-unavailable / 7 whole-suite-skip / 1 todo`——**存量里确实混着 todo 与 whole-suite-skip**，但它们不在增量里（见下）。
- 逐名 diff（baseline 名字集合 vs 运行时名字集合）只多出 4 条，全在 `tests/history/search/daemon.it.test.ts`：
  `evaluates filters over fields absent from every document in the segment` / `pairs each batched-resolved operation id with its own document` / `returns only the surviving version of a re-indexed operation, across segment boundaries` / `selects the same set whether a filter is answered by the index or per document`。
  它们的 classname 是 `history-search native list-search`，对应 `tests/history/search/daemon.it.test.ts:160` 的 `describe.skipIf(!NATIVE)`；`NATIVE = isNativeHistorySearchAvailable()`（同文件 `:110`）。**确为 native-gated。**
- 30→35 的完整分解（`git show bea1dfa3:tests/infra/entry-test-discovery-baseline.json` 计 30 条 identity，当前文件 31 条，运行时 35 条）：
  - **+1**：peer `7a99a254 fix(history-search): bind the tail cursor to its index generation` 新增的 `describe.skipIf(!NATIVE)`（`daemon.it.test.ts:489`），已由**本分支**的 `7af27044` 精确补进 baseline；
  - **+4**：peer `d38fcb9c test(history-search): cover the new list-search read path`（commit message 自述 "Adds four native list-search cases"），**尚未登记**。

### 出处 commit 写错了

文档（HANDOVER 新段第 2 条）写「差的 4 条来自 peer 的 `08046d5c`（strict persisted list search）尚未登记」。实测：

```
git merge-base --is-ancestor 08046d5c bea1dfa3  → 0   # 08046d5c 早就是阶段 1 基线的祖先
git merge-base --is-ancestor d38fcb9c bea1dfa3  → 1   # d38fcb9c 不在阶段 1 基线里
git merge-base --is-ancestor d38fcb9c HEAD      → 0   # 但在当前树里
```

`08046d5c`（2026-08-06 19:56，feature 提交）**在 `bea1dfa3` 之前就已合入**，它引入的 skip 早已含在「30」里，**结构上不可能是 30→35 的来源**。真正的来源是 `d38fcb9c`（2026-08-08 21:20，纯测试提交）。

### 接手方会因此做出什么错误动作

文档紧接着给了动作指令：「若你要跑 entry evidence producer 而它报 `skipped identity multiset mismatch`，先去看那 4 条是否已被 peer 补上。」接手方按 `08046d5c` 去查，会看到那是一个两天前就已合入 master 的 feature 提交、且 baseline 里与它相关的 identity 早已登记齐全，于是得出「peer 已经补过了、我这边的 mismatch 一定是别的原因」——转而去怀疑 runner blob、glob 顺序或自己的改动，而真正该看的 `d38fcb9c` 从未进入视野。**归因错比不写更坏**，这里正是那个形态。

### 修复建议

把 `08046d5c` 改成 `d38fcb9c`，并把 30→35 拆成「+1 已由本分支 `7af27044` 登记 / +4 来自 `d38fcb9c` 未登记」；顺带写明补法就是 `7af27044` 的做法（按 canonical 序精确插入 identity，`reason=native-unavailable`，不改成数量比较、不硬编码总数）。

---

## H4 — 分支状态段

**判定：BLOCKER**

原文：「该分支的全部提交已是 `master` 祖先（判据：`git merge-base --is-ancestor worktree-nghttp2-header-deadline master` 退出 0）。**用户已裁决：分支删除、worktree 目录保留**；删除在最后一次 fast-forward 之后执行，本行写作时尚未执行——以 `git branch --list ...` 的实际输出为准。无论删与不删，阶段 1 的历史都完整在 `master` 上，不依赖该分支引用。」

### 做对的部分

「尚未执行 + 以 `git branch --list` 实际输出为准」**确实避免了把未发生的动作写成完成时**，这一点 PASS；判据本身也可执行、可判定。

### 三条实测反证

```
git merge-base --is-ancestor worktree-nghttp2-header-deadline master → 1   （文档说「退出 0」）
git rev-list --count master..worktree-nghttp2-header-deadline        → 5
git show master:docs/plan/2026-08-08-header-deadline-stage2-3/HANDOVER.md | grep -c 收尾时刷新 → 0
```

1. **文档给出的判据当场为假。** 它自称「退出 0」，实测退出 **1**。而且这不是「后来又漂了」——**写下这句话的那个提交 `62ef4e61` 本身就是分支上未进 master 的提交**，落笔即自我证伪（评审时已累积到 5 个）。
2. **`master` 上的 HANDOVER 根本没有这次刷新。** master 版本 72 行，`收尾时刷新` 与 `收尾后的分支状态` 均 0 命中。撞项目纪律 `docs-merge-before-execute`（定稿文档先合主线）。
3. **「无论删与不删，历史都完整在 master 上」只对阶段 1 的代码成立，对本次交接刷新不成立。** `git merge-base --is-ancestor bea1dfa3 master → 0`（阶段 1 代码确在 master），但未进 master 的 5 个提交是纯 docs 提交，**其中就包括本次被评审的 HANDOVER/KICKOFF 刷新本身**。
4. **删除动作在物理上还过不去。** 该分支正被本 worktree 检出，而裁决要求「worktree 目录保留」。`/tmp` 一次性仓库实测：对被另一 worktree 检出的分支执行 `git branch -d feat` → `error: cannot delete branch 'feat' used by worktree at '/tmp/wt-del-probe/wt'`，退出 1。即便先摘掉 worktree，`-d` 也会因为这 5 个提交未合并而再拒一次——只有 `-D`（本仓 git 护栏还会再拦一道）才删得掉，而那正是把这份交接刷新变成 reflog-only 孤立提交的操作。

### 接手方（以及执行删除的人）会因此做出什么错误动作

- **主路径**：接手方按 KICKOFF「开新隔离 worktree」从 `master` 起树，读到的 HANDOVER 是**没有刷新段的 72 行旧版**——上面写着 `7279 executed / 30 skipped / 0 fail`。他跑出 `7297 / 35`（且可能带 1 条 flaky 红），于是发生的正是这次刷新想防止的那件事：**误判回归**。刷新写了，但送不到读者手里。
- **删除路径**：执行删除的人相信「全部提交已是 master 祖先、删了无损」，`-d` 被拒后自然升级到 `GIT_DISCIPLINE_OK=1 git branch -D`（护栏提示词就是这么引导的），于是把这 5 个 docs 提交打成孤立提交。

### 修复建议（有先后）

1. **先把这 5 个 docs 提交 fast-forward 进 `master`**，再谈删除；`master` 上的 HANDOVER/KICKOFF 必须含刷新段。
2. 把「已是祖先」从**断言**改成**待验判据**：写成「删除前须先跑 `git merge-base --is-ancestor <branch> master`，退出 0 才可删；当前退出 1，尚有 N 个未合并的 docs 提交」，并给出重取命令而非快照结论。
3. 写明删除的物理前提：该分支被 worktree 检出时 `git branch -d` 必失败；「保留 worktree」与「删除分支」二者需要先把 worktree 切到 detached HEAD 才能同时成立——这一步没写，就等于把一个做不到的裁决交给下一个人。

---

## H5 — HANDOVER ↔ KICKOFF 一致性

**判定：数字一致 PASS；两处 MINOR（口径摩擦 + 文档自带命令在接手方环境里跑不通）**

### 同步与权威（PASS）

逐项比对 KICKOFF 新增段（`KICKOFF.md:34`）与 HANDOVER 新增段（`HANDOVER.md:15-19`）：`master` = `5720855929`、`7297 executed / 35 skipped / 0 fail`、`skipped 30→35 = native-gated`、`allowed_skipped 31 vs 实测 35`、「只影响 `capture-entry-evidence.ts` 的 exact multiset 门」——**五项逐字一致，无数字或结论分岔**。KICKOFF 两处指回 HANDOVER（`:3` 权威声明、`:34` 段尾「完整说明见 HANDOVER.md」），权威单一，PASS。

附带一个好结果：H2 里那条错误的 `08046d5c` 归因**只出现在 HANDOVER**，没有复述进 KICKOFF——但这也意味着 KICKOFF 的读者拿不到任何排查指针，修 HANDOVER 时不要顺手把错的那个 commit 复制过去。

### MINOR-1：`minimum_executed` 与「不归你修」互相拉扯

`KICKOFF.md:19` 要求「**合并主线后必须重跑 `bun run test:backend` 重取 `minimum_executed`**」——`minimum_executed` 正是 `tests/infra/entry-test-discovery-baseline.json` 的字段（当前值 `7279`）。而新增段说同一个文件「不归你修」「`test:backend` 不读它」。两句都不算错（`minimum_executed` ≠ `allowed_skipped`），但**放在同一份交接里，接手方要么以为 `:19` 已作废、要么只改 `minimum_executed` 而留下 `allowed_skipped` 与 `files` 陈旧**，producer 门照旧红。建议在新增段里按字段分工写清：`files` 与 `minimum_executed` 归你维护（前者还被 `test:backend` 校验，见 H3），`allowed_skipped` 的那 4 条不归你。

### MINOR-2：文档给的复现命令，在它自己规定的工作方式下会被拒

`HANDOVER.md:5` 的复现命令 `git -C /home/xp/src/copilot-api-js rev-parse refs/heads/master`、`:11` 的 `git -C /home/xp/src/copilot-api-js status --short`，配合 `KICKOFF.md:15`「开新隔离 worktree」。**本轮实测**：从隔离 worktree 会话里发这种 `git -C <共享主树>` 命令，会被护栏直接拒绝——

> This session is isolated in the worktree ...，but this command redirects git to the shared checkout via `-C`. Refusing to run it

接手方按 KICKOFF 开隔离树后，交接里这两条「自己去重取」的命令**一条都跑不通**。等价可跑的写法是在自己的 worktree 里 `git rev-parse refs/heads/master`（worktree 共享 refs，实测同值）。另外 `HANDOVER.md:5` 仍写着 `master = d1011fe7`，与新增段的 `5720855929` 同处一个状态块——虽有「收尾时刷新」的时序标签兜住，但先读到的是旧值加一条权威模样的复现命令。

**接手方会因此做出什么错误动作**：命令被拒后，他要么以为「环境坏了/我目录不对」（正是 HANDOVER「我犯过的错」第 4 条记的那个误判形态），要么直接沿用文档里的快照值 `d1011fe7` 不再重取——而那正是 `anchor-numbers-to-commits` 要求的反面。

---

## H6 — 反向检查：该写而没写的当前态变化

**判定：`session-closeout` 退役一项 PASS（无需写）；另有两项 MAJOR / MINOR 该写没写**

### 6a. `session-closeout` skill 退役（`e7a9cadb`）—— PASS，不必写进交接

- `git merge-base --is-ancestor e7a9cadb HEAD → 0`，退役已在本树生效；`ls .claude/skills/` 里已无 `session-closeout`。
- `rg -n "session-closeout" docs/plan/2026-08-08-header-deadline-stage2-3/` **唯一命中是 HANDOVER:11 里一个 peer 未提交文件的文件名**（`docs/plan/2026-07-28-session-closeout-skill-review-claude.md`），不是对 skill 的引用。
- 两份交接**从未指向该 skill**，因此不存在断链；接手方的收尾路由由 CLAUDE.md 第 56 条负责，而 `e7a9cadb` 已同步重写该条（指向 user-level `closing-a-development-session` / `writing-handover-docs`）。按 `one-authority-allows-contextual-restatement`，权威已更新且交接无陈旧复述 → **不需要**在交接里另写一份。写了反而制造第二个入口。
- 附带**不可核验**一项：HANDOVER:11 列的共享主树未提交 WIP 是否仍然成立，我无法核（隔离会话对共享树的 `git -C` 被护栏拒绝，见 H5 MINOR-2）。文档已写「接手时自行重取」，方向对，但重取命令本身跑不通。

### 6b. **MAJOR — 没写：本任务自己动过那个 baseline（`7af27044`）**

新增段说 baseline 的缺口「**这不是本任务引入的，也不归你修**」。但本分支的 `7af27044 test: 把合法 native-gated skip 补进 entry discovery allowlist` **正是往 `allowed_skipped` 里补了一条 identity**（`daemon.it.test.ts` 的 cursor-generation 用例，`reason=native-unavailable`），31 这个数就是这么来的。交接把这段历史抹平成「与我无关」，代价是：

- 接手方不知道**同一道门在本轮已经 false-red 过一次**，也拿不到已经被独立评审裁定过的**正确补法**（按 canonical 序精确插入 identity，不改成数量比较、不硬编码总数）；
- 于是他遇到同类 mismatch 时更可能选择「把门放宽」或「跳过」，而不是照 `7af27044` 再补一条——这正是 `red-tests-may-be-guarding-something` 与 `no-self-adjudicated-gate-weakening` 要防的动作。

**建议**：新增段补一句「本分支 `7af27044` 已按此法补过 1 条；剩余 4 条同法可补，但属 peer 在飞工作，本轮未代改」。

### 6c. **MINOR — 没写：「只有 exact multiset 门会红」是有前提的全称句**

`capture-entry-evidence.ts:264-265` 在到达 multiset 门**之前**还有一道 `fail(4, "discovery baseline differs from entry tree")`，条件是 `baseline.runner_git_blob !== runnerBlob` 或 `files` 集合不等。当前树两者都成立（baseline `runner_git_blob = 66d215f2...`，`git rev-parse HEAD:scripts/parallel-test.ts = 66d215f2...`，一致），所以**今天**文档那句是对的。但 `7af27044` 的提交信息自己就记着：peer 分支 `command-algebra-entry-gate-fix` 已把 runner 改成 `9998d99d`，一旦它合入 master，producer 会**先**在 `fail(4)` 挂掉、根本走不到 multiset 门。

**接手方会因此做出什么错误动作**：producer 报的是 `discovery baseline differs from entry tree` 而不是文档预告的 `skipped identity multiset mismatch`，接手方会以为撞上了文档没覆盖的新问题，去查自己的测试文件清单；真正的原因是 runner blob pin 过期，且**同样不归他修**。建议把那句从「只有 X 会红」改成「按顺序会先撞 `fail(4)`（runner blob / files 不符），再撞 multiset 门；两者都不归你修」。

---

## 总判定

**存在 blocker（1 条：H4 —— 判据当场为假 + 刷新未落 `master`，接手方读不到这次刷新）**；另有 MAJOR 3 条（H1 `0 fail` 不可复现、H3「`test:backend` 不读它」为假、H2 归因 commit 写错）、MINOR 3 条（H5×2、H6c）、PASS 2 条（H5 数字同步、H6a）。**修完 H4 与三条 MAJOR 后可交付**；其中 H4 的第 1 步（把 5 个 docs 提交 fast-forward 进 `master`）是其余修订能生效的前提。

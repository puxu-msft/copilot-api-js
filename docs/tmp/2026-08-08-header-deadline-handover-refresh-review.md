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

---

# 复评（第二轮）

**整改提交**：`a419c17f` + `5c350e59`。**冻结 HEAD 实测** `git rev-parse HEAD` = `5c350e59`（与派活一致）。
**方法**：只对整改后的正文做接手方第一人称走查 + 机械核对；不复跑 `test:backend`。

## R-A — 整改**新引入**的两处事实错误（重点证伪 1）

**判定：MINOR ×2（都是可执行指令层面的错，不是措辞）**

### R-A1 — flaky 测试的路径写错了

新增文本：「独立评审两次实测都有 `tests/history/store-performance.it.test.ts` …撞 15s timeout…**撞到时先单跑该文件**判别是真回归还是机器负载」。

```
$ ls tests/history/store-performance.it.test.ts
ls: cannot access 'tests/history/store-performance.it.test.ts': No such file or directory
$ ls tests/history/v3/store-performance.it.test.ts
tests/history/v3/store-performance.it.test.ts
```

**漏了 `v3/` 一层。** 我上一轮报告里写的是带 `v3/` 的全路径，整改时被截短了。

**接手方会因此做出什么错误动作**：他照文档跑 `bun test tests/history/store-performance.it.test.ts`，bun 会因为找不到匹配文件而**不报错地跑出 0 个测试**（或报 no test files），他据此得到「单跑是绿的」——而实际上他根本没跑到那个文件。文档给的正是**判别真回归 vs 负载**的那一步，这一步空转会让他把一次真回归误判成 flaky。**这是本轮唯一一处「判据看似执行了、其实没触达目标」的形态**，因此虽然只错一个路径段，危害高于普通笔误。修法：补成 `tests/history/v3/store-performance.it.test.ts`。

### R-A2 — `entry-evidence-schema.unit.test.ts:13,19` 的 `19` 指错了行

实测该文件（`sed -n '10,26p'`）：`:13` = `BASELINE_PATH` 常量（对）；**`readFileSync` 在 `:17`**（`const baseline = parseDiscoveryBaseline(readFileSync(BASELINE_PATH, "utf8"))`）；`:19` 是 `for (const suffix of [...])`，与 `readFileSync` 无关；`:25` = `expect(baseline.files).toEqual(files)`（对）。

即文档写「`:13,19` 用 `readFileSync` 读的就是真实文件」，其中 `19` 应为 `17`。属 `file:line` 漂移类，**接手方打开 `:19` 看到 glob 循环、会怀疑整段结论**（因为这段正是上一轮被证伪过一次的地方，可信度本就在被重新建立中）。

### R-A3（反向核，PASS）

新增的「exact multiset 比对只在 `scripts/capture-entry-evidence.ts` / `scripts/validate-entry-evidence.ts`」**经核成立且比我上一轮的说法更准**：`validate-entry-evidence.ts:748` 取 `baseline.allowed_skipped`、`:755` 与运行时 identities 做 multiset 比较、`:759` `fail(8, "skipped identity multiset mismatch")`。我上一轮只点了 `capture`，整改方补全了 `validate` 这一侧——采纳。
`capture-entry-evidence.ts:265` 的 `fail(4)` 排在 multiset 门之前，也经核属实（该行即 `runner_git_blob !== runnerBlob || !compareSets(baseline.files, discover(tree))` 的判断）。

## R-B — H2 新归因是否准确（重点证伪 2，identity 级复核）

**判定：PASS（`d38fcb9c` +4 与 `7a99a254` +1 均在 identity 级坐实）**

我没有只看「它改了那个文件」，而是对**每一条 identity 名**做了「父提交无、本提交有」的双向核：

```
git grep -c "pairs each batched-resolved operation id with its own document"        d38fcb9c^ -- tests/history/search/daemon.it.test.ts → 无命中(rc=1)
git grep -c "pairs each batched-resolved operation id with its own document"        d38fcb9c  -- 同上 → 1
git grep -c "evaluates filters over fields absent from every document in the segment" d38fcb9c^ → 无命中 ; d38fcb9c → 1
git grep -c "returns only the surviving version of a re-indexed operation"           d38fcb9c^ → 无命中 ; d38fcb9c → 1
git grep -c "selects the same set whether a filter is answered by the index or per document" d38fcb9c^ → 无命中 ; d38fcb9c → 1
```

四条**全部**是 `d38fcb9c` 引入的，与我上一轮从运行时 `skipped-multiset.json` 与 baseline 做名字集合 diff 得到的「多出 4 条」**逐条同名**——两种不同原理的方法（运行时产物集合 diff / git 历史 identity 溯源）交叉一致。

+1 一侧同样成立：`git grep -c "a cursor that outlived its index cannot certify the rebuilt one" 7a99a254^ -- <file>` 无命中、`7a99a254` 命中 1；该 identity 现已在 baseline 里（由本分支 `7af27044` 补入）。而那 4 条至今**不在** baseline：`git grep -c "pairs each batched-resolved operation id with its own document" HEAD -- tests/infra/entry-test-discovery-baseline.json` 无命中（rc=1）。

**归因描述的准确性**：文档写「`d38fcb9c`（+4，给 `tests/history/search/daemon.it.test.ts` 加了 191 行）」——`git show --stat d38fcb9c` 确为该文件 `191 +++...`，数字对。**错因自述也对**：`git log -S '<字符串>'` 找的是该字符串**出现次数发生变化**的提交，用它定位「谁新增了这些测试」在字符串早已存在（如 describe 名被复用）时会指向错误提交——这条自述值得保留，它是可复用的方法论。

**唯一保留意见（不构成发现）**：文档把 5 条增量分成「4 条不归你修 / 1 条已登记」，但没写**补法**。上一轮我建议过写明 `7af27044` 的做法（按 canonical 序精确插入 identity、`reason=native-unavailable`、不改成数量比较、不硬编码总数）。整改未采纳也未记录不采纳理由；接手方真要补那 4 条时会重新发明一遍补法，且很可能选「放宽成数量比较」这条更省事的错路。建议补一句指向 `7af27044`。

## R-C — H3 的推论是否过强（重点证伪 3）

**判定：PASS（文档正文的限定是准确的）+ 一条完整性 nit**

派活消息里把它转述成「**新增／改名任何测试文件**都会红」——那个说法**确实过强**。但文档正文写的是限定形式：「你只要新增／改名任何一个 `tests/**/*.{unit,it,http}.test.ts`，`test:backend` 就会红在这条」。逐项核这个限定：

| 我试图构造的例外 | 结论 |
|---|---|
| 新增 `tests/` **之外**的测试（`packages/*/`、`ui-v4/`、`src/` 旁） | 不会红。glob 的 `cwd` 固定为 `path.join(REPO_ROOT, "tests")`（`entry-evidence-schema.unit.test.ts:20`），**已被文档的 `tests/**` 限定排除** |
| 新增 `.pty.test.ts` / `.e2e.test.ts` | 不会红。suffix 只枚举 `["unit", "it", "http"]`（`:19`），**已被文档的 `{unit,it,http}` 限定排除** |
| 新增 `tests/` **根目录**下的文件（`**/` 是否要求至少一层子目录） | **会红，无例外**。实测 baseline 里就有 `tests/gemini-stream-cache-write.unit.test.ts`、`tests/ghc-usage.unit.test.ts` 等根级条目（`grep -o '"tests/[^/"]*\.test\.ts"'`），说明 `**/*` 匹配零层深度 |
| 该守卫本身是否可能被 skip 掉（那样就不会红） | 否。`describe("entry evidence discovery baseline v1")` 无 `skipIf`，不依赖 native 产物 |

即：**在文档写下的限定范围内，我构造不出例外**。推论不过强。

**nit（完整性，非错误）**：判据是集合**相等**（`expect(baseline.files).toEqual(files)`，`:25`），所以**删除**一个 backend 测试文件同样会红，而文档只写了「新增／改名」。阶段 2 若把某个 `.it` 测试合并进别的文件或删掉旧夹具，会撞上同一条而文档没有预告。建议改成「新增／改名／删除」。

## R-D — H4 新写法在「未 ff」状态下是否误导（重点证伪 1）

**判定：结构 PASS，一处 MINOR（数字 `5` 已漂到 `7`）；blocker 本身仍未闭合——但那是待用户执行，不是文档缺陷**

### 先复核当前实测（不是判断 ff 做没做，而是判断新写法在这个状态下读起来对不对）

```
git merge-base --is-ancestor worktree-nghttp2-header-deadline master → 1
git rev-list --count master..worktree-nghttp2-header-deadline        → 7
git diff --name-only master...worktree-nghttp2-header-deadline | grep -v '^docs/' → 无输出（全部改动都在 docs/ 下）
```

### 逐条证伪「有没有让读者以为删除已执行 / 以为可以跳过 ff」

| 我试图找的误读 | 新文本是否给了空子 | 依据 |
|---|---|---|
| 以为删除已执行 | **否** | 三步写成祈使式「① 先…② 确认…③ 再删」，全段无一处完成时；末句显式「**不要相信本行的时态**」，并把判官交给 `git branch --list` 与 `merge-base` 两条可跑命令 |
| 以为可以跳过 ff 直接删 | **否** | 「**顺序不能颠倒**」+ 给出跳过的后果（`-d` 会拒、`-D` 会孤立提交），是**后果**而非**禁令**，比禁令更难绕过 |
| 以为 `-d` 失败就该上 `-D` | **否** | 明写 `-D` 的代价是孤立那些提交，且另给了检出态删不掉的物理前提与两条出路（`git checkout --detach` 或移除 worktree） |
| 以为 ff 已经发生（因为写的是「**写作时**并不在 master 上」） | **弱空子，但被兜住** | 「写作时」这个时间限定单独看确实容许「现在也许已经合了」的推测，但紧接着的「正确顺序 ① 先 ff」把 ff 明确列为**尚待执行的第一步**，且末句要求以实测判据为准。**不构成误导** |

结论：**新写法在未 ff 的状态下也不误导**，重点证伪 1 的问题回答为「否」。

### MINOR — 「5 条」已漂成 7 条

文本两处写「有 **5** 条」「`-D` 会把这 **5** 条 docs 提交打成孤立提交」，实测现为 **7** 条（本轮又叠了 `ffc0c824`/`a419c17f`/`5c350e59` 等）。这是典型的**易变数字未锚定**：段首把它写成「实测判据」的一部分，读者会当作现值。**接手方/执行者的错误动作**：ff 前照文本核对，看到 7 条而文档说 5 条，无法判断多出来的两条是不是别人塞进来的、要不要一起合——在一个刚刚因为「假断言」被返工过的段落里，这种对不上会直接摧毁对整段的信任。
修法（沿用本仓 `anchor-numbers-to-commits`）：把裸值换成命令，例如「未合入提交数以 `git rev-list --count master..worktree-nghttp2-header-deadline` 为准（写作时为 5，只增不减，全部在 `docs/` 下）」。附带一个好消息可以写进去：`git diff --name-only master...<branch> | grep -v '^docs/'` 无输出，**这些提交至今仍是纯 docs**，孤立它们不会丢代码——这条比数字稳定得多。

### blocker 状态

`master` 上的 HANDOVER 仍无刷新段（上一轮 `git show master:<file> | grep -c 收尾时刷新` = 0，本轮 `is-ancestor` 仍为 1，未 ff 故不可能改变）。**文档侧已修完，剩下的是主树的 ff 动作，需用户执行**——按派活约定我不做 merge。因此 blocker 记为「文档修复已到位、待 ff 后自动闭合」，不再计为文档缺陷。

## R-E — HANDOVER ↔ KICKOFF 是否仍逐项同步（重点证伪 4）

**判定：MAJOR ×1（KICKOFF 的限定被削掉，且照它做会主动制造红）+ 其余同步 PASS**

### 同步的部分（PASS）

`master = 5720855929`、`7297 executed / 35 skipped`、`5 条增量全是 skipIf(!NATIVE)`、`+4 来自 d38fcb9c / +1 来自 7a99a254 已登记`、`allowed_skipped 31 vs 35 不归你修`、`exact multiset 在 capture/validate-entry-evidence`、`0 fail 不稳定` —— **七项逐字一致**，KICKOFF 两处仍指回 HANDOVER 为权威。上一轮 MINOR-2（`git -C <主树>` 被护栏拒）已在 HANDOVER 加警告；MINOR「`minimum_executed` 是地板非等式」已在 HANDOVER 写明（当前 7279、实测 7297 满足），与 `KICKOFF:19`「合并主线后重取 `minimum_executed`」不再打架（地板只升不降，重取是合理动作）。

顺带核实一条我上一轮没查的新增断言——HANDOVER 说该守卫还校验「canonical 形态（键序、字节序排序、唯一性，含 `allowed_skipped` 自身结构）」，**属实**：`scripts/entry-evidence-schema.ts:99` 查顶层键序、`:106` `files are not unique bytewise sorted`、`:111` `allowed_skipped are not unique bytewise sorted`、`:119` 原始字节 canonical 比较，而这些都由 `entry-evidence-schema.unit.test.ts:17` 作用在**真实 baseline** 上。

### MAJOR — KICKOFF 把 HANDOVER 的限定削没了，而这条削减会**反向**制造红

- HANDOVER（正确）：「你只要新增／改名任何一个 **`tests/**/*.{unit,it,http}.test.ts`**，`test:backend` 就会红在这条」。
- KICKOFF（削减后）：「**你新增或改名任何测试文件，都必须同步更新该 `files`**，否则 backend 直接红，这归你」。

KICKOFF 版本丢掉了**两条**限定：目录必须在 `tests/` 下（glob 的 `cwd` 固定为 `REPO_ROOT/tests`），后缀必须是 `{unit,it,http}`（`entry-evidence-schema.unit.test.ts:19` 只枚举这三个）。

**接手方会因此做出什么错误动作**：阶段 3 之类工作里他新增一个 `tests/**/*.e2e.test.ts`，或在 `packages/foundation/` 旁边加测试，照 KICKOFF 的字面「任何测试文件都必须同步更新 `files`」把该路径**加进 baseline 的 `files`**——于是 `baseline.files` 多出一个 glob 里根本不存在的条目，`expect(baseline.files).toEqual(files)` **当场变红**，而这条红是**他照文档做才产生的**。他手里没有别的判据可用来意识到「这类文件本来就不该进 `files`」，最可能的下一步是继续调 baseline（越调越偏），或者判定这条守卫「坏了」而绕过它。

**这不是措辞松紧问题**：同一条指令在 HANDOVER 里是安全的、在 KICKOFF 里会造成 false-red，而 KICKOFF 是"复制成新会话第一条消息"的那一份，**接手方最可能只读它**。修法：把 KICKOFF 的那句补回限定——「新增／改名／删除任何 `tests/**/*.{unit,it,http}.test.ts`」（顺带按 R-C 的 nit 加上「删除」）。

## R-F — KICKOFF 压缩后的 flaky 说明是否仍够用（重点证伪 5）

**判定：信息结构 PASS，但被 R-A1 的路径错**废掉了关键一步**（合并计为 MINOR，不重复计数）**

压缩后的一句：「**`0 fail` 不稳定**：`tests/history/store-performance.it.test.ts` 在全套件并行下会撞 15s timeout 而红、单跑即绿，撞到时先单跑判别。」

接手方第一步所需的四个要素**都在**：① 哪条测试；② 触发条件（全套件并行，非代码相关）；③ 症状（15s timeout 而红，不是断言失败）；④ **判别动作**（单跑；绿则是负载，红则是真回归）。相比 HANDOVER 版只少了「别当成你的改动引入」这句安抚，不影响动作，压缩是称职的。

**但第 ④ 步——整段唯一的可执行动作——因为路径少了 `v3/` 而落空**（见 R-A1）。压缩本身没问题，问题是压缩时把路径也一起截短了。KICKOFF 与 HANDOVER **两份都错同一处**，所以交叉比对发现不了，只有实地 `ls` 才撞得到。

补充一条**可选增强**（不算发现）：两份都没写「单跑也红时该怎么办」。按项目 `empirical-verification` 的取证顺序，建议加半句「单跑仍红 = 真回归，按 `root-cause-over-patch` 查，别改测试超时阈值」——因为 15s timeout 最诱人的"修法"恰恰是调大 `setDefaultTimeout`，那会把一条真的性能回归永久掩盖掉。

---

## 复评总判定

**未发现阻断性缺陷（0 blocker）**。上轮的 1 blocker + 3 major + 3 minor **全部经复核已闭合**：H4 的假断言已删并改成「实测判据 + 先 ff 后删 + 检出态删不掉」的可执行顺序（R-D 证伪未通过 = 新写法在未 ff 状态下**不**误导）；H2 归因经 identity 级双向溯源坐实（R-B）；H3 后果已补且限定准确（R-C）；H1 已点名 flaky；三条 MINOR 均已落文。**blocker 的物理闭合仍待主树执行 ff**，属用户动作，不计为文档缺陷。

本轮**新增发现 1 major + 3 minor**（均为整改过程中引入或残留）：

| 编号 | 级别 | 位置 | 一句话 |
|---|---|---|---|
| R-E | **MAJOR** | `KICKOFF.md` 新增第 2 段 | 「任何测试文件都必须同步更新 `files`」丢了 `tests/**` 与 `{unit,it,http}` 两条限定；照它做会把 glob 外的路径加进 `files`，**主动制造 false-red**，而 KICKOFF 正是接手方唯一必读的那份 |
| R-A1 | MINOR | HANDOVER + KICKOFF | flaky 测试路径漏了 `v3/`（实为 `tests/history/v3/store-performance.it.test.ts`），使「先单跑判别」这一步空转，可能把真回归误判成负载 |
| R-A2 | MINOR | `HANDOVER.md` | `entry-evidence-schema.unit.test.ts:13,19` 的 `19` 应为 `17`（`readFileSync` 所在行） |
| R-D | MINOR | `HANDOVER.md` 分支状态段 | 「5 条」已漂成 7 条；建议换成 `git rev-list --count master..<branch>` 命令，并写上「至今仍是纯 docs」（实测 `git diff --name-only master...<branch>` 无 `docs/` 之外的路径）这条更稳的事实 |

另有两条**建议**（非缺陷）：R-B 建议补一句指向 `7af27044` 的补法，避免接手方把那 4 条用「放宽成数量比较」补掉；R-C 建议把「新增／改名」写全为「新增／改名／删除」（判据是集合相等）。

**结论：修复 R-E 后可交付**；R-A1 建议一并修（它废掉的是唯一一条判别动作）。

---

# 复评（第三轮）

**整改提交** `9c1f44b4`；`git rev-parse HEAD` 实测 = `9c1f44b4`（与派活一致）。不复跑 `test:backend`。

## R3-A — 补回的限定是否准确且不过窄（问题 1）

**判定：PASS，未发现反方向的 false-red**

新文本（两份同义）：「glob 只覆盖 `tests/` 目录下这三个后缀；`.pty` / `.e2e` 与 `tests/` 之外的路径**不在其中，误加进去会让 `toEqual` 当场红**」。逐项对源码核：

- **目录**：`tests/infra/entry-evidence-schema.unit.test.ts:20` 的 `scanSync({ cwd: path.join(REPO_ROOT, "tests"), onlyFiles: true })` —— cwd 固定在 `tests/`，限定准确。
- **后缀**：同文件 `:19` 的 `for (const suffix of ["unit", "it", "http"])` —— 三个，限定准确。
- **是否过窄（会不会把本该入 `files` 的合法路径排除掉）**：我从两个方向找例外：
  - **深度**：`**/*` 是否要求至少一层子目录？否——baseline 里就有 `tests/gemini-stream-cache-write.unit.test.ts` 等根级条目（上一轮实测），根级文件**在**范围内，而新文本写的是「`tests/` 目录下」，涵盖根级，不过窄。
  - **扩展名**：glob 模式是 `**/*.${suffix}.test.ts`，只认 `.ts`。若仓库里存在 `.tsx`/`.mts` 的 backend 测试，「三个后缀」的说法就会漏掉它们。**实测不存在**：`fd -e tsx -e mts -e cts . tests/` 与 `fd 'test\.(tsx|mts|js)$' tests/` **均无输出**。故当前不过窄。
- **反方向危害的表述准确性**：「误加进去会让 `toEqual` 当场红」成立——判据是集合**相等**（`:25`），多一条与少一条同样红。这正是我上一轮指出的那个反向 false-red，已被正面写出。

## R3-B — 引用审计：路径 / 行号 / 命令（问题 4，重点扫「两份同错」）

**判定：PASS（本轮未再发现同错一处的引用）**

方法：不做交叉比对（那正是上轮漏掉 `v3/` 的原因），而是把两份文档里所有仓库路径**机械抽出后逐个 `ls`**。

`rg -oN '\`[^\`]*\`' <两份文档> | grep -oE '(tests|scripts|src|packages|docs|exp)/[A-Za-z0-9_./*-]+' | sort -u` 抽出 19 个候选，逐个存在性核验：

- **全部存在**：`docs/{DESIGN.md,todo/deferred-backlog.md,spec/2026-08-06-...md,plan/2026-08-06-...md,decisions/2026-07-11-block-level-buffered-retry.md,plan/2026-08-06-nghttp2-cancel-series/HANDOVER.md}`、`packages/foundation`、`scripts/{capture,validate}-entry-evidence.ts`、`tests/architecture/{package-boundaries,response-header-timeout-scope}.unit.test.ts`、`tests/history/search/daemon.it.test.ts`、**`tests/history/v3/store-performance.it.test.ts`（上轮缺陷已修，两份都带 `v3/`）**、`tests/infra/{entry-evidence-schema.unit.test.ts,entry-test-discovery-baseline.json}`、`tests/transport/{http-transport.it,http2-client.it,upstream-fetch.unit}.test.ts`。
- Markdown 相对链接目标（`../../spec/…`、`../…`、`../../DESIGN.md`、`../../decisions/…`、`../2026-08-06-nghttp2-cancel-series/HANDOVER.md`）从 `docs/plan/2026-08-08-header-deadline-stage2-3/` 解析后**均落在已存在的文件上**。
- **行号逐条复验**（按最终文件重新打开，不按上一轮记忆）：
  - `entry-evidence-schema.unit.test.ts:13` = `BASELINE_PATH` 常量 ✓；**`:17` = `readFileSync`** ✓（上轮的 `19` 已改对）；`:25` = `expect(baseline.files).toEqual(files)` ✓。
  - `capture-entry-evidence.ts:265` = `if (baseline.runner_git_blob !== runnerBlob || !compareSets(...)) fail(4, "discovery baseline differs from entry tree")` ✓，确在 multiset 门之前。
- **命令可执行性**：`bun test tests/history/v3/store-performance.it.test.ts` 的目标文件存在（上一轮我实跑过该文件，`3 pass / 0 fail`）。`git merge-base --is-ancestor …`、`git rev-list --count master..…`、`git diff --name-only master...…`、`git branch --list …` 四条本轮均由我实际执行过，在**隔离 worktree 会话内可跑**（不带 `-C`，不触发护栏）。

## R3-C — 两份是否仍逐项同步（问题 2）

**判定：PASS（本轮改动的同一批句子两边等价）+ 一条**两边同缺**的遗漏**

逐句比对本轮改动的三处：

| 内容 | HANDOVER | KICKOFF | 一致 |
|---|---|---|---|
| flaky 路径与判别命令 | `tests/history/v3/store-performance.it.test.ts` + `bun test <同路径>` | 同 | ✓ |
| 守卫行号 | `:13,17` 读文件、`:25` 精确 `toEqual` | `:17` 读真实文件、`:25` 精确 `toEqual` | ✓（KICKOFF 省掉 `:13` 常量行，不影响动作） |
| 限定 | 「glob 只覆盖 `tests/` 目录下这三个后缀；`.pty`/`.e2e` 与 `tests/` 之外**不在其中，误加进去会让 `toEqual` 当场红**」 | 「只有这三个后缀、且在 `tests/` 目录下的文件在该 glob 内；`.pty`/`.e2e` 与 `tests/` 之外**不在其中，加进去反而会让 `toEqual` 当场红**」 | ✓ 语义等价 |

**MINOR — 两边都仍写「新增或改名」，漏了「删除」**：判据是集合**相等**（`entry-evidence-schema.unit.test.ts:25` 的 `toEqual`），所以**删除**一个 backend 测试文件同样会红（`baseline.files` 变成真集合的超集）。这是我上一轮以 nit 提出、本轮**未采纳也未按 `record-not-adopted` 记录理由**的一条。阶段 2/3 完全可能把某个 `.it` 夹具合并或删除（T4 就涉及重组 settlement 路径的测试）——**接手方的错误动作**：删掉一个旧测试文件后 `test:backend` 红在这条，而文档只预告了「新增／改名」两种触发，他会误以为撞上了文档没覆盖的新问题。修法：把两处的「新增／改名」写成「新增／改名／删除」。

## R3-D — 换成命令后是否还有残留的字面易腐值（问题 3）

**判定：MINOR ×2**

分支状态段本身已彻底命令化（`merge-base --is-ancestor` / `rev-list --count` / `diff --name-only` / `branch --list`），并补了那条不随提交数变化的稳定事实——**这一段我找不到残留易腐值**，改得干净。但同一状态块的**邻近**位置还留着两处：

1. **`allowed_skipped` 目前是 31 条而实测 35 条**（HANDOVER 与 KICKOFF 两份都有，且用「目前」自称现值，无锚点、无重取命令）。这个数**随时会腐**：peer 只要把那 4 条补进 baseline，就变成 35 vs 35，而文档仍宣称有 4 条缺口。**接手方的错误动作**：producer 没报 `skipped identity multiset mismatch`，他却按文档以为「缺口还在、只是没撞上」，把一个已经闭合的问题继续当成已知风险带着走；反过来若 peer 又加了 native-gated 测试，缺口变成 6 条而文档说 4 条，他会以为多出来的两条是自己引入的。**修法**：给一条重取命令（例如 `grep -c '"kind"' tests/infra/entry-test-discovery-baseline.json` 对比运行时 `skipped-multiset.json`），并把「4 条」改成「若干条，以命令为准」。
2. **`minimum_executed`（当前 7279）**：这个已明确标「当前」且说明它是**地板**（只需 `实测 ≥ 它`），腐化后果轻——但同一句里既有「当前 7279」又有「实测 7297 满足它」，两个都是快照。属可接受，记为提示不作要求。

**另一处同类残留（问题 4 的延伸）**：上一轮的「`git -C <主树>` 在隔离会话会被护栏拒绝」只在 `HANDOVER.md:15`（未提交 WIP 那条）加了警告，而 **`HANDOVER.md:5`「核验基线」里的同一形态命令 `git -C /home/xp/src/copilot-api-js rev-parse refs/heads/master` 没加**（`rg -n 'git -C'` 实测两处命中，只有一处带警告）。这正是「修了一处、兄弟位置照旧」的形态：接手方读到的第一条可执行命令就是 `:5` 那条，跑出来被拒，而警告在十行之后。**修法**：`:5` 的复现命令直接改成隔离会话也能跑的 `git rev-parse refs/heads/master`（worktree 共享 refs，本轮实测同值），或就地补同样的警告。

## R3-E — commit 引用审计（问题 4 的第三个维度）

**判定：PASS**

两份文档里出现的每个 commit 引用都逐个 `git rev-parse --verify -q <hash>^{commit}` 解析成功，无悬空引用：`5720855929…`（收尾时 master）、`bea1dfa3`（阶段 1 代码终点）、`d1011fe7`（核验基线 master）、`d47492a6`（spec 状态提交）、`f4efacfe`（合并态实测点）、`08046d5c`／`d38fcb9c`／`7a99a254`／`7af27044`（skip 归因链，本轮 R-B 已在 identity 级复核）、`f0cb1f1e`（T1 守卫边界实测点）。语义正确性此前已核的不再重复；本轮只补了存在性这一维。

---

## 第三轮总判定（问题 5）

**未发现阻断性缺陷（0 blocker / 0 major）**。上轮 1 major + 3 minor **全部闭合且经实测复核**：KICKOFF 限定已补回并与 HANDOVER 语义等价（R3-A/R3-C）、`v3/` 路径两份都已修且命令可直接复制（R3-B）、行号 `19→17` 已改对（R3-B）、提交数已命令化并采纳了「只有 `docs/` 路径」这条稳定事实（R3-D）。

**本轮新增／残留 3 条 MINOR**（都不阻断，均可一次性修完）：

| 编号 | 位置 | 一句话 |
|---|---|---|
| R3-C | 两份文档的守卫段 | 只写「新增／改名」，漏了「**删除**」——判据是集合相等，删测试文件同样红（上轮 nit，未采纳也未记不采纳理由） |
| R3-D-1 | 两份文档 | `allowed_skipped` 「目前 31 vs 实测 35」是无锚点的现值断言，peer 补完就腐；建议给重取命令、把「4 条」改成「以命令为准」 |
| R3-D-2 | `HANDOVER.md:5` | 「`git -C <主树>` 在隔离会话被拒」的警告只加在 `:15`，`:5` 的同形态复现命令没加——**修了一处、兄弟位置照旧**；而 `:5` 恰是接手方读到的第一条可执行命令 |

**可否交付**：**文档内容可以交付**——剩余三条都是「读者会短暂困惑」级别，没有一条会导致错误的代码动作或数据损失。

**但交付的物理前提仍未满足**：`git merge-base --is-ancestor worktree-nghttp2-header-deadline master` 本轮仍退出 1，`master` 上的 HANDOVER 仍是没有任何刷新段的旧版。**在主树完成 `git merge --ff-only` 之前，接手方从 `master` 开树读到的仍然是被证伪过的那一版**——这三轮修的东西对他一个字都不可见。建议按文档自己写的顺序：先 ff（顺带把这三条 MINOR 一并修进同一次提交），再谈删分支。

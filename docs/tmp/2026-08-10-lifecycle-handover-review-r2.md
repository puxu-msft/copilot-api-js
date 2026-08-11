# 交接件复评 R2（接手方第一人称走查）

评审对象：`docs/plan/2026-08-08-long-resident-operation-lifecycle/{HANDOVER,KICKOFF}.md`、`docs/lifecycle.md` `[wip]` 指针。
本轮范围：**只做 C1–C3**（C4–C7 与主动排查留待下一轮唤醒）。
走查时主树 HEAD：`e120a49c`（`git log --oneline -1`）。

## C1 — 分支/worktree 已不存在、`0e0768ee` 在 master 上：**成立**

- 命题（HANDOVER:8/12、KICKOFF:7）：`fix-long-resident-operations` 与 `merge-long-resident-lifecycle` 均已被取代且不存在；最终 fast-forward 到 `0e0768ee`。
- `git branch -a --list '*fix-long-resident*' '*merge-long-resident*'` → **输出为空**（本地与 remote-tracking 下均无这两个分支）。
- `git worktree list` → 190+ 条中**无** `fix-long-resident-operations`、无 `merge-long-resident-lifecycle`；KICKOFF:7 点名的 `.worktree/fix-long-resident-operations` 路径也不在列表内。
- `git merge-base --is-ancestor 0e0768ee master` → exit 0；`git log --oneline -1 0e0768ee` → `0e0768ee merge: integrate master (16 commits) — entry-gate and load-sensitive-test work`。
- 判定：**成立**（三项断言逐项证实）。
- 接手方错误动作：无。这条按写法执行不会致错。

## C2 — 「本特性要修的缺陷至今仍在」：**成立**

- 命题（HANDOVER:60、待办 2 的证伪判据 HANDOVER:100、`docs/lifecycle.md:43`）：`formatActiveRequestsSummary` 仍直接打印 `request.state`，未经 lifecycle blocker 归一，故 Tasks 5–8 未作废。
- 命令：`git grep -n "request.state" -- src/lib/shutdown.ts` → exit 0，唯一命中：
  `src/lib/shutdown.ts:270:    return \`  ${request.method} ${request.path} ${model} (${request.state}, ${age}s)\``
- 交叉验证（不同原理：读该行所属函数而非只信 grep）：`src/lib/shutdown.ts:262` 即 `export function formatActiveRequestsSummary(...)`，`:296` 是其唯一生产调用点（drain 进度日志），即命中行确实落在交接件点名的那个函数与那条日志路径上。
- 附带命题也成立：HANDOVER:60 说摘要文案已改为 `accepted operation(s)`。实证 `src/lib/shutdown.ts:272` → `Waiting for ${requests.length} accepted operation(s):`，`active request(s)` 全文件已无残留。Task 8 若按旧文案写断言确实会红，交接件的提醒方向正确。
- 判定：**成立**。
- 接手方错误动作：无。这条给的是可重算命令（不是写死行号），复跑即得当前行号，是本交接件里写得最稳的一条。

## C3 — 15 文件 focused gate `236 pass / 0 fail`：**部分成立**（`0 fail` 成立，`236` 与「15 文件可复现」不成立）

- 命令（KICKOFF:38 的十文件 + 未具名的「Task 4 焦点集」3 文件 + `tests/history/worker/admission-shutdown.unit.test.ts` + `tests/infra/entry-evidence-schema.unit.test.ts`）实跑于 HEAD `e120a49c`：
  `239 pass` / `0 fail` / `781 expect() calls` / `Ran 239 tests across 15 files. [2.71s]`，进程 exit 0。
- 判定：**`0 fail` 成立且稳定**（连跑两次均绿，第一次仅在 coverage 写盘阶段报 `WriteFailed`，与测试结果无关）；**`236` 不成立**（实测 239）。
- 下面两条是本轮的正式发现。

### [major] KICKOFF:38 / HANDOVER:14 — 「15 文件」在两份交接件里都不可复现（「Task 4 焦点集」从未列名）

- 证据：`rg -n "焦点集" docs/` 显示 HANDOVER:14/15/34 与 KICKOFF:38 四处都只写「Task 4 焦点集」这个代号，**没有一处列出文件名**。真正的文件名只存在于 `docs/tmp/2026-08-08-long-resident-operation-lifecycle-handover-review.md:27`（转引 plan Task 4 Step 5）：`tests/context/manager-dual-registry.unit.test.ts`、`tests/context/context-manager.it.test.ts`、`tests/shutdown/drain-waits-operation.unit.test.ts`。
- KICKOFF:38 的可复制命令只含 10 个文件，KICKOFF:36 却要求「接手第一件事是复验而非采信」。
- 接手方会做出的错误动作：照 KICKOFF:38 那条唯一可复制的命令跑，得到的是 **10 文件**的读数，拿它去对 `236` 必然对不上；于是要么判成回归去追一轮不存在的缺陷，要么干脆放弃复验、直接采信——而 HANDOVER:34 恰恰把这个 gate 指定为「判断自己是否破坏了东西」的唯一稳定判据，判据不可复现即等于没有判据。
- 修法：把那三个文件名直接并进 KICKOFF:38 的命令行，让全 15 文件成为一条可复制粘贴的命令。

### [major] HANDOVER:14 与 HANDOVER:10 自相矛盾，且 `236` 是写死的易变数字

- HANDOVER:10 声明「合并态断言取证于 master `0e0768ee`」，而 HANDOVER:14 的门禁读数标注为 `3df0e08d`，并加了一句「**这是该引用的那一组**」。
- 实测两者不是同一状态：`git merge-base --is-ancestor 3df0e08d 0e0768ee` → exit 0，`git rev-list --count 3df0e08d..0e0768ee` → **17**。即被指定为「该引用的那一组」的读数取自最终合并态之前 17 个提交，**focused gate 从未在它自称的合并态 `0e0768ee` 上跑过**。
- 数字本身也已过期：当前 master 实测 `239 pass`，与文档的 `236` 差 3（0 fail，非回归；差额未逐条归因，本轮只做 C1–C3）。
- 接手方会做出的错误动作：复验拿到 239、文档写 236，正好落进 HANDOVER:16 自己警告过的「陈旧数被当成回归」陷阱——而这次警告失效，因为陈旧的正是它让你引用的那一组；更坏的一种是反向误判：以为合并态已被门禁覆盖，而实际上最后 17 个提交进来后这道 gate 一次没跑过。
- 修法：按项目「写死易变数字是绝对怪味」的裁决，把 `236` 换成可重算的命令 + `0 fail` 判据（HANDOVER:119 对 `test:backend` 已经这么做了，这里没同步）；同时把 HANDOVER:14 的 commit 锚点与 HANDOVER:10 对齐，或明写「本读数取自 `3df0e08d`，最终合并态未复跑」。

---

# R2 复评（整改提交 `0286b3e5`）

复评时树况：HEAD 在本轮开始时是 `e120a49c`，复评过程中被 peer 推进到 `f2a44579`（`git rev-list --count e120a49c..HEAD` → **49**）。下面凡涉及实测的都标了当时的 HEAD。

## 复评 major 1（15 文件不可复现）：**已消除**

- KICKOFF「测试门禁现状」现在给的是围栏内一整行命令。**未手打**，用 `awk '/^  bun test /{print; exit}' KICKOFF.md` 抠出后 `eval` 执行。
- 抠出的命令 `tr ' ' '\n' | rg -c '^tests/'` → **15**；逐个 `[ -e ]` 存在性检查 → 无 MISSING。
- 三个 Task 4 焦点集文件已就地列名（HANDOVER 与 KICKOFF 各一处），不再需要跳到 `docs/tmp/` 才能拼出集合。
- 判定：**已消除**。接手方现在能一行复制、一次跑到 15 个文件。
- 但这条命令的**可读性**另有问题，见下面 F-N1；且它当前**不是绿的**，见 F-N2。

## 复评 major 2（写死易变数字 / commit 锚点自相矛盾）：**病灶已消除，但整改引入一处新缺陷**

- 「写死数字」：判据已改为 `0 fail`，236 与 239 降级为带 commit 的出处而非对照目标。逐条复核两组读数：`3df0e08d`=236、`e120a49c`=239，与我实测一致。
- 「锚点矛盾」：新增的口径句可机械复核——`git merge-base --is-ancestor 3df0e08d 0e0768ee` → exit 0，`git rev-list --count 3df0e08d..0e0768ee` → **17**，与文中「早 17 个提交」「没有在 `0e0768ee` 上原样跑过」逐字相符。
- 判定：两个病灶**都已消除**，且新写法自带可重算命令，不再是死数字。
- **新缺陷见 F-N3**：同一句里的 `typecheck` / `lint:all` 断言在改写中丢了 commit 锚点。

## [major] F-N1 —— KICKOFF 的 gate 命令在 agent 的执行方式下**拿不到判据行**

- 命题：KICKOFF 说「判据是 `0 fail`」，前提是那条命令会把 `0 fail` 打出来。
- 实测（HEAD `f2a44579` 及 `e120a49c`，共 8 次）：只要 **stdout 是管道**（agent 的每次 Bash 调用都是），`bun test` 有很高概率在打印覆盖率表途中崩掉——`error: An internal error occurred (WriteFailed)`、**exit 1**、pass/fail 汇总**一行都不打印**。8 次里 5 次如此；换 `--coverage-reporter=text` 与 `=lcov` 各试一次，同样崩。
- 根因不在测试：`bunfig.toml:17-19` 强制 `coverage = true` + `["text","lcov"]`，而 KICKOFF 给的是**裸 `bun test`**（项目自己的脚本走的是 `scripts/parallel-test.ts` 或 `bun test --parallel`），于是每次都要把整棵 `src/` 的覆盖率表灌进管道。改成写文件或 `>/dev/null` 就稳定不崩。
- 另一个必须写进文档的事实：**pass/fail 汇总走的是 stderr，覆盖率表走 stdout**。实证 `bun test <files> >/dev/null 2>tmp` → tmp 里拿到 ` 238 pass / 1 fail / Ran 239 tests across 15 files.`。
- 接手方会做出的错误动作：照 KICKOFF「第一件事是复验」原样复制，拿到 `exit 1` + `internal error`、**没有任何 `0 fail`**，于是把这道被指定为「唯一稳定判据」的门读成红的——要么去追一个不存在的回归，要么判定 master 坏了而停下；也可能反过来，看到 `exit 1` 就绕过复验直接开工。
- 修法：命令改为 `bun test <15 files> >/dev/null`（汇总仍在 stderr 上可见），或在旁边写明「覆盖率表灌管道会崩，判据行在 stderr」。

## [blocker] F-N2 —— 这道 gate 现在是**红的**，且红因与本特性无关，文档没有给归属判据

- 命题（HANDOVER:14「共 15 文件 → `0 fail`」、HANDOVER:34「它们稳定绿」、KICKOFF「判据是 `0 fail`」）。
- 实测：在 `e120a49c` 上是 `239 pass / 0 fail`；49 个 peer 提交之后，在 `f2a44579` 上同一条命令连跑四次都是 **`238 pass / 1 fail` / `Ran 239 tests across 15 files`**。
- 失败者是 gate 成员之一 `tests/infra/entry-evidence-schema.unit.test.ts`，断言 `expect(baseline.files).toEqual(files)` 失败，diff 指向 `tests/helpers/protocol-oracles/anthropic-sdk-oracle.unit.test.ts`。取证：该文件**存在且已被 HEAD 跟踪**（`git ls-tree HEAD -- tests/helpers/protocol-oracles/`），`git status --short -- tests/` **干净**，而 `rg -n "anthropic-sdk-oracle" tests/infra/entry-test-discovery-baseline.json` **无命中**——即 peer 提交 `6af28887 test: extract shared SDK protocol oracles` 新增了测试文件却没同步发现基线。
- 结构性问题（不只是这一次红）：这道 gate 里混进了一个**全树发现基线守卫**，它对**任何 peer 在 `tests/` 下增删任何文件**都会红。HANDOVER 把这道 gate 与「负载敏感的 `test:backend`」对举、称其为「稳定绿」的那一面，这个对举**不成立**——它只是换了一种跨会话噪声源。
- 接手方会做出的错误动作：接手第一件事就复验，此时**自己一行代码都没改**，却拿到 `1 fail`。按 HANDOVER:34 的归属规则「先看失败文件是否落在自己的改动面内」，答案是「不在」，但文档没写下一步该干什么，于是最可能的三种错误动作是：①判定 master 已坏而停下等人；②以为自己起 worktree 的姿势不对而重来一遍；③最坏——照 KICKOFF:40 的提示去「同步」`entry-test-discovery-baseline.json`，那是 peer 在飞工作的产物，改它等于替别的会话做决定，还会把 gate 的证据价值抹掉。
- 修法（二选一，都属长远正确）：把 `entry-evidence-schema.unit.test.ts` 从「本特性的稳定 gate」里移出、单列为「全树基线守卫，红了先查是不是 peer 增删了测试文件、不是自己的事」；或保留在集合内但补一条明确的归属判据与「不要自行重生成基线」的禁令。

## [major] F-N3 —— 整改把 `typecheck` / `lint:all` 的 commit 锚点删掉了

- 改前 HANDOVER:14 的 bullet 头是「**已跑门禁（合并态，master `3df0e08d`——这是该引用的那一组）**」，那个锚点同时罩着同句的 `bun run typecheck` exit 0 与 `bun run lint:all` exit 0（全树）。
- 改后 bullet 头只剩「**已跑门禁**」：15 文件那部分改用 `0 fail` + 可重算命令，是对的；但 `typecheck` / `lint:all` 这两条**仍是写死的当前状态断言，现在一个 commit 锚点都没有了**。
- 这正是本次整改要治的那个病在同一句里的复发（`every-number-carries-scope`：状态断言必须带口径）。本仓 master 一天前进数百提交、且**无 pre-commit 门禁**（CLAUDE.md），全树 lint 干净是极易过期的断言。
- 接手方会做出的错误动作：把「`lint:all` exit 0（全树）」读成此刻成立，于是交付前不再自己跑；等到真跑时撞上 peer 留下的 lint 错误，又按 `dont-ignore-existing-errors` 全揽下来查，白花一轮在别人的改动上。
- 修法：给这两条补回锚点（如「测于 `3df0e08d`」），或与 15 文件那条一样改成「跑这条命令看 exit 0」。

---

# C4–C7 与主动排查

## C4 — 立案证据的 operationId 与重取路径：**路径成立，记录已不可再生**

- 路径写法核对：`docs/API.md:127` → `` `/history/api/entries/:id/export` | GET | 将 V3 `getEntry` 投影服务端 zstd 压缩为 `.json.zst` 附件。``，与 HANDOVER:44 逐字相符；相对链接 `../../API.md` 从 `docs/plan/<dir>/` 上溯两级正好落在 `docs/API.md`（全篇仅此一个 markdown 相对链接，解析成立）。
- 活体探针（只读 GET，未起服务器、未碰 4141 进程、未落盘）：
  - `GET /history/api/entries/req_1786064856101_137/export` → **`404` `{"error":"Entry not found"}`**
  - 对照 `GET /history/api/entries?limit=1` → **`200`**（证明服务在跑、路由存在，404 是领域级「记录没了」而非路由不存在）
- 判定：**部分成立**。端点、路径写法、API.md 出处三项都对；但 HANDOVER:44 写成可执行动作的「**怎么重取**」，实测已经取不到了——它预留的那句「若 History 已按保留策略淘汰该记录，该导出即不可再生」现在**已经发生**，而正文仍以「可以重取」的语气呈现。
- 接手方会做出的错误动作：照「怎么重取」去打这条 URL，拿到 404，第一反应是自己 id 抄错了或端点变了，于是回头翻 API.md、试别的 id、甚至怀疑 History 坏了——而真相是记录已被保留策略淘汰、且当时导出的 manifest 从未提交（HANDOVER:45 自陈）。
- 修法：把这条改成实测结论 +（若仍需要原始数据）明确的不可再生声明，例如「2026-08-11 实测该 id 已 404，立案证据只剩 spec 里的症状文本与本文记录的身份信息」。

## C5 — 「从 master 起步、新开隔离 worktree（放 `.worktrees/`）」：**成立**

- KICKOFF:7 与 HANDOVER:12 都写 `.worktrees/`，与 CLAUDE.md「隔离 worktree 放 `.worktrees/`」一致。
- 指向已删除分支的指令：全文只剩 KICKOFF:7 那句显式否定（「不要再用 `.worktree/fix-long-resident-operations`」）与 HANDOVER:12 的同义否定，**没有任何一处仍把它们当起点**。C1 已证实两个分支与对应 worktree 都不存在，所以这两句是「防止误用」而非「指向死物」。
- 接手方错误动作：无。

## C6 — 是否还有地方指示接手方去合并 master：**没有，成立**

- `rg -n "合并 master|先合并|merge master|--ff-only|Gate 1"` 扫 HANDOVER / KICKOFF / plan 正文，全部命中都是**完成态或历史叙述**：KICKOFF:14「已于 2026-08-09 完成，不要重做」；HANDOVER 的同名小节已由删除线改写为「## 已完成、不要重做：先合并 master（2026-08-09 完成）」；HANDOVER:100 待办 2 标注已完成；HANDOVER:63 是「仍然有效的纪律」（讲下次遇到同类集成怎么做，不是让你现在去合）。
- 判定：**成立**，没有会让人白干一遍完整集成的残留指令。
- 附带：小节标题在 `0286b3e5` 里被改名（去掉删除线）。回查所有指向它的引用——KICKOFF:14「见 HANDOVER 同名小节」与 HANDOVER:100「见上同名小节」——新标题仍含「先合并 master」，两处都还找得到，**未产生断引用**。

## C7 — `test:backend` 专节列出的三类命中面：**全部存在，成立**

- 逐个 `[ -e ]` 核对 HANDOVER:26–30 点名的七个文件（`store-performance` / `summary-query-performance` / `db-health` / `package-boundaries` / `telemetry-domain-surface` / `anchor-remap-single-authority` / `packaged-runtime`）→ **无 MISSING**。
- 「不限于 History 子系统」这句也被文件面本身证实：`tests/architecture/` 下三个 AST 扫描守卫确实不属 History。
- 接手方错误动作：无。

## [major] F-N4 —— plan 的四个写死行号，而交接件自己要求接手方改写那份 plan

- 现状核对（当前 HEAD）：HANDOVER:50 与状态表 :86/:87/:88/:89 写的 `384 / 454 / 510 / 557` **此刻全部正确**（`sed -n '384p;454p;510p;557p' docs/plan/2026-08-08-long-resident-operation-lifecycle.md` 逐行命中 `### Task 5/6/7/8:`）。
- 但 HANDOVER:103–105 的待办 3 **要求接手方的第一步就是 plan-vs-code 对账、「不存在的当场标注并改写计划」**。标注与改写必然增删行，这四个行号是**被设计成会失效**的——而失效后它们仍指向存在的行，看起来完全正常。
- 这与 `0286b3e5` 刚刚治好的病是同一个（项目裁决：文档里直接写易变数字是绝对的怪味），只是这次载体是行号不是通过数；整改覆盖了通过数，漏了行号。
- 接手方会做出的错误动作：做完待办 3 的改写后，再照状态表跳到「plan 第 454 行」去开 Task 6，落点已经偏移到别的 Task 的正文里；因为落点仍是合法内容，最可能不是报错而是**照着错的 Task 开工**。
- 修法：换成能重算的定位命令，例如 `rg -n '^### Task [5-8]:' docs/plan/2026-08-08-long-resident-operation-lifecycle.md`，或直接引锚点标题名。

## 一条对派活方说法的更正（provenance，不是发现）

- 派活消息称「`99ef6713` 早于你本轮走查的 HEAD `e120a49c`」。**不成立**：`git log -1 --format='%ci'` → `99ef6713` 是 `2026-08-11 05:16:09`，`e120a49c` 是 `2026-08-11 05:12:43`，且 `git merge-base --is-ancestor 99ef6713 e120a49c` **返回非 0**（不是祖先）。
- 也就是说，我上一轮走查时树上 KICKOFF:10 **确实**还指着已删除的项目 skill `session-closeout` 的 §6b，那条旁证在当时成立；修复是在我走查之后约 3 分钟落的。
- 当前状态（已核）：`99ef6713` 已在 HEAD 里；KICKOFF:10 现在指 user-level skill `writing-handover-docs` 并附「旧名已删除」注；该 skill 的进度文件协议确实在 `~/.claude/skills/writing-handover-docs/SKILL.md:158`「## 派 implementer 时的进度文件 —— HANDOVER 的上游」；项目 skill 的删除提交是 `e7a9cadb`（`2026-08-08 22:05:13`），与 KICKOFF 里写的「2026-08-08 并入并删除」相符。**这条现在无缺陷。**

---

# R3 复评（整改提交 `8b821a44`）

## F-N2（blocker）：**已消除**，且三问逐条核过

- ① **命令实跑**（`awk` 抠出、未手打）：参数 `tr ' ' '\n' | rg -c '^tests/'` → **14**；`rg -c 'entry-evidence'` → **0**（确已移出）；逐个存在性检查无 MISSING；原样 `eval` 执行 → **`234 pass / 0 fail` / `Ran 234 tests across 14 files.` / exit 0**，无 `WriteFailed`。
- ② **移出没有丢东西——你的判断成立，而且理由比你给的更硬**。你举的是「KICKOFF 单列了一条要自己跑」，那是**靠纪律**的保留；机械保留还有第二条：该守卫是 `.unit.test.ts`，而 `scripts/parallel-test.ts:56` 的 `BACKEND_SUFFIXES = ["unit","it","http"]` 决定了它**照常进 `test:backend`**——CLAUDE.md 规定交付前必跑那一档。所以「本特性 gate 里不跑」不等于「不跑」，覆盖面零损失。建议把这条机械保留也写进 KICKOFF，纪律那条才不是唯一防线。
- ③ **红因描述属实**。守卫的发现口径是 `tests/infra/entry-evidence-schema.unit.test.ts:19` 的 `["unit","it","http"]`（不含 pty/e2e）。我按同口径独立枚举磁盘发现集与基线 JSON 求差：磁盘多出的**正好 4 个**——`tests/helpers/protocol-oracles/anthropic-sdk-oracle.unit.test.ts` 与 `tests/openai/semantic-bridge/` 下的 `client-wire-golden.http.test.ts`、`known-defects.unit.test.ts`、`mutation-registry-coverage.it.test.ts`；反向（基线有、磁盘无）为空。与你写的「少 4 个、三个在 semantic-bridge」逐字相符。
- 判定：**blocker 已闭合**。

### [nit] 归属判据里的两处措辞可以再硬一点（不影响可用性）

- 「由 peer 提交 `588b0c09` … **引入**」——`588b0c09 test: cover both Anthropic event invariants` 是该文件的**最近一次改动**（正是你写的判据 `git log --oneline -1 -- <file>` 会返回的那个），**引入**它的是 `6af28887 test: extract shared SDK protocol oracles`（同为 2026-08-09）。id 与判据自洽，只是「引入」用词不准。
- 「提交不是你的，就不是你的问题」——本仓**所有**提交的 author 都是同一个人（这 4 个也都是 `Pu Xu`），按作者分辨不出来。接手方第一次复验时恰好零提交，所以实际可用；但一旦他自己已经提交过几轮，这句就失效了。建议改成机械判据：**该 commit 在不在你自己的 `master..HEAD` 里**。

## F-N1：**已消除**，说法属实

- `>/dev/null` 已在命令末尾（`rg -c '>/dev/null'` → 1），且加了「承重、别删」的说明。
- 「汇总在 stderr、覆盖率表在 stdout」这个说法我独立验过：`bun test <files> >/dev/null 2>tmp` 时 tmp 里拿得到 ` 238 pass / 1 fail / Ran 239 tests…`，而覆盖率表随 stdout 被丢弃。本轮按新命令实跑，判据行**读得到**（`234 pass / 0 fail`），连跑未再出现 `WriteFailed`。
- 把它称作「过滤器造出来的假红」也准确——退出码来自覆盖率写盘失败而非测试。

## F-N3：**已消除，且做得比我建议的更远**

- 锚点补回为「已跑门禁（`3df0e08d`，随后在 `e120a49c` 复测）」，并加了「**这三项都是那两个 commit 上的读数，不是「此刻仍然如此」**——接手请自己重跑」。后半句是我没提的，它把「带锚点」升级成「带锚点 + 明示失效风险 + 指定动作」。

## F-N4：**已消除**

- `rg -n '^#+ .*Task [5-8]' docs/plan/2026-08-08-long-resident-operation-lifecycle.md` → 四条全中（`384/454/510/557` 上的 `### Task 5/6/7/8:`）。状态表四格与入口指引第 2 条都已改成这条 grep，且写明了「行号漂完从外观上看不出来」的理由。

## C4 改写：**如实**

- `404 {"error":"Entry not found"}` 与对照 `entries?limit=1` → `200`，与我的只读实测**逐字一致**；「失效的是这条记录，不是这条路径」这个区分是对的（我正是用那个 200 对照排除了「服务不可用/路由不存在」）。
- `incident-manifest.zst` 实测存在、**541965 字节**（≈542 KB，十进制口径与文中一致），位于 `/home/xp/.claude/jobs/36fcb851/tmp/`，仓库内确实无副本；引用的 `docs/tmp/2026-08-10-long-resident-closeout-temp-manifest.md` 存在（9195 字节）。「唯一副本 + 用户裁决前不要清理」如实且必要。

## [major] F-N5 —— 新发现：`236/239` 两个读数在 HANDOVER 里没跟上「gate 变 14 文件」

- KICKOFF:44 已经补了限定：「（`3df0e08d`=236、`e120a49c`=239，**均含当时还在门内的 entry-evidence**）」。**HANDOVER 没有同步**：`HANDOVER:16` 仍写「通过数会随后续提交增长：`3df0e08d` 上测得 236，`e120a49c` 上复测为 **239**」，`HANDOVER:17` 仍写「合并之后的实测是 `e120a49c` 上的 `239 pass / 0 fail`」——两句都紧跟在 `HANDOVER:15`「focused gate 是 14 个文件」之后，读者会把它们当成**同一道 14 文件门**的读数。
- 这正是本轮要治的那一类（改了一处、没改指向它的另一处），只是这次跨的是 KICKOFF→HANDOVER 这条缝。
- 接手方会做出的错误动作：跑新命令得 `234 pass`，回头看 HANDOVER 说这道门是 236→239「随提交增长」，于是发现数字不增反降 5，判成有人删了测试或自己漏跑了文件，去追一个不存在的回归——而真相只是那两个读数含已被移出的第 15 个文件。
- 修法：把 KICKOFF:44 已有的那句限定原样搬进 HANDOVER:16/17（或直接标注「15 文件时代的读数，与当前 14 文件门不可直接比较」）。

## [minor] F-N6 —— 立案证据节里旧 bullet 与新 bullet 并列，语气自相矛盾

- 新 bullet 已把「记录没了」写成实测确证，但同节保留的旧 bullet 仍是条件语气：「**若** History 已按保留策略淘汰该记录，该导出即不可再生」，且「是否长期留存属用户决定，不由本次收尾代劳」与新 bullet 的「在此之前不要清理那个目录」是同一件事说了两遍。
- 接手方错误动作：轻——读到旧 bullet 会以为「淘汰」还只是一种可能，可能再去打一次那个 URL 确认。建议把两个 bullet 合并成一条，条件语气改成既成事实。

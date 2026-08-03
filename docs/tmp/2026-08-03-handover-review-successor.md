# 交接文档评审 —— 接手方第一人称走查

被审：`docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md` + `KICKOFF.md`（master `b7504c51`）
视角：我就是下一个接手会话，逐个动作实地去仓库查。
裁判轴：长远正确 + 完整（非 ROI/YAGNI）。

## 走查记录（边验证边追加）

### F3 [blocker] HANDOVER:33+38 —— 「`src/` 下 `closeAnchorViaOwner(..., "terminal")` 恰 10 处」在声明的核验基线（master）上是 **0 处**
实地（每条自绑目录根，master `b7504c51` 工作区）：
- `rg -n 'closeAnchorViaOwner' src/ --glob '*.ts'` → **exit 1，零命中**；全仓命中只在 8 份 `docs/` 文件里。
- `git grep -n 'closeAnchorViaOwner' feat/inter-block-anchor-allocator -- 'src/*'` → **10 处 terminal + 2 处 before-real + 1 处定义，行号与 HANDOVER 列的 `702,1464,1584,1623,1688,1808,1848,1893` / `driver.ts:1436,1611` 逐字吻合**。
即：事实为真，但**锚在未合并分支 `feat/inter-block-anchor-allocator`**，而 HANDOVER 第 4 行把核验基线声明成 master `98e6875e`，第 38 行「计数事实的集合边界」——文档专门用来交代口径的那一节——把口径写成「**`src/` 下**」，没有任何 ref 限定。
接手方错误动作：这是文档明写「别再重新推导」的表。按 KICKOFF gate 2 复验时在 master 上得 0/10，而该行证据等级标着「实测（未截断）」；接手方最可能的结论是「HANDOVER:109 警告的编造报告，这份文档自己也中了一条」→ 全表失信、把 T4 之外的 5 条硬事实统统重新推导（正是文档要省掉的成本），或直接向用户报「交接不可信」。反向错误更贵：不复验而把这 10 个 file:line 抄进 T4 的锚点表当 master 锚点，产出一份锚点全指向不存在符号的 plan。
建议：第 38 行改成「口径 = **`feat/inter-block-anchor-allocator` @ `854421d4` 的 `src/`**（M1 代码未合并，master 上该符号不存在）」，第 33 行「出处」列补同一 ref。

### F4 [major] HANDOVER:31/32/35 的 `file:line` 同样是分支行号，在 master 上偏移 ~10 行且无任何提示
实地逐条比对（`git show <ref>:<file> | grep -n`）：
| 引用 | HANDOVER 写 | master `98e6875e` 实际 | 分支 `854421d4` 实际 |
|---|---|---|---|
| `ClientSink` 声明 | `pipeline/types.ts:747` | **737** | 747 ✓ |
| `beginLeg`/`noteWinner` | `driver.ts:882-888` | beginLeg **877**、noteWinner **880**（区间 882-888 两者都不含） | 885 / 888 ✓ |
| `injectContentAnchor` 可达点 | `keepalive-anchor.ts:306` | 该文件 419 行，306 行是 `const { anchor, state, ... } = args` 解构，与 anchor 注入无关；且 `injectContentAnchor` 在该文件**零命中**（真身在 `routes/messages/handler-v4.ts` 与 `pipeline/client-sink.ts`） | 该文件 388 行，306 行落在 `allocateAndWriteAnchor` 回调内 ✓ |
| `streamKeepaliveMode` 默认 | `packages/foundation/src/state-defaults.ts:122` | **122 行精确命中** ✓（唯一 master 可解析的一条） |
与 F3 不同的是：第 30 行只说「M1 代码在分支上未合并」，而 31/32/35 三行被叙述成**既有架构事实**（「这是 RFC 闭包根必须是传递闭包的成因」「R-14 存在的唯一理由」），读者完全没有「这也是分支行号」的信号。
接手方错误动作：在主树打开 `types.ts:747` 看到的是 `write(frame: ClientFrame)` 的 doc comment 中段，打开 `driver.ts:882-888` 看到的是 terminal 分支而非 `beginLeg`/`noteWinner` 对照——于是要么误判「架构已被 peer 改过、R-14 的理由不再成立」，要么把 T4 锚点表建在错行上。`keepalive-anchor.ts:306` 更糟：文件名与符号在 master 上根本对不上（`injectContentAnchor` 不在该文件），足以让人相信 keepalive 链路已被重构。
建议：全表 file:line 统一加 ref 前缀（如 `br@854421d4 types.ts:747`），或给出复算命令（`git grep -n 'export interface ClientSink' 854421d4 -- src/lib/pipeline/types.ts`）——本项目 `anchor-numbers-to-commits` 正是为此。
### F5 [major] HANDOVER:113-120 的六条核对命令，抓不到本节自己举的那个案例；第 6 条还是坏的
实地逐条实跑：
- `git log --oneline -1 98e6875e` → rc=0 有输出；`git log --oneline -1 deadbeef` → rc=128 `fatal: ambiguous argument`。**可区分** ✓
- `git branch --list feat/does-not-exist` → **空输出但 rc=0**；真分支 rc 也是 0。只能肉眼看，**不能进 `&&` 链或脚本**。
- `ls <不存在>` → rc=2 ✓
- `git diff --stat`（**唯一没绑目录根的一条**）：从 `/tmp` 跑 → **rc=129，打出 git 的 usage 帮助**，不是「无改动」。而 KICKOFF gate 4 与 HANDOVER:105「每条 Bash 自绑目录根」正是本轮踩过的坑——**核对清单自己违反了它**。
更要命的是判别力：本节开头举的案例是「写 RFC 的 agent 声称六项修订、实际 `git diff` 只有 1 行」——那次 **SHA 存在、分支存在、报告文件存在、worktree 有提交**，命令 1/2/3/5 **全绿放行**；唯一指向内容的是第 6 条，而第 6 条在主树跑既看不到 agent 自己 worktree 的改动（跨 worktree 盲），agent 一旦已提交又恒为空（把诚实提交者判成「零产出」）。**这套判据抓不到催生它的那个失效形态。**
接手方错误动作：照抄六条命令核对某个 agent，四条全绿 + 第六条空输出 → 判定「已核实」并采信一份内容造假的报告；或反过来把一个已提交的诚实 agent 判成没干活而重派（本项目 `never-reassign-failed-agent` 明禁）。
建议：把第 6 条换成绑根且面向内容的一对——`git -C <agent worktree> show --stat <SHA>` + `git -C <repo> diff --stat <基线SHA>..<声称SHA>`，并加一句「SHA/分支/文件存在只证动作发生，不证内容；**必须逐项在 `show --stat` 的文件与行数里指认**」。第 2 条改 `git rev-parse --verify refs/heads/<分支>`（不存在 rc≠0）。
### F6 [major] HANDOVER:134 「记忆不在 git 里，覆盖即永久丢失」为假 —— `docs/memory/MEMORY.md` 是 git 追踪文件
实地：
- `readlink -f ~/.claude/projects/-home-xp-src-copilot-api-js/memory/MEMORY.md` → `/home/xp/src/copilot-api-js/docs/memory/MEMORY.md`（HANDOVER 给的是符号链接侧路径）。
- `git ls-files --error-unmatch docs/memory/MEMORY.md` → **TRACKED**；`git show HEAD:docs/memory/MEMORY.md | wc -c` = **32645**，与磁盘逐字节相同、`git diff` 为空；`git log -3 -- docs/memory/MEMORY.md` 有 `8e1f0cc7`/`9e50d514`/`73ddae98` 三条近期提交。项目 CLAUDE.md 也明写 `docs/memory/MEMORY.md` 是记忆库归属。
即：peer 条目**已经在 git 里**，被旧快照覆盖后 `git show HEAD:docs/memory/MEMORY.md` 一条命令即可取回。
接手方错误动作：这句话是上一会话「有意不压缩」的**唯一理由**，也是「确认无并发写者后再压」这道前置门的全部分量来源。本仓当前有 **12 个活 worktree**（`git worktree list` 实测），「确认无并发写者」实质不可证 → 接手方会把这件事无限期挂起，而 HANDOVER:132 自己说超限=「记忆库失去入口」，等于接手方自己的记忆检索一直是坏的。反向风险同样存在：被告知没有安全网，就不会去用那个**现成存在**的安全网（压缩前先提交 → 压 → 逐条 diff 找回被漏掉的 peer 条目）。
建议：把该段改成——「`docs/memory/MEMORY.md` **在 git 里**（`~/.claude/projects/.../memory/` 是指向它的符号链接）。处置：① 先 `git add -- docs/memory/MEMORY.md && git commit` 冻住当前含 peer 条目的版本；② 再压；③ 压完 `git diff HEAD~1 -- docs/memory/MEMORY.md` 逐条确认无条目/链接丢失。并发写者不再是硬门，只是需要事后对账。」

### F7 [minor] KICKOFF:43-54 两整节复述 HANDOVER 的理由与数字，违反本文件第 3 行自己声明的分工
实地对读：KICKOFF:3 声明「事实、证据、理由、数字、完整步骤**都在 HANDOVER**，本文件只放启动 gate、第一步与批准状态」。但——
- KICKOFF:43-48「这一轮反复踩的坑」4 条 = HANDOVER:96-105「我这轮犯过的错」表的**理由复述**（人口枚举漏项 / 新机制自己也要过检验 / 次数与概率口径 / O-6 门恒真），不是 gate。
- KICKOFF:50-54「测试门禁现状」= HANDOVER:7 的数字（21 次、6845 pass / 0 fail）+ HANDOVER:36 的 O-6 行为，**逐字第二份**。
- KICKOFF:14 写「核验基线是 master `98e6875e`」，KICKOFF:50 写「核验于 … master `cc909c81`」——同一文件两个 master SHA 并列，谁都没说二者关系。实测 `git merge-base --is-ancestor cc909c81 98e6875e` = YES 且 `git diff --name-only cc909c81..98e6875e -- src tests packages scripts` **为空**（纯 docs），所以 21 次读数确实顺延到 `b7504c51`——但这一步推导文档里没有。
接手方错误动作：改 HANDOVER 数字时忘了改 KICKOFF（双源必漂），下一个接手方拿到两份互相矛盾的门禁读数；或在 gate 2 复验时不知道该和哪个 SHA 比，把 `98e6875e` 当代码基线去解释 6845 这个数。
建议：43-48 与 50-54 两节压成一行指针（「坑与门禁读数见 HANDOVER『我这轮犯过的错』与头部『已跑门禁』」），仅保留可逐字重复的 gate 命令本身；第 14 行补一句「代码状态 `cc909c81`，其后到 `b7504c51` 仅 docs 变更（`git diff --name-only cc909c81..b7504c51 -- src tests packages scripts` 为空），故 21 次读数顺延」。
### F8 [minor] 同目录并存 `KICKOFF.md`（4.5KB，新）与 `kickoff.md`（32KB，陈旧），HANDOVER:46 用「陈旧 kickoff」指代其中一个
实地：`ls -la docs/plan/2026-07-27-inter-block-anchor-allocator/` → 两个仅大小写不同的文件共存（`KICKOFF.md` Aug 3 18:05 / `kickoff.md` Aug 2 22:41）。`head -15 kickoff.md` 自称「**整体 kick-off（推荐起点）**」，**通篇无作废横幅**（`rg 'supersede|已作废|command algebra|HANDOVER' kickoff.md` 仅在 236 行命中一处无关的 Q5 表述）。而 HANDOVER:46 的裁决行只写「不从**陈旧 kickoff** 的「P0」起」。
接手方错误动作：在该目录 `ls` 会看到两个 kickoff，大的那个自称「推荐起点」；HANDOVER:46 的「陈旧 kickoff」指代不明（读者完全可能理解成 `KICKOFF.md`）。照 `kickoff.md` 的「整体 kick-off」提示词起手，就是用户明确裁掉的那条路。缓解只有一跳：`kickoff.md` 首行指向 `README.md`，而 `README.md:3` 有正确横幅「**接手入口是 HANDOVER.md，不是本文件**」——但那要求接手方不直接照 `kickoff.md` 的代码块粘贴。
建议：在 `kickoff.md` 顶部加与 README 同款横幅（「**本文件已被 2026-08-03 command algebra RFC supersede；接手入口是 HANDOVER.md / KICKOFF.md**」），或 `git mv kickoff.md kickoff-superseded-2026-08-02.md`；同时把 HANDOVER:46 改成带文件名的指代（「不从 `kickoff.md`（小写、2026-08-02）的 P0 起」）。

### F9 [minor] KICKOFF:53 的 rustup 归因未经核实，且把「快速档」与「全后端档」当成同一条命令的替代
实地：`package.json` 里 `test` → `test:fast` → `bun scripts/parallel-test.ts unit **http**`（无 `it`），而 KICKOFF:16/53 推荐的是 `... unit **it** http`（= `test:backend`）。两者是 CLAUDE.md 反复强调的**不同档位**，不是同一条命令的两种写法。至于 rustup：`.worktrees/anchor-alloc/node_modules` **不存在**（实测），`build:history-search` 确实 spawn `cargo`（`scripts/build-history-search.ts:11`），但 `test`/`test:fast`/`prepare`→`build`→`tsdown` 这条链里没有 cargo，`native/history-search` 也不是 workspace 成员（`workspaces` 只有 `ui-v4`、`packages/*`）。我**没有**在别的会话的 worktree 里跑 install 去证伪（只读约束），故这条标记为「归因未交叉验证」。
接手方错误动作：把「用 parallel-test.ts 那条命令」当成 `bun run test` 的等价替身，事后报「跑了 test 全绿」而实际跑的是另一档；或反过来照搬为「worktree 里不能跑 `bun run test`」写进下一份交接，把一个未核实的归因固化成长期心智模型。
建议：改成「隔离 worktree 需先 `bun install`（新树无 `node_modules`）；门禁一律用 `FORCE_COLOR=0 bun scripts/parallel-test.ts unit it http`（= `test:backend` 全后端档，**不是** `bun run test` 的快速档）」，rustup 归因要么补一次实测要么删。

## 走查中**核对通过**的部分（记录以便下轮不重复劳动）

- KICKOFF gate 3/第一步引用的 RFC 小节**全部存在**：`§7.1`（538 行含「至少 15 次」，与 HANDOVER T3 一致）、`§7.2`、`§7.3–§7.11`（Commit 0–8 逐个有节）、`§9.2`、`§9.3 实施前必须调查的缝`、`§9.4 裁决与调查的可达停点`、`§10.3 与原 O-1～O-9 对账`、`§10.4 完成判定`、`§4.9`、`§6`、`§8`。
- T4 引用的 skill 存在且内容相符：`.claude/skills/large-refactor/SKILL.md` `## 5. RFC 交并行实现者时：三层文档结构` 正是 design/plan/prompts 三层，并明写「plan 必给 **factory 锚点表**（`file:line` + order 常量）」——T4 的验收判据与它一致。
- T5 除 F4 外可直接开工：`filterEmptyAnthropicTextBlocks` 在 `src/lib/anthropic/sanitize/content-blocks.ts:13`，`sanitize/result.ts:53` 无条件调用，rewrite 名 `sanitize-messages` 在 `payload-rewrites.ts:117`（`appliesTo: () => true`, order 300），外层门 `request-rewrite-adapter.ts:65` **行号精确命中**。
- `exp/inter-block-anchor-allocator/byte-equivalence.sh` 与 KICKOFF:54 描述**完全一致**：179 行 `cmp -s`、180-181 行 `O-6 PASS` + `exit 0`、184-186 行 `O-6 FAIL` + `exit 9`、168-171 行 `RECAPTURE=1` 重写 fixture。
- `bun scripts/parallel-test.ts unit it http` 语法有效（脚本 usage 逐字给出该形式）。
- `4f7a3989` / `200aba8b` / `51b1e1c9` / `cc909c81` 四个 SHA 均存在**且都是 master 祖先**；`2c339784` 不在 master（与「有意不合并」一致）。
- T3 的用例名精确存在：`tests/history/v3/store-performance.it.test.ts:120`；「约 1/15 复现率 → 21 次全绿只有 0.24 概率意义」与 `baseline-flake-status.md:41` 逐字一致（与该文件另一处的 1/9 不是同一量，非矛盾）。
- HANDOVER:6「主树另有并发会话的未提交改动（`docs/memory/*`、`.claude/settings.json` 等）」实测为真。
- `packages/foundation/src/state-defaults.ts:122` 是 `file:line` 表中**唯一**在 master 上精确命中的一条。

## 计数与 verdict

- **blocker 1**：F3
- **major 4**：F1、F4、F5、F6
- **minor 4**：F2、F7、F8、F9
- **nit 0**
- **verdict：存在 blocker，修复后方可作为接手入口使用。**

核心问题不是「写得不好」，而是**锚定基准分裂**：文档头声明核验基线是 master，而全部代码 `file:line` 与 10 处计数锚在未合并分支 `feat/inter-block-anchor-allocator @ 854421d4`，且文档专门用来交代口径的那一节（「计数事实的集合边界」）把口径写成了「`src/` 下」。修法是**统一给每条 file:line/计数加 ref**，一次性闭合 F3+F4。

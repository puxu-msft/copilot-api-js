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

---

# 复审（master `8ea97bec`，接手方第一人称重走）

## 逐条处置核验

| 原编号 | 判定 | 实地证据 |
|---|---|---|
| **F3 blocker** | **已闭合** | HANDOVER:4-6 拆出「文档落地基线 / 代码事实基线 `2c339784`」；表前 :30 有醒目说明「在 master 上复算会失败，那不是事实错误而是走错了树」+ `cd .worktrees/anchor-alloc`；表头 :32 带 `tree = feature 2c339784`。KICKOFF gate 2（:14）同步且措辞独立无双源。**引用的两条证据我逐条复算**：master `rg closeAnchorViaOwner src/` 仍零命中、master `ClientSink` 在 `types.ts:737` —— 与文档所写一致。 |
| **F1 major** | **已闭合** | `git show --stat 6cfa0e89` = 5 文件 1821 行；五份产物 `git ls-files --error-unmatch` **全部 TRACKED**；HANDOVER:9 措辞与磁盘相符。 |
| **F4 major** | **已闭合** | 在 `.worktrees/anchor-alloc`（HEAD 实测 `2c339784`）逐条复算：`ClientSink` **747** ✓；`driver.ts:885` = `beginLeg("primary", source)`、`:888` = `?.noteWinner(source)`，落在所写 882-888 区间内 ✓；`closeAnchorViaOwner(...,"terminal")` handler-v4 **8** + driver **2** = **10** ✓；`keepalive-anchor.ts:306` = `port.allocateAndWriteAnchor(({ wireIndex, envelope }) =>` ✓。:37 补的「`noteWinner` 不受该门控，但仍受 optional chaining 约束」修正了原「无条件」的过强表述，与代码相符。 |
| **F5 major** | **已闭合** | 六条全部 `git -C` 绑根；新增的诚实边界段（:137）三分法正确：前五条=不存在、第六条=已提交但内容不符、都抓不住「提交了 diff 也对但结论错」。这正是原报告指出的判别力缺口。 |
| **F6 major** | **已闭合** | `stat -c '%i'` 两路径均 **2158870** ✓，与文档所写 inode 一致；`docs/memory/MEMORY.md` TRACKED ✓。:153-154 明确标注原理由为错并换成「静默删除没人发现，有备份也没用」——该理由成立且不依赖 git 事实。 |
| **F2 minor** | **已闭合** | :20 改为「§0～§11」并删掉行数，附「不在此写行数——它每轮都在漂」。RFC 实测 `## 0.`～`## 11.` 共 12 个二级节，与新写法相容。 |
| **F9 minor** | **已闭合** | KICKOFF:53 显式撤回 rustup 归因，并补上 `bun run test`=`test:fast`（无 `it`）vs `test:backend` 的档位区分；「只有 `test:ci` 会先 `build:history-search`」经 `package.json:59` 核实为真。 |
| **F7 minor** | **未处置** | KICKOFF:43-48「这一轮反复踩的坑」与 :50-54「测试门禁现状」仍在，且 :52-53 本轮**变长了**（新增 run-log 指针与档位说明）。KICKOFF:3 自称「数字都在 HANDOVER」，而 :52 仍带 21 次 / 6845 / 0 fail / `cc909c81` 四个数字。 |
| **F8 minor** | **未处置** | `head -4 kickoff.md` **仍无作废横幅**，仍自称「整体 kick-off（推荐起点）」；`KICKOFF.md` / `kickoff.md` 仍同目录共存。HANDOVER:51 仍写「不从陈旧 kickoff 的 P0 起」，指代不明。 |

## 本轮修订**新引入**的问题

### N1 [major] HANDOVER:10 与 `baseline-run-log.md` 把**跨树**对照写成「同一 HEAD」
实地：新增的 `docs/tmp/2026-08-03-baseline-run-log.md`（存在且 TRACKED ✓）第三节标题写「修复前的对照（**同一 HEAD**，未修 flaky 时）」，而该节代码块自己写着 `cwd=/home/xp/src/copilot-api-js/.worktrees/anchor-alloc head=**2c339784**`——前两节是 `cwd=<主树> head=**cc909c81**`。两者**不是同一 HEAD**，也不是同一测试人口：**6848** pass vs **6845** pass。我另跑 `git merge-base --is-ancestor cc909c81 2c339784` → **NO**（`51b1e1c9` 同样 NO），所以「feature 树未含修复」这一半是真的，但「同一 HEAD」这一半是假的。HANDOVER:10 把这个错误措辞原样搬进了头部：「含修复前的对照：**同一 HEAD** 未修 flaky 时 6 次里 2 次有红」。
接手方错误动作：把「2/6 红 → 0/21 红」当作**同一树上的受控前后对照**引用进 RFC §7.1 入场记录或 T3 的诊断 AC。它实际是跨树比较，混杂了 master↔feature 之间的全部差异（含 3 条测试的人口差），**不能排除「红消失是因为换了树」**。T3 的修复 AC 要求「逆 mutation 转红 / 同等负载转绿」——用一个跨树对照去顶那个受控实验，正是 T3 证伪条款要防的。这是本次 blocker（锚定基准分裂）的**同类复发**，发生在修它的那次改动里。
建议：标题改「修复前的对照（**feature 树 `2c339784`，不含 `51b1e1c9`/`cc909c81` 两条修复；与上两节的 master `cc909c81` 不同树、测试人口 6848 vs 6845**）」，并在 HANDOVER:10 与文末结论行同步；文末「修复前 6 次里 2 次有红，修复后 21 次零红」加一句「**跨树对照，非受控前后实验**」。

### N2 [minor] HANDOVER:5 的「文档落地基线 master `dafa31d8`（本文件所在提交）」指错了提交
实地：`git log --oneline -1 dafa31d8` → `docs(skill): correct a V7 entry I recorded as passing without running it`，与本特性无关；`git log dafa31d8..8ea97bec` → 中间还隔着 `c10f0269`，**本文件实际所在提交是 `8ea97bec`**（`git log -- HANDOVER.md` 前两条 = `8ea97bec`、`b7504c51`）。
接手方错误动作：想确认「我拿到的是不是最新那版交接」时去 `git show dafa31d8 -- .../HANDOVER.md` → 空输出，误判文件被移动/删除过；或把 `dafa31d8` 当本轮工作的起点去 diff，diff 里混进一条无关的 skill 提交。这与上一轮「基线写成自己的父提交」是同一形态，只是换了标签。
建议：写成「**文档落地基线：本文件所在提交（写作时为 master `8ea97bec`；复算用 `git log -1 -- docs/plan/2026-07-27-inter-block-anchor-allocator/HANDOVER.md`）**」——给命令而非给会过期的 SHA。

### N3 [minor] HANDOVER:43「计数事实的集合边界」仍写「`src/` 下」，且在同一段里混两棵树
实地：:43 原文未改——「10 处 terminal 决策点」= **`src/` 下** … ；「21 次连跑」= … 代码状态 `cc909c81`。前半句的 tree 是 feature `2c339784`，后半句是 master `cc909c81`，**同段两棵树、只有后者带 SHA**。表前 :30 的声明说的是「表里」，:43 是表**后**的独立小节。
接手方错误动作：这一节的存在目的就是「拿去当口径抄」——抄走「`src/` 下 10 处」在主树复算，仍会撞回原 blocker 的那堵墙（只是这次表前有救生索）。
建议：:43 两句各自内联 tree —— 「= **feature `2c339784`** 的 `src/` 下 …」「= **master `cc909c81`** 上 `unit+it+http` 三档 …」。

## 复审中另行确认为真的新增内容

- HANDOVER:106 新增的否定性断言自我推翻，**数字我完全复现**：`find docs/spec docs/decisions docs/plan/2026-07-27-inter-block-anchor-allocator -name '*.md' | wc -l` = **122**；同范围 `rg -l` 五个检索词 = **21**。它点名的未命中文档（`decisions/2026-07-22-continuation-retry-sequential-anchor.md` 等）确实在 122 里、不在 21 里。这一条把上一版的假「无冲突」换成了带待办的诚实边界，是本轮质量最高的修订。
- HANDOVER:39 的「9 处／4 文件」**精确复算通过**（feature 树）：调用点 `driver.ts:883,944,1012,1097`、`keepalive-anchor.ts:280`、`live-reconcile.ts:139`、`handler-v4.ts:1112,1422,1772` = 9；4 文件。`session.ts:90` 定义与 4 条 import specifier、以及 `driver.ts:943` 的 `ReturnType<typeof ...>` 类型位置均正确排除——「AST 枚举 CallExpression」的口径名副其实。
- HANDOVER:96-99 的 O-1~O-9 + R-1~R-14 = **23 项** 算数正确；新增的 23 行 ledger 验收 + 「ledger 少于 23 行即证伪」是可机械判的。
- HANDOVER:62-63（T1）、:73-76（T3）新增的验收/证伪条款各自可判别，T3 的「复现成功 ≠ 已修」正好堵住原表述的假绿。
- KICKOFF gate 2 与 HANDOVER:4-6 是**转述而非复制**，未新增双源。

## 复审 verdict

- **blocker 0**（原 1 条已闭合）
- **major 1**：N1（新引入）
- **minor 4**：N2、N3（新引入）+ F7、F8（未处置）
- 原 1 blocker / 4 major / 4 minor 中，**1 blocker + 4 major + 2 minor 已闭合**。

**尚有 1 项 major（N1）未决**，故不给「无未决 blocker/major」。N1 是纯措辞修正（标题 + HANDOVER:10 + run-log 结论行三处），改完即可放行；**无未决 blocker**。

---

# 第三轮复审（master `cf82f0f5`）

## ① N1 / N2 / N3 是否闭合（实地查，非读文本）

- **N1 —— 闭合。** `docs/tmp/2026-08-03-baseline-run-log.md` 第三节标题已是「修复前的观测（⚠️ **不同的树，不是受控前后对照**）」，文末警示块的三条事实我逐条复算：feature `2c339784` / **6848** vs master `cc909c81` / **6845**（与代码块内 `head=` 行自洽）、`git merge-base --is-ancestor cc909c81 2c339784` → **rc≠0 = NO**（我第二轮已实跑，本轮未变）。HANDOVER 头部「已跑门禁」下方同步了同一警示块，并自陈「这条纠正本身就是同类复发」。**「它支持 / 它不支持」二分写法是可判别的**：接手方拿它去顶 T3 修复 AC 时，文档明确说 NO 并指明替代（同树逆 mutation）。
- **N2 —— 闭合，且改法比我建议的更好。** 自指 SHA 已删，换成现算命令；我**实跑**了那条命令：`git -C /home/xp/src/copilot-api-js log -1 --format='%h %ad' --date=short -- docs/plan/.../HANDOVER.md` → `cf82f0f5 2026-08-03`，rc=0，指向当前提交 ✓。全文 `dafa31d8` 仅剩 1 处，是「上一版写 `dafa31d8`，实际落在 `8ea97bec`」这句**有意的反例说明**，非残留。
- **N3 —— 闭合，且超出我提的范围。** 那段已拆成三行表格，每行带独立「树 / 代码状态」列，第 3 行还显式标注「（≠ 上面两行的树）」，段首写「**别跨条借用**」。新增的 `tests/**` 排除项**是实质修正而非装饰**：我在 feature 树实测 `rg -c closeAnchorViaOwner tests/` → `tests/architecture/anchor-close-sites.unit.test.ts:**12**`，`getDownstreamDeliverySession` 亦有 3 个测试文件命中——不写这条排除，接手方复算必然对不上数。

## ② 三条新判据的接手方走查

### N4 [major] T4「每一项**恰好一个**归属 commit」+ 证伪②，与 RFC 自己的归属列直接冲突
实地：把 RFC §10.2（`design.md:746-761`）的 R-1～R-14 最后一列逐行读出来，**至少 6 条本就跨多个 commit**——R-1「Commit 0 只激活 recorder 自检；production 硬门在 Commit 4」、R-2「unit 门在 Commit 1，production 门在 Commit 4」、R-5「辅助门 Commit 1；production 硬门 Commit 4」、R-6「Commit 1／6」、R-12「Commit 4 更新、Commit 7 审计」、**R-11「沿用原 O-6；本 RFC 每 commit 共同门」**（R-11 结构上就不可能只属于一个 commit）。
接手方错误动作：照「恰好一个」建矩阵，这 6 条会全部触发证伪②「矩阵有孤儿」→ **正确状态被判红**。最省事的修法是每条硬塞一个 commit，于是 R-1/R-2/R-5 的「辅助门早、production 硬门晚」两段式被压平、R-11 从每 commit 共同门降成单点检查——**恰好废掉 RFC 花六轮建立的分级**。这是 `criteria-fail-two-ways` 的 false-red 半边。
建议：改成「每一项**至少一个**归属 commit，多归属者必须逐 commit 写明**该 commit 上它是什么等级**（辅助门 / production 硬门 / 共同门 / 审计）」，证伪②改为「某条 R/O **一个归属都没有**，或多归属而未标等级」。

### N5 [major] T4 的鉴别力正控拿 O-9 做 mutation，而 O-9 在本 RFC 内**本就没有归属 commit**
实地：RFC §10.3（`design.md:775`）O-9 行写「**仍待 M7，绝不删除**……归 M7 独立交叉 mutation 矩阵。逐 task 全绿不能替代它」；§10.4（`:779`）明写「O-3／O-5／O-7／O-9 以及 O-4 完整验收明确留给后续 M2～M8／P7／P8」，并要求 verdict 用 `NOT-YET-IN-SCOPE`。
接手方错误动作：① 正控写「把 O-9 挪到 Commit 2（**其依赖尚未就位**）」——但 O-9 的依赖不是「Commit 2 时未就位」，而是**整个本 RFC 都不提供**（依赖 M2～M8 合并态）。这个 mutation 的前提是错的，做出来红了也**证明不了矩阵能抓「门排在能力之前」**，只证明它能抓「不在范围内的项」；正控失去针对性。② 更糟：O-3/O-5/O-7/O-9 四条在正确状态下就没有归属 commit，撞证伪② → 又一处 false-red，与 N4 叠加。
建议：正控换成一个**本 RFC 内真有依赖序**的对子——RFC §7.7 已写明 R-5 的 production 双命中 mutation 依赖 Commit 4 的 mapping 接线（`:378`「当前基线的 `withAllocatedRealBlock`／`writeBlockFrame` 为零 production 调用者，所以双命中 registration mutation 在 cutover 前不可达」），把 **R-5 的 production 硬门挪到 Commit 2** 才是「门排在其依赖能力之前」的真实例；同时给矩阵加第三种 verdict `NOT-YET-IN-SCOPE`，与 §10.4 对齐。

### N6 [major] T2 的证伪③**在当前 RFC 上已经成立**，而 HANDOVER 没预警——接手方可能据此判定 Q1 已裁而跳过 T2
实地三处对读：§9.1（`design.md:692`）把 Q1 列为「待主会话／用户裁决」并给 A/B/C 与推荐 A；§9.4（`:734`）「**Q1 保持 open 并在 Commit 5 前停**」；§4.9（`:414`）「该项作为 open question 交主会话选择」——三处一致说 open。**但 §7.8 Commit 5 条目（`:645`）第一行写的是「前置停门：Q1 已裁；……Q4 已裁决方案 B」。**
接手方错误动作：T2 指定的「三处」之一就是 Commit 5 条目；一个先读 §7 执行路径的接手方（KICKOFF 第一步正是「读 RFC §7」）会先撞见「Q1 已裁」，据此认为 T2 不再阻塞，直接开 Commit 5——而 telemetry key 形状根本没定，落地后要么私建旁路表（§4.9 明禁），要么返工 SQLite migration。HANDOVER T2 / KICKOFF:32 说的是「仍待裁决」，方向是对的，但**没有点名 §7.8 这句已经与之矛盾**。
建议：T2 补一行「**已知不一致（先修）**：RFC §7.8 首行现写『Q1 已裁』，与 §9.1／§9.4／§4.9 矛盾；这正是本条证伪③的现成实例，裁决落盘时**连同这句一起改**」。（这条是 RFC 既有缺陷，非本轮引入，但 T2 是唯一会撞上它的入口。）

### N7 [minor] T5 第 2、4 格要「实测上游响应码」却不给路线；在 `protect-user-main-server` 下接手方会卡在「禁止推断」与「拿不到实测」之间
实地：能力**存在**——`.claude/skills/live-ghc-e2e-verification/SKILL.md` 正是为此而设，其 frontmatter 与正文明写「绝不 kill／重启 4141（`protect-user-main-server`），而是在**其他端口起隔离测试服务器**跑当前 worktree 代码 + 真 GHC auth + 独立 history.db，History API 当核验 oracle」，并给了靶向省额度纪律（便宜模型 + 小 `max_tokens`）。但 **T5 通篇没点名它**，也没说「实测」允许烧真实额度。
接手方错误动作：读到证伪③「第 4 格用推断代替实测」+ CLAUDE.md 的 4141 禁令，最可能的两个动作都错——① 判定「实测不可得」，把 T5 无限期挂起（而它是 P7 唯一的定性路径）；② 自行摸索起服务器，撞上 skill 已写死的盲点「`live=旧码`」，拿 4141 上的**改动前代码**去测，得出假结论。另外「真 **Anthropic** 上游」在本项目是歧义词——上游是 GHC 的 Anthropic 兼容端点，不是 anthropic.com；新接手方可能去找不存在的 Anthropic 凭据。
建议：T5 加一行「**第 2／4 格的实测路线**：走 skill `live-ghc-e2e-verification`（非 4141 隔离测试服务器 + 真 GHC auth + 独立 history.db；靶向、便宜模型、小 `max_tokens`）。**上游 = GHC 的 Anthropic／CC／Responses 兼容端点**，非 anthropic.com。」

## ③ 修复 N1 过程中是否新引入缺陷

`git show cf82f0f5` 逐 hunk 读：改动只落在 6 个目标块（头部基线行、已跑门禁行、集合边界段、T2/T4/T5），**无 collateral、无整行重复、无邻接内容被顺手复制**（我按 `replacement-must-cover-what-it-restates` 逐 hunk 比对了 `-`/`+` 两侧）。run-log 的三处 `head=` 行未被改动，仍与新警示块的数字自洽。**N1/N2/N3 三条修复本身干净。**
但本轮**新写的三条判据引入了 3 个缺陷**：N4、N5（T4，均为 false-red 型，与 RFC 归属列/范围外分类冲突）、N7（T5，判据要求的实测无路线）。N6 是 RFC 既有、非本轮引入，但被新 T2 首次照亮。**「为闭合而加的机制，自己要过同等强度的检验」——KICKOFF:46 自己写下的那条，本轮又中了一次。**

## 第三轮 verdict

- **blocker 0**
- **major 3**：N4、N5、N6
- **minor 3**：N7 + 上轮遗留的 F7（KICKOFF 复述 HANDOVER 数字）、F8（`kickoff.md` 无作废横幅）
- N1 / N2 / N3 **全部闭合**，其中 N2、N3 的改法优于我原先的建议。

**不给「无未决 blocker/major」**：N4/N5 会让接手方在**正确状态**下判红并做出压平 RFC 分级的错误修补，N6 会让接手方跳过一个阻塞 Commit 5 的未决裁决。三条都是措辞级修改（T4 两处、T2 一行）。**无未决 blocker。**

---

# 第四轮复审（master `37f13c90`）

## N4 / N5 / N6 / N7 闭合核验

- **N4 —— 闭合。** T4 已改「至少一个」，并把我列的 6 条（R-1/R-2/R-5/R-6/R-12 两段式、R-11 每 commit 共同门）写进警示，要求多归属标每段阶段与等级、压平即不合格。
- **N5 第一臂 —— 闭合，且指针纠正正确。** 我实测 `design.md:378` 所属节：用 awk 从文件头累计最近的 `### ` 标题 → **`### 4.6 双命中 mutation oracle`**。**我上轮写的「§7.7:378」章节号确实错了，行号对**；文档按 §4.6 改并在括号里注明这个出入，是对的。R-5 作为「门排在其依赖能力之前」的正控成立：§4.6 明写 `withAllocatedRealBlock`／`writeBlockFrame` 零 production 调用者、双命中 mutation 在 cutover 前不可达，而 §10.2 R-5 行记「辅助门 Commit 1；production 硬门 Commit 4」。
- **N6 —— 闭合。** RFC §7.8 首行已改为「Q1**必须已裁**——**截至本 RFC 交付时 Q1 仍 open**（见§9.1／§9.4），这是本 commit 的入场条件、不是已完成的状态；与同行 `Q4已裁决方案B` 的语气不同」。T2 里点名了这处历史命中并要求「动过任何 Q1 相关文字后重跑四处一致性检查」。
- **N7 —— 闭合，且拆格是正确的加强。** T5 已点名 skill `live-ghc-e2e-verification` + 非 4141 隔离实例 + PID 精确停 + 「『Anthropic 上游』= GHC 兼容端点、三腿互不可外推」。4 格拆 6 格（`@cc`/`@responses` 分开）我认同：合成一格时「只坏 Responses 腿」会假绿。
- **21 次连跑降级 —— 闭合。** run-log:10、HANDOVER:11、KICKOFF:52 三处措辞一致，均写「自我报告的摘要、非独立可核验、别当门禁已过」，并指回 RFC §7.1 要求在 entry commit 重跑。三处无矛盾。

## ① 接手方照着做还会不会出错

### N8 [major] T4 证伪② 仍会把 **O-3 / O-5 / O-7 / O-9 四条**在正确状态下判红——N5 的第二臂没修
实地：`design.md:763-777` 的 §10.3 逐行读，「说明与归属」列——O-3「**仍待后续补**……归 M2～M8 中的 gap lifecycle」、O-5「**不属于本 RFC，仍待 P8**」、O-7「**不属于本 RFC，仍待 P7／P8**」、O-9「**仍待 M7，绝不删除**」。**这四条在本 RFC 内一个归属 commit 都没有**，而 T4 证伪② 原文仍是「某条 R/O **没有归属 commit**」即孤儿即不合格。
接手方错误动作：矩阵覆盖 O-1～O-9，四条正确的范围外项触发证伪② → 判据在**正确状态**下红。修法只有两条，都坏：给它们硬塞一个 commit（把 §10.4 明令「不得因『不属于本 RFC』从 roadmap 删除」的待办伪装成本轮已归属），或干脆把它们从矩阵里删（正是 §10.3「绝不删除」禁的）。**上一轮我给的建议是两条并列的**——「正控换 R-5」+「给矩阵加第三种 verdict `NOT-YET-IN-SCOPE`，与 §10.4 对齐」——只落地了前一条。旁证：同文件 T6:130 已经在用 `PASS / FAIL / NOT-YET-IN-SCOPE` 三态，T4 却没有，**同一份文档里两套口径**。
建议：证伪②改为「某条 R/O 既无归属 commit **也未标 `NOT-YET-IN-SCOPE` 并指明归属相位**」，并在 T4 正向要求里补一句「范围外项 verdict 写 `NOT-YET-IN-SCOPE` + 归属相位（如 O-9 → M7），与 T6 的 ledger 同口径」。

### N9 [minor] T4 要「标出每段的阶段与等级」，但 **R-6 在 RFC 里读不出分段等级**
实地：`§10.2` R-6 行末列原文 = `本RFC辅助门；Commit 1／6，不计behavior闭合`——**两个 commit、一个等级、没有分段说明**。其余 13 条都能直接读出：R-1「Commit 0 只激活 recorder 自检；production 硬门在 Commit 4」、R-2「unit 门 Commit 1，production 门 Commit 4」、R-3「Commit 0 characterization；production 修复硬门 Commit 4」、R-5「辅助门 Commit 1；production 硬门 Commit 4」、R-12「Commit 4 更新、Commit 7 审计」、R-11「每 commit 共同门」，单归属的 R-4/7/8/9/10/13/14 亦各带等级。
接手方错误动作：R-6 一条只能自行推断（Commit 1 = compile fixtures／类型门就位，Commit 6 = legacy 删除后 import guard 复跑），而这个推断**没有 RFC 出处**——落进 plan 后就成了「plan 里出现 RFC 未冻结的内容」，撞 T4 自己的证伪①。或者接手方照抄「辅助门」给两段同一等级，那就是 T4 禁的**压平**。
建议：T4 补一行「**已知缺口**：R-6 是唯一多归属却未分段的一条（`本RFC辅助门；Commit 1／6`）——写矩阵时把它的两段等级**作为待 RFC 补齐的调查项列出**，不要自行填充」。

### N10 [minor] T2 现在有**三份互不相同的清单**，并集实为 5 处而非 3 处或 4 处
实地：T2 验收 = {§9.2、§4.9、Commit 5 条目(§7.8)}；T2 证伪② = 「**三处**只同步了其中一两处」；本轮新增的 ⚠️ = 「重跑一次**四处**一致性检查（§7.8 / §9.1 / §9.4 / §4.9）」。三份清单的并集是 **5 处**——`§9.1`（Q1 现列于「待主会话／用户裁决」，`design.md:692`）、`§9.2`（裁后归属）、`§9.4`（`:734` 现写「Q1 保持 open 并在 Commit 5 前停」）、`§4.9`（`:414` 现写「作为 open question 交主会话选择」）、`§7.8`。**没有任何一份清单是完整的，且新增的四处清单恰恰漏掉了 §9.2**（裁决落盘的正主）。
接手方错误动作：按验收同步 3 处、按证伪②自查「三处都同步了」→ 通过；⚠️ 那条虽会触发（确实动过 Q1 文字），但它的清单里没有 §9.2，于是 §9.2 是否真写了裁决**没有任何一条检查覆盖**。结果是 Q1 被裁决后 §9.1 仍挂在「待裁决」、或 §9.2 空着——正是 T2 要防的「三处只同步了其中一两处」的变体。
建议：把三份清单合成**一份具名的 5 处清单**（§9.1 移除／标裁决、§9.2 记裁决、§9.4 撤停点、§4.9 记 key 形状、§7.8 入场条件转已满足），验收、证伪②、⚠️ 全部引用这一份，不再各写各的。

## ② §7.8 改完后，接手方走「先读 RFC §7」还会不会误判 Q1 已裁

**不会。** 我以接手方身份只读 §7.8 那一行：「Q1**必须已裁**——**截至本 RFC 交付时 Q1 仍 open**（见§9.1／§9.4），这是本 commit 的入场条件、不是已完成的状态；与同行 `Q4已裁决方案B` 的语气不同，别读成同一件事。」——**它把结论、出处、与最易混的邻居（Q4）三样都给全了**，单读这一行就足以得出「Q1 未裁」。这是本轮质量最高的一处修订。
**但它是时间相对断言**（「截至本 RFC 交付时」），Q1 一旦被裁就变成假陈述。守它的是 T2 的「动过任何 Q1 相关文字后必须重跑一致性检查」——**该守卫成立但依赖 N10 那份不完整的清单**；N10 修完即闭合。

## ③ 本轮是否再引入新缺陷

`git show 37f13c90` 逐 hunk 读：4 文件、31 增 12 删，改动全部落在目标块（T2 ⚠️、T4 正向+正控、T5 表与路线、§7.8 一行、run-log 与 KICKOFF 的降级措辞）。我按 `replacement-must-cover-what-it-restates` 跑了机械检查——`git show ... | rg '^\+' | sort | uniq -d` **无重复新增行**，无邻接内容被顺手复制，design.md 只动了 §7.8 那一行。
**本轮唯一新引入的是 N10**（新增的「四处」清单与既有「三处」清单并存且互不覆盖）。N8 是上轮建议只落地一半的遗留臂，N9 是 RFC 既有缺口被新判据首次照亮——两者都不是本轮写坏的。

## 第四轮 verdict

- **blocker 0**
- **major 1**：N8
- **minor 4**：N9、N10 + 遗留 F7（KICKOFF 复述 HANDOVER 数字）、F8（`kickoff.md` 无作废横幅）
- N4 / N5(第一臂) / N6 / N7 / 21 次降级 **全部闭合**；我上轮给的 `§7.7:378` 指针错误已被文档正确纠正为 §4.6。

**不给「无未决 blocker/major」**：N8 会让接手方在正确状态下把四条范围外 oracle 判红，而两种自然修法（硬塞 commit / 删出矩阵）分别违反 §10.4 与 §10.3 的明令。改法是证伪②一句话 + 正向要求一句话，与 T6 已有的三态 verdict 对齐即可。**无未决 blocker。**


---

# 第五轮复审（master `3be24a4d`）

## N8 / N9 / N10 闭合核验

- **N8 —— 闭合。** T4 已引入 `IN-SCOPE / NOT-YET-IN-SCOPE` 两态归属 + `PASS / FAIL / NOT-YET-IN-SCOPE` 验收态，明写「T6 已在用，别开第二套」；证伪②改成「既没有归属 commit、也没有 `NOT-YET-IN-SCOPE` + 具名后继相位」；新增证伪⑤把两种坏修法（硬塞 commit / 删出矩阵）分别绑到 §10.4 与 §10.3 的明令上。O-3/O-5/O-7/O-9 已实测列出并标「这是正确状态」。
- **N9 —— 闭合（判断正确）。** R-6 已移出两段式清单另起一段。我复核 §10.2 R-6 末列原文 `本RFC辅助门；Commit 1／6，不计behavior闭合` —— 确实两 commit、一等级、无分段；而 R-1/R-2/R-3/R-5/R-12 各自带分段等级、R-11 写「每 commit 共同门」。判为 RFC 既有缺口成立。
- **N10 —— 部分闭合，见下 N11。** 五行表逐行核对「裁决前的正确状态」列：§9.2 现确实不含 Q1（`design.md:711` 的「以下不是open questions」列表里没有 Q1）✓、§7.8:645 现是「必须已裁／截至交付时仍 open」✓、§9.4:734 现是「Q1 保持 open 并在 Commit 5 前停」✓、§9.1:692 是问题+A/B/C+推荐 ✓、§4.7:382「Per-command telemetry：复用既有 registry」确实是 key 形状／接入形状所在 ✓。**你自查出的两处硬错都成立**：key 形状在 §4.7 而非 §4.9（§4.9 是 Compound command phase）；`rg -n 'Q1' design.md` 只命中 645/692/734，§4.9 确无字面 `Q1`。

## ① 三态读得出吗（依据在 RFC 哪里）

**读得出，四类来源都实地验过：**
- **R-1～R-14 的归属 + 等级** → §10.2 末列，13/14 可直读（R-6 除外，已由 N9 处置）。
- **O-1～O-9 的态与后继相位** → §10.3「说明与归属」列：O-3「仍待后续补……归 M2～M8 gap lifecycle」、O-5「不属于本 RFC，仍待 P8」、O-7「不属于本 RFC，仍待 P7／P8」、O-9「仍待 M7，绝不删除」——**四条都自带具名后继相位**，正好喂给证伪②要求的「`NOT-YET-IN-SCOPE` + 具名后继相位」。
- **§10.4 的必过口径** → `design.md:779` 已要求逐项写 `PASS / FAIL / NOT-YET-IN-SCOPE`，与 T4 新口径同源。
- **非 behavior 硬门的两条**（R-9「不计 behavior 闭合」、R-6）T4 已点名，不会被误并进硬门集合。

## ② 「停下来问」——问谁、怎么提，写清楚了吗

### N12 [minor] T4 只写「停下来问」，没写**问谁**与**问题该长什么样**
实地：T4 R-6 那段原文止于「**处置是把它列成一条待 RFC 补齐的调查项，停下来问，别自己填。**」全文再无对象与形式。而本项目 CLAUDE.md `scope-ambiguity-then-ask` 要求「真分叉才 `AskUserQuestion`，且摆 3-4 个带量化影响的选项而非 yes/no」；RFC 侧的对应机制是 §9.1「待**主会话／用户**裁决」+ §9.4 停点表。
接手方错误动作：三条都见过——① 丢给 subagent reviewer（它无权改 RFC 内容，只会给意见，等于没裁）；② 向用户提一个 yes/no（「R-6 的两段等级要不要拆？」），违反本项目提问规范且用户无从判断；③ 因为「停下来问」没有对象，实际继续自己填——正是这条要防的。
建议：补一句「**按 §9.1／§9.4 的 open question 机制走**：在 RFC §9.1 新登一条（问题 + 候选拆法 + 各自后果），交**主会话／用户**裁决，落盘沿用 T2 五行表同型（问题位 / 裁决位 / 停点位）。**候选拆法可以先给**——§10.2 R-6 判据列已写『compile fixtures 覆盖…；import guard 带违规样本』，对应 §7.4 Commit 1（Capability types 就位）与 §7.9 Commit 6（legacy 删除后 guard 复跑），可作为待确认提案而非空白。」（既不自行填，也不把一张白纸推给用户。）

## ③ 「裁决后必须变成什么」那一列会不会与 RFC 现有措辞冲突

### N11 [major] 五行表自称「全文只有这一份……不得另列」，但 **§4.9 是第六处**——而支撑该完备性声明的命令只搜字面 `Q1`，结构上找不到它
实地（换一种原理复算，用**内容轴**而非字面 `Q1`）：

```
awk 'BEGIN{sec=""} /^#{2,4} /{sec=$0} /联合查询|open question|compound dimension|multidimensional|任意多维/{print NR" ["sec"]"}' docs/rfc/.../design.md
```

→ 命中 **`414 [### 4.9 Compound command phase与partial表达]`**。该行结尾原文：「……若产品要求 `command × outcome × format` 联合查询，现 registry 不兼容，**该项作为 open question 交主会话选择『预组合一个有界 compound dimension』或扩展 registry 为 typed multidimensional key**，不能私建旁路表。」——**这就是 Q1 的选项 A 与选项 B，逐字写在 §4.9 里，只是没写 `Q1` 这两个字符**。
接手方错误动作：Q1 裁决为 A 之后，接手方按五行表同步完 §9.1/§9.2/§4.7/§7.8/§9.4，跑证伪④「判据自己漏掉了五处中的某一处」→ **通过**。而 §4.9 仍写着「该项作为 open question 交主会话选择」。**§4.9 恰恰是 Commit 5 要实现的那一节**（compound phase／partial 与 SQLite additive columns），实施者读它时会看到一个关于自己正在建的 schema 的「未裁决 open question」，于是停下来重新请裁，或按 §4.9 的旧措辞自行另选一个方案——T2 全套判据对此**全盲**。
更麻烦的是 ⚠️ 那句**主动把人推离** §4.9：「§4.9 全文一次都没提 Q1」——字面为真，但读者据此得出的是「§4.9 与 Q1 无关」，而它承载着 Q1 的两个选项原文。**这是第三次同型复发**：把「按某个查询没找到」当成「不存在」，正是同段自己命名的 `verified-by-a-wrong-query`。
建议：① 五行表加第六行「**§4.9** `Compound command phase与partial表达` | 该方案在 SQLite additive columns 上的落地约束 | 现写『该项作为 open question 交主会话选择 A 或 B，不能私建旁路表』 | 改为『已裁 X，按 X 的 key 形状增列，仍不得私建旁路表』」；② 完备性依据从字面 `Q1` 的 awk **换成上面那条内容轴查询**，并把「§4.9 一次没提 Q1」改成「**§4.9 不含字面 `Q1`，但含 Q1 的选项原文——按字面搜索会漏掉它，这正是本条要防的**」；③ 记下两处低置信邻居供一并过目：`§4.12:435`（更小/更大方案对比）与 RFC 头部 `:3`「状态：草案，待主会话／用户确认 open questions 后进入实施计划」——后者在 Q2/Q5 仍 open 时不必动，但裁完最后一条 open question 时必须一起改。

## ④ 本轮是否再引入新缺陷

- `git show 3be24a4d --stat` = 3 文件（HANDOVER +30/−9、run-log、新增 `baseline-runs.sh` 110 行），**未动 `design.md`**。
- `git show ... | rg '^\+' | sort | uniq -d` → 仅一个裸 `+`（空行），**无重复新增行、无 collateral**。
- `baseline-runs.sh`：`bash -n` **语法通过**；文件头把「为什么是脚本不是散文配方」写成三条具体失效（provenance 与运行不在同一个 shell、没有 tree↔commit 一致性检查、`cmd | tee log` 报的是 tee 的退出码所以红跑看起来是绿），并**自陈边界**「它仍不能向第三方证明这些跑是真的——本地没有任何东西能做到；它只消掉上述失效面」。第 20-24 行还记下自己第一版的 bug（命令走字符串 env var 会 word-split，导致红路径正控**因错误原因通过**）。`OUT` 必填、`RUNS` 默认 15、`ALLOW_DIRTY` 需显式开且每份日志打 DIRTY 标记并注明「Do not use this for a gate」——**这几条把「脚本本身变成新的自证工具」的风险堵住了**。`exp/` 被 `.gitignore:27` 覆盖，`git ls-files --error-unmatch` 确认该脚本**已被追踪**（`add -f` 生效），不会被未跟踪文件清扫命令静默带走。
- run-log:14 与 HANDOVER T3 修复 AC④ **都已改指该脚本**，措辞一致，无双源漂移。

**本轮唯一新引入的是 N11**（五行表的完备性声明 + 那句「§4.9 没提 Q1」的误导性）。N12 是 N9 修订里遗留的未答问题，非新写坏。

## 第五轮 verdict

- **blocker 0**
- **major 1**：N11
- **minor 3**：N12 + 遗留 F7（KICKOFF 复述 HANDOVER 数字）、F8（`kickoff.md` 无作废横幅）
- N8 / N9 / N10 主体 **闭合**；`baseline-runs.sh` 是本轮最扎实的产出——把一条会被自证的散文配方换成了带自陈边界与失败史的可执行件。

**不给「无未决 blocker/major」**：N11 会让 Q1 裁决后 §4.9 残留一句「作为 open question 交主会话选择」，而实施 Commit 5 的人正是读 §4.9 的人，T2 全套判据对此全盲。改法是表加一行 + 完备性依据从字面查询换成内容轴查询。**无未决 blocker。**


---

# 第六轮复审（master `6d578b57`）

## ① 我能不能找出第八处（换我自己的查法）

### N13 [major] **§4.8「字段基数与存储分界」是第八处**——而且它与选项 A **正面冲突**，你的谓词结构上看不见它
我的查法**不用 Q1 词汇**，改问一个结构问题：**「选项 A 会新增一个 bounded dimension，那么『新 dimension 必须登记在哪张表』『哪里规定了 compound 命名』？」** 顺着这条找到 §4.8。实测：
- `sed -n '388,407p' design.md | grep -acE 'Q1|联合查询|compound dimension|multidimensional'` → **0**。`q1-locations.sh` 报「no unlisted section」正是因为它一处都不命中。
- 但 §4.8 是 RFC 里**唯一**逐字段规定「哪个字段是 bounded dimension／counter key」的规范表；选项 A（`design.md:695`）要新增的 `generation_command_outcome` **就是一个 bounded dimension**，不登记进 §4.8 就没有 SSOT。
- 更硬的是 `design.md:392` 的 `command` 行原文：「取RFC冻结的command family枚举；**不得使用函数名、任意error字符串或动态compound名称**」——**这是一条对 compound 命名的禁令**。选项 A 落地后，§4.8 至少要写清「静态笛卡尔积生成的有界 compound dimension 不属于此处禁止的『动态 compound 名称』」。
接手方错误动作：Q1 裁 A、七处全同步、`q1-locations.sh` rc=0、证伪④通过——然后 Commit 5 的实施者打开 §4.8（他必须打开，那是他要照着建 SQLite 列的表），读到「不得使用……动态 compound 名称」，与自己正在建的 `generation_command_outcome` 直接抵触。两条出路都坏：按 §4.8 放弃 compound 维（等于推翻已裁的 A），或自行判定「这不算动态」（无 RFC 出处的自裁，撞 T4 证伪①）。
建议：EXPECTED 增第 8 行 `4.8|absent|destination|bounded dimension 规范表；裁决后必须登记新维并澄清「动态compound名称」禁令的边界`，并把 PREDICATE 扩到能命中它（加 `bounded dimension|counter key|compound名称`）——**但更重要的是把「怎么找第八处」的方法写进脚本注释**：不是加关键词，而是问「这个裁决会产生什么新对象／新约束，RFC 里哪张表登记这类对象」。低置信邻居一并记下：§10.2 R-9 行（`design.md:756`「比较canonical key集合」）在 A 落地后其 oracle 的 key 集合会变，但措辞方案无关，暂不入表。

## ② 裁决落地时该怎么更新脚本——写清楚了吗

### N14 [major] 脚本**没有裁决后的校准**：正确落地裁决会让它变红，且状态词汇里根本没有「已裁」这一态
我没有停在读注释——**我做了一次落地模拟**（只读仓库：复制 `design.md` 到 `/tmp/q1sim/`，按表格「裁决后必须变成」那一列改 §9.2／§9.4／§7.8，再用 `DOC=` 指向副本跑脚本）：

```
7.8    declares-open    silent-on-cube   DRIFT
9.2    absent           declares-open    DRIFT
9.4    declares-open    silent-on-cube   DRIFT
rc=1
```

两个具体缺陷，都不是「忘了改 EXPECTED」那么简单：
1. **`state_of` 只产出三个值 `absent / declares-open / silent-on-cube`，没有一个表示「已裁」。** 正确落地后 §7.8／§9.4 变成 `silent-on-cube`——这个标签字面意思是「提到了 cube 但没说 open 与否」，用它记录「已裁决方案 A」是**名实不符**，下一个读 EXPECTED 的人会以为那几节丢了裁决信息。
2. **§9.2 落地后被判成 `declares-open`，而理由与 Q1 无关**：§9.2 正文自带「以下不是 open questions：」这句 boilerplate，命中 `declares-open` 关键词集。于是「裁决落盘的正主」在裁决完成后，会被这个 oracle 标成「宣告 Q1 仍 open」——**恰好相反**。接手方若照实把 EXPECTED 改成 `9.2|declares-open`，就把一个反向的标签冻进了判据。
接手方错误动作：改完 RFC 跑脚本得 rc=1 三行 DRIFT。最省事的反应恰恰是本项目 `criteria-fail-two-ways` 点名的那一种——**判据在正确状态下红 → 执行者改判据或绕过它**：把 EXPECTED 全刷成 actual（判据从此只复述现状、零判别力），或干脆认定「脚本是裁决前的工具，裁决后作废」而不再跑（那第八处、第九处就再无守卫）。你担心的「永久红着被无视」是其中较轻的一种。
建议：① 给 `state_of` 加第四态 `ruled`（关键词如 `已裁决方案|裁决为方案|Q1：方案`），并让 `declares-open` 与 `ruled` **互斥判定**（先判 ruled）；② §9.2 的 boilerplate 要排除——按行判而非按整节 grep，或对 destination 类只看含 predicate 的那些行；③ EXPECTED 每行改成 `裁决前|裁决后` **两个期望值**，脚本接 `PHASE=pre|post`（默认 pre），**裁决后只需改一个环境变量而不是重写七行**——这样「忘了改脚本」在结构上不再可能；④ 把「同一 commit 内一起改」从脚本注释**提到 T2 的验收里**（现在 T2:17 只要求「退出 0」，没有一句提到 EXPECTED 需要维护，而脚本注释接手方未必读）。

## ③ R-6 的「候选拆法」会不会被当成已定结论

**基本不会，框定是清楚的。** T4 该段实测原文：「**这是 RFC 的既有缺口，不是接手方该自行填的空**」→「**处置是把它列成一条待 RFC 补齐的调查项，停下来问，别自己填**」→「**走 §9.1／§9.4 的 open question 机制，交主会话／用户**，与 Q1／Q2 同一条通道」→「把这条对应关系作为**候选**提出，**由主会话／用户确认两段各是什么等级**」。四层递进，且「候选」「由……确认」两处限定词直接落在提案句里。N12 闭合。

### N15 [minor] 但「摆 3–4 个带量化影响的选项」与「只给了 1 个候选」之间没有搭桥
实地：该段引 `scope-ambiguity-then-ask` 要求 3–4 个选项，紧接着只给出一个候选拆法（compile fixtures↔§7.4 Commit 1、import guard↔§7.9 Commit 6）。
接手方错误动作：① 为凑数**编造**另外两三个选项（本项目对「为满足形式而造内容」已有教训）；② 只交一个候选就当满足了提问规范，用户实际拿到的仍是 yes/no。
建议：补一句「**这是 3–4 个选项里的第一个**；另外两个天然候选是『两段同为辅助门（即 RFC 现状的字面读法）』与『Commit 6 那段升为 production 硬门（legacy 删除后 guard 必须真红）』——**量化影响写「哪一档失败会阻断交付」**」。

## ④ 本轮有无新缺陷

- `git show 6d578b57 --stat` = 3 文件（HANDOVER +39/−?、`baseline-runs.sh` +49、新增 `q1-locations.sh` 115 行），**未动 `design.md`**。两个脚本 `bash -n` 均通过；`q1-locations.sh` 已被 git 追踪（`exp/` 在 `.gitignore` 内，`add -f` 生效）。
- **`q1-locations.sh` 裁决前跑：`7/7 as expected, no unlisted section`、rc=0** ✓，与 T2:17 的验收一致。脚本注释把三版清单的失败史与「为什么第 2 项承重」写清楚了，并自陈「首跑就抓到 4.12」——这是本轮最有价值的结构改进：**它把一个反复错五版的手写清单换成了带 unlisted 检测的 oracle**。
- `baseline-runs.sh`：`MIN_RUNS` 默认 15、`RUNS < MIN_RUNS` 直接 exit（堵住 `RUNS=0` 报 `0/0 green` 的空真）；运行前后比对 `tree`+`HEAD`，drift 计入 failed 并在日志打 `=== drift : YES (…)`。两处都是真机制，不是措辞。
- T4 的 `NOT-YET-IN-SCOPE` 白名单我逐条对了 §10.3／§10.4：`O-3/O-4(仅完整真SDK验收部分)/O-5/O-7/O-9` **恰 5 项**，且 O-4 的「靶向复用那部分是 IN-SCOPE，别整条豁免」与 §10.3 O-4 行「仍待 P8，RFC 在 Commit 4 靶向复用」一致 ✓。
- **你自查出的那条 false-red 我复核成立**：`rg -c 'M7' design.md` → **1**（只在 §10.3 的 O-9 行），而 §8 只有 `679` 一行区间「M2～M8 的剩余 feature 本体」，P7／P8 各自成行。改成区间覆盖判据是对的；附带那句「grep `M7` 只得一处，容易误判这个相位不存在」对接手方很有用。
**本轮新引入：无。** N13（§4.8）与 N14（裁决后校准）都是新 oracle **暴露出来的既有盲区**，不是本轮写坏的——N13 是七处清单从一开始就漏的第八处，N14 是脚本天生只覆盖裁决前一半状态空间。

## 第六轮 verdict

- **blocker 0**
- **major 2**：N13（§4.8 为第八处且与选项 A 正面冲突）、N14（脚本无裁决后校准，正确落地会让它红）
- **minor 3**：N15 + 遗留 F7（KICKOFF 复述 HANDOVER 数字）、F8（`kickoff.md` 无作废横幅）
- N11 / N12 **闭合**；`q1-locations.sh` + `baseline-runs.sh` 的 `MIN_RUNS`／drift 检测是本轮实质产出。

**不给「无未决 blocker/major」**：N14 尤其要紧——它让判据在**正确状态**下变红，而本项目已有教训说执行者对 false-red 的自然反应是改判据或绕过；配合 N13，裁决落地后接手方既会撞上一次红，又仍漏掉一处与已裁方案冲突的规范表。**无未决 blocker。**


---

# 第七轮复审（master `b5cb9b86`）

## N13 / N14 / N15 闭合核验

- **N13 —— 闭合，处置比我建议的更稳。** §4.8 已作为 `constraint` 类入表并**自带精确模式** `动态compound名称`（我原建议是把 `compound` 折进全局谓词——你实测放宽到裸 `compound` 会命中 18 个小节、把绊线变噪声，**你的判断对，我的建议会毁掉这条判据**）。完备性措辞已全撤，脚本头写进「it has also been beaten once」并点明**换轴提问比加词有效**。
- **N14 —— 闭合，我复跑验证机制对称有效**：`bash q1-locations.sh` → `8/8 as expected, no unlisted section`、**rc=0**；`PHASE=post` 同一份未裁决的 RFC → **八行全 DRIFT、rc=1**。第四态 `ruled` 已加；状态改为只看命中谓词的行，§9.2 的 boilerplate 不再污染判定。
- **N15 —— 闭合。** R-6 现给三个候选（按判据列拆／两段同为辅助门／Commit 6 升 production 硬门），各附量化影响，并写明「只交一个会诱使接手方编造凑数」。

## ① 再换一条轴：**第九处在载体轴上**

### N16 [major] `q1-locations.sh` 只扫 `design.md`，而 **HANDOVER T2 与 KICKOFF:32 本身就是 Q1 位置**——它们恰恰是把人送进 RFC 的那两份文件
我这次换的轴不是词汇、也不是结构，而是**载体**：「Q1 的陈述只可能写在 RFC 里吗？」实测：
- `rg -ln '联合查询|command × outcome × format|compound dimension|multidimensional' docs/ .claude/skills/` → 命中 6 份，其中**两份是入口文档**：`docs/plan/.../HANDOVER.md`、`docs/plan/.../KICKOFF.md`（`.claude/skills/` 零命中，遥测 skill 无 Q1 依赖，这点可以放心）。
- `KICKOFF.md:32` 原文：「仍待裁决：Q1（telemetry 联合查询能力）——阻塞 Commit 5，不阻塞 Commit 0–4，见 HANDOVER T2」。
- HANDOVER 侧：T2 的**标题**就是「T2 —— Q1 未裁决（阻塞 Commit 5…）」，加上表格整列「裁决前」。
- 而脚本 `:42` 是 `DOC="${DOC:-$REPO/docs/rfc/.../design.md}"`——**扫描范围是一个默认环境变量**，T2:20 的验收句「`q1-locations.sh` 退出 0（八处状态全部符合预期，且冻结名单之外没有小节命中冻结谓词）」**一个字都没说这只限 design.md**。
接手方错误动作：裁决 Q1=A → 同步八处 RFC → `PHASE=post` → **rc=0**、证伪④通过 → 判定「Q1 已闭合」。但 **KICKOFF 是新会话贴进去的第一条消息**，它仍写「仍待裁决：Q1」，而 KICKOFF「第一步」分支表写着「尚未裁决 → 把 T1 摆给用户，**不要自行选一条往下走**」。于是**下一个会话对一个已裁的问题重新去问用户**；或者它发现 RFC 说已裁、入口文档说未裁，判定这套文档不可信而全面重新推导。**这正是七轮来一直在打的那类缺陷，只是搬到了「指路文档」这一层：oracle 守住了 RFC，没守住把人送进 RFC 的两份文件。**
注意这条**不被 T2:21 的免责声明覆盖**——那条说的是「谓词可能被没想到的措辞绕过」（词汇轴），而这里的两处**命中谓词命中得好好的**，只是不在扫描的文件里（载体轴）。
建议：① 脚本支持多文档（`DOCS=` 或第二组 EXPECTED），把 `HANDOVER.md`／`KICKOFF.md` 的 Q1 陈述登记为 `mirror` 类成员，`PHASE=post` 时要求它们也翻；② 退一步的最小修法：T2:20 验收补一句「**同一 commit 内改 KICKOFF:32 与 T2 的标题及表格**」；③ 无论走哪条，脚本头必须写明**当前扫描范围只有 design.md**——现在连这层限定都没写出来，读 T2:20 会以为 rc=0 覆盖全部。

## ② `PHASE=pre|post` 接手方真的会翻吗

**机制本身合格**（对称、可实跑、两列写在同一行所以不能以「漏改」形式失效），且 T2:20 已把它写进**验收正文**并注明「**这一步属于本条验收，不是脚本注释里的建议**」——触发点可达，这正是本项目 `downgrading-a-gate-needs-a-reachable-trigger` 要求的形状。**但同一条 T2 里另有一句相反的指令：**

### N20 [minor] T2:26 的收尾指令仍是「重跑 `q1-locations.sh`（**八行全过**）」，没提翻 PHASE——裁决后照它跑就是八行全红
实地：我用当前（未裁决）文档实跑 `PHASE=post` 得八行全 DRIFT，反过来同理——裁决落地后按 T2:26 跑默认 `PHASE=pre`，会得到**八行全 DRIFT**。接手方看到「按文档指令跑出来全红」，最自然的三个反应都坏：以为自己改坏了 RFC 而回滚正确的裁决同步、把 EXPECTED 刷成 actual、或直接判定脚本已过期不再跑（**你担心的「红着被无视」的真实入口在这里，不在 PHASE 机制本身**）。
建议：T2:26 改成「重跑 `q1-locations.sh`——**裁决前 `PHASE=pre`、裁决后 `PHASE=post`，八行全过**」。

## ③ §4.8 那条冲突会不会仍被自行化解

**基本不会。** T2:17 的框定是本文件里最强的一处：🔴 标记 +「**别自行化解**」+ 两种读法都摆出来（笛卡尔积静态有界 vs 禁令本就覆盖）+「**由实施者自判『这不算动态』是无出处的自裁**（撞 T4 证伪①）」+ 处置明写「连同两种读法摆进 Q1 的裁决材料，由主会话／用户在裁 A/B/C 时**一并裁掉**」。更关键的是有**机械兜底**：`PHASE=post` 要求 §4.8 那行变成 `ruled`，自行化解而不落盘会被脚本判红。

### N19 [minor] 但 T2:2 的「问题」行仍只列 A/B/C，没带上 §4.8 这条约束
实地：T2:2 原文止于「选项 A（预组合有界 compound dimension，RFC 推荐）/ B / C」。裁决材料若从这一行生成（这是最自然的取材点——它就叫「问题」），§4.8 冲突会被漏在 15 行之后的 🔴 段里。
接手方错误动作：按 `scope-ambiguity-then-ask` 摆 A/B/C 三个选项给用户，用户裁了 A，而「A 与 §4.8:392 禁令的关系」**根本没进裁决材料**——于是裁决落地时 §4.8 那行无从写 `ruled`，接手方要么回头再问一次（用户体验上像是没想清楚），要么就地自判（正是 🔴 段禁的）。
建议：T2:2 末尾补一句「**选 A 时必须同时裁 §4.8:392『动态 compound 名称』禁令是否覆盖笛卡尔积生成的静态 compound 维**——这是同一次裁决的一部分，不是后续细节」。

## ④ 本轮新缺陷

### N17 [major] T2 内部计数漂移：**验收写「八处」，而 operative 的证伪②仍写「七处」**，导语也仍写「真正的成员有七处」
实地 `rg -n '七处|八处' HANDOVER.md` → 三处命中：`:93` 验收「**八处**状态全部符合预期」✓；`:95` 证伪②「**七处**只同步了一部分（destination 仍为 absent 也算没同步）」✗；`:76` 导语「而真正的成员有**七处**」✗。
接手方错误动作：**证伪条款才是他逐条对照的那张单子**（验收是一句命令、证伪是一份清单）。照证伪②枚举七处并宣布同步完毕——而少算的第八处**恰恰是 §4.8**，即唯一带实质冲突、且 T2:17 用 🔴 标出「别自行化解」的那一处。判据把自己最承重的成员数漏掉了一个。
建议：`:95` 与 `:76` 一并改为「八处」，并且**别再在散文里写数字**——改成「以 `q1-locations.sh` 的 EXPECTED 行数为准」，否则下一次加第九处时同样的漂移会再发生一次（这已经是本文件第二次因散文里的数字与实际集合脱节而出问题，上一次是 RFC「786 行」实为 818 行）。

### N18 [minor] `MIN_TESTS` 默认 1，而 T3 的 AC④／run-log 都没写死入场跑该用多少
实地：`baseline-runs.sh:54` `MIN_TESTS="${MIN_TESTS:-1}"`；脚本注释 `:36-38` 自己写着「**Set it to the expected baseline count for a gate**」。但 `rg 'MIN_TESTS' HANDOVER.md` → **零命中**，run-log 只在正样本对照里提了假 `bun` 那条。默认 1 确实堵住了它的动机案例（假 `bun` 跑 0 条 → `0 < 1` → 判红，我核过 `:148` 的比较），**但堵不住「跑成了别的档」**——`parallel-test.ts unit` 单档也远大于 1，会照样报绿，而 RFC §7.1 的入场条件要的是 `unit+it+http`。
建议：T3 修复 AC④ 与 run-log 的配方行都写死 `MIN_TESTS=<entry commit 上实测的总条数>`（当前基线是 6845），并说明「这个下限是防档位跑错，不是防伪造」。

### 其余核验通过
- `git show b5cb9b86 --stat` = 4 文件，**未动 `design.md`**；两脚本 `bash -n` 均通过；`q1-locations.sh` 仍被 git 追踪。
- `baseline-runs.sh` 新增的二进制 provenance 我核了实现：`:101` `command -v "${CMD[0]}"`、`:102` `"${CMD[0]}" --version`，与 `PATH` 一并写进每份日志 —— 假 `bun` 那条假绿的**成因**（命令文字不变、无从分辨）被真正消掉了。脚本注释还诚实标了边界「This does not defend against a hostile …」。
- run-log:16-17 的正样本对照已记到**十条**且标「均实测」，与脚本行为一致。

## 第七轮 verdict

- **blocker 0**
- **major 2**：N16（第九处在载体轴：HANDOVER／KICKOFF 不在扫描范围，且 T2:20 未声明这层限定）、N17（证伪②与导语仍写「七处」，漏算的正是 §4.8）
- **minor 4**：N18、N19、N20 + 遗留 F7／F8（KICKOFF 复述 HANDOVER 数字、`kickoff.md` 无作废横幅）
- N13 / N14 / N15 **全部闭合**；`PHASE` 机制与二进制 provenance 都是真机制，实跑验证过。

**不给「无未决 blocker/major」**：N17 是一句话的改动但影响最直接（照证伪②枚举会正好漏掉 §4.8）；N16 则说明这套 oracle 的边界仍需明说——**它守 RFC，不守指路的文档**，而下一个会话最先读到的恰恰是后者。**无未决 blocker。**


---

# 第八轮复审（master `5a71607f`）—— 收口

## 前轮闭合核验（实跑）

`bash exp/inter-block-anchor-allocator/q1-locations.sh` → **8 RFC sections + 2 carriers all as expected, no unlisted section**、rc=0。两个 carrier 的行级模式我逐条核过：`KICKOFF.md|裁决：Q1` 精确命中 `:32`「仍待裁决：Q1（telemetry 联合查询能力）」；`HANDOVER.md|^### T2 ——` 命中 T2 标题行。**你把 RFC 撤出 CARRIERS 是对的**——整文件判定下任何讨论过该问题的文档都恒 `declares-open`，那确实是 false-red 生成器；你被自己的正控打出来这一点，比我提的建议更早发现。
- **N17 闭合**：`rg -n '七处|八处|九处' HANDOVER.md` → **零命中**，散文数字已全部撤下，权威计数只剩脚本的 `EXPECTED`+`CARRIERS`。
- **N18 闭合，且强于我的建议**：`MIN_TESTS` 改成**必须显式给、脚本无默认值**（`:113`），参考锚 `cc909c81 → 6845` 并注明 entry commit 不同则以那次实测为准。我只建议写死一个数，你把它升成了硬性参数。
- **N19 闭合**：`:76` 已在「问题」行紧邻处写明「裁决材料还必须带上一条约束，别只端 A/B/C 出去」。
- **N20 闭合**：收尾指令已分相位，证伪补了「只跑了 `PHASE=pre`」。
- **把 run gate 的声称缩小**（不再声称「全后端套件已执行」，改为「具名命令被调用 N 次、带 provenance、自报计数稳定且高于调用方指定下限」，并把 full-suite oracle 列为具名待办 T3-b）——这是本轮最诚实的一处处置：`MIN_TESTS` 与它检查的数同源，加固不了，**缩小声称范围而不是假装加固**，正是 `evidence-weaker-than-it-looks` 要的动作。

## ① 第四条轴：我试了三种，都没找到可 demonstrate 的错误动作

前三条轴（词汇／结构／载体）之后，我实地试了另外三个方向，逐个给结论——**没有一个够格成为发现**：

1. **实例轴（同类缺陷的兄弟实例）** —— 问「Q1 的多点散布问题，Q2／Q5 有没有同样的病，而它们没有 oracle」。实测按小节分布：**Q5 横跨 10 个小节**（§6.1／6.3／6.5／7.7／7.10／7.13／9.2／9.3／9.4／10.2），比 Q1 的 8 处还散；Q2 只有 2 处（§9.1／9.4）。
   **但我说服不了自己这是缺口**：Q5 的**裁决已经做完**（帧序变更接受，落在 §9.2 与 HANDOVER「用户已裁决」表），根本不存在「把一个待裁结论传播到 N 处」的问题；它剩下的是 Commit 4 前的逐帧 diff 停门，而 T4 的矩阵**明写覆盖「§9.4 停点」**。Q2 只有 2 处且其停点由 T6 的 ADR D2 段承接。**我构造不出一个接手方会因此做错的具体动作**，所以按「没有问题配额」的纪律，这条只作观察记录，不列为发现。
2. **代码轴（裁决的下游落点在源码里）** —— 问「Q1 裁 A 会新增一个 dimension，源码侧有没有对应的 SSOT 会被漏改」。实测：`src/lib/observability/telemetry-dimensions.ts:147` 是 `const DIMENSION_EXTRACTORS: Record<TelemetryDimensionName, TelemetryKeyExtractor>` —— **穷尽 Record**。新增 dimension 名而不补 extractor 是 **compile-red**。这一轴**由类型系统自守，比任何 grep 型判据都强**，不是缺口，反而是这套设计里最硬的一段。
3. **沉默／否定轴（因「什么都没写」而参与的位置）** —— 已经被 `destination` 类建模掉了（§4.7／§9.2「按设计是空的，absent 才是正确状态」），并且证伪②明写「destination 仍为 absent 也算没同步」。这一轴已闭合。

**结论：三条轴已尽我所能。** 我不再声称能找到第九处；同时**这不等于集合已闭合**——脚本头「it has also been beaten once」那句和 T2:21 的免责，仍是这份文档里最该保留的两段话。**换轴提问比加词有效，而下一条轴会由下一个撞上它的人发现，不是由这份判据。**

## ② 未决项与 verdict

逐条复核我八轮里提出的全部条目：blocker 1 条（锚定基准分裂）与 major 13 条（F1／F4／F5／F6／N1／N4／N5／N6／N8／N11／N13／N14／N16／N17）**全部闭合并经实地复核**。仍开的只有两条长期 minor：
- **F7** —— KICKOFF 仍复述一处「21 次」（`rg -c '21 次' KICKOFF.md` = 1）。危害已大幅消解：那一处现在自带「自我报告的摘要、不是独立可核验的原始输出，**别当门禁已过**」。
- **F8** —— 同目录的陈旧 `kickoff.md` 仍无作废横幅（`head -3` 确认首段仍是「本计划分 9 个相位（P0–P8）」）。缓解仍是一跳：它指向的 `README.md:3` 有「**接手入口是 HANDOVER.md，不是本文件**」。

# **无未决 blocker/major。**

状态行可以从「草稿·未评审」改掉。两点建议随手带上（不是新的评审意见，是改状态行时该一并写准的事实）：
- 写清**评审了什么**：本文件与 KICKOFF 经**八轮**接手方第一人称走查（`docs/tmp/2026-08-03-handover-review-successor.md`），收敛至 0 blocker / 0 major，遗留 2 条 minor（F7／F8）已具名。
- **RFC 本体不在本次评审范围内**——我只在它被 HANDOVER 引用到的位置上核过（§4.6／4.7／4.8／4.9／4.12／6.x／7.x／9.x／10.2／10.3／10.4）。它自己的六轮评审记录是另一份证据链。

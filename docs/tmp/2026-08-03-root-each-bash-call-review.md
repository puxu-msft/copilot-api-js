# 评审报告：用户级 always-on 规则新增 `root-each-bash-call`

- **日期**：2026-08-03
- **被审对象**：`/home/xp/.claude/rules/00-user/20-tool-use-preference.md`（英文生效投影，实际注入）与 `/home/xp/.claude/rules/00-user_zh/20-tool-use-preference.md`（中文权威源，`paths: should_no_match.disabled` 不注入）中新增的 `root-each-bash-call` 条目，未提交状态。
- **评审强度**：按 always-on 指令文本最高强度（错误不被任何测试发现，静默作用于此后每一次载入）。
- **本报告不修改任何被审文件。**

## 总体 verdict

**修复 3 条 major 措辞问题后可提交。blocker 数：0。**

中英两份语义**基本等价**（一处 nit 级偏差）；三条技术断言（`git -C` / `npm --prefix` / `make -C` 的 command-local 语义）**逐条实测为真**；与 skill `proving-where-a-command-ran` 无技术冲突。三条 major 全部是「会被误读」类：括号里的理由让规则在**恰好是四次事故发生的那个人群（主会话）**上失去说服力；判定条款漏掉该 skill 自己记录的两种失效方向之一；「预防 / 证据」分工把该 skill 的触发面窄化，与 skill 自身及 `git-preference:isolating-from-a-shared-git-worktree` 的 REQUIRED SUB-SKILL 声明不一致。三条都是纯措辞修正，不改变规则意图。

---

## 双视角覆盖证据

### 机械核对做了哪些扫描 / 对账 / 查证

1. **逐句中英对照**：EN `:8-13` vs CN `:10-15`，六句逐一比对（含粗体位置、括号补充、分号 vs 句号的断句差异）。
2. **注入通道实证**：本会话注入的 `# claudeMd` 段**含** `rules/00-user/20-tool-use-preference.md` 正文、**不含** `rules/00-user_zh/`——第一手证实「英文生效、中文不注入」；与 `~/.claude/docs/2026-07-13-rules-rewrite-design.md:11-13` 的记载互相印证。
3. **全 rules 目录冲突扫描**：`rg -i "\bcwd\b|absolute path|working directory|\bcd \b|pushd" rules/00-user/` → 命中**仅**新增的 8-13 行，其余 9 个规则文件零命中，无重复条款。
4. **反向引用扫描**：`rg -l "proving-where-a-command-ran" ~/.claude` → 9 个文件；确认中英两份都引用了该 skill（EN:12 / CN:14），且 `my/git-preference/skills/isolating-from-a-shared-git-worktree/SKILL.md:47,60` 对该 skill 的定位与新规则的转述不完全一致（见 Major-3）。
5. **打开 skill 正文核对分工**（未依赖派活者转述）：`skills/proving-where-a-command-ran/SKILL.md` 全文 173 行，重点核 `:14-19`（两种失效方向）、`:21-28`（When to use / Not for）、`:30-47`（Layer 1/2 表）、`:156`（`git -C` 作为 proof 属 common mistake）。同时注意到该 skill **本身也有未提交改动**（三处把具名实测细节泛化），已纳入交叉核对。
6. **规则登记册对账**：`~/.claude/docs/2026-07-13-rules-retention-map.md:5,61-65` 自述是「持续同步的设计期审计登记册」、记录「当前 rule ID、档位」，其 `### 20-tool-use-preference.md` 小节只列 `batching-calls` 与 `rg`/`fd` preference，**未登记 `root-each-bash-call`**（见 Minor-5）。
7. **引文保真核对**：规则引用的 "working directory persists between calls" 与本会话运行时 `Bash` 工具 schema 实际字符串 "Working directory persists between calls, but prefer absolute paths…" 一致，与 skill `:51` 的引用亦一致。
8. **长度量化**：`wc` 实测——EN 文件 22 行 / 446 词 / 3101 字节，新增条目占 **314 词（70.4%）/ 2000 字节**；单条 `Evidence basis` 行 72 词，比原有整条 `batching-calls`（56 词）还长。全 `rules/00-user/` 语料 8911 词，新增占 3.5%。
9. **证据基线取证**：`~/.claude/projects/**/*.jsonl` 中 `Shell cwd was reset` 的分布与时间戳（见 Minor-3、Minor-4）。

### 第一人称执行视角模拟了哪些流程 / 分支

1. **在本 subagent 执行面跑 snap-back 探针**（三次独立调用）：call A `pwd -P` → `/home/xp/src/copilot-api-js`；call B `cd /tmp && pwd -P` → `/tmp`；call C（独立调用、无 cd）`pwd -P` → **回到 `/home/xp/src/copilot-api-js`**。第一手证实括号里「subagent 上则完全不成立」为真，也证实本会话 `Bash` 工具描述那句在本执行面上为假。
2. **实测 `git -C` 三段断言**：`git -C /home/xp/.claude rev-parse --show-toplevel` → `/home/xp/.claude`，紧随其后同一 shell 的 `pwd -P` → `/home/xp/src/copilot-api-js`（不动 shell cwd ✓）；同一条 `&&` 链里的兄弟命令 `git rev-parse --show-toplevel` → `/home/xp/src/copilot-api-js`（不约束兄弟命令 ✓）。
3. **实测另外两个 command-local 例子**（`mktemp -d` 沙盘，用后按精确路径清理）：`make -C <dir>` 的 recipe 内 `pwd -P` → `<dir>`；`npm --prefix <dir> run where` 的脚本内 `pwd -P` → `<dir>`；两者结束后 shell cwd 未变。三个例子全部准确。
4. **扮演第三方审计员读 transcript 判合规**：把判定条款套到四类真实写法（主会话 leak-forward、同调用内 `cd <abs> && git add -- <相对 pathspec>`、`Read`/`Edit` 绝对路径、脚本写文件），找出一处漏判、一处误判（Major-2、Minor-1）。
5. **扮演主会话读者**走一遍括号里的理由，检查它是否支撑正文的无条件义务（Major-1）。
6. **扮演未来要执行证伪判据的人**，检查这条判据有没有可执行的触发点、执行者、记录位置与计票规则（Minor-4）。

---

## 事实性发现

（EN = `rules/00-user/20-tool-use-preference.md`，CN = `rules/00-user_zh/20-tool-use-preference.md`，均在 `/home/xp/.claude/` 下。）

### [major] EN:8 / CN:10 —— 括号里的理由按「执行面」切分，恰好放走了出事故的那个人群

**问题**：正文的义务是无条件的（「every call binds its own directory root」），但紧跟的括号给出的理由是按**执行面**切分的：「does not hold on several execution surfaces, and does not hold at all for subagents」。

**证据 / 失败场景**：skill `proving-where-a-command-ran:40-44` 的 Layer 2 实测表里，真正的判别轴**不是执行面，而是目标路径是否落在 allowed set 内**——

| 执行面 | `cd` 到 allowed set **之外** | `cd` 到 allowed set **之内** |
|---|---|---|
| Main CLI session | 下次调用前回退 | **保持** |
| Subagent | 回退 | **也回退** |

即：主会话 + 目标在 allowed set 内 = cwd **确实**保持。于是一个主会话读者走这段理由的第一人称推理是：「不成立的是『若干执行面』和 subagent；我是主会话，所以工具描述对我成立」——理由蒸发，剩下一条没有理由支撑的义务。而据派活者陈述，四次事故**正是主会话**发生的。这条规则最需要说服的读者，恰好被自己的理由排除在外。

另外「several execution surfaces」在字面上也偏松：该 skill 只实测了两个执行面。

**修复建议**（中英同步）：把理由改回实测的判别轴，并显式点名主会话不豁免。例如 EN：`(the tool description's "working directory persists between calls" holds only for a main session staying inside its allowed directory set — it is false outside that set, and false entirely on subagent surfaces, where every call restarts at the launching session's cwd)`；CN：`（工具描述所称的「cwd 在调用间保持」仅在主会话且目标位于 allowed set 之内时成立，出了该集合即不成立，在 subagent 上则完全不成立——每次调用都从启动会话的 cwd 重新开始）`。

### [major] EN:11 / CN:13 —— 判定条款只覆盖 snap-back，漏掉该 skill 记录的另一半失效方向（leak-forward）

**问题**：判定条款只问一个方向：「若任何命令的正确性**依赖**前一次 Bash 调用留下的 cwd……本条即未做到」。

**证据 / 失败场景**：skill `:14-19` 明确写了**两个**已观测失效方向，且第二个只发生在主会话：

- **Snap-back** —— `cd` 被撤销，后续命令跑在原树里（判定条款覆盖 ✓）。
- **Leak-forward** —— 「cwd persists further than you intended, so a command you meant to run at the repo root runs in the target dir. (Main-session surface only…)」（判定条款**不覆盖** ✗）。

第一人称走一遍 leak-forward：call 1 = `cd /repo/.worktrees/x && git status`（主会话、allowed set 内 → cwd 保持）；call 2 = `bun test`，作者意图是在 `/repo` 跑。审计员套用判定条款问：「这条命令是否**因为**上次留下的 cwd 才正确？」——不是，它是**因为**上次留下的 cwd 而**错误**。判定条款返回「本条已做到」，而这一轮刚刚产出了一个跑错树的绿。

同一个漏洞也存在于触发句（EN:8 / CN:10）：leak-forward 的受害命令，其目标目录**正是**会话初始 cwd，第一个触发条件不成立；是否落入第二个条件（「读写相对路径」）取决于 `bun test` 隐式发现相对路径算不算，读者会两可。

**修复建议**：判定条款补对称的第二问，中英同步。EN 追加：`…, or if any command that is meant to run at the session root runs without binding that root`；CN 追加：`……，或任何本应在会话根目录执行的命令没有显式绑定该根目录`。

### [major] EN:12 / CN:14 —— 「预防 / 证据」的分工窄化了该 skill 自己划的触发面，与两处 REQUIRED SUB-SKILL 声明冲突

**问题**：规则写「本条只做**预防**。当某个命令的结果要用来支撑一个论断（……），预防不等于证据，走 skill 的 gate」。这句话唯一给出的进入 skill 的入口是「结果要支撑论断」。

**证据 / 失败场景**：打开该 skill 正文核对（未依赖转述），它的「When to use」`:23-26` 共四个触发条件，**其中两个与「支撑论断」无关**：

- `:23` —— 「You are about to **delegate** work to a subagent, agent, or a later Bash call that must happen in a specific tree.」
- `:25` —— 「You are **cleaning up, deleting, or resetting**, and the blast radius depends on cwd.」

而且这两个是被**硬性要求**的：`my/git-preference/skills/isolating-from-a-shared-git-worktree/SKILL.md:47` 写 「**REQUIRED SUB-SKILL:** Use **proving-where-a-command-ran** before dispatching, or accepting the result of, any load-bearing command in the isolated tree」，`:60` 再次 「**REQUIRED SUB-SKILL**」。

第一人称走一遍：一个 always-on 读者要向 subagent 派活去隔离 worktree 干活，脑中检索规则——「我这次不是要拿结果支撑论断，只是派活，所以按规则我只需做预防」→ 跳过一个被两处标为 REQUIRED 的 sub-skill。而 skill `:55` 实测：prompt 里写目录对 subagent 的 cwd **零约束力**，这正是派活场景最需要 gate 的地方。

注意这不是技术矛盾（规则没说「skill 仅用于论断」），而是**唯一被点名的入口条件塑造了读者的心智模型**——always-on 文本是每次都读到的那份，它给出的触发面就是实际生效的触发面。

**修复建议**：把入口从一个扩到三个，仍保持一句话。EN：`… — prevention is not evidence. Run the gate in skill \`proving-where-a-command-ran\` whenever a result is about to support a claim, whenever you delegate work that must happen in a specific tree, or whenever the blast radius of a cleanup depends on cwd.`；CN 对应：`……预防不等于证据。凡结果要支撑论断、凡派活到指定目录树、凡清理的爆炸半径取决于 cwd，都走 skill \`proving-where-a-command-ran\` 的 gate。`

### [minor] EN:11 / CN:13 —— 「只靠相对路径定位目标」与上一 bullet 允许的 `cd <abs> && …` 边界不清，且与既有 pathspec 纪律相撞

**问题**：判定条款第二半句「或任何写操作只靠相对路径定位目标」。「只靠 / alone」的辖域有两种读法：

- **宽读**：只要目标是相对路径就违规——那么上一 bullet（EN:10 / CN:12）明文推荐的 `cd <绝对路径> && …` 形态里，任何 `> out.txt`、`git add -- src/foo.ts` 都被自己的判定条款判违规，**两个 bullet 自相矛盾**。
- **窄读**：相对路径且**同一次调用内没有绑定绝对根**才违规——与上一 bullet 自洽。

**证据**：窄读才是显然的本意，但宽读会与既有纪律正面相撞：`my/git-preference/skills/coordinating-a-shared-git-worktree/SKILL.md:30,44-46` 强制 `git add -- <your exact paths>` / `git commit -m "msg" -- <paths>`，示例全是相对 pathspec；`git commit` 是写操作。一个照宽读执行的会话会以为两条规则冲突。

**修复建议**：把辖域写死。EN：`… or if any write locates its target through a relative path with no absolute root bound in the same call`；CN：`……或任何写操作在同一次调用内没有绑定绝对根、仅靠相对路径定位目标`。（注：`Read`/`Edit`/`Write` 工具本就要求绝对路径，不会被误判；被误判的只有 Bash 内的相对写。）

### [minor] EN:10 / CN:12 —— 「写文件的脚本必须在写入前断言规范化后的目标路径仍在预期根目录之下」字面过宽

**问题**：字面读，**任何**写文件的脚本都必须内置根目录断言。而 always-on 覆盖的日常写法里，大量是 `cat > /abs/path <<EOF` 这类目标本身就是绝对字面量的一次性脚本——对一个已经是绝对字面量的目标再做「规范化后仍在根之下」断言，是纯仪式。

**失败场景**（第一人称）：读者要么每次都加断言（噪音累积，且规则很快被整体轻视），要么当场判断「这条显然不针对我」——而 always-on 规则一旦养成「按需豁免自己」的习惯，同一条里承重的判定条款也会被同样处理。

**修复建议**：限定到真正有风险的形态——目标路径由脚本**自己拼接 / 派生**（而非以绝对字面量传入）时才要求断言。EN：`A script that **derives** its write targets (rather than receiving them as absolute literals) must assert, before writing, that the normalized target still resolves under the expected root.`；CN 同步。

### [minor] EN:13 / CN:15 —— 「证据基线（2026-08-03）」的日期与派活者自述及 transcript 时间戳不合，且用日期无法定位样本

**问题**：规则标注证据基线日期为 2026-08-03，派活说明自述事故发生在「2026-08-02 一次长会话中」。

**证据**：`~/.claude/projects/-home-xp-src-copilot-api-js/0205d11f-….jsonl` 中 `Shell cwd was reset` 事件的时间戳横跨 `2026-08-02T16:43`、`2026-08-02T23:02` 与 `2026-08-03T07:36`–`07:54`（该会话首条记录为 `2026-07-28T11:14`，是一个跨日长会话）；另一会话 `639d465e-….jsonl` 的同类事件全部落在 `2026-08-02`。也就是说单一日期无法唯一指向那次事故集。

**为什么这条不是吹毛求疵**：证伪判据本身是按「会话」定义的（「此后凡……的会话，抽查前 10 个」），基线却按日期标注，两者不同单位；未来执行审计的人无法确定哪一批是基线、从哪一刻起算「此后」。

**修复建议**：基线改用会话 id（如 `session 0205d11f`）+ 日期区间标注，与证伪判据的计数单位统一。

### [minor] EN:13 / CN:15 —— 证伪判据没有执行者、触发点、记录位置与计票规则，结构上不会被执行；且把「来源样本」与「证实票」混同

**问题**：「抽查前 10 个会话；只要出现一次依赖 sticky cwd 的调用，就……升级为 harness/hook 级机械约束」——文本里没有说**谁**在**什么时刻**抽查、抽查结果**记在哪**、「前 10 个」的计数**由谁维护**。

**证据（可执行性其实没问题，缺的是归属）**：审计在技术上完全可做——本次评审就用 `rg -c "Shell cwd was reset" ~/.claude/projects/**/*.jsonl` 得到了跨会话分布。所以缺的不是手段，是**执行契约**。按用户自己的 `30-use-of-agents` 的 `downgrade-self-adjudicated-gates`：同一方既当判官又当被告、且全部条件自评的判据「structurally abusable」，正解是**记录在案、择期换判官裁决**，而不是把条件写进正文了事。目前这条正好落在「无归属 → 永不触发」的形态上。

**第二个缺陷**：`skills/reshaping-a-bypassed-guard/verification-log.md:8-11` 已经确立了本仓库的计票范式——**来源事故属于「基线」，明确不计入任何断言的票数**（「混进票数会污染统计」）。新规则的「四次实测事故」既是这条规则的**来源**、也是它**唯一的样本**，按该范式应记为基线、0 证实 / 0 证伪，而现文本把它直接摆在 `Evidence basis` 位置，读者极易当成「已有四次正向证据」。

**修复建议**：见下方「问题 6」的处置结论——把完整证伪协议移入 skill 的记录文件，正文只留一句 provisional 标记。

### [minor] `~/.claude/docs/2026-07-13-rules-retention-map.md:61-65` —— 规则登记册未登记新 rule ID

**证据**：该表自述（`:5`）是「持续同步的**设计期审计登记册**」，「记录当前 rule ID、档位」；`### 20-tool-use-preference.md（后续新增）` 小节现有两行（`batching-calls` / `rg`、`fd` preference），无 `root-each-bash-call`。提交这两份改动的同时不补登记，即在**指定的档位登记册**上产生一处 doc drift，而该表正是未来判断「某条规则是 `[hard]` 还是 default」的对账依据。

**修复建议**：与本次改动同批追加一行 `| root-each-bash-call | default | 每次 Bash 调用自绑目录根；证据基线一次会话，provisional |`。（`docs/2026-07-13-rules-rewrite-design.md:14` 的行数 / 词数 / 字节数是带日期的快照，**不需要**更新。）

### [nit] EN:11 有 "supposedly"，CN:13 无对应词 —— 中英唯一一处语义偏差

**证据**：EN「if any command is correct only because an earlier Bash call **supposedly** left cwd behind」vs CN「若任何命令的正确性依赖前一次 Bash 调用留下的 cwd」。EN 的 "supposedly" 表达「你**以为**它留下了 cwd（而它可能根本没留下）」，CN 缺这一层。方向上英文更强（更贴近实际失效机理），但中文是权威源，权威源缺了生效版有的语义即为受控性缺口。

**修复建议**：CN 补「……依赖前一次 Bash 调用**自以为**留下的 cwd」或「……依赖前一次 Bash 调用据信留下的 cwd」。

### [nit] EN:8 丢掉 CN:10 的「本轮操作的」限定

CN「当**本轮操作的**目标目录不是会话初始 cwd」→ EN「When **the** target directory is not the session's initial cwd」。EN 少了「本轮操作的」这一限定，字面上「the target directory」的指代略悬空。影响极小，可不改；若改，EN 用 `the directory this round of work targets`。

### 逐句等价性核对结论（问题 1 的完整答复）

| # | CN（权威源） | EN（生效投影） | 判定 |
|---|---|---|---|
| 1 | 触发句 + 「每次调用都自行绑定目录根」 | 同，分号改为句号拆成两句、后半用祈使句 | 等价（EN 丢「本轮操作的」，nit） |
| 2 | 括号：工具描述那句在多种执行面不成立、subagent 完全不成立 | 同 | 等价（**两份同错**，见 Major-1） |
| 3 | command-local 选项三例 + 「只约束该工具 / 不证明 shell cwd / 不约束兄弟命令」 | 同 | 完全等价，且三例**实测为真** |
| 4 | 同一次调用内 `cd` + 绝对路径传入 + 脚本写前断言 | 同 | 等价（**两份同宽**，见 Minor-2） |
| 5 | 判定条款 | 多一个 "supposedly" | 近等价（nit）；两份**同漏 leak-forward**（Major-2） |
| 6 | 「只做预防」+ 走 skill gate | 同 | 等价（**两份同窄**，见 Major-3） |
| 7 | 证据基线 + 证伪判据 | 同 | 等价（两份同问题，见 Minor-3/4） |

**结论：没有一处「英文比中文强 / 弱 / 漏」的实质分岔**（唯一偏差是 EN 多一个 "supposedly"，方向是英文更精确）。规则事实上处于受控状态；本次全部 major/minor 都是**两份共有**的问题，修时必须两份同步改。

---

## 逐题裁定

### 问题 2 —— 与既有条款有无冲突或重复

- **与同文件 `batching-calls`（EN:7）：无冲突、无重复，但有一处未被点破的协同关系。** `batching-calls` 要求「使用多行命令并在内部判断分支」，`root-each-bash-call` 要求「在**同一次调用内** `cd <abs> && …`」——两者同向：把工作塞进单次调用，既省往返又天然自绑根。值得在 `root-each-bash-call` 里点一句「这也是 `batching-calls` 的多行单调用形态的自然结果」，但不点也不构成缺陷。
- **与 `rules/00-user/` 其余 9 个文件：零重叠。** `rg` 扫描 `cwd|absolute path|working directory|cd |pushd` 在其余文件零命中。唯一间接相关的是 `21-git-workflow.md` 的 pathspec 纪律与 `my/git-preference/skills/coordinating-a-shared-git-worktree/SKILL.md:30,44-46` 的相对 pathspec 示例——见 Minor-1，是措辞辖域问题而非规则冲突。
- **与 skill `proving-where-a-command-ran`：技术上一致，分工上有偏差（Major-3）。** 技术断言逐条对上：skill `:156` 把「用 `git -C <path>` 当 proof」列为 common mistake，规则说 `git -C` 「只约束该工具、不证明 shell cwd」——同一立场的两个侧面，且规则自己用「本条只做预防」把推荐 `git -C` 与「`git -C` 不是证据」隔开了，没有矛盾。偏差只在触发面的窄化。
- **额外提醒（超出被审范围）**：`skills/proving-where-a-command-ran/SKILL.md` 目前也是**未提交**状态，`git diff` 显示三处把具名实测细节改成泛化表述（如把「a Claude sonnet `general-purpose` subagent 和一个 GPT-as-agent reviewer」改为「two different agent backends」、把 `A = /home/xp/.claude` / `B = …/my` 的 A/B 改为「a different, existing directory」、把「this session's own schema has `isolation` without `cwd`」改为「a runtime offering `isolation` without `cwd` has been observed」）。方向是把「本会话实况」改成「可复用事实」，合理；但这削弱了未来重测时的可定位性（原文的具名细节正是 `Re-test contract` 想让人复现的）。**这一项建议由派活者自行决定，不属本次评审对象。**

### 问题 3 —— 判定条款是否外部可判

**结论：部分可判。可判性本身没问题，问题是一处漏判（Major-2）和一处误判（Minor-1）。**

- **可机械判定的部分（✓）**：第三方读 transcript 能逐调用检查「这条命令是否在同一次调用内绑定了绝对根」。这是纯语法判断，不需要揣测意图。本次评审自己就跑通了这条路径（`rg` 扫 transcript 的 `Shell cwd was reset` 分布）。
- **不会被误判的正常写法（✓ 已确认安全）**：
  - `Read`/`Edit`/`Write` 用绝对路径——判定条款只谈「命令」和 Bash 内的写，且工具本身强制绝对路径，不会命中。
  - 单次调用内的相对路径 + 同调用内 `cd <abs> &&`——窄读下安全，但**字面上两可**，见 Minor-1，必须把辖域写死。
  - `git -C <abs> <subcommand> -- <相对 pathspec>`——`git -C` 已在该命令内绑定根，相对 pathspec 相对该根解析（实测：`git -C` 会先 chdir），安全。
- **会被误判为合规、实际不合规的部分（✗）**：leak-forward，见 Major-2。这是可判性的**真缺口**——判定条款的方向性提问放走了一整类失效。

### 问题 4 —— `git -C` 那句技术断言是否准确

**结论：三段断言全部准确，且与 skill 立场一致。已实测，非推理。**

| 断言 | 实测命令 | 观测 | 判定 |
|---|---|---|---|
| 「只约束该工具」 | `git -C /home/xp/.claude rev-parse --show-toplevel` | 输出 `/home/xp/.claude` | ✓ |
| 「不证明调用 shell 的 cwd」 | 紧随其后同一 shell 的 `pwd -P` | 输出 `/home/xp/src/copilot-api-js` | ✓ |
| 「不约束同一条链里的其它命令」 | `git -C /home/xp/.claude rev-parse --show-toplevel && git rev-parse --show-toplevel` | 依次输出 `/home/xp/.claude`、`/home/xp/src/copilot-api-js` | ✓ |

**与 skill 的立场核对**：skill `:156` 「Using `git -C <path>` as the proof. `git -C` reports the named tree from any cwd, so it says nothing about where the *rest* of the command ran.」；`my/git-preference/skills/isolating-from-a-shared-git-worktree/SKILL.md:47` 「`git -C <worktree> rev-parse HEAD` satisfies **none** of it」。**完全一致**——skill 说的是「不能当证据」，规则说的是「可以当预防手段，但它证明不了什么」，两者互补且规则里「本条只做预防」那句正是把二者接在一起的铰链。

**顺带核实另外两个例子**（规则未声称、但列了就该准）：`make -C <dir>` 的 recipe 内 `pwd -P` = `<dir>`；`npm --prefix <dir> run <script>` 的脚本内 `pwd -P` = `<dir>`；两者均不改变调用 shell 的 cwd。三个例子全部经得起推敲。

### 问题 5 —— 未标 `[hard]` 是否恰当

**结论：不标 `[hard]`（保持强默认）是对的，但正确理由不是「证据只有一次会话」。**

派活者给的理由（证据薄 → 别绑死所有项目）在方向上对，但它是个**外部理由**，会让人觉得「等证据攒够就该升 `[hard]`」。更结实的理由是**内部的**：按 `00-kernel.md` 的 `hard-rule-vs-strong-default`，强默认允许「a verified true block」或更具体规则覆盖时偏离——而这条规则**恰好存在一个正当偏离基**：会话在本执行面上**实测**了 cwd 保持（skill `:69-78` 的 Re-test contract 就是干这个的），此时依赖 sticky cwd 不是违规而是有据。`[hard]` 会把这个由 skill 明文提供的实测出口一并封死，反而与配套 skill 自相矛盾。

**另一个支持不标 `[hard]` 的结构性理由**：`[hard]` 应留给「违反即不可逆」的条款。这条的兜底不在自身，而在 skill 的 gate——真正承载不可逆后果的场景（拿结果支撑论断、派活、清理）由 skill 的 gate 覆盖，本条只是把地板抬高。地板不需要 `[hard]`。

**但「不标 `[hard]` 会不会形同虚设」的担心是真的**，只是解法不在档位标记上，而在 Major-1（让主会话读者认账）和 Major-2（判定条款能真咬住）。这两条不修，标 `[hard]` 也照样虚设。

### 问题 6 —— 「证据基线 + 证伪判据」留、删、还是移

**结论：移。always-on 正文只留一句 provisional 标记（约 12 词），完整协议移入 `~/.claude/skills/proving-where-a-command-ran/verification-log.md`（新建，套用 `skills/reshaping-a-bypassed-guard/verification-log.md` 的现成范式）。**

三个理由，按分量排：

1. **正文里那句话结构上不会被执行（Minor-4）**，留着只会变成「看起来有证伪机制」的装饰——这恰是用户自己 `downgrade-self-adjudicated-gates` 要防的形态：判据不消失，但**判官与时机要换**，落到一个「必然到达的时点」被独立方裁决。verification-log 就是那个落点。
2. **计票范式已经存在且更严谨。** `reshaping-a-bypassed-guard/verification-log.md:8-11` 明确把来源事故记为「基线（**不计入任何断言的票数**）」并说明理由（「混进票数会污染统计」），`:15-19` 用 `V1 · 0 证实 / 0 证伪` 的形状记账。新规则的四次事故正是这种「既是来源也是唯一样本」的情形，搬进去会被自动记成基线而非证据——比留在正文更诚实。
3. **注意力预算是次要但确实的理由**：该行 72 词，占新增条目 23%，且比原有整条 `batching-calls`（56 词）还长；而它对**任何一次实际执行**都没有指导作用（它指导的是一次将来的审计）。always-on 的每一句都该是「这次就要用」的。

**不建议整段删**：派活者的顾虑成立——删了这条规则就会被当成已验证的定论，而它目前的证据是**一次会话 + 该会话自述**（本次评审能独立证实的只有「`Shell cwd was reset` 事件在多个会话高频出现」和「subagent 上 cwd 确实不保持」，**证实不了「四次事故」这一具体计数**，那是同一作者的自述，非独立来源）。

**建议的正文替代（中英同步，约 12 词）**：
- EN：`- **Provisional** — evidence basis is one session; falsification criteria and audit log live in skill \`proving-where-a-command-ran\`.`
- CN：`- **暂定（provisional）**——证据基线仅一次会话；证伪判据与审计记录见 skill \`proving-where-a-command-ran\`。`

**移入 verification-log 的内容**应包含现文本已有的全部要素，外加正文放不下的三样：审计的**执行时点**（建议挂在 skill 每次被实际调用时顺手记一行，而非另设一次性审计）、**记录形状**（沿用 `- **<日期> · <断言编号> · 证实|证伪|数据不足** — <场景><观察>`）、以及**基线不计票**的显式声明。

### 问题 7 —— 长度与注意力成本

**量化**：新增条目 314 词 / 2000 字节，占该文件 446 词的 **70.4%**——这个文件原本是一份「一行一条偏好」的短清单（`batching-calls` 56 词 + 5 行工具偏好），新条目使它变成 2.4 倍，并成为文件内唯一的多层嵌套块。放在全语料看则不算突出：`rules/00-user/` 合计 8911 词，新增占 3.5%，远小于 `30-use-of-agents.md`（2871 词）。所以**问题不是绝对长度，是文件内的风格断层**。

**可删而不损可执行性的**（按建议顺序）：

1. **`Evidence basis` / 证伪判据整行（72 词，-23%）** —— 移入 verification-log，正文换成 12 词的 provisional 标记。见问题 6。净减约 60 词。
2. **`npm --prefix` 与 `make -C` 两例（约 8 词）** —— 可压成 `git -C <absolute-path>`（or the tool's own directory option, e.g. `--prefix` / `-C`）。**但我不推荐删**：三例实测全准，且「哪些工具有 command-local 选项」正是需要被提示的知识；删了省不到 10 词，收益不抵损失。
3. **触发句里的 `pushd`（1 词）** —— 「`cd`、`pushd`、环境变量或其他 shell 状态」中 `pushd` 被后半句完全涵盖。可删，收益微乎其微。

**明确不得删（承重）**：
- 判定条款（EN:11 / CN:13）——**且应变长**（Major-2 要求补第二问、Minor-1 要求写死辖域）。这条是整条规则唯一外部可判的部分，删它等于把规则退化成一句态度。
- 「预防不等于证据」那句（EN:12 / CN:14）——**且应变长**（Major-3 要求把入口从一个扩到三个）。删它会让读者把 `git -C` 当成证据，正是 skill `:156` 点名的 common mistake。
- Major-1 的括号理由——**应重写而非删**。删了理由，义务就成了无据的祈使句；always-on 里无据的祈使句最先被降权。

**净效果**：按上述建议，条目从 314 词变为约 300 词（移出 60、补回 45），**长度基本持平而承重部分变厚、装饰部分归零**。这比单纯压缩更符合「长远正确 + 完整」。

---

## 主观建议

- **[建议] EN:8 / CN:10 触发句** —— 现在的两个触发条件（目标目录 ≠ 初始 cwd、连续调用读写相对路径）是**枚举式**的，读者需要先自判是否命中才决定守不守。改成默认全域 + 明确豁免（「所有 Bash 调用都自绑根；唯一例外是目标就是会话初始 cwd 且不涉及跨调用状态」）会更难自我豁免。**预期影响**：减少「我这次不算触发」的自判空间，代价是措辞略强硬。**推荐做法**：仅在 Major-1/2 修复后仍观察到自我豁免时再改，避免一次性堆太多变化。
- **[建议] 整条规则缺「派活」这一腿** —— 规则名为 `root-each-bash-call`，天然只覆盖 Bash 调用；但 skill `:55` 实测「prompt 里写目录对 subagent 的 cwd 零约束力」、`:59` 指出 `Agent` 工具有 `isolation` / `cwd` 参数可用。对一个每次都注入的规则来说，「派活时用参数而非在 prompt 里写目录」可能是单位字数价值最高的一句。**预期影响**：覆盖一整类当前 always-on 完全没有提示的失效（且该失效在 subagent 上是 100% 发生，不是概率事件）。**推荐做法**：这会扩展规则名的语义边界，属用户决策——要么在本条加一句子项，要么另立 `bind-delegate-directory` 条目；不建议由评审单方决定。
- **[建议] `batching-calls` 与本条的协同未点破** —— 见问题 2。**预期影响**：读者更容易把「多行单次调用」同时当成效率手段和正确性手段。**推荐做法**：在 EN:10 / CN:12 末尾加半句 `(this is also the natural shape of \`batching-calls\`)`。

---

## 最终表态

**这两份改动：修复 3 条 major 后可提交，blocker 数 0。**

- 3 条 major 全是措辞级修改，均不改变规则意图，且**必须中英同步改**（本次全部问题都是两份共有，不存在单侧分岔）。
- Minor-1 / Minor-2 建议一并改（同样是措辞辖域）；Minor-5（登记册补一行）建议同批提交；Minor-3 / Minor-4 由问题 6 的处置（移入 verification-log）一次性解决。
- 不建议以「先提交、后续再改」的方式落地：always-on 文本每一次载入都在生效，措辞缺陷的成本是按会话数累积的，而修复成本此刻最低。
- 若采纳「移入 verification-log」的建议，新建的 `~/.claude/skills/proving-where-a-command-ran/verification-log.md` 属指令类产物，按 `instruction-text-must-be-reviewed` 需再过一次评审——建议与规则改动一起提交后，作为独立一轮复审派出（我作为叶子执行单元不派活，此处仅向主会话建议）。

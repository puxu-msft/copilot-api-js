# 记忆条目评审（提交 `9e50d514` / `8e1f0cc7`）

## 评审范围

- `docs/memory/methodology-downgrading-a-gate-needs-a-reachable-trigger.md`（新建，31 行）
- `docs/memory/methodology-dont-specify-across-a-seam-you-havent-read.md`（新增实例 5–7 + 推广三问）
- `docs/memory/methodology-mechanism-story-in-spec-must-be-experiment-backed.md`（新增「事后归因同形」段 + Related）
- `docs/memory/MEMORY.md` 第 32、33、74 行三条索引钩子
- 证据源（只读、不评审）：`docs/tmp/2026-08-03-selfverify-mechanism-review.md`（245 行，五轮 + 姊妹 skill 复审）、`docs/tmp/2026-08-03-root-each-bash-call-review.md`、`/home/xp/.claude` 的 `skills/proving-where-a-command-ran/{SKILL.md,verification-log.md}` 与 `skills/reshaping-a-bypassed-guard/verification-log.md`、user-rule `30-use-of-agents`

## 总体 verdict

**可进入下一阶段。Blocker：0；Major：0；Minor：4；Nit：2。**

事实断言逐条对得上评审报告与 `~/.claude` 的落地文件，**未发现放大结论或削掉限定语**——包括最容易出事的那几个数字（`2276` 是作者当场复验的独立读数，不是抄错报告里的 `2274`；正文所描述的两处「修法」在真实文件里确已落地，不是把打算当成已做）。问题集中在三处：全文无一个 `file:line` / skill 名 / 报告路径导致不可追溯、索引钩子的枚举与正文对不上、对源规则要素的复述短了两项。

## 双视角覆盖证据

### 机械核对做了哪些扫描 / 对账 / 查证

1. `git show 9e50d514 / 8e1f0cc7` 逐 hunk 对照提交信息与实际改动，确认无「提交信息声称改了而正文未改」。
2. 逐条把正文断言映射回评审报告行号：三分之二（`selfverify:18`）、三条断言里只裁得一条 + leaf 分支（`selfverify:71`）、`Provisional` 宿主（`selfverify:125`）、初始「没有执行者/触发点/记录位置」（`root-each-bash-call-review:123`）、指纹误报 major 后自撤（`selfverify:226-228`）、vacuous cohort（`proving-…/verification-log.md:81`）。
3. 数字交叉验证（两种原理：报告读数 vs 现场重跑）。`ls -1 /home/xp/.claude/projects/*/*.jsonl` = 1038、`…/subagents/agent-*.jsonl` = 2313（今日，已增长）；作者会话 transcript 内 `tool_result` 原文为「主会话 transcript：1030 / subagent transcript：2276」，时间戳 `2026-08-03T08:50:53Z`，同一会话正文并注明「比评审当时多 2 份，是这期间新产生的」。
4. Python 重算窗口切分：以 UTC 00:00 为界得 `before 1750 / in 989`（1750 是前缀计数、稳定，与报告一致）；以 `828b442` 的 `08:44:41Z` 为界得 `2287 / 452`。
5. 实跑指纹命令：`sed -n '3p' SKILL.md | sha256sum | cut -c1-16` = `8ba8938bbecbe5cf`；去掉行尾 LF = `6643f1eda71d2f01`。与正文所记、姊妹 log 第 39/54 行完全一致。
6. 核实「修法确已落地」：`reshaping-a-bypassed-guard/verification-log.md:13-15,43`（票数改派生视图 + 对账规则 + 根因由叙事改为 dual-write）、`proving-where-a-command-ran/verification-log.md:24-25,37,46,81,92-94`（按日期触发的 cohort、冻结窗口、V4 毕业不影响 V1R）。
7. 文本机械扫描：五个 `[[slug]]` 全部解析到实存文件；三份正文无半角标点越界（唯一命中是 YAML 的 `description: `，合法）；无重复行 / 重复块；MEMORY.md 中新条目只出现 1 次，位于「精炼保留」节。
8. 归属对照：通读 `feedback-skill-claims-needing-field-proof-must-self-verify.md` 与 `feedback-pass-null-clean-not-self-validating.md` 判定重叠面；统计 `methodology-*.md` 的 frontmatter `type` 分布（feedback 44 / methodology 2 / project 18 / reference 3），确认 `type: feedback` 合乎既有约定。

### 第一人称执行视角模拟了哪些流程 / 分支

1. 「我要把一个自评闸门降级」——照本条正文当清单执行：补判官 → 补触发点 → 补记录位置 → 收工。对照 user-rule 原文发现清单短了两项（minor-1）。
2. 「我只在 MEMORY.md 索引上扫一眼」——第 33 行钩子给出的三次打回，与正文第 1–4 条对不上（minor-2）。
3. 「我照这条去复用已落地的范式」——想找那份 cohort audit 协议或票数派生视图的原文，正文没给任何名字或路径，仓库内 `rg` 也搜不到（它们在 `~/.claude`）（minor-3）。
4. 「我按 How to apply 第一条做完第一人称走查，通过了，于是收工」——而本条自己的记录是 4 次全部由外部评审打回（建议 1）。
5. 「我正在做事后归因」——检查 `mechanism-story` 的 frontmatter description 会不会把我召回来：它仍只讲「在 spec 里」（建议 5）。

## 事实性发现

[minor] `docs/memory/methodology-downgrading-a-gate-needs-a-reachable-trigger.md:8` — 对源规则 `downgrade-self-adjudicated-gates` 的复述只列了三样，源规则实际还要求两项 — 正文写「`downgrade-self-adjudicated-gates` 要求的是三样东西：判官、触发点、记录位置」。user-rule `30-use-of-agents` 的同名条目另有两条明写的要求：**The record carries a level; review strength follows the level**（「Without the level, adjudication has to treat everything alike」）与 **Downgrading must be recorded and stated aloud**（「say in your reply that you downgraded it under this rule, so the user can veto」）。第一人称走查：未来会话若拿本条当降级清单，会产出一份**没有 level、也没有当场告知用户**的记录——而 level 正属于「事后再也分不清当时是哪种确信」的那类信息。缓解：user-rule 常驻上下文，读者手上有完整原文，故不判 major。修复建议：改成「规则要的不止三样，本条只谈其中最容易漏的触发点」，或直接补上 level 与 stated-aloud 两项；二者取其一即可，避免第二处维护点。

[minor] `docs/memory/MEMORY.md:33` — 索引钩子的「连打回三次（…）」括号枚举与正文的编号不是同一组，会让只读钩子的人记住错误的第三次 — 钩子写「连打回三次（搬进 skill 只修好三分之二·指针字面只裁得了三条里的一条·没写 leaf 转交分支）」。对照正文：括号第 1 项 = 正文第 2 条；括号第 2、3 项**同出正文第 3 条**（该条原文即「又被打回**两处**」，是同一轮的两个子发现）；正文第 1 条与第 4 条都不在括号里。也就是说钩子把「一轮两处」记成了「两轮」，读者据钩子会以为第三次打回是 leaf 转交分支，而正文的第三次是宿主寿命那条（第 4 条另由钩子后半句「还要查触发点的宿主会不会先于断言消失」单独承载，但不计入次数）。另有一处易误读：正文第 10 行说「连打回三次」，紧跟 1–4 四个编号项，需要读者自行推断第 1 条不算「打回」（第 1 条是初始诊断，此读法成立，故「三次」本身不算错）。修复建议：钩子改为「三轮打回（正文正是这三条）+ 第四轮才发现触发点寄生在会被删除的宿主上」，让钩子与正文编号一一对应。

[minor] 三份新增内容全文没有任何 `file:line`、skill 名或报告路径，事实断言不可追溯、修法也拿不回来 — `rg -n "proving-where-a-command-ran|reshaping-a-bypassed-guard|docs/tmp|root-each-bash-call"` 对两份被审正文**零命中**。被讲述的产物全部住在 `~/.claude`（`skills/proving-where-a-command-ran/`、`skills/reshaping-a-bypassed-guard/`），仓库内 grep 结构性搜不到；两份评审报告就在同仓 `docs/tmp/2026-08-03-{selfverify-mechanism,root-each-bash-call}-review.md` 也未被引。后果有两层：① 未来会话无法复核任何一条断言（本次评审能核，是因为派活消息告诉了我报告路径）；② 拿不到已落地的可复用范式——按日期触发的 cohort 协议在 `proving-where-a-command-ran/verification-log.md:44-94`，票数降派生视图 + 对账规则在 `reshaping-a-bypassed-guard/verification-log.md:13-15`，两者都是本条讲的「修法」的**成品**。对照：同目录既有条目（如 `methodology-dont-specify…:14` 的 `session.ts:46`、`feedback-pass-null…` 引 skill 名）都带指针。修复建议：每条各补一个指针即可（正文一句「实例与落地形状见 `~/.claude/skills/proving-where-a-command-ran/verification-log.md`、评审记录见 `docs/tmp/2026-08-03-selfverify-mechanism-review.md`」）。

[minor] 数字全部缺口径 — `methodology-dont-specify-across-a-seam-you-havent-read.md:20-21` — 「本机 1030 主 + 2276 subagent」「~107 万条事件里 ~8.56 万条没有顶层 `timestamp`」「本会话窗前 1750 / 窗内 630」三组数字都没写产生它的命令、时点与窗口边界（user-rule `every-number-carries-scope`）。**准确性本身已核实、无放大**：85,635 / 1,067,893（`selfverify:161`）≈「8.56 万 / 107 万」，取整诚实；`2276` 经作者会话 `2026-08-03T08:50:53Z` 的 tool_result 独立复验并注明比评审当时多 2 份；`0205d11f…jsonl` 确为作者本人会话（该 transcript 内 27 次出现本记忆文件名），故「本会话」准确。问题在可复现性：今日重跑得 1038 / 2313（单调增长），而 `1750 / 630` 的窗口边界实为 **UTC 00:00**（我用报告最终冻结的 `828b442` 时刻 `08:44:41Z` 复算是 `2287 / 452`）——一条**专讲「没定义用哪个时间字段/边界」**的教训，自身没写边界，是本条最该避免的形状。修复建议：给该实例补一句边界与取数命令（例如「以 UTC 当日 00:00 为界、按顶层 `timestamp`」），或标注为「示意量级，随时间增长」。

[nit] `methodology-downgrading-a-gate-needs-a-reachable-trigger.md:19` — 「票数小节纹丝不动地停在 `0 证实`」用了逐字引用的形态，但旧文件里只有 V1 那行是 `V1 · 0 证实 / 0 证伪`，V2/V3/V4 三行是「数据不足」；三张票也分属 V1/V2/V3 三条**不同**断言（`selfverify:220`：每条各 `1 证实`，不是同一断言的三票）。姊妹 log 自己的复盘（`reshaping-…/verification-log.md:43`）也这么概括，故不误导读者行动，仅是引号内容与原文不完全一致。

[nit] `docs/memory/MEMORY.md:32` — 新增段用了全角 `／`（「角色边界／数据可得性／数据格式」），user-rule `10-text-formatting` 的对照表要求这些符号用半角 `/`。与同一行既有文字风格一致，属存量约定，单独改动价值有限。

### 已核实、不构成发现的命题（列出以证明查过）

- **「~8.56 万条无顶层 timestamp」准确**：`selfverify:161` 记 1,067,893 条可解析事件中 85,635 条无顶层 `timestamp`、982,257 条有、1 条 malformed。
- **「连打回三次」的四条内容逐条属实**：三分之二（`selfverify:18` 原文「原病灶只解决了三分之二」）、「照字面执行只裁得了三条断言里的一条」+ leaf 转交缺失（`selfverify:71`）、`Provisional` 宿主会被删（`selfverify:125` + `proving-…/verification-log.md:92`）、初始「没有执行者、触发点、记录位置」（`root-each-bash-call-review:123`，该轮定级为 minor，正文未声称其级别，无放大）。
- **指纹自撤实例属实且给出的命令能复现所记值**：`selfverify:226-228`；我实跑 `sed -n '3p' … | sha256sum | cut -c1-16` = `8ba8938bbecbe5cf`（含 LF）、去 LF = `6643f1eda71d2f01`，与正文与姊妹 log 第 39/54 行一致。
- **两处「修法」确已落地，不是把打算写成已做**：票数改派生视图 + 「同一次编辑追加记录并重算、提交前从记录重数对账、数不上以记录为准」（`reshaping-…/verification-log.md:13-15`）；按日期触发、不寄生 `Provisional` 的 cohort 审计与冻结窗口 `[2026-08-03T08:44:41Z, 2026-09-02T08:44:41Z)`（`proving-…/verification-log.md:25,37,46,92-94`）。
- **「三票同源」的转述无失真**：`selfverify:218-220` 判「补法正确，没有把三张不同断言的票误合成一张」；被审记忆并未把它写成同一断言的三票。
- **Related 的括号注解有出处**：「零 miss 的 cohort 若一个 exposure 都没有，是 vacuous 而非通过」对应 `proving-…/verification-log.md:81` 的 `vacuously clean` / `records insufficient`。
- **语言约定（命题 ⑤）合规**：三份正文 + 三条钩子的中文段落无半角 `,.:;?!()` 越界（机械扫描唯一命中为 YAML `description: `）；保留 ASCII 的均属允许类别（slug、`[[slug]]`、`timestamp`/`sha256`/`SSOT`/`leaf executor` 等技术标识符、行内 code、命令）。frontmatter `description` 与 MEMORY.md 钩子均为中文。
- **可执行性（命题 ④）三样齐全**：新条具体形态（触发点被写成一句陈述）+ 可执行判据（未来会话在必经流程里会不会真走到 / 宿主会不会先于断言消失 / 执行者有没有这个权限）+ 本轮实例（四条编号记录）；`dont-specify` 的推广三问、`mechanism-story` 的「我的解释能预测出别的可观测后果吗」同样是可当场执行的动作，不是「我意识到了」。
- **无编辑事故**：三文件与 MEMORY.md 无重复行 / 重复块，`[[slug]]` 五个全部解析到实存文件，新条在 MEMORY.md 中只出现一次。

## 主观建议

[建议] `methodology-downgrading-a-gate-needs-a-reachable-trigger.md:23` — How to apply 的第一条「补完判官和记录位置后，**第一人称走一遍**」是一个自评动作，而本条自己的记录是四次全部由外部评审打回；姊妹条 `methodology-dont-specify-across-a-seam-you-havent-read.md:18` 更明写「全部由外部证据打回、**自审一次都没抓到**」 — 预期影响：读者做完自走查就认为闭合，正是本条要防的形态复发 — 推荐补一句「这道走查要由**未写该文本的人**走（本轮 4/4 都是外部评审抓到的，自审 0）」，把它从自评降级为可外部裁决，与 `downgrade-self-adjudicated-gates` 的精神一致。

[建议] 同文件第 20 行「写进文档的指纹必须带 canonical bytes 的取法」与既有 `feedback-skill-claims-needing-field-proof-must-self-verify.md:14`「把基线数字连同**产生它的确切命令**一起写下（口径不同的两个数不可比）」是同一条教训的两个实例，目前两处独立表述、互不引用 — 预期影响：两处会各自演化，未来读者不知道它们是一回事 — 推荐在新条里注明「这是 `feedback-skill-claims…` 那条的第二个实例（上次是基线数字，这次是 hash）」并互链，或整条并入该文件。

[建议] 归属判断（命题 ③）我判为**正确，不应合并** — `feedback-skill-claims…` 管「skill 里需实战检验的断言要内置自验表」，触发场景是「我在写 skill」；新条管「任何自评闸门降级之后，那个触发点会不会真被走到」，触发场景是「我正在降级一个闸门」，两者召回时机不同。与 `dont-specify` 的 leaf 实例重复是**有意分工**（通用形状 vs 闸门后果）且双向互链，也不必合并 — 预期影响：维持现状即可，本项仅记录裁定理由，供后续复核。

[建议] `docs/memory/MEMORY.md:33` — 钩子里补上 ASCII 规则名 `downgrade-self-adjudicated-gates` — 预期影响：会话按规则名 grep MEMORY.md 时能召回（当前钩子只有中文「降级自评闸门」，正文第 8 行才有 ASCII 名）。

[建议] `methodology-mechanism-story-in-spec-must-be-experiment-backed.md:3` 与 `methodology-downgrading-a-gate-needs-a-reachable-trigger.md:3` 的 frontmatter `description` 未随正文扩写 — 前者仍只说「在 spec 里…本轮两条断言全错」，正文已扩到「事后归因」（且此时「本轮」指向哪一轮已有歧义：文件里有 2026-07-28 与 2026-08-03 两轮）；后者未含新增的 dual-write 与指纹两条配套（MEMORY.md 钩子已含）— 预期影响：description 是召回面，做事后归因或找「汇总/明细漂移」的会话可能召不回 — 推荐各扩一句，并把前者的「本轮」改为具名日期。

## 严重度汇总

- Blocker：0
- Major：0
- Minor：4
- Nit：2

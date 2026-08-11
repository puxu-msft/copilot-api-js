# 第二批临时文件清理清单独立评审

- 评审范围：commit `28e8025a` 新增的第二批清理清单，以及指令评审中的「未安置项 → 已消解」更正。
- 冻结版本：`git rev-parse HEAD` = `28e8025ad14b12fa5fff421b701d05fed853a37e`，与指定 HEAD 一致。
- 总体 verdict：修复 Major 后可进入下一阶段；当前不可执行删除。
- blocker 数量：0。

## T1 枚举口径

**判定：PASS**

运行命令：

```sh
find /home/xp/.claude/jobs/14d4ecd1/tmp -mindepth 1 \( -type f -o -type l \) -printf '%y %p\n'
find /home/xp/.claude/jobs/14d4ecd1/tmp -maxdepth 1 -mindepth 1 -printf '%y %p\n'
find /home/xp/.claude/jobs/14d4ecd1 -maxdepth 1 -mindepth 1 -printf '%y %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n'
stat --format='%F %s %y %n' /home/xp/.claude/jobs/14d4ecd1/recap.trigger /home/xp/.claude/jobs/14d4ecd1/state.json /home/xp/.claude/jobs/14d4ecd1/timeline.jsonl
```

关键输出：前两条命令均无输出，分别证实当前 regular file/symlink 集合为 0、顶层条目集合为 0。job 根目录另有 `state.json`、`tmp/`、`recap.trigger`、`timeline.jsonl`；三份 harness 文件均为 regular file，且 `state.json` 在评审期间仍更新到 `2026-08-08 23:20:34 +0000`。它们位于 job 根而非清单明确限定的 `tmp/`，且表现为 harness 活状态，不应纳入本会话临时证据清理。

结论：清单的两个 0 计数准确，没有漏列仍存在于 job tmp 的文件或符号链接；把 job 根下三个 harness 文件判为「不属本会话、不动」恰当。

## T2 六份提交信息的替代证据

**判定：PASS**

运行命令：

```sh
git cat-file -e 3be7182a^{commit} && git cat-file -e 7af27044^{commit} && git cat-file -e 819a7263^{commit} && git cat-file -e 94b6d021^{commit} && git cat-file -e 553985f4^{commit} && git cat-file -e f4efacfe^{commit}
git show -s --format='%H%n%P%n%s%n%n%b' <上述各 commit>
git log --reverse --format='%h %s' 2a4898e8..f4efacfe
```

关键输出：六个 `cat-file -e` 均退出 0。subjects 分别为：`docs: 记录 job tmp 清理执行结果与 V19 观测`、`test: 把合法 native-gated skip 补进 entry discovery allowlist`、`docs: 更正「双评审均 0/0」的错误断言并补落盘处置`、`docs: 处置第二轮复评的 3 条 minor`、`docs: 收录第二轮复评结论`、`Merge branch 'master' into worktree-nghttp2-header-deadline`，与六份消息文件的用途链相符。`f4efacfe` 确有两个父提交 `553985f4` 与 `9fad0bdf`；其完整 body 包含 modify/delete 冲突、接受 skill 删除、逐项归宿和唯一未安置项的处置说明，证实 merge 消息并非只有默认 subject，而携带清单所说的 `mg.txt` 内容。

结论：六份已删提交信息输入均有不可变 Git commit message 替代证据。

## T3 五份校验脚本的替代证据

**判定：PASS**

运行命令：

```sh
git diff-tree --no-commit-id --numstat -r 7af27044
git diff-tree --no-commit-id --name-status -r 7af27044
git show --format= --stat --oneline 7af27044
git show 7af27044^:tests/infra/entry-test-discovery-baseline.json | wc -l
git show 7af27044:tests/infra/entry-test-discovery-baseline.json | wc -l
```

关键输出：`diff-tree` 仅列 `tests/infra/entry-test-discovery-baseline.json`，numstat 为 `9 0`；父版与提交版行数为 993 和 1002，独立交叉支持 +9/-0。

代码证据：`scripts/validate-entry-evidence.ts:316-347` 把 testcase/suite identity 的全部结构字段编码成 key，并保留重复项后 bytewise sort；`:744-759` 从 JUnit 聚合 `actualIdentities`，从 `baseline.allowed_skipped` 去掉只用于说明、不属于身份的 `reason` 得到 `expectedIdentities`，再比较排序后数组的 JSON。数组长度和重复次数都参与比较，故是精确 multiset，而不是 set 或数量比较；同时还对 artifact 中的 `skipped_identities` 做同一比较。

结论：五份一次性脚本的两个长期结论均已有不可变或常驻替代证据，清单所说「脚本本身无长期价值、可重写」没有建立在一个不存在的 oracle 上。

## T4 三个待删 `/tmp` 文件的替代证据

**判定：PASS**

运行命令：

```sh
wc -l /tmp/tmp-rescan-14d4ecd1.txt /tmp/mine-14d4.txt /tmp/theirs-14d4.txt
python3 -c '<逐行取 tmp-rescan basename，并逐项检查正文；展开 mutate-* 与 lint-round2/3/4 缩写>'
git show -s --format='%H%n%P%n%s%n%n%b' 02ecde73
git merge-base 02ecde73^1 02ecde73^2
python3 -c '<分别运行 git diff --name-only 475bed45... <parent>，与 /tmp/mine-14d4.txt、/tmp/theirs-14d4.txt 做 byte-for-byte 比较>'
```

关键输出：三个文件分别为 42、18、49 行。`tmp-rescan` 有 42 个 unique basename，按清单表格的逐字项及两处明确集合缩写（`mutate-*.patch`、`lint-round2/3/4.out`）展开后，`missing=[]`。merge `02ecde73` 的真实父提交是 `3be7182a` 与 `ad8128a`，两父 merge-base 是 `475bed45`。以该 merge-base 实际重建后：mine 为 18 行且 `mine_exact_bytes=True`；theirs 为 49 行且 `theirs_exact_bytes=True`。

结论：`tmp-rescan` 的 42 项记录已全部由仓库文档承载；mine/theirs 两份文件可由不可变 Git 对象逐字节精确重建。删除三文件不会丢失唯一信息。

## T5 流程偏差登记

**判定：MAJOR**

运行命令：

```sh
rg -o 'commit-msg-v19\.txt|m1\.txt|m2\.txt|m3\.txt|m4\.txt|mg\.txt' <session-transcript> | sort | uniq -c
rg -o 'add-skip-identity\.mjs|skip-diff\.mjs|verify-multiset\.mjs|diff35\.mjs|final-check\.mjs' <session-transcript> | sort | uniq -c
rg -o '.{0,300}/tmp/m5\.txt.{0,700}' <session-transcript>
rg -o '.{0,300}/tmp/m6\.txt.{0,700}' <session-transcript>
git log --all --format='%H %s' --grep='<m5/m6 subjects>'
```

关键输出：正文列出的六份消息文件和五份脚本在 session transcript 中均有记录，说明「随用随删」并非凭空自述；但清单漏登记了同类偏差。`m5.txt` 正是生成被评审 commit `28e8025a` 的 `git commit -F` 输入，同一 Bash 调用在 commit 后执行 `rm -f`，未先进入清单与独立评审。随后 `m6.txt` 又以同样方式生成 commit `62ef4e61` 并立即删除。两次 tool result 均证实 commit 成功；两个 commit 的 subject 与消息文件一致。尤其 `m5.txt` 在第二批清单落盘的产生动作中已经存在，不能以冻结 HEAD 排除；`m6.txt` 则证明清单写成后流程偏差仍继续发生。

问题：第 61 行把偏差限定为「下表前两类」，但实际至少还有 `m5.txt`，且之后又发生 `m6.txt`；因此登记不完整。它没有把已登记的偏差说轻——「程序上确实绕过了门」定性准确——但漏掉同类实例，并且没有阻止复发。

下一个接手的人会因此做出的错误动作：会把“6 份提交信息输入”误当成完整总体，并据此认为第二批临时对象已穷尽、偏差已经闭合；实际清单自身和后续 handover 提交仍在用同一违规模式制造并删除未评审消息文件。应由文档作者补记 `m5.txt`、`m6.txt` 及其不可变替代 commit，并把表述从封闭的六份改为与真实总体一致；更新 disposition 后须重新评审。

## T6 「无归宿」更正段

**判定：MINOR**

运行命令：

```sh
git -C /home/xp/.claude cat-file -e 7d4c09f^{commit}
git -C /home/xp/.claude show -s --format='%H%n%P%n%ad%n%s%n%n%b' --date=iso-strict 7d4c09f
git -C /home/xp/.claude show --format= --unified=8 7d4c09f -- skills/closing-a-development-session/SKILL.md
stat --format='%W %w %Y %y %Z %z %n' /home/xp/.claude/skills/closing-a-development-session/SKILL.md
# 从 session transcript 提取 22:39/22:40 两次 grep 命令及输出、23:06 复查输出
```

关键输出：`7d4c09f8...` 存在，subject 精确为 `skills: preserve the peer's job-tmp hardening before it is lost to a merge`，commit 时间为 `2026-08-08T22:48:24+00:00`。该 commit 的 diff 确实新增当前 `SKILL.md:151-153` 小节与「variable expansion plus a pipe ... literal absolute path」措辞。当前 skill 第 153 行仍是该事实。

事后归因核验：**mtime 单独不能证明“grep 时内容不存在”**，因为它只给最后修改时刻，不能给目标行的产生点；但本例不只剩 mtime。session transcript 记录作者在 `22:39:55` 运行跨两个 skill 的 grep、在 `22:40:01` 单独 grep `closing-a-development-session/SKILL.md`，后者明确无输出；`7d4c09f` 的 diff 与 `22:48:24` commit 又证明目标文字在后续变更中被新增。23:06 的复查首次命中第 153 行。因此窄结论「22:40 的零命中当时正确，随后被 7d4c09f 改变」有独立历史证据，不是仅凭 mtime 编造根因。

Minor：文档第 70 行把历史观测写成无锚点的现在时 `文件 mtime 2026-08-08 22:47`。评审时当前文件 mtime 已是 `2026-08-08 23:27:05 +0000`，因为文件又被修改；裸 mtime 不再可复跑。应改成「session transcript 在 23:06 记录当时 mtime 为 22:47，并且 22:40 grep 无输出、7d4c09f diff 后续引入该行」。

下一个接手的人会因此做出的错误动作：若只照第 70 行重跑当前 `stat`，会因得到 23:27 而误判整条更正证据失效；但这不影响该事实已有唯一归宿，也不影响三个待删文件的内容替代证据。

## 结构怪味扫描

- `docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md:61-68`——**动态总体被写成封闭静态枚举，同时产出清单的流程本身继续制造同类临时文件**。处置：本轮必须补账并改成不漏自产 commit-message 输入的流程；因为 disposition 改变，重新独立评审。
- 扫描范围：第二批清单、其产生 commit 的 session transcript、全局 cleanup skill。其余替代证据未见重复实现或职责错位；Git objects 与常驻 validator 均是合适的共享基座，不需要保留一次性脚本。

## 总判定

**不可据当前清单执行 `/tmp/tmp-rescan-14d4ecd1.txt`、`/tmp/mine-14d4.txt`、`/tmp/theirs-14d4.txt` 的删除。** 三文件本身的替代证据已核验充分，且未发现 blocker；但 T5 是 Major：清单漏登记 `m5.txt`，并在清单后又以 `m6.txt` 复发同类绕门删除。按清单自己引用的规则，补充或改变任何 disposition 都使本次 verdict 失效，修正文档后必须重新独立评审。

评审期间分支 HEAD 从已确认的冻结点 `28e8025a` 前进到 `62ef4e61`；T1-T4 与 T6 均锚定其明确对象或不可变 Git object，T5 额外纳入该后续提交作为流程复发证据。此 HEAD 前进本身不改写对 commit `28e8025a` 的核验结果。

## 复评（第二轮）

- 冻结版本：`git rev-parse HEAD` = `83696acf4e529d0bfd367237f99fa2927aa72b6c`，与指定 HEAD 一致。

### R1 Major 整改：消息文件判据与清单完整性

**判定：MAJOR**

运行命令：

```sh
git diff 83696acf^ 83696acf -- docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md
rg -n 'm7\.txt|83696acf|处置第二批清单评审' <session-transcript>
git show -s --format='%H%n%P%n%s%n%n%b' 83696acf
git log --reverse --format='%h %s' 2a4898e8..83696acf
rg -n '^\| `add-skip-identity|^\| `/tmp/tmp-rescan|^\| `/tmp/mine' docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md
```

关键输出与判定：

1. **自指问题的方向识别正确，但判据的 oracle 不充分。**「每份消息文件都对应携带该消息的 commit」是 file→commit 方向，能裁“有文件、无 commit”；`git log --oneline` 只能显示 commit subject，不能证明该 commit 是由某个已删文件经 `-F` 产生，也不能枚举已经删除的文件总体，因此不能单独裁“有 commit、无文件”或“是否漏了一份已删文件”。后一个方向对“有没有未落盘信息”本非必要，但正文主动声称“凡是本轮提交，其消息都来自这样一份已删文件”，该全称命题不能由所给命令独立验证，仍留有作者自述口子。已知实例可由 session transcript 独立裁，但新判据没有把 transcript／harness timeline 设为已删文件总体的枚举 oracle。
2. **`m7.txt` 语义上被开放式判据包含，但替代证据行没有把它闭合。** transcript 明确显示 `m7.txt` 生成 `83696acf` 后同一调用删除，commit body 与文件内容相符；然而表格只列到 `m6.txt`，不可变 commit 只列 8 个、止于 `62ef4e61`，并写“本节之后若再有提交……不必回来改这一行”。这会让 manifest 永久缺少该临时对象自己的 row／明确替代对象；规则虽能口头套用，却没有冻结“本次实际总体已核到哪个 tip”。可判定写法至少应记录审计边界 `tip=83696acf`，并把 `m7.txt → 83696acf` 纳入已核实例；未来再提交则更新 tip，或明确由 transcript 查询机械枚举该 base..tip 间所有 `commit -F` 输入并逐项比对。
3. **整改 commit 新引入三行重复表格。** `83696acf` 的 diff 在新增 `m1～m6` 行后，又重复插入校验脚本、`tmp-rescan`、mine/theirs 三行，而旧三行仍保留；当前文件第 70–72 行与 73–75 行逐字重复。这是 `new_string` 重述了 replacement 区间外原文的典型重复，说明整改文档没有完整通读。它不新增不同 disposition，但让“逐项清单”不再是一对象一行，破坏清单作为删除授权的规范形状。

下一个接手的人会因此做出的错误动作：会把开放式规则误当成已经对实际总体完成过枚举，并在没有 `m7.txt → 83696acf` 审计锚点的情况下放行；或者把重复的三个 disposition 当成六个对象／两次独立核验。修复建议：去除重复三行；把已核边界锚到 `83696acf` 并补 `m7.txt → 83696acf`；将“所有已删消息文件”的总体来源明确为 session transcript 中实际 `git commit -F <path>` 调用，而 `git log` 仅负责核对对应 commit message。任何 disposition 文本变更后再次复评。

### R2 Minor 整改：历史归因改锚不可变证据

**判定：PASS**

运行命令：

```sh
git -C /home/xp/.claude show 7d4c09f -- skills/closing-a-development-session/SKILL.md | rg -c '^\+.*too complex'
git -C /home/xp/.claude show 7d4c09f -- skills/closing-a-development-session/SKILL.md | rg '^\+.*too complex'
git -C /home/xp/.claude show -s --format='%H %ad %s' --date=iso-strict 7d4c09f
# 从 session transcript 按 tool_use_id 提取 22:40 空结果与 23:06 命中结果
```

关键输出：新增行计数为 1，diff 的 `+` 行完整包含 `too complex` 事实；`7d4c09f` 时间为 `22:48:24+00:00`。transcript 中同一文件的目标 grep 在 `22:40:01` 无输出，`23:06:51` 命中第 153 行。三者合起来支持窄因果序列：22:40 时该文本不在文件中；22:48 的 commit 将其新增；23:06 已可命中。修订后的“该段文字是在我 grep 之后才被写进那个文件”没有超出证据。

### 第二轮总判定

**不可据当前 `83696acf` 清单执行三个 `/tmp` 文件的删除。** 原 Minor 已闭合；原 Major 的自指识别有进步，但整改仍有 Major：缺少已删消息文件总体的独立枚举 oracle和冻结 tip，且遗漏 `m7.txt → 83696acf` 的已核实例；同时 commit 新引入三行重复 disposition。修复这些内容会再次改变清单，按门禁必须重新独立复评。blocker 仍为 0。

## 复评（第三轮）

- 冻结版本：`git rev-parse HEAD` = `4a37b9143b94c6bd74ec56de825755f7931ba50c`，与指定 HEAD 一致。

### R3-1 去重与整改覆盖面

**判定：PASS**

运行命令：

```sh
sort docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md | uniq -d
rg -n '^\| `add-skip-identity|^\| `/tmp/tmp-rescan|^\| `/tmp/mine' docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md
git diff 4a37b914^ 4a37b914 -- docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md
```

关键输出：全文重复行检查仅输出 blockquote 的空 `>` 行；上一轮重复的三个表格 row 现各只出现一次，位于第 77–79 行。`4a37b914` diff 同时显示只删除重复 rows、替换消息文件判据与实例行，未在文件其他位置复制相邻正文。去重整改闭合。

### R3-2 两个方向的证据边界

**判定：MAJOR**

运行命令：

```sh
# 从本会话 transcript 枚举所有 Bash tool_use 中含 `git commit -F` 的调用
python3 -c '<JSONL 解析；打印 timestamp、tool_use_id、-F path>'
git log --format='%H%x00%s' 2a4898e8..83696acf
rg -n 'm8\.txt|4a37b914|闭合第二批清单' <session-transcript>
```

我能读取本会话完整 transcript。实际枚举到 audited tip `83696acf` 为止的 9 份输入：`commit-msg-v19.txt`、`m1.txt`～`m7.txt`、`mg.txt`；与第 76 行枚举完全相等。transcript 还保留每个 heredoc 的内容、对应 tool result 与 commit SHA，所以本轮可独立核对九份内容均落成所列 commit。tip 后另有 `m8.txt → 4a37b914`，同样有完整 command 与成功 tool result。就**实际事实**而言，未发现消息内容丢失或漏枚举。

但文档对方向①的证据能力仍写错：删掉原文件后，仓库里的 `git log --oneline` 只能证明“这些 commit 及其 subject 存在”，**不能证明“某份已删文件的内容等于该 subject”**。文件名、原内容及 `-F` 生产关系都只能从 transcript 取得。也就是说，两个方向不是“方向①仓库可核／方向② transcript 可核”；正确 provenance 是：

- transcript 枚举 `commit -F` 调用，并给出 file path、heredoc 内容、调用顺序与 tool result；
- Git object 独立证明对应 commit 仍存在且 message 与 transcript 中输入一致；
- 两者联合才能证明 file→commit 的内容保存；总体穷尽则由 transcript 在明确时间／event 边界内枚举。

第 69 行“方向①可由仓库独立核验”因此仍是承重的错误断言；`<base>` 也未给字面值，所称复核命令不能直接执行。下一个接手者会只跑 `git log` 就误以为验证了已删文件内容，实际只验证了 commit 自身。修复建议不是增加条件，而是撤回“仓库独立核验”，改成上述两源联合 provenance，并给 audited base 的字面 SHA。

### R3-3 审计边界的收敛性

**判定：PASS（方法成立，措辞需随 R3-2 修正）**

把 manifest 的实例集冻结到已审 tip `83696acf`，并由本轮评审对 tip 后、触发本轮修订的 `m8.txt → 4a37b914` 单独核验，确实能打断“为了记录最新消息文件再提交、再产生下一份文件”的无限自指。收敛点不是让同一 row 永久覆盖未来，而是：

1. 持久 manifest 明确覆盖闭区间 `base..83696acf`；
2. 本次独立评审的报告记录并裁决边界后的 `m8.txt → 4a37b914`；
3. 后续若再提交，不回写旧闭区间，而由该次提交自己的评审／收尾记录覆盖新半开区间。

这不是把口子平移，只要每个新区间都明确 `baseExclusive`、`tipInclusive` 和 transcript event/time 边界，且不声称旧 row 覆盖未来。当前文档缺 audited base 字面 SHA，且第 72 行“tip 之后的提交……去 transcript 取 oracle”没有点名**由哪个必经评审产物接住新区间**；不过本轮报告已经实际接住 `m8`。建议修订为“manifest 覆盖 `<literal-base>..83696acf`；本轮复评覆盖 `(83696acf,4a37b914]` 的 transcript `commit -F` 事件”，避免未来读者把“按同一判据核”当无人负责的开放承诺。

### 第三轮总判定

**仍不可据当前 `4a37b914` 清单删除三个 `/tmp` 文件。** 去重已闭合，transcript 实测也证实截至 `83696acf` 的九份输入完整、并核到 `m8.txt → 4a37b914`，审计分段方法可收敛；但仍有 1 Major：文档错误声称方向①仅靠仓库即可验证，实际必须由 transcript（文件输入与生产关系）+ Git object（持久 commit message）联合裁决，且 audited base／新区间接收产物未写实。修正会改变承重证据边界，须再次复评。blocker 为 0。

## 复评（第四轮）

- 冻结版本：`git rev-parse HEAD` = `ffc0c824ad7205a6e54d4b7fdd56ff603e0a5ee7`，与指定 HEAD 一致。

### R4-1 消息文件 provenance 与分段承接

**判定：PASS**

运行命令：

```sh
git log --oneline 2a4898e8..83696acf | wc -l
git log --oneline 2a4898e8..83696acf
rg -n 'm9\.txt|ffc0c824|更正「test:backend' <session-transcript>
sort docs/tmp/2026-08-08-header-deadline-job-tmp-reconciliation.md | uniq -d
```

关键输出：字面 Git range 可直接执行并返回 32 行。清单没有再声称 Git 单独证明已删文件来源，而是准确拆成 transcript 提供 heredoc／`commit -F` 生产关系、Git object 提供持久 message，两源联合闭合。文档引用上轮独立评审为「截至 `83696acf` 枚举九份输入，与本表一致」与我的实际核验强度完全相符，没有扩大成对未来或对其他临时对象的背书。

分段承接已落到具体产物：manifest 冻结 `2a4898e8..83696acf`；本报告第三轮已记录 `m8.txt → 4a37b914`；本轮 transcript 明确记录 `m9.txt` 的 heredoc、`git commit -F` 调用及成功生成 `ffc0c824` 的 tool result，本节即承接 `(4a37b914,ffc0c824]`。没有残留由作者自评总体的口子。术语上 `A..B` 的 Git range 排除 A，称“闭区间”不够精确，但字面命令与已审输入边界明确，不会改变枚举结果或删除授权，属 nit；后续可称“有界 range”或写 `baseExclusive/tipInclusive`。

### R4-2 `test:backend` 与 discovery baseline 的真实契约

**判定：PASS**

证据：

- `package.json:55` 定义 `test:backend = bun scripts/parallel-test.ts unit it http`；`scripts/parallel-test.ts:58-64,122` 枚举全部 `.unit/.it/.http.test.ts`，因此 `tests/infra/entry-evidence-schema.unit.test.ts` 在 backend 档。
- `tests/infra/entry-evidence-schema.unit.test.ts:13,17-25` 从真实 `tests/infra/entry-test-discovery-baseline.json` 读取并调用 `parseDiscoveryBaseline`，然后只将 `baseline.files` 与实际发现的 backend 文件集合比较。
- `scripts/entry-evidence-schema.ts:91-120` 在 parse 时也校验整个 baseline 的 schema、字段键序、`files` 与 `allowed_skipped` 各自的类型／唯一性／字节序排序，以及全文 canonical bytes。因此“校验 files 集合与 canonical 形态”准确。这里确实会验证 `allowed_skipped` 自身结构、排序和唯一性，但**不会把它与任何运行时 skip 集合比较**；文档使用“不把 `allowed_skipped` 与运行时实际 skip 集合比对”已明确限定这一点，没有把 parse 校验误说成不存在。
- `scripts/capture-entry-evidence.ts:177-197,228-234,300` 把 baseline `allowed_skipped` 与运行 artifact `skipped_identities` 比对；`scripts/validate-entry-evidence.ts:744-759` 做同类 exact multiset 比较。全仓 `rg` 未发现 backend 普通测试路径上读取真实 baseline 后再与 runtime skip 对比的其他生产点。

HANDOVER 与 KICKOFF 语义一致：都写明 backend 会读真实文件并校验 files/canonical，但四条未登记 runtime skip 不会使 backend 红，exact runtime multiset 属 capture/validate。KICKOFF 是压缩复述并指回 HANDOVER，没有分叉。

### R4-3 三个待删文件的最终复核

**判定：PASS**

前轮 T4 已逐字节证明：`tmp-rescan` 的 42 项全部进入清单，mine/theirs 可由 merge-base 与两父 Git objects 精确重建。第四轮没有改这三项的 disposition 或替代证据；新增修改只纠正消息文件 provenance 与交接文档。当前 job tmp 仍不含新文件／符号链接，三个 `/tmp` 候选仍存在。

### 第四轮总判定

**可以据此执行 `/tmp/tmp-rescan-14d4ecd1.txt`、`/tmp/mine-14d4.txt`、`/tmp/theirs-14d4.txt` 的删除。** blocker=0，major=0，minor=0，仅有一个不影响动作的术语 nit（Git `A..B` 不是数学闭区间）。删除前仍应按既定门复查三个精确路径存在且 job tmp 无新增；若 manifest disposition 或审计边界再变化，本 verdict 失效。

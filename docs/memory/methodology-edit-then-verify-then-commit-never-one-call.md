---
name: methodology-edit-then-verify-then-commit-never-one-call
description: "编辑脚本把写盘放在所有 assert 之后 → 中途失败即静默丢弃全部改动，而 git commit 照跑，提交信息于是描述了没发生的事；同一次调用里后续命令的绿证明不了编辑生效"
metadata:
  type: feedback
---

**改文件、验证改动、提交，这三步不得写在同一次 Bash 调用里。** 顺序是：编辑 → **用「缺失即返回 0」的 grep 验新文本真在磁盘上** → 再提交；提交后可再用 `git show HEAD:<path> | grep -c` 按 tree 对象复验（不看工作区）。

**Why:** 2026-08-03 同一会话内中了两次，形态完全一样。惯用的 python heredoc 是「先逐个 `assert` 锚点，全过之后才 `io.open(p,"w")`」——**任一锚点没匹配上，异常就把此前的替换和其后的编辑一并丢弃**，而同一次调用里后面的 `git commit` 照常执行。于是：

- 第一次：`5a71607f` 的提交信息描述了脚本的 precise-claim 段与 HANDOVER 的 T3-b，**磁盘上一个都没有**；而由另一次调用写入的 run-log 已经引用了那个不存在的条目。**是评审去找产物才抓到的，不是我自查到的。**
- 第二次：`88171b3b` 声称重验了相位状态行，锚点差**一个空格**，只有状态行进了提交。

**没抓住的真正原因**，比机制本身更值得记：我拿同一次调用里后续命令的 `bash -n` → `syntax ok`、`smoke rc=0` 当成了编辑已生效的证据——**而这两条在未编辑的文件上同样通过**，它们从原理上就区分不了两种结果。这是 [[feedback-pass-null-clean-not-self-validating]] 与 user-rule `60-evidence-and-criteria` 的 `verified-by-a-wrong-query` 的又一个实例：跑了命令、拿到绿、结论是错的。

**How to apply:**
- 编辑与提交**分两次调用**。中间那次只做验证，且验证必须**针对新写入的具体字符串**（`grep -c '<新文本片段>'`），不是语法检查、不是 smoke 跑。
- 批量替换时，**每个 replacement 打印它的命中数**，并让写盘发生在**每个**替换之后而不是全部之后；或者干脆一次调用只做一处替换。
- 提交信息里凡是「本次新增/改写了 X」的句子，落笔前对 X 各跑一次 grep。**提交信息是会撒谎的权威声音**（→ [[methodology-diagnostic-log-is-authoritative-voice-verify-against-ground-truth.md]]），而它比日志更容易被后人当作已发生事实。
- 已经发出错误提交信息时，**下一个提交显式说明它没落**，别默默补上——后人做 `git log` 考古时看到的是那条错的。

# 清理增量评审（`3a492b3c`）

**评审者**：`gpt-souls:reviewer`，独立派发，未参与该 commit 的写作。
**范围**：只审收尾末尾的清理增量四个文件，不重审整份终报。
**结论**：**BLOCKER 0 / MAJOR 0 / MINOR 1**，修掉 MINOR 后可收口。

⚠️ **这份记录由主会话代为落盘，不是评审自己写的。** 评审拿到的 `REPORT_FILE` 指向共享检出，被运行时的写入护栏拒绝，于是它的结论一度只存在于返回正文里——正是「结论只活在对话里」的形态。正文逐条转录如下，未改写；主会话的复核另起一节标明。

## 评审执行的证据

- 脚本默认路径与显式传参两种用法均输出 427 的九类计数。
- 隔离副本把清单 header 改成 426 后按预期 `exit=1`（正样本对照成立，脚本不是恒绿）。
- `git cat-file -e` / `git ls-tree` 证明四个文件确在 commit 对象中；`exp/` 确受 `.gitignore:27` 忽略——所以**不能用 `git status` 判它们是否入库**。
- 三棵已删 worktree 与同名分支均不存在；`continuation` 存在。
- 终报 C4、C5 的命令成立；diff 中未见意外删除（`replacement-must-cover-what-it-restates` 检查通过）。
- README 的「它没有证明什么」四条**均为该探针的具体边界**，不是套话。

## 唯一的 MINOR，及其处置

**发现**：`docs/mandatory-block-delivery-h2-observability/2026-08-09-task-37-closeout-evidence-manifest.md:65` 以现在时断言 transcript 位于某绝对路径，而 `test -f` 已为 false。

**主会话复核（实跑，非照收）**：属实，且成因值得写下来——`find /home/xp/.claude/projects -name 'a7c2cc1a-*.jsonl'` 显示它现在在 `-home-xp-src-copilot-api-js/` 下。**transcript 的 project 目录名随会话当时的 cwd 派生，不随 job 派生**：删掉那棵 worktree 后它挪了回去。

这条在同一份文档里**踩过两次、方向相反**：第一次是我给评审的路径少了 worktree 前缀（文件不存在，评审自己找到了真路径），第二次是补上前缀之后、我的清理动作又让前缀失效。所以处置不是把路径改对，而是**改成按文件名检索**——绝对路径这个载体本身就会过期。

**已修**：manifest 第 65 行改为给出文件名与 `find` 命令，并把两次相反的失效都记在那里。

## 这轮暴露的一个流程缺口（记录，未修）

派给 reviewer 的 `REPORT_FILE` 若落在共享检出内，会被后台隔离护栏拒绝，reviewer 写不了盘。本轮靠返回正文没丢东西，但那正是「攒到最后一次性输出、被掐断就全丢」要防的情形。**下次派活时 `REPORT_FILE` 应给 reviewer 自己可写的位置**（隔离 worktree 内，或 job 临时目录再由主会话归档）。

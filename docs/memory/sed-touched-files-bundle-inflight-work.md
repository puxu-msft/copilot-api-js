---
name: sed-touched-files-bundle-inflight-work
description: sed 碰过的文件 git add 会裹入在飞工作已归入 skill large-refactor §6；见那里
metadata:
  type: feedback
---

**已归入 skill `large-refactor` §6（sed 碰过的文件会裹入在飞工作）。** 钩子：机械 sed 跨多文件后 `git add <file>` 暂存该文件**整个工作区状态**、连带别 phase 在飞未提交工作裹进 commit；tripwire=`git diff --cached --stat` 逐文件对账行数（1 行 cosmetic 显 170 churn=红旗）；污染文件 `git reset -q HEAD -- <file>` 只 unstage 不动工作区。

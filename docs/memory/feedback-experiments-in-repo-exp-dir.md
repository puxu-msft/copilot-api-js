---
name: feedback-experiments-in-repo-exp-dir
description: "探测/实验代码与报告放项目仓库 exp/<exp-name>/,不放 /tmp"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 23c7e548-1ad2-4ce2-9ae4-0445eb6ca9d2
---

探测实验(probe/spike/调研)的**代码、ss 输出、报告等一切产物**放到项目仓库内 `exp/<exp-name>/`,**不要放 `/tmp`**。

**Why:** `/tmp` 文件易丢失、不可追溯、且项目的 `~/*` 路径别名在 `/tmp` 下不解析(逼得我把探针写到项目根再 rm,或硬编码绝对路径)。放仓库内 `exp/<exp-name>/` 则:别名可用、产物可留存复查、一个实验自成一个子目录(代码+报告同处)。也避免了我受 `rm`/`kill` 安全规则限制后在 `/tmp` 留一堆清不掉的垃圾。

**How to apply:**
- 探针脚本写 `exp/<exp-name>/probe.ts`(或 .mjs),import 直接用 `~/lib/...` 别名。
- 调研结论/报告写 `exp/<exp-name>/README.md` 或 `findings.md`。
- 命名 `<exp-name>` 用 kebab,反映实验主题(如 `exp/bun-undici-keepalive/`)。
- **入库**:用户已定 `exp/` 入库(不 gitignore),实验产物随 commit 进 git 跟踪——所以探针产物该 `git add exp/<exp-name>/` 提交,不是本地临时。
- **坑:项目 `.gitignore` 有 `*.txt` 和 `*.log` 全局通配**——`exp/` 本身不被 ignore,但其下的 `.txt`/`.log` 文件会被静默挡住、入不了库。报告写 `.md`,ss/命令输出存 `.md`/`.json`/无扩展名,**别用 `.txt`/`.log`**(否则 git add 不进、看不到)。
- 跑完不必急着删(留存可追溯);派 subagent 做探针时也告知它把产物放这里,不放 /tmp。

关联 [[feedback_tests_never_touch_real_env]](探针/测试的环境纪律)。

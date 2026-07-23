---
name: find-claude-session-by-git-branch
description: 按 gitBranch 字段置信度打分，从 ~/.claude/projects/<path>/*.jsonl 里定位某分支对应的并发 session（id+title）
metadata: 
  node_type: memory
  type: reference
  originSessionId: aef7321a-543b-4e1e-bbb8-762455cee92b
  modified: 2026-07-22T20:08:27.567Z
---

要定位「哪个 Claude session 在某个 git 分支上工作」（例如误 pop 了某分支的 stash、要找物主会话协调），session 数据在 `~/.claude/projects/<encoded-cwd>/*.jsonl`（文件名=session id UUID）。

**决定性信号 = JSONL 每条记录的 `gitBranch` 字段**——它记录该条活动发生时的分支。某 session 的记录里出现 `"gitBranch":"<branch>"` = 它确实在该分支工作过（强于「内容里偶然提到分支名」）。一个 session 会跨多分支，故 `gitBranch` 取到的是**去重集合**。

**置信度打分**（脚本 `/tmp/find-session-by-branch.sh`，本会话产出）：
- `gitBranch` 字段精确命中分支 **+100**（最强）
- 内容含 stash 锚 commit hash **+50** · 含分支名字符串（非字段）**+20** · 含特征文件路径 **+5**
- 先 `rg -l` 筛候选再逐个 `grep -c`/`jq` 打分，避免对全部 jsonl（本项目 288 个）跑重 jq。

**title 提取的坑**：session 首条 `type:"user"` 记录常是系统注入（`<task-notification>`/`<system-reminder>`/`<command-...>`/`[SYSTEM ...]`），不是真人 prompt。取 title 要 `grep -vE '^<|^\[SYSTEM|^\[Request'` + 长度过滤，取首条真正的人类叙述；或退回 `type:"summary"` 记录的 `.summary`（Claude 生成的标题，很多 session 没有）。

**实测**：`feat/retry-strategy-registry` → session `f8e8d95a-...`（score 175：gitBranch 字段命中 134 次、anchor commit 12 次），第二名仅 75（内容提及、gitBranch 字段 0 次）——区分度极高。

Related: [[git-stash-push-empty-pathspec-pops-peer-wip]]（触发场景：找误 pop 的 WIP 物主）。skill `session-time-attribution` 也读同一批 jsonl（不同目的：时间归因）。

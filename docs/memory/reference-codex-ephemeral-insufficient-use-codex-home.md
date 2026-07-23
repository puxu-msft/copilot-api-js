---
name: reference-codex-ephemeral-insufficient-use-codex-home
description: "测试里跑 real codex exec 时 --ephemeral 不足以隔离——它只抑制 session rollout,memories/goals/state/logs sqlite 仍写真实 ~/.codex;真隔离开关是 CODEX_HOME"
metadata: 
  node_type: memory
  type: reference
  originSessionId: a048630b-9b10-48c5-8924-4053edf4b5f0
  modified: 2026-07-20T05:55:58.900Z
---

在**测试/oracle 里驱动真实 `codex exec`** 时,要让它不污染用户真实 `~/.codex`(不留 transcript/memories/state),**`--ephemeral` 不够**——实测(2026-07-20)`--ephemeral` **只抑制 session rollout 文件**,codex 仍会往真实 `~/.codex` 写 `memories_1`/`goals_1`/`state_5`/`logs_2` 等 sqlite,还会读用户的 `config.toml`/`AGENTS.md`/hooks。

**真隔离开关 = `CODEX_HOME`**(codex --help:「Layer $CODEX_HOME/... on top of base user config」+「auth still uses CODEX_HOME」)。每次调用套一个一次性 home:

```bash
CODEX_HOME="$(mktemp -d)" OPENAI_API_KEY=dummy codex exec --json --ephemeral \
  -c model_provider=oracle -c model_providers.oracle.base_url=$PROXY/v1 \
  -c model_providers.oracle.wire_api=responses -c model_providers.oracle.preferred_auth_method=apikey \
  -c model=$MODEL -s read-only --skip-git-repo-check "..."   # 完事 rm -rf 那个 CODEX_HOME
```

`CODEX_HOME` 把 codex **全部**持久化(sessions/memories/goals/state/logs/installation_id/auth)重定向到临时目录,并给一个**不受用户个人 config 污染**的干净基座(确定性测试双赢)。`--ephemeral` 作额外保险保留。**实证**:隔离跑后 `~/.codex/{goals,memories,state}.sqlite` mtime 前后完全不变。落地在 `exp/responses-buffered-merge-codex-oracle/run-proxy-arm.sh`(commit `03fb1610`)。类比:代理测试实例隔离用 `XDG_DATA_HOME`(见 skill `live-ghc-e2e-verification`),codex 侧对应物是 `CODEX_HOME`。

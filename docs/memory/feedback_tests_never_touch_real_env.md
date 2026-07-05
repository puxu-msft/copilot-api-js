---
name: feedback_tests_never_touch_real_env
description: 测试绝不写真实用户环境、DI 隔离已归入 skill test-isolation；见那里
metadata:
  node_type: memory
  type: feedback
---

**已归入 skill `test-isolation`（铁律 + 地板防线）。** 钩子：测试绝不写真实 `$HOME`/`~/.claude`/`~/.local/share/copilot-api`；用 DI 注入临时目录、**不用 `process.env.HOME` mutation**（Bun `os.homedir()` 忽略它）、不把 `mock.module` 当接缝；地板=`bunfig.toml [test].preload` 沙箱 `XDG_DATA_HOME` + 守卫测试。两次事故（写盖 `~/.claude.json`、擦掉 negotiation-states）。

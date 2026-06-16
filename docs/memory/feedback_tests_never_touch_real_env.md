---
name: feedback_tests_never_touch_real_env
description: "测试绝不能写入真实的用户配置/环境;使用依赖注入,而非 process.env mutation;运行前先验证"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2cc513ee-b169-4c19-a99a-9041eaf57d8d
---

一个针对 `setup-claude-code` 的测试(位于 `tests/`)在测试运行期间写入了用户的**真实 `~/.claude.json` / `~/.claude/settings.json`**。原因:我把一个 `mock.module("node:os")`(它曾安全地把 `homedir()` 重定向到一个临时目录)替换成了运行时的 `process.env.HOME = tempDir`——但 **Bun 的 `os.homedir()` 并不会在调用时重新读取 `process.env.HOME`**(它返回了真实的 `/home/xp`),于是 `writeClaudeCodeConfig()` 覆盖了真实配置。用户理所当然地警觉了("严重的问题... 实验不要直接修改了真实环境配置")。

**Why:** 我把一个 `mock.module` 单纯当作需要移除的跨文件泄漏,忽略了它还承担着一个**安全隔离**的用途(把 fs 写入隔离在真实 home 之外)。而且我在没有先证明它已被隔离的情况下,就对着真实环境运行了这个有缺陷的测试。

**How to apply:**
- 一个会对 `$HOME`/配置路径做真实文件 I/O 的测试,必须通过**依赖注入**来隔离——给函数一个 `options.home`(或 paths)参数,并传入一个 `mkdtemp` 临时目录。绝不依赖 `process.env.HOME` mutation(Bun 的 `os.homedir()` 在运行时忽略它),也绝不把 `mock.module("node:os")` 当作接缝。
- 在"修复"/移除任何 `mock.module` 之前,先问它是否提供了**安全隔离**(fs/网络封闭),而不只是文件间隔离——若是,则替代方案必须保留那层封闭。
- **在执行任何可能触及真实用户状态的操作前,先证明隔离**:确认该代码路径只能命中临时/沙箱位置。拿不准时,先取得用户确认(他们说过:未确认不动手)。
- 对于 CLI 本身,要尊重已有配置:检测已存在的自定义配置,展示直观的 `+/~/-` diff,在破坏性覆盖前确认,并区分"essential"(默认写入)与"extension"(仅 opt-in)设置。与 [[feedback_complete_root_cause_fix]] 和 [[feedback_optimize_long_term_maintainability]] 相关。
